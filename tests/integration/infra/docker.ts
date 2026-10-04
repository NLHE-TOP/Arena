/**
 * Disposable, isolated local infrastructure for acceptance runs.
 *
 * Canonical platform pattern: a uniquely named PostgreSQL container published
 * on an ephemeral loopback port, paired with Redis. Nothing here touches
 * operator data, an operator Redis database, or a shared database name: every
 * run provisions its own container and tears it down unless --keep is set.
 *
 * Local `redis-server` is used as a fallback when Docker images are not
 * available; PostgreSQL always fails closed rather than silently reusing a
 * non-disposable database.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { freePort, runCommand, runCommandOrThrow, spawnManaged, type ManagedProcess } from './proc.js';

export const POSTGRES_IMAGE = process.env.NLHE_IT_PG_IMAGE ?? 'postgres:18-alpine';
export const REDIS_IMAGE = process.env.NLHE_IT_REDIS_IMAGE ?? 'redis:8-alpine';

export async function isDockerAvailable(): Promise<boolean> {
  const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 15_000,
  });
  return result.code === 0;
}

async function containerPort(name: string, internal: number): Promise<number> {
  const result = await runCommandOrThrow('docker', ['port', name, `${internal}/tcp`], {
    timeoutMs: 15_000,
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const port = Number(lines.at(-1)?.split(':').at(-1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`docker port ${name} ${internal}/tcp returned ${JSON.stringify(result.stdout)}`);
  }
  return port;
}

async function waitForContainerCommand(
  name: string,
  args: string[],
  accept: (stdout: string) => boolean,
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const result = await runCommand('docker', ['exec', name, ...args], { timeoutMs: 10_000 });
    last = (result.stdout + result.stderr).trim();
    if (result.code === 0 && accept(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`container ${name} not ready: ${last}`);
}

export interface PostgresHandle {
  kind: 'docker';
  container: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export async function startPostgres(runId: string, artifactDir: string): Promise<PostgresHandle> {
  const container = `nlhe-it-pg-${runId}`.slice(0, 60);
  const password = randomBytes(12).toString('hex');
  const logFile = join(artifactDir, 'logs', 'docker-postgres.log');
  mkdirSync(join(artifactDir, 'logs'), { recursive: true });
  await runCommandOrThrow(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ],
    { timeoutMs: 600_000, logFile }
  );
  try {
    await waitForContainerCommand(container, ['pg_isready', '-U', 'postgres', '-d', 'postgres'], (out) =>
      out.includes('accepting connections')
    );
  } catch (error) {
    await runCommand('docker', ['rm', '-f', container], { timeoutMs: 30_000 });
    throw error;
  }
  const port = await containerPort(container, 5432);
  return {
    kind: 'docker',
    container,
    port,
    url: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await runCommand('docker', ['rm', '-f', container], { timeoutMs: 60_000 });
    },
  };
}

export interface RedisHandle {
  kind: 'docker' | 'local';
  container?: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(
  runId: string,
  artifactDir: string,
  dockerAvailable: boolean
): Promise<RedisHandle> {
  if (dockerAvailable) {
    const container = `nlhe-it-redis-${runId}`.slice(0, 60);
    try {
      await runCommandOrThrow(
        'docker',
        ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::6379', REDIS_IMAGE],
        { timeoutMs: 600_000, logFile: join(artifactDir, 'logs', 'docker-redis.log') }
      );
      await waitForContainerCommand(container, ['redis-cli', 'ping'], (out) => out.includes('PONG'), 60_000);
      const port = await containerPort(container, 6379);
      return {
        kind: 'docker',
        container,
        port,
        url: `redis://127.0.0.1:${port}`,
        stop: async () => {
          await runCommand('docker', ['rm', '-f', container], { timeoutMs: 30_000 });
        },
      };
    } catch (error) {
      await runCommand('docker', ['rm', '-f', container], { timeoutMs: 30_000 });
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|pull access|manifest unknown|daemon/i.test(message)) throw error;
    }
  }

  // Fallback: an isolated local redis-server with its own dir, port and no
  // persistence. It is still exclusive to this run.
  const port = await freePort();
  const dir = join(artifactDir, 'redis');
  mkdirSync(dir, { recursive: true });
  const process: ManagedProcess = spawnManaged(
    'redis-server',
    'redis-server',
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir],
    { cwd: artifactDir, logDir: join(artifactDir, 'logs') }
  );
  // A kept local Redis must not hold the run script open; stop() still owns it.
  process.child.unref();
  // waitForHttp only speaks HTTP; poll redis-cli instead.
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    const ping = await runCommand('redis-cli', ['-p', String(port), 'ping'], { timeoutMs: 3000 });
    if (ping.code === 0 && ping.stdout.includes('PONG')) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    await process.stop();
    throw new Error(`local redis-server did not become ready on ${port}`);
  }
  return {
    kind: 'local',
    port,
    url: `redis://127.0.0.1:${port}`,
    stop: async () => {
      await process.stop();
    },
  };
}

export async function removeContainer(name: string): Promise<void> {
  await runCommand('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
}

/** Explicit-infrastructure SQL against the disposable container. */
export async function psqlContainer(container: string, sql: string): Promise<string> {
  const result = await runCommandOrThrow(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { timeoutMs: 30_000 }
  );
  return result.stdout.trim();
}

/** SQL through a host psql client for an externally supplied DATABASE_URL. */
export async function psqlUrl(databaseUrl: string, sql: string): Promise<string> {
  const result = await runCommandOrThrow('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

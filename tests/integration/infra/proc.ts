/**
 * Child-process supervision and HTTP readiness helpers for the real local
 * acceptance topology. Logs are streamed to the run's artifact directory and
 * tailed into errors so a failed start is diagnosable from CI output.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { buildChildEnv, redactCommandLine } from './env-boundary.js';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function tailFile(path: string, lines = 30): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '<no log>';
  }
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  command: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Every child is explicitly bounded: no ambient environment is inherited
      // unless the caller declares it.
      env: options.env ?? buildChildEnv({ purpose: 'platform', declared: {} }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (options.logFile) {
        const prefix = `${redactCommandLine(command, args)}\n`;
        const sink = createWriteStream(options.logFile, { flags: 'a' });
        sink.write(prefix);
        sink.write(stdout);
        sink.write(stderr);
        sink.end();
      }
      resolve({ code, signal, stdout, stderr, command: `${command} ${args.join(' ')}` });
    });
  });
}

export async function runCommandOrThrow(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string } = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const details = `${result.command} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
    throw new Error(`${details}\n${(result.stderr || result.stdout).split('\n').slice(-25).join('\n')}`);
  }
  return result;
}

export interface ManagedProcess {
  name: string;
  child: ChildProcessWithoutNullStreams;
  logPath: string;
  pid: number | undefined;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
  /** Hard kill (SIGKILL) for deterministic crash-window tests. */
  kill: () => Promise<void>;
}

export function spawnManaged(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; logDir: string }
): ManagedProcess {
  const logPath = join(options.logDir, `${name}.log`);
  const sink = createWriteStream(logPath, { flags: 'a' });
  sink.write(`${redactCommandLine(command, args)}\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? buildChildEnv({ purpose: 'platform', declared: {} }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(sink);
  child.stderr.pipe(sink);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => {
      sink.end();
      resolve({ code, signal });
    });
  });

  const managed: ManagedProcess = {
    name,
    child,
    logPath,
    pid: child.pid,
    exited,
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }
      child.kill(signal);
      const killed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!killed) {
        child.kill('SIGKILL');
        await exited;
      }
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
  return managed;
}

export async function waitForHttp(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    accept?: (response: Response) => boolean | Promise<boolean>;
    onRetry?: (error: unknown) => void;
    logPath?: string;
  } = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
      if (options.accept === undefined || (await options.accept(response))) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    options.onRetry?.(lastError);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const logs = options.logPath ? `\n--- ${options.logPath} ---\n${tailFile(options.logPath)}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${detail}${logs}`);
}

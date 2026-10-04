/**
 * Real PokerTools platform topology for NLHE integration acceptance.
 *
 * Builds the platform workspace artifacts, regenerates the PostgreSQL Prisma
 * client, applies the reviewed migrations, seeds the canonical HOUSE identity,
 * then supervises the ACTUAL built API (`dist/server.js`) and the ACTUAL workers
 * (`dist/workers.js`) as one topology. The API process stays running across NLHE
 * process restarts; only the platform topology owns the database and Redis.
 *
 * NLHE runtime code never reaches into this module's platform internals; the
 * tests themselves only speak the public `@pokertools/sdk` + `@pokertools/types`
 * contract. The one explicit-infrastructure exception is the operator bootstrap
 * (admin role promotion and canonical chip grants), which runs outside the
 * product boundary against the disposable database/API.
 */
import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RunContext } from './context.js';
import { POKERTOOLS_DIR, PLATFORM_API_DIR, PLATFORM_SDK_DIR, PLATFORM_TYPES_DIR } from './context.js';
import { freePort, runCommandOrThrow, spawnManaged, waitForHttp, type ManagedProcess } from './proc.js';
import { buildChildEnv } from './env-boundary.js';

const BUILD_WORKSPACES: Array<{ workspace: string; dir: string; distFile: string; deps: string[] }> = [
  { workspace: '@pokertools/types', dir: PLATFORM_TYPES_DIR, distFile: 'dist/index.js', deps: ['src'] },
  { workspace: '@pokertools/sdk', dir: PLATFORM_SDK_DIR, distFile: 'dist/index.js', deps: ['src'] },
  { workspace: '@pokertools/api', dir: PLATFORM_API_DIR, distFile: 'dist/server.js', deps: ['src'] },
  {
    workspace: '@pokertools/custody',
    dir: join(POKERTOOLS_DIR, 'packages', 'custody'),
    distFile: 'dist/index.js',
    deps: ['src'],
  },
];

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

const BUILD_STAMP = '.nlhe-build-stamp';

async function buildFreshness(dir: string, deps: string[]): Promise<{ distExists: boolean; stale: boolean }> {
  const distDir = join(dir, 'dist');
  const distExists = existsSync(distDir);
  if (!distExists) return { distExists: false, stale: true };
  const newestSource = Math.max(...deps.map((dep) => newestMtime(join(dir, dep))));
  const stampPath = join(distDir, BUILD_STAMP);
  // A build stamp records the source state at the last successful build; dist
  // mtimes alone are unreliable because a failed tsc can emit partial files.
  if (existsSync(stampPath)) {
    return { distExists: true, stale: newestSource > statSync(stampPath).mtimeMs };
  }
  return { distExists: true, stale: newestSource > newestMtime(distDir) };
}

function writeBuildStamp(dir: string): void {
  writeFileSync(join(dir, 'dist', BUILD_STAMP), `${Date.now()}\n`);
}

/**
 * Strict platform builds.
 *
 * The local `./pokertools` source tree is the only authoritative runtime: a red
 * build must fail the run and a stale or partial `dist` must never be used.
 * `never` additionally verifies the existing dist is strictly newer than every
 * source dependency; it is for already-built CI environments, not a fallback.
 */
export async function ensurePlatformBuilds(context: RunContext): Promise<void> {
  for (const entry of BUILD_WORKSPACES) {
    const freshness = await buildFreshness(entry.dir, entry.deps);
    if (context.build === 'never') {
      if (!freshness.distExists) {
        throw new Error(
          `platform build missing for ${entry.workspace} (${entry.distFile}); NLHE_IT_BUILD=never refuses to build`
        );
      }
      if (freshness.stale) {
        throw new Error(
          `platform build for ${entry.workspace} is older than its sources; NLHE_IT_BUILD=never refuses a stale dist`
        );
      }
      continue;
    }
    if (!freshness.stale && context.build !== 'force') continue;
    context.log(`building ${entry.workspace} from ./pokertools source...`);
    // A failed build throws: no last-green fallback, no partial/stale dist.
    await runCommandOrThrow('npm', ['run', 'build', '-w', entry.workspace], {
      cwd: POKERTOOLS_DIR,
      env: buildChildEnv({ purpose: 'platform', declared: {} }),
      timeoutMs: 600_000,
      logFile: join(context.logDir, `build-${entry.workspace.replace(/[@/]/g, '_')}.log`),
    });
    writeBuildStamp(entry.dir);
  }
}

const PRISMA_SCHEMA = join(PLATFORM_API_DIR, 'generated', 'prisma', 'schema.prisma');
const PRISMA_LOCK_DIR = join(POKERTOOLS_DIR, '.runtime', 'nlhe-it-prisma.lock');
const PRISMA_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Serialize the shared Prisma client regeneration. The platform workspace has a
 * single generated client; independent PokerTools testers can otherwise clobber
 * each other's provider generation. Callers hold this lock across
 * generate -> migrate -> seed -> API/workers start, then release.
 */
export async function acquirePrismaLock(context: RunContext, timeoutMs = 300_000): Promise<() => void> {
  const runtimeDir = join(POKERTOOLS_DIR, '.runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(PRISMA_LOCK_DIR);
      writeFileSync(join(PRISMA_LOCK_DIR, 'owner'), `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch {
      try {
        const stat = statSync(PRISMA_LOCK_DIR);
        if (Date.now() - stat.mtimeMs > PRISMA_LOCK_STALE_MS) {
          rmSync(PRISMA_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock disappeared between attempts; retry immediately.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for the shared Prisma generation lock at ${PRISMA_LOCK_DIR}; another PokerTools run holds it`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(PRISMA_LOCK_DIR, { recursive: true, force: true });
  };
}

export async function ensurePostgresPrismaClient(
  context: RunContext,
  databaseUrl: string
): Promise<void> {
  const current = existsSync(PRISMA_SCHEMA) ? readFileSync(PRISMA_SCHEMA, 'utf8') : '';
  const isPostgres = /provider\s*=\s*"postgresql"/.test(current);
  if (isPostgres && (context.build !== 'force' || process.env.NLHE_IT_SKIP_PRISMA_GENERATE === '1')) {
    if (context.build === 'force' && process.env.NLHE_IT_SKIP_PRISMA_GENERATE === '1') {
      throw new Error('NLHE_IT_SKIP_PRISMA_GENERATE=1 conflicts with NLHE_IT_BUILD=force');
    }
    return;
  }
  if (process.env.NLHE_IT_SKIP_PRISMA_GENERATE === '1') {
    throw new Error(
      'NLHE_IT_SKIP_PRISMA_GENERATE=1 but the generated Prisma client is not PostgreSQL; refusing to run the API'
    );
  }
  context.log('regenerating platform Prisma client for PostgreSQL...');
  await runCommandOrThrow('npm', ['run', 'db:generate', '-w', '@pokertools/api'], {
    cwd: POKERTOOLS_DIR,
    env: buildChildEnv({ purpose: 'platform', declared: { DATABASE_URL: databaseUrl } }),
    timeoutMs: 300_000,
    logFile: join(context.logDir, 'prisma-generate.log'),
  });
}

export async function migratePlatform(context: RunContext, databaseUrl: string): Promise<void> {
  context.log('applying platform PostgreSQL migrations...');
  await runCommandOrThrow(process.execPath, ['scripts/migrate-postgres.mjs'], {
    cwd: PLATFORM_API_DIR,
    env: buildChildEnv({ purpose: 'platform', declared: { DATABASE_URL: databaseUrl } }),
    timeoutMs: 300_000,
    logFile: join(context.logDir, 'migrate-postgres.log'),
  });
}

export async function seedPlatform(context: RunContext, databaseUrl: string): Promise<void> {
  context.log('seeding canonical platform HOUSE identity...');
  const result = await runCommandOrThrow('npm', ['run', 'db:seed', '-w', '@pokertools/api'], {
    cwd: POKERTOOLS_DIR,
    env: buildChildEnv({ purpose: 'platform', declared: { DATABASE_URL: databaseUrl } }),
    timeoutMs: 300_000,
    logFile: join(context.logDir, 'db-seed.log'),
  });
  void result;
}

export interface PlatformHandle {
  baseUrl: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Present only when this harness started the API/workers itself. */
  api?: ManagedProcess;
  workers?: ManagedProcess;
  stop: () => Promise<void>;
  /** Restart only the API process (fresh in-memory verifier/registry state). */
  restartApi?: () => Promise<void>;
}

export async function startPlatform(
  context: RunContext,
  input: {
    databaseUrl: string;
    redisUrl: string;
    autoDealDelayMs?: number;
    /** Preallocated when financial fixtures must be seeded before boot. */
    port?: number;
    /** Real valueless ASSET admission (requires a READY financial platform). */
    paid?: { sponsorPrincipalIds: readonly string[] };
  }
): Promise<PlatformHandle> {
  const port = input.port ?? (await freePort());
  const paid = input.paid;
  const env = buildChildEnv({
    purpose: 'platform',
    declared: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: input.databaseUrl,
      REDIS_URL: input.redisUrl,
      JWT_SECRET: `nlhe-it-jwt-${context.runId}-${randomBytes(8).toString('hex')}`,
      COOKIE_SECRET: `nlhe-it-cookie-${context.runId}-${randomBytes(8).toString('hex')}`,
      ALLOWED_SIWE_CHAIN_IDS: '31337',
      LOG_LEVEL: 'warn',
      ENABLE_TEST_ROUTES: 'false',
      // Fast, deterministic acceptance cadence: the product/table hand lifecycle
      // must not wait 5s between hands while the acceptance matrix runs.
      AUTO_DEAL_DELAY_MS: String(input.autoDealDelayMs ?? 250),
      GAME_OUTBOX_SWEEP_INTERVAL_MS: '1000',
      ACTION_TIMEOUT_SECONDS: '10',
      CANONICAL_DEPOSIT_MONITOR_INTERVAL_MS: paid ? '300000' : '60000',
      RECONCILIATION_INTERVAL_MS: paid ? '300000' : '60000',
      TOURNAMENT_BLIND_INTERVAL_MS: '15000',
      TOURNAMENT_BLIND_SCAN_INTERVAL_MS: '5000',
      WS_HEARTBEAT_INTERVAL_MS: '10000',
      ...(paid
        ? {
            COMPETITION_PAID_ENABLED: '1',
            COMPETITION_SPONSOR_PRINCIPAL_IDS: paid.sponsorPrincipalIds.join(','),
          }
        : {}),
    },
  });

  const api = spawnManaged('platform-api', process.execPath, ['--max-old-space-size=3072', 'dist/server.js'], {
    cwd: PLATFORM_API_DIR,
    env,
    logDir: context.logDir,
  });
  const workers = spawnManaged('platform-workers', process.execPath, ['--max-old-space-size=3072', 'dist/workers.js'], {
    cwd: PLATFORM_API_DIR,
    env,
    logDir: context.logDir,
  });

  const handle: PlatformHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    databaseUrl: input.databaseUrl,
    redisUrl: input.redisUrl,
    api,
    workers,
    stop: async () => {
      if (handle.api) await handle.api.stop();
      if (workers) await workers.stop();
    },
    restartApi: async () => {
      if (handle.api) await handle.api.stop();
      handle.api = spawnManaged('platform-api', process.execPath, ['--max-old-space-size=3072', 'dist/server.js'], {
        cwd: PLATFORM_API_DIR,
        env,
        logDir: context.logDir,
      });
      await waitForHttp(`${handle.baseUrl}/health`, {
        timeoutMs: 90_000,
        accept: (response) => response.ok,
        logPath: handle.api.logPath,
      });
    },
  };

  try {
    await waitForHttp(`${handle.baseUrl}/health`, {
      timeoutMs: 90_000,
      accept: (response) => response.ok,
      logPath: api.logPath,
    });
  } catch (error) {
    await handle.stop();
    throw error;
  }
  context.log(`platform API ready at ${handle.baseUrl}`);
  return handle;
}

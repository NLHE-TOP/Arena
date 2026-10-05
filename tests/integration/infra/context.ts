/**
 * Shared test-run context: paths, isolated artifact directories, logging and a
 * PASS/FAIL/PENDING/SKIP report. Infrastructure only — no product behavior.
 *
 * Everything a run writes lives under tests/artifacts/integration/<runId>/
 * (already git-ignored), so disposable PostgreSQL/Redis/SQLite state and process
 * logs never leak into the repository.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const INTEGRATION_DIR = join(ROOT, 'tests', 'integration');

export interface RunContext {
  runId: string;
  artifactDir: string;
  logDir: string;
  /** Keep disposable containers/processes alive for inspection. */
  keep: boolean;
  /** Build policy for NLHE artifacts only. */
  build: 'auto' | 'force' | 'never';
  /** Operator-started disposable released PokerTools test deployment. */
  external: {
    platformUrl?: string;
    databaseUrl?: string;
    redisUrl?: string;
    postgresContainer?: string;
  };
  log: (message: string) => void;
  logFile: string;
}

export function createRunContext(options: Partial<Pick<RunContext, 'keep' | 'build'>> = {}): RunContext {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const artifactDir = join(ROOT, 'tests', 'artifacts', 'integration', runId);
  const logDir = join(artifactDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'run.log');

  const context: RunContext = {
    runId,
    artifactDir,
    logDir,
    keep: options.keep ?? process.env.NLHE_IT_KEEP === '1',
    build: options.build ?? (process.env.NLHE_IT_BUILD as RunContext['build']) ?? 'auto',
    external: {
      platformUrl: process.env.NLHE_IT_PLATFORM_URL,
      databaseUrl: process.env.NLHE_IT_DATABASE_URL,
      redisUrl: process.env.NLHE_IT_REDIS_URL,
      postgresContainer: process.env.NLHE_IT_POSTGRES_CONTAINER,
    },
    logFile,
    log: (message: string) => {
      const line = `[${new Date().toISOString()}] ${message}`;
      // eslint-disable-next-line no-console
      console.log(line);
      appendFileSync(logFile, `${line}\n`);
    },
  };
  return context;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'PENDING' | 'SKIP';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  durationMs: number;
  error?: unknown;
}

export class Report {
  readonly results: CheckResult[] = [];

  async check(
    name: string,
    fn: () => Promise<void> | void,
    options: { pending?: string; skip?: string } = {}
  ): Promise<CheckResult> {
    const startedAt = Date.now();
    if (options.pending !== undefined) {
      const result: CheckResult = { name, status: 'PENDING', detail: options.pending, durationMs: 0 };
      this.results.push(result);
      return result;
    }
    if (options.skip !== undefined) {
      const result: CheckResult = { name, status: 'SKIP', detail: options.skip, durationMs: 0 };
      this.results.push(result);
      return result;
    }
    try {
      await fn();
      const result: CheckResult = { name, status: 'PASS', durationMs: Date.now() - startedAt };
      this.results.push(result);
      return result;
    } catch (error) {
      const result: CheckResult = {
        name,
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        error,
      };
      this.results.push(result);
      return result;
    }
  }

  pending(name: string, detail: string): CheckResult {
    const result: CheckResult = { name, status: 'PENDING', detail, durationMs: 0 };
    this.results.push(result);
    return result;
  }

  skip(name: string, detail: string): CheckResult {
    const result: CheckResult = { name, status: 'SKIP', detail, durationMs: 0 };
    this.results.push(result);
    return result;
  }

  failures(): CheckResult[] {
    return this.results.filter((result) => result.status === 'FAIL');
  }

  pendingResults(): CheckResult[] {
    return this.results.filter((result) => result.status === 'PENDING');
  }

  print(log: (message: string) => void = console.log): void {
    for (const result of this.results) {
      const suffix = result.detail ? ` — ${result.detail}` : '';
      const timing = result.status === 'PASS' || result.status === 'FAIL' ? ` (${result.durationMs}ms)` : '';
      log(`${result.status.padEnd(7)} ${result.name}${timing}${suffix}`);
    }
    const counts = this.results.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.status] = (accumulator[result.status] ?? 0) + 1;
      return accumulator;
    }, {});
    log(
      `SUMMARY ${Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(' ')} (${this.results.length} checks)`
    );
  }
}

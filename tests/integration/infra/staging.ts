/**
 * Fresh disposable staging topology for the deterministic container gate.
 *
 * The tracked harness owns only generic infrastructure and supervision:
 * - a mode-0700 runtime directory under the approved temp root (never inside
 *   `tests/artifacts/**`), holding transient mode-0600 env files and the
 *   generated-secret manifest for the final scanner;
 * - a fresh Docker network with fresh PostgreSQL and Redis containers whose
 *   unit identities are supervised like every other unit (Redis supports a
 *   planned pause/resume for the outage scenario);
 * - an external staging fixture (absolute module path, pinned platform image)
 *   that owns the PokerTools-specific operational wiring: API, workers,
 *   custody, Anvil and the two quorum processes. Its unit descriptors are
 *   adopted into the same supervisor, so Anvil/quorum/worker/custody are each
 *   independently supervised with pid/container identity and unexpected death
 *   fails the gate.
 *
 * Initialization is cleanup-capable from the first resource: a failure at any
 * step stops every unit created so far, removes the network/volume, deletes the
 * runtime directory and the generated-secret manifest, and rethrows.
 *
 * Reuse rules respected here: the RUNNING live scenario is never touched (new
 * network, new containers, new ports, new database); no platform source or
 * operator SQL is embedded in tracked code; no paid provider is used.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AdminDatabaseTarget } from './admin.js';
import type { RunContext } from './context.js';
import { RELEASED_PLATFORM_IMAGE } from './provenance.js';
import { freePort, runCommand, runCommandOrThrow } from './proc.js';
import { generateSyntheticSecret, SecretRegistry } from './secret-registry.js';
import {
  startContainerUnit,
  Supervisor,
  type ReleasedProcessUnit,
  type UnitDescriptor,
  type UnitKind,
} from './supervisor.js';

/**
 * Pinned immutable PokerTools 2.0.4 production image. The default is the ONE
 * central released artifact (`RELEASED_PLATFORM_IMAGE`); a paid wrapper rejects
 * every other reference. The environment override exists only for gated
 * development/readiness runs, never for paid acceptance.
 */
export const DEFAULT_PLATFORM_IMAGE = process.env.NLHE_IT_PLATFORM_IMAGE ?? RELEASED_PLATFORM_IMAGE;

export const DEFAULT_PRODUCT_IMAGE = process.env.NLHE_IT_PRODUCT_IMAGE ?? 'nlhe-product:container-gate';

export interface StagingPlatformUnitDescriptor {
  name: string;
  kind: UnitKind;
  identity(): Promise<Record<string, string | number | undefined>>;
  alive(): Promise<boolean>;
  evidence?(): Promise<string>;
  stop?(): Promise<void>;
  start?(): Promise<void>;
}

/**
 * External fixture finance surface. The required call/cost operations are
 * unchanged; the optional public operator metadata/methods below let the
 * tracked live CHALLENGE adapter expose the fixture's actual topology without
 * importing platform source. All values are public (asset/token/treasury/
 * sponsor identities and container names); no credential is read through it.
 */
export interface StagingPlatformFinance {
  bootstrapSponsorBudget(amountAtomic: string): Promise<{ available: string; operator: string }>;
  fundAndClaim?(session: unknown, accountIndex: number, amountAtomic: string): Promise<{ txHash: string; logIndex: number }>;
  /** Public asset identity registered in the fresh platform database. */
  assetId?: string;
  /** Public valueless token identity (lowercase address + decimals). */
  tokenAddress?: string;
  tokenDecimals?: number;
  /** Public sponsor identity seeded for the caller's sponsor principal. */
  sponsorPrincipalId?: string;
  sponsorAddress?: string;
  /** Public treasury address that receives real on-chain transfers. */
  treasuryAddress?: string;
  /** Public API container name for supervised maintenance restarts only. */
  apiContainerName?: string;
  /** Read-only operator balances (canonical atomic strings). */
  readPrincipalAccounts?(principalId: string): Promise<{ available: string; operator: string }>;
  /**
   * Existing custody-start contract. On the default topology the worker is
   * already live and this only verifies liveness; on the acceptance-only
   * deferred CHALLENGE bootstrap it creates the planned worker exactly once.
   * It never stops/restarts a running worker and never fabricates READY.
   */
  startCustody?(): Promise<void>;
  /** Poll the platform's actual `/ready` (never a fabricated attestation). */
  waitForReady?(timeoutMs?: number): Promise<void>;
  /**
   * Maintenance restart of ONLY the platform API container (deposit-verifier
   * cache isolation). The tracked caller wraps this in a supervisor
   * maintenance window; Anvil/quorum/workers/custody are never restarted.
   */
  restartApi?(): Promise<void>;
}

export interface StagingPlatformHandle {
  units: StagingPlatformUnitDescriptor[];
  /** Which existing-heartbeat/process evidence the fixture produces. */
  expectations?: { custodyHeartbeat?: boolean; workers?: boolean };
  /** Optional strongest readiness (for example financial READY) polling. */
  waitForReady?: (timeoutMs?: number) => Promise<void>;
  /** Optional declared sponsor-budget classification (no value creation). */
  finance?: StagingPlatformFinance;
  /**
   * Unit name of the custody worker the fixture deliberately did NOT start
   * (deferred CHALLENGE bootstrap only). The tracked topology holds it in
   * supervisor maintenance until `finance.startCustody()` creates it.
   */
  deferredCustodyUnit?: string;
  stop(): Promise<void>;
}

export interface StagingPlatformInput {
  context: RunContext;
  /** Mode-0700 runtime directory outside captured artifacts. */
  dir: string;
  network: string;
  platformUrl: string;
  productOrigin: string;
  platformImage: string;
  databaseUrl: string;
  internalDatabaseUrl: string;
  redisUrl: string;
  internalRedisUrl: string;
  postgresContainer: string;
  redisContainer: string;
  secrets: { jwtSecret: string; cookieSecret: string; metricsToken: string };
  sponsor: { principalId: string; address: string };
  /**
   * Acceptance-only: plan the custody worker but do not start it. The fixture
   * must return `deferredCustodyUnit` and start the worker only when
   * `finance.startCustody()` is called. False/default keeps custody live from
   * topology startup exactly as before.
   */
  deferCustodyStartup: boolean;
  /** Platform-authority secret (redacted/manifested, forbidden in NLHE). */
  registerSecret(label: string, value: string): void;
}

export interface StagingFixtureModule {
  startStagingPlatform(input: StagingPlatformInput): Promise<StagingPlatformHandle>;
}

/**
 * Resolve the planned-but-not-started custody unit requested by the
 * acceptance-only deferred bootstrap. Default/false never defers; `true`
 * fails closed unless the external fixture declares the planned unit, so a
 * fixture that always starts custody can never be silently treated as
 * deferred.
 */
export function resolveDeferredCustodyUnit(
  deferCustodyStartup: boolean,
  handle: Pick<StagingPlatformHandle, 'deferredCustodyUnit'>
): string | null {
  if (!deferCustodyStartup) return null;
  const unit = handle.deferredCustodyUnit;
  if (typeof unit !== 'string' || unit.length === 0) {
    throw new Error(
      'deferred custody bootstrap requested but the external staging fixture did not declare the planned custody unit (deferredCustodyUnit)'
    );
  }
  return unit;
}

export async function loadStagingFixture(path?: string): Promise<StagingFixtureModule> {
  const fixture = path ?? process.env.NLHE_IT_STAGING_FIXTURE;
  if (!fixture || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
    throw new Error(
      'the deterministic container gate requires NLHE_IT_STAGING_FIXTURE: an absolute path to a built external staging fixture module exporting startStagingPlatform. No mock or embedded platform fallback exists.'
    );
  }
  const module = (await import(pathToFileURL(fixture).href)) as Partial<StagingFixtureModule>;
  if (typeof module.startStagingPlatform !== 'function') {
    throw new Error('external staging fixture must export startStagingPlatform(input)');
  }
  return module as StagingFixtureModule;
}

export interface StagingTopologyOptions {
  context: RunContext;
  sponsor: { principalId: string; address: string };
  platformImage?: string;
  productImage?: string;
  fixturePath?: string;
  /** Dedicated runtime dir; defaults to <tmp>/opencode/nlhe-container-gate/<runId>. */
  runtimeDir?: string;
  /**
   * Acceptance-only deferred custody bootstrap for the paid CHALLENGE run.
   * Default/false: the deterministic/SPONSORED topology always starts custody
   * with the topology and requires actual heartbeat + READY before startup
   * returns. Only the live CHALLENGE wrapper may set this, and only with a
   * fixture that declares the planned custody unit.
   */
  deferCustodyStartup?: boolean;
}

export interface StagingTopology {
  supervisor: Supervisor;
  context: RunContext;
  runtimeDir: string;
  secretManifestPath: string;
  network: string;
  platformImage: string;
  productImage: string;
  platformUrl: string;
  productUrl: string;
  /** Actual platform metrics surface + bearer token (429 counters etc.). */
  platformMetrics: { url: string; token: string };
  databaseUrl: string;
  internalDatabaseUrl: string;
  redisUrl: string;
  internalRedisUrl: string;
  postgresContainer: string;
  redisContainer: string;
  adminTarget: AdminDatabaseTarget;
  platform: StagingPlatformHandle;
  /**
   * Planned custody unit held in supervisor maintenance during a deferred
   * bootstrap; null on the default always-live topology.
   */
  deferredCustodyUnit: string | null;
  /** Generated-secret registry (redaction + final scanner manifest). */
  secretRegistry: SecretRegistry;
  /** Register a platform-authority credential (redacted + child-forbidden). */
  addGeneratedSecret(label: string, value: string): void;
  /** Register a product-authorized credential (redacted; child-allowed). */
  addProductSecret(label: string, value: string): void;
  assertHealthy(stage: string, options?: { requireCustodyHeartbeat?: boolean }): Promise<void>;
  /**
   * Retained-diagnostics finalization: explicitly release supervised LOCAL
   * PROCESS units (fixture children such as Anvil/quorum TCP proxies) so the
   * orchestrator exits naturally, while every container unit, volume, runtime
   * dir, secret manifest and the private product SQLite stays intact for
   * operator classification. Never throws; bounded per-unit results.
   */
  releaseRetainedProcesses(): Promise<ReleasedProcessUnit[]>;
  stop(): Promise<string[]>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForCondition(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 90_000,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label} (${timeoutMs}ms): ${last}`);
}

async function firstFailingCheck(platformUrl: string): Promise<string> {
  try {
    const response = await fetch(`${platformUrl}/ready`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) return 'ready';
    const body = (await response.json().catch(() => ({}))) as {
      checks?: Array<{ name?: string; detail?: string; state?: string }>;
    };
    const failing = (body.checks ?? []).filter((check) => check.state !== 'READY');
    return failing.length > 0
      ? failing.map((check) => `${check.name}:${check.state}:${check.detail}`).join(',')
      : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Recursively snapshot `*.log` files under a runtime directory into one
 * redacted artifact file. Only `.log` files are read: never `.env` files,
 * secret manifests or JSON metadata. Exported for focused regression testing.
 */
export function snapshotRuntimeLogs(
  runtimeDir: string,
  destination: string,
  redact: (text: string) => string
): { files: number } {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.log')) files.push(path);
    }
  };
  walk(runtimeDir);
  let content = '';
  for (const file of files.sort()) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '# unreadable runtime log\n';
    }
    content += `===== runtime ${relative(runtimeDir, file)} =====\n${redact(text)}\n`;
  }
  if (files.length === 0) content = '# no runtime .log files\n';
  writeFileSync(destination, content, { mode: 0o600 });
  return { files: files.length };
}

export async function startStagingTopology(options: StagingTopologyOptions): Promise<StagingTopology> {
  const { context } = options;
  const deferCustodyStartup = options.deferCustodyStartup === true;
  const logDir = context.logDir;
  const platformImage = options.platformImage ?? DEFAULT_PLATFORM_IMAGE;
  const productImage = options.productImage ?? DEFAULT_PRODUCT_IMAGE;
  const runtimeDir =
    options.runtimeDir ?? join(tmpdir(), 'opencode', 'nlhe-container-gate', context.runId);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const registry = new SecretRegistry();
  const jwtSecret = generateSyntheticSecret('platform-jwt');
  const cookieSecret = generateSyntheticSecret('platform-cookie');
  const metricsToken = generateSyntheticSecret('platform-metrics');
  const postgresPassword = generateSyntheticSecret('postgres-password');
  registry.addAll('platform', { JWT_SECRET: jwtSecret, COOKIE_SECRET: cookieSecret, METRICS_TOKEN: metricsToken });
  registry.addPlatformSecret('POSTGRES_PASSWORD', postgresPassword);
  const secretManifestPath = registry.persistEnvManifest(join(runtimeDir, 'runtime-secrets.env'));

  const supervisor = new Supervisor({
    log: (message) => context.log(message),
    redact: (text) => registry.redact(text),
  });

  const short = context.runId.replace(/[^a-z0-9]/gi, '').slice(-10);
  const network = `nlhe-stage-${short}`;
  const postgresContainer = `nlhe-stage-pg-${short}`;
  const redisContainer = `nlhe-stage-redis-${short}`;
  const pgVolume = `nlhe-stage-pg-data-${short}`;

  const pgImage = process.env.NLHE_IT_PG_IMAGE ?? 'postgres:18-alpine';
  const redisImage = process.env.NLHE_IT_REDIS_IMAGE ?? 'redis:8-alpine';
  const pgPort = await freePort();
  const redisPort = await freePort();
  const apiPort = await freePort();
  const productPort = await freePort();

  const databaseUrl = `postgresql://postgres:${postgresPassword}@127.0.0.1:${pgPort}/postgres`;
  const internalDatabaseUrl = `postgresql://postgres:${postgresPassword}@${postgresContainer}:5432/postgres`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const internalRedisUrl = `redis://${redisContainer}:6379`;
  const platformUrl = `http://127.0.0.1:${apiPort}`;
  const platformMetricsUrl = `${platformUrl}/metrics`;
  const productUrl = `http://127.0.0.1:${productPort}`;

  let platform: StagingPlatformHandle | null = null;
  let pgStarted = false;
  let redisStarted = false;

  try {
    context.log(`staging runtime dir (outside artifacts): ${runtimeDir}`);
    context.log(`fresh staging network ${network}; pinned platform image ${platformImage}`);

    await runCommandOrThrow('docker', ['network', 'create', network], { timeoutMs: 60_000 });
    supervisor.addCleanup('docker network', async () => {
      await runCommand('docker', ['network', 'rm', network], { timeoutMs: 60_000 });
    });
    await runCommandOrThrow('docker', ['volume', 'create', pgVolume], { timeoutMs: 60_000 });
    supervisor.addCleanup('postgres volume', async () => {
      await runCommand('docker', ['volume', 'rm', '-f', pgVolume], { timeoutMs: 60_000 });
    });

    const postgresEnvPath = join(runtimeDir, 'postgres.env');
    writeFileSync(postgresEnvPath, `POSTGRES_PASSWORD=${postgresPassword}\n`, { mode: 0o600 });
    const postgres = await startContainerUnit({
      name: postgresContainer,
      imageRef: pgImage,
      runArgs: [
        '--network',
        network,
        '-p',
        `127.0.0.1:${pgPort}:5432`,
        '-v',
        `${pgVolume}:/var/lib/postgresql`,
        '--env-file',
        postgresEnvPath,
        pgImage,
      ],
      transientFiles: [postgresEnvPath],
    });
    pgStarted = true;
    supervisor.add(postgres);

    const redis = await startContainerUnit({
      name: redisContainer,
      imageRef: redisImage,
      runArgs: ['--network', network, '-p', `127.0.0.1:${redisPort}:6379`, redisImage],
    });
    redisStarted = true;
    // Redis must be pausable for the explicit outage/recovery scenario; a
    // missing pausable registration would make `supervisor.pause` throw.
    supervisor.add(redis, { pausable: redis });

    await waitForCondition(
      'postgres accepting connections',
      async () => {
        const result = await runCommand(
          'docker',
          ['exec', postgresContainer, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
          { timeoutMs: 10_000 }
        );
        return result.code === 0 && result.stdout.includes('accepting connections');
      },
      120_000
    );
    await waitForCondition(
      'redis PONG',
      async () => {
        const result = await runCommand('docker', ['exec', redisContainer, 'redis-cli', 'ping'], {
          timeoutMs: 10_000,
        });
        return result.code === 0 && result.stdout.includes('PONG');
      },
      60_000
    );

    const fixture = await loadStagingFixture(options.fixturePath);
    platform = await fixture.startStagingPlatform({
      context,
      dir: runtimeDir,
      network,
      platformUrl,
      productOrigin: productUrl,
      platformImage,
      databaseUrl,
      internalDatabaseUrl,
      redisUrl,
      internalRedisUrl,
      postgresContainer,
      redisContainer,
      secrets: { jwtSecret, cookieSecret, metricsToken },
      sponsor: options.sponsor,
      deferCustodyStartup,
      registerSecret: (label, value) => registry.addPlatformSecret(label, value),
    });

    for (const unit of platform.units) {
      supervisor.add(unit as UnitDescriptor);
    }
    for (const line of await supervisor.captureIdentities()) {
      context.log(`supervised ${line}`);
    }
    const deferredCustodyUnit = resolveDeferredCustodyUnit(deferCustodyStartup, platform);
    if (deferredCustodyUnit !== null) {
      // Planned-not-started custody: keep the unit out of death detection until
      // finance.startCustody() actually creates the worker, then the caller
      // releases the maintenance window and requires actual heartbeat + READY.
      supervisor.beginMaintenance(deferredCustodyUnit);
      context.log(
        `deferred custody bootstrap: ${deferredCustodyUnit} planned, not started (supervisor maintenance until startCustody)`
      );
    }
    if (!deferCustodyStartup && platform.waitForReady) await platform.waitForReady(180_000);
    supervisor.startMonitoring();

    const topology: StagingTopology = {
      supervisor,
      context,
      runtimeDir,
      secretManifestPath,
      network,
      platformImage,
      productImage,
      platformUrl,
      productUrl,
      platformMetrics: { url: `${platformUrl}/metrics`, token: metricsToken },
      databaseUrl,
      internalDatabaseUrl,
      redisUrl,
      internalRedisUrl,
      postgresContainer,
      redisContainer,
      adminTarget: { kind: 'container', container: postgresContainer },
      platform,
      deferredCustodyUnit,
      secretRegistry: registry,
      addGeneratedSecret(label, value) {
        registry.addPlatformSecret(label, value);
      },
      addProductSecret(label, value) {
        registry.addProductSecret(label, value);
      },
      async assertHealthy(stage, healthOptions = {}) {
        await supervisor.assertAllAlive(stage);
        const health = await fetch(`${platformUrl}/health`, { signal: AbortSignal.timeout(10_000) });
        if (!health.ok) throw new Error(`platform /health HTTP ${health.status} during ${stage}`);
        const ready = await fetch(`${platformUrl}/ready`, { signal: AbortSignal.timeout(15_000) });
        if (!ready.ok) {
          throw new Error(
            `platform /ready HTTP ${ready.status} during ${stage}: ${await firstFailingCheck(platformUrl)}`
          );
        }
        if (healthOptions.requireCustodyHeartbeat ?? platform?.expectations?.custodyHeartbeat ?? false) {
          await waitForCondition(
            'custody heartbeat evidence',
            async () => {
              const result = await runCommand(
                'docker',
                [
                  'exec',
                  postgresContainer,
                  'psql',
                  '-U',
                  'postgres',
                  '-d',
                  'postgres',
                  '-tAc',
                  `SELECT count(*) FROM "CustodyHeartbeat" WHERE "observedAt" > NOW() - INTERVAL '5 minutes'`,
                ],
                { timeoutMs: 15_000 }
              );
              return result.code === 0 && Number(result.stdout.trim()) > 0;
            },
            120_000
          );
        }
      },
      async releaseRetainedProcesses() {
        // Retained-finalization ownership: dispose ONLY the local supervised
        // process fixtures (their piped stdio can pin this orchestrator's event
        // loop forever once `stop()` is deliberately skipped). Containers,
        // volumes, the runtime dir, the secret manifest and the private product
        // SQLite are never touched here.
        const released = await supervisor.releaseProcessUnits();
        for (const unit of released) {
          context.log(
            `retained process release: ${unit.name} pid=${unit.pid ?? 'none'} released=${String(
              unit.released
            )}${unit.reason ? ` (${unit.reason})` : ''}`
          );
        }
        return released;
      },
      async stop() {
        const errors: string[] = [];
        // Stop liveness monitoring before the fixture removes its containers:
        // an intentional teardown must never be recorded as an unexpected death.
        supervisor.stopMonitoring();

        const containerNames = [
          ...(platform?.units ?? [])
            .filter((unit) => unit.kind === 'container')
            .map((unit) => unit.name),
          postgresContainer,
          redisContainer,
        ];

        const captureChildLogs = async (phase: 'pre-stop' | 'post-stop'): Promise<void> => {
          // Full docker logs (never --tail), redacted, one artifact file per
          // phase so teardown-flushed output is preserved for the final scan.
          const containerDestination = join(logDir, `topology-child-logs-${phase}.log`);
          try {
            let content = '';
            for (const container of containerNames) {
              const result = await runCommand('docker', ['logs', container], { timeoutMs: 120_000 });
              const text = `${result.stdout}${result.stderr}`;
              content += `===== ${container} =====\n${
                result.code === 0 && text.trim().length > 0
                  ? registry.redact(text)
                  : `# logs unavailable (docker exit ${result.code})\n`
              }\n`;
            }
            writeFileSync(containerDestination, content, { mode: 0o600 });
          } catch (error) {
            writeFileSync(
              containerDestination,
              `# container log capture failed: ${registry.redact(errorText(error))}\n`,
              { mode: 0o600 }
            );
          }
          try {
            snapshotRuntimeLogs(runtimeDir, join(logDir, `runtime-child-logs-${phase}.log`), (text) =>
              registry.redact(text)
            );
          } catch (error) {
            context.log(`runtime log capture (${phase}) failed: ${registry.redact(errorText(error))}`);
          }
        };

        const captureMetricsEvidence = async (): Promise<void> => {
          // Captured BEFORE the API is stopped so route-specific 429 evidence
          // survives even a later scan failure. Never prints the bearer token.
          const destination = join(context.artifactDir, 'platform-metrics-final.txt');
          try {
            const response = await fetch(platformMetricsUrl, {
              headers: { authorization: `Bearer ${metricsToken}` },
              signal: AbortSignal.timeout(15_000),
            });
            const text = await response.text();
            if (!response.ok) {
              writeFileSync(
                destination,
                `# platform metrics unavailable: HTTP ${response.status}\n${registry.redact(text).slice(0, 4_000)}\n`,
                { mode: 0o600 }
              );
              context.log(`platform metrics evidence unavailable: HTTP ${response.status} (safe diagnostic written)`);
              return;
            }
            writeFileSync(destination, registry.redact(text), { mode: 0o600 });
            context.log(`platform metrics captured before API stop (${text.length} bytes)`);
          } catch (error) {
            writeFileSync(
              destination,
              `# platform metrics capture failed: ${registry.redact(errorText(error))}\n`,
              { mode: 0o600 }
            );
            context.log(`platform metrics evidence failed safely: ${registry.redact(errorText(error))}`);
          }
        };

        // Phase 1 (pre-stop): metrics + complete container/runtime logs while
        // every child still exists.
        await captureMetricsEvidence();
        await captureChildLogs('pre-stop');
        try {
          await platform?.stop();
        } catch (error) {
          // Fixture stop failures must never mask or veto the rest of cleanup.
          errors.push(`fixture stop: ${errorText(error)}`);
        }
        // Phase 2 (post-stop): node/Anvil/command outputs may flush during
        // fixture stop; capture again while the runtime dir still exists.
        await captureChildLogs('post-stop');
        errors.push(...(await supervisor.dispose()));
        if (process.env.NLHE_IT_KEEP_RUNTIME === '1') {
          context.log(`runtime dir retained for scanner: ${runtimeDir}`);
        } else {
          rmSync(runtimeDir, { recursive: true, force: true });
        }
        return errors;
      },
    };

    if (deferCustodyStartup) {
      // Bootstrap contract: the API must already be live (the fixture waits
      // for /health and migrations), while platform readiness is expected
      // non-READY because the custody worker is planned but not started.
      const health = await fetch(`${platformUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      if (!health.ok) {
        throw new Error(`deferred custody bootstrap: platform /health HTTP ${health.status}`);
      }
      const ready = await fetch(`${platformUrl}/ready`, { signal: AbortSignal.timeout(15_000) });
      if (ready.ok) {
        throw new Error(
          'deferred custody bootstrap: platform reports READY before the custody worker started; refusing to continue without actual custody'
        );
      }
      context.log(
        `deferred custody bootstrap healthy: API /health 200, /ready ${ready.status} (${await firstFailingCheck(platformUrl)}); actual READY is required after startCustody`
      );
    } else {
      await topology.assertHealthy('topology startup', { requireCustodyHeartbeat: true });
      context.log('fresh staging topology healthy: API /health + /ready 200, custody heartbeat observed');
    }
    return topology;
  } catch (error) {
    // Initialization failed at some resource: stop everything created so far,
    // including a partially started fixture, then delete the runtime manifest.
    if (platform) {
      try {
        await platform.stop();
      } catch (stopError) {
        context.log(`staging init cleanup: fixture stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
      }
    }
    const cleanupErrors = await supervisor.dispose();
    for (const cleanupError of cleanupErrors) context.log(`staging init cleanup: ${cleanupError}`);
    if (!pgStarted || !redisStarted) {
      context.log('staging init cleanup: partial container startup handled by supervisor dispose');
    }
    SecretRegistry.remove(secretManifestPath);
    rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

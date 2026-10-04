/**
 * One real, isolated local acceptance topology:
 *
 *   disposable PostgreSQL + Redis
 *     -> actual built platform API + workers (public SDK contract)
 *       -> actual built NLHE product process (started separately by scenarios)
 *
 * `startEnvironment` provisions the platform half and a loopback OpenAI-compatible
 * provider. NLHE is started/restarted by the scenario via `startNlhe`, so the
 * platform stays up across NLHE process restarts.
 */
import { join } from 'node:path';
import type { RunContext } from './context.js';
import { startPostgres, startRedis, isDockerAvailable, type PostgresHandle, type RedisHandle } from './docker.js';
import {
  ensurePlatformBuilds,
  ensurePostgresPrismaClient,
  migratePlatform,
  seedPlatform,
  startPlatform,
  acquirePrismaLock,
  type PlatformHandle,
} from './platform.js';
import { startFakeProvider, type FakeProviderHandle } from './fake-provider.js';
import { startFinancialTopology, type FinancialTopology } from './anvil-finance.js';
import type { AdminDatabaseTarget } from './admin.js';
import { freePort } from './proc.js';

export interface TestEnvironment {
  context: RunContext;
  platform: PlatformHandle;
  fakeProvider: FakeProviderHandle;
  postgres: PostgresHandle | null;
  redis: RedisHandle | null;
  adminTarget: AdminDatabaseTarget;
  reusedExternalPlatform: boolean;
  /** Real valueless financial topology (Anvil + asset + custody worker). */
  financial: FinancialTopology | null;
  stop: () => Promise<void>;
}

export interface EnvironmentOptions {
  /** Reuse NLHE_IT_PLATFORM_URL/DATABASE_URL instead of provisioning. */
  allowExternal?: boolean;
  autoDealDelayMs?: number;
  /**
   * Provision the real valueless financial topology and enable paid ASSET
   * admission. The sponsor identity is seeded as a declared fixture before
   * boot so the platform allowlist can reference it.
   */
  financial?: { sponsorPrincipalId: string; sponsorAddress: string } | null;
}

export async function startEnvironment(
  context: RunContext,
  options: EnvironmentOptions = {}
): Promise<TestEnvironment> {
  const external = context.external;
  const useExternal =
    options.allowExternal === true && Boolean(external.platformUrl) && Boolean(external.databaseUrl);

  let postgres: PostgresHandle | null = null;
  let redis: RedisHandle | null = null;
  let platform: PlatformHandle | null = null;
  let fakeProvider: FakeProviderHandle | null = null;
  let financial: FinancialTopology | null = null;

  try {
    if (options.financial && useExternal) {
      throw new Error('the real financial topology requires locally provisioned PostgreSQL');
    }
    await ensurePlatformBuilds(context);

    let databaseUrl: string;
    let redisUrl: string;
    let adminTarget: AdminDatabaseTarget;

    if (useExternal) {
      databaseUrl = external.databaseUrl!;
      redisUrl = external.redisUrl ?? 'redis://127.0.0.1:6379';
      adminTarget = external.postgresContainer
        ? { kind: 'container', container: external.postgresContainer }
        : { kind: 'url', databaseUrl };
      context.log(`reusing external platform at ${external.platformUrl}`);
      const releasePrismaLock = await acquirePrismaLock(context);
      try {
        await ensurePostgresPrismaClient(context, databaseUrl);
      } finally {
        releasePrismaLock();
      }
      platform = {
        baseUrl: external.platformUrl!,
        port: Number(new URL(external.platformUrl!).port),
        databaseUrl,
        redisUrl,
        stop: async () => undefined,
      };
    } else {
      const dockerAvailable = await isDockerAvailable();
      if (!dockerAvailable && !external.databaseUrl) {
        throw new Error(
          'Docker is required to provision disposable PostgreSQL; alternatively set NLHE_IT_PLATFORM_URL + NLHE_IT_DATABASE_URL + NLHE_IT_REDIS_URL'
        );
      }
      context.log(`provisioning disposable PostgreSQL (${process.env.NLHE_IT_PG_IMAGE ?? 'postgres:18-alpine'})...`);
      postgres = await startPostgres(context.runId, context.artifactDir);
      context.log(`disposable PostgreSQL on 127.0.0.1:${postgres.port}`);
      context.log(`provisioning disposable Redis...`);
      redis = await startRedis(context.runId, context.artifactDir, dockerAvailable);
      context.log(`disposable Redis on 127.0.0.1:${redis.port} (${redis.kind})`);

      databaseUrl = postgres.url;
      redisUrl = redis.url;
      adminTarget = { kind: 'container', container: postgres.container };

      // Hold the shared Prisma generation lock across generate -> migrate ->
      // seed -> API/workers start so an independent PokerTools tester cannot
      // flip the shared generated client mid-boot.
      const releasePrismaLock = await acquirePrismaLock(context);
      try {
        await ensurePostgresPrismaClient(context, databaseUrl);
        await migratePlatform(context, databaseUrl);
        await seedPlatform(context, databaseUrl);
        const port = await freePort();
        if (options.financial) {
          // Workers capture the Asset RPC registry at bootstrap. Seed the real
          // token and live quorum endpoints before starting API/workers; custody
          // remains deferred until the public deposit/bootstrap flow completes.
          financial = await startFinancialTopology({
            context,
            databaseUrl,
            postgresContainer: postgres.container,
            platformBaseUrl: `http://127.0.0.1:${port}`,
            sponsor: {
              principalId: options.financial.sponsorPrincipalId,
              address: options.financial.sponsorAddress,
            },
          });
        }
        platform = await startPlatform(context, {
          port,
          databaseUrl,
          redisUrl,
          autoDealDelayMs: options.autoDealDelayMs,
          ...(options.financial
            ? { paid: { sponsorPrincipalIds: [options.financial.sponsorPrincipalId] } }
            : {}),
        });
      } finally {
        releasePrismaLock();
      }
    }

    fakeProvider = await startFakeProvider();
    context.log(`loopback OpenAI-compatible provider at ${fakeProvider.baseUrl}`);

    const environment: TestEnvironment = {
      context,
      platform,
      fakeProvider,
      postgres,
      redis,
      adminTarget,
      reusedExternalPlatform: useExternal,
      financial,
      stop: async () => {
        await financial?.stop();
        await fakeProvider?.stop();
        if (!useExternal) await platform?.stop();
        if (!context.keep) {
          await redis?.stop();
          await postgres?.stop();
        } else {
          context.log('NLHE_IT_KEEP=1: leaving disposable containers running for inspection');
        }
      },
    };
    return environment;
  } catch (error) {
    await financial?.stop();
    await fakeProvider?.stop();
    if (!useExternal && platform) await platform.stop();
    if (!context.keep) {
      await redis?.stop();
      await postgres?.stop();
    }
    throw error;
  }
}

export function artifactsPath(context: RunContext, ...parts: string[]): string {
  return join(context.artifactDir, ...parts);
}

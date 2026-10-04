/** Real external PokerTools plus a deterministic loopback provider. */
import { join } from 'node:path';
import type { RunContext } from './context.js';
import type { PostgresHandle, RedisHandle } from './docker.js';
import type { PlatformHandle } from './platform.js';
import { startFakeProvider, type FakeProviderHandle } from './fake-provider.js';
import { startFinancialTopology, type FinancialTopology } from './anvil-finance.js';
import type { AdminDatabaseTarget } from './admin.js';
import { waitForHttp } from './proc.js';

export interface TestEnvironment {
  context: RunContext;
  platform: PlatformHandle;
  fakeProvider: FakeProviderHandle;
  postgres: PostgresHandle | null;
  redis: RedisHandle | null;
  adminTarget: AdminDatabaseTarget;
  reusedExternalPlatform: boolean;
  financial: FinancialTopology | null;
  stop: () => Promise<void>;
}

export interface EnvironmentOptions {
  /** Retained for existing callers; all platforms are now external. */
  allowExternal?: boolean;
  /** Configure this cadence on the external deployment. */
  autoDealDelayMs?: number;
  financial?: { sponsorPrincipalId: string; sponsorAddress: string } | null;
}

export async function startEnvironment(
  context: RunContext,
  options: EnvironmentOptions = {}
): Promise<TestEnvironment> {
  const external = context.external;
  if (!external.platformUrl || !external.databaseUrl || !external.redisUrl) {
    throw new Error('An externally started PokerTools 2.0.0 test deployment is required: set NLHE_IT_PLATFORM_URL, NLHE_IT_DATABASE_URL and NLHE_IT_REDIS_URL. Use a disposable database for operator bootstrap.');
  }
  const platform: PlatformHandle = {
    baseUrl: external.platformUrl,
    port: Number(new URL(external.platformUrl).port),
    databaseUrl: external.databaseUrl,
    redisUrl: external.redisUrl,
    stop: async () => undefined,
  };
  await waitForHttp(`${platform.baseUrl}/health`, { timeoutMs: 30_000, accept: response => response.ok });
  context.log(`using external PokerTools 2.0.0 at ${platform.baseUrl}`);
  let financial: FinancialTopology | null = null;
  let fakeProvider: FakeProviderHandle | null = null;
  try {
    if (options.financial) {
      financial = await startFinancialTopology({
        context,
        databaseUrl: platform.databaseUrl,
        postgresContainer: external.postgresContainer,
        platformBaseUrl: platform.baseUrl,
        sponsor: { principalId: options.financial.sponsorPrincipalId, address: options.financial.sponsorAddress },
      });
    }
    fakeProvider = await startFakeProvider();
    const provider = fakeProvider;
    return {
      context, platform, fakeProvider: provider, postgres: null, redis: null,
      adminTarget: external.postgresContainer
        ? { kind: 'container', container: external.postgresContainer }
        : { kind: 'url', databaseUrl: platform.databaseUrl },
      reusedExternalPlatform: true,
      financial,
      stop: async () => {
        await financial?.stop();
        await provider.stop();
        // The operator owns the external platform lifecycle.
      },
    };
  } catch (error) {
    await financial?.stop();
    await fakeProvider?.stop();
    throw error;
  }
}

export function artifactsPath(context: RunContext, ...parts: string[]): string {
  return join(context.artifactDir, ...parts);
}

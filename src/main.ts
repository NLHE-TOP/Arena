/**
 * Product server composition root.
 *
 * One Node.js process with its own SQLite product database. It composes:
 *
 * - startup configuration (`src/config.ts`, no secrets exposed);
 * - the durable `ProductStore` (rooms/participants/attempts/results only);
 * - the agent catalog (file-configured references, persisted agent ids);
 * - `ProductRooms`, whose platform operations travel through the public SDK
 *   adapter below (never platform source, persistence or ad-hoc HTTP);
 * - the same-origin product API (`/api/*`), liveness/readiness and the Vite
 *   `dist/web` static build.
 *
 * Platform gameplay and finance stay authoritative in PokerTools. This process
 * stores no seats, no poker state, no financial settlement and no credentials.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import type { Principal } from '@pokertools/types';

import { loadConfig, type Config } from './config.js';
import {
  createPlatformProbe,
  platformClient,
  platformCompetitions,
} from './platform.js';
import { sanitizeSecretText } from './security/sanitize.js';
import {
  AgentCatalog,
  normalizeAgentConfig,
  type AgentConfig,
} from './product/catalog.js';
import { ProductStore } from './product/store.js';
import {
  ProductRooms,
  challengeTermsVersion,
  type ChallengeTermsConfig,
} from './product/rooms.js';
import { registerProductApi } from './api/product.js';
import { assertPromptPolicy } from './llm/prompt-policy.js';
import { CREDENTIAL_EXPIRY_MARGIN_MS, SdkRoomRuntime } from './agents/rooms.js';

export interface BuildServerOptions {
  /** Parsed configuration; defaults to `loadConfig(process.env)`. */
  config?: Config;
  /** Product store; defaults to opening `config.DATABASE_PATH`. */
  store?: ProductStore;
  /** Agent catalog; defaults to the configured file plus durable store ids. */
  agents?: AgentCatalog;
  /** Pre-built orchestrator (tests); defaults to the SDK composition. */
  rooms?: ProductRooms;
  /** Override bearer introspection (tests); defaults to the public SDK. */
  getPrincipal?: (token: string) => Promise<Principal>;
  /** Override agent credential availability (tests). */
  agentAvailable?: (agentId: string) => boolean;
  /** Disable request logging (tests). */
  logger?: boolean;
  /** Static build root; `null` disables static serving. */
  staticRoot?: string | null;
}

/**
 * Format of the agent configuration file (`AGENTS_CONFIG_PATH`): a JSON array
 * of strict `AgentConfig` records. Secrets are environment-variable names.
 */
export function loadAgentConfigsFile(path: string | undefined): AgentConfig[] {
  if (path === undefined || path.length === 0 || !existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`agent configuration at ${path} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`agent configuration at ${path} must be a JSON array`);
  }
  return parsed.map((input) => {
    const config = normalizeAgentConfig(input);
    assertPromptPolicy(config.promptPolicyId, config.promptPolicyHash);
    return config;
  });
}

/**
 * Persist file-configured agent references (durable preprovisioning) and load
 * every durable agent configuration into the in-memory catalog. A missing file
 * leaves the durable set untouched, so a human-only product needs no agents.
 */
export function syncAgentCatalog(
  store: ProductStore,
  catalog: AgentCatalog,
  fileConfigs: readonly AgentConfig[],
): void {
  for (const config of fileConfigs) {
    store.upsertAgentConfig(config);
  }
  for (const stored of store.listAgentConfigs()) {
    catalog.register(stored);
  }
}

/** Paid CHALLENGE terms from configuration; null keeps paid rooms disabled. */
export function challengeFromConfig(config: Config): ChallengeTermsConfig | null {
  if (config.CHALLENGE_ENABLED !== '1') return null;
  if (
    config.CHALLENGE_ASSET_ID === undefined ||
    config.CHALLENGE_ENTRY_ATOMIC === undefined ||
    config.CHALLENGE_PRIZE_ATOMIC === undefined ||
    config.CHALLENGE_SPONSOR_PRINCIPAL_ID === undefined
  ) {
    return null;
  }
  return {
    assetId: config.CHALLENGE_ASSET_ID,
    entryAtomic: config.CHALLENGE_ENTRY_ATOMIC,
    prizeAtomic: config.CHALLENGE_PRIZE_ATOMIC,
    sponsorPrincipalId: config.CHALLENGE_SPONSOR_PRINCIPAL_ID,
  };
}

function agentAvailableFromEnvironment(agents: AgentCatalog): (agentId: string) => boolean {
  return (agentId: string): boolean => {
    let agent: AgentConfig;
    try {
      agent = agents.get(agentId);
    } catch {
      return false;
    }
    if (!agent.enabled) return false;
    const credential = process.env[agent.keyEnv];
    return typeof credential === 'string' && credential.length > 0;
  };
}

/**
 * Explicit exact secret values for log/error redaction: configured product
 * credentials plus every catalog provider environment value. The sanitizer
 * performs no implicit environment discovery.
 */
export function configuredSecrets(config: Config, agents: AgentCatalog): string[] {
  const secrets = new Set<string>();
  for (const candidate of [
    config.POKERTOOLS_ORCHESTRATION_TOKEN,
    config.PRODUCT_ADMIN_TOKEN,
  ]) {
    if (candidate !== undefined && candidate.length > 0) secrets.add(candidate);
  }
  for (const agent of agents.list()) {
    const value = process.env[agent.keyEnv];
    if (typeof value === 'string' && value.length > 0) secrets.add(value);
  }
  return [...secrets];
}

const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-product-admin-token"]',
  'res.headers["set-cookie"]',
];

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ownsStore = options.store === undefined;
  const store = options.store ?? ProductStore.open({ path: config.DATABASE_PATH });
  const agents = options.agents ?? new AgentCatalog();
  if (options.agents === undefined) {
    syncAgentCatalog(store, agents, loadAgentConfigsFile(config.AGENTS_CONFIG_PATH));
  }
  const knownSecrets = configuredSecrets(config, agents);

  const app = Fastify({
    ...(options.logger === false
      ? { logger: false }
      : {
          logger: {
            level: config.LOG_LEVEL,
            redact: [...LOG_REDACT_PATHS],
            serializers: {
              err: (error: Error) => ({
                type: sanitizeSecretText(error.name, { knownSecrets }),
                message: sanitizeSecretText(error.message, { knownSecrets }),
                stack: sanitizeSecretText(error.stack ?? '', { knownSecrets }),
              }),
            },
          },
        }),
    bodyLimit: 65536,
  });

  const platformUrl = config.POKERTOOLS_API_URL;
  const orchestrationToken = config.POKERTOOLS_ORCHESTRATION_TOKEN;
  const probe = createPlatformProbe(platformUrl, orchestrationToken);

  let runtime: SdkRoomRuntime | null = null;
  let rooms: ProductRooms;
  if (options.rooms !== undefined) {
    rooms = options.rooms;
  } else {
    const runtimeLog = (event: { event: string; detail?: string }): void => {
      app.log.info({ runtimeEvent: event.event, detail: event.detail ?? null }, 'agent runtime');
    };
    runtime = new SdkRoomRuntime({
      config,
      store,
      agents,
      platformUrl,
      knownSecrets,
      issueCredentials: (roomId: string) =>
        rooms
          .issueAgentCredentials(roomId, {
            chatEnabled: config.AGENT_CHAT_ENABLED === '1',
            expiresAt: new Date(
              Date.now() + config.OVERALL_RUNTIME_MS + CREDENTIAL_EXPIRY_MARGIN_MS,
            ).toISOString(),
          })
          .then((issued) =>
            issued.map((credential) => ({ agentId: credential.agentId, token: credential.token })),
          ),
      log: runtimeLog,
    });
    rooms = new ProductRooms({
      store,
      agents,
      competitions: platformCompetitions(platformUrl, orchestrationToken),
      platform: probe,
      challenge: challengeFromConfig(config),
      runtime,
      agentAvailable: agentAvailableFromEnvironment(agents),
    });
  }

  const dbHealthy = (): boolean => {
    try {
      store.listAppliedMigrations();
      return true;
    } catch {
      return false;
    }
  };

  // Liveness is process-only; dependency readiness (DB + platform SDK) is
  // answered by /ready and nowhere else.
  const liveness = () => ({ status: 'ok', timestamp: Date.now() });
  const readiness = async () => {
    const status = await rooms.probePlatform();
    const dbOk = dbHealthy();
    const ready = dbOk && status.status === 'AVAILABLE';
    return { ready, db: dbOk ? 'ok' : 'unavailable', platform: status };
  };

  app.get('/health', async () => liveness());
  app.get('/ready', async (request, reply) => {
    const body = await readiness();
    return reply.code(body.ready ? 200 : 503).send(body);
  });

  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await registerProductApi(app, {
    config,
    agents,
    rooms,
    getPrincipal:
      options.getPrincipal ?? ((token: string) => platformClient(platformUrl, token).getPrincipal()),
    publicOrigin: config.PUBLIC_ORIGIN,
    adminToken: config.PRODUCT_ADMIN_TOKEN ?? null,
    agentAvailable: options.agentAvailable ?? agentAvailableFromEnvironment(agents),
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'request rejected');
    if (reply.sent) return;
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply.code(status).send({
      error: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      code: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      message: status === 400 ? 'request rejected' : 'internal product error',
    });
  });

  const staticRoot = options.staticRoot ?? join(process.cwd(), 'dist', 'web');
  if (staticRoot !== null && existsSync(join(staticRoot, 'index.html'))) {
    await app.register(staticPlugin, { root: staticRoot, prefix: '/', index: ['index.html'] });
  }

  const reconcile = setInterval(() => {
    void rooms.reconcileAll().catch((error: unknown) => {
      app.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'room reconciliation failed');
    });
  }, 5000);
  reconcile.unref();

  void rooms.recover().catch((error: unknown) => {
    app.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'room recovery pending');
  });
  void rooms.probePlatform().catch(() => undefined);

  app.addHook('onClose', async () => {
    clearInterval(reconcile);
    if (runtime !== null) await runtime.stop();
    if (ownsStore) store.close();
  });

  return app;
}

export function logChallengeConfiguration(config: Config, app: FastifyInstance): void {
  const challenge = challengeFromConfig(config);
  app.log.info(
    {
      challenge: challenge === null ? 'disabled' : `enabled:${challengeTermsVersion(challenge)}`,
      pokerApiUrl: config.POKERTOOLS_API_URL,
    },
    'product startup',
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const config = loadConfig();
  const app = await buildServer({ config });
  logChallengeConfiguration(config, app);
  const shutdown = (): void => {
    void app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
}

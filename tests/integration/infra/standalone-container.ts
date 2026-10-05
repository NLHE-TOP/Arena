/**
 * Supervised standalone NLHE container for the deterministic container gate.
 *
 * The product enforces HTTP-loopback-only base URLs, so the container joins a
 * dedicated TCP forwarding sidecar network namespace (the proven acceptance
 * pattern). The sidecar listens on loopback-compatible ports inside the shared
 * namespace and forwards to the actual host API/provider:
 *
 *   product (--network container:<sidecar>)
 *     POKERTOOLS_API_URL   = http://127.0.0.1:<apiProxyPort>       -> host platform
 *     agent catalog baseUrl= http://127.0.0.1:<providerProxyPort>  -> host provider
 *   sidecar publishes 127.0.0.1:<productPort> -> product :3001 and
 *   127.0.0.1:<apiProxyPort> on the host (operator SDK/metrics/browser).
 *
 * The mounted agent catalog is a derived, non-secret copy in the runtime
 * directory with only loopback fake-provider ports remapped; real HTTPS
 * provider catalogs are left unchanged. It persists across both restarts.
 *
 * Credential handling:
 * - the container environment (orchestration token, product admin token) is a
 *   mode-0600 env file in the runtime directory outside captured artifacts,
 *   deleted immediately after `docker run` creates the container;
 * - captured container logs are full (never `--tail`) and redacted through the
 *   generated-secret registry before they touch an artifact;
 * - image freshness is checked against the current source tree;
 * - an unexpected product exit is a gate failure (no restart policy).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunContext } from './context.js';
import { ROOT } from './context.js';
import { buildChildEnv } from './env-boundary.js';
import { PLATFORM_SECRET_ENV_NAME_RE } from './env-boundary.js';
import { freePort, runCommand, runCommandOrThrow, waitForHttp } from './proc.js';
import type { SecretRegistry } from './secret-registry.js';
import {
  startContainerUnit,
  type ManagedContainerUnit,
  type Supervisor,
} from './supervisor.js';

export interface StandaloneContainerOptions {
  supervisor: Supervisor;
  context: RunContext;
  /** Mode-0700 runtime directory outside captured artifacts. */
  runtimeDir: string;
  secretRegistry: SecretRegistry;
  productImage: string;
  /** ACTUAL host platform URL (loopback); operator SDK/metrics keep using it. */
  platformUrl: string;
  /** ACTUAL host provider base URL (loopback fake provider). */
  providerBaseUrl: string;
  providerApiKey: string;
  providerModel: string;
  orchestrationToken: string;
  productAdminToken: string;
  agentsConfigPath: string;
  /** Host SQLite path; persisted run evidence, no credentials. */
  databasePath: string;
  /** Host product origin to publish (browser/product API). */
  productUrl: string;
  maxProviderCalls?: number;
  maxHands?: number;
  extraEnv?: Record<string, string>;
  /** Override the sidecar image (default node:24-slim). */
  sidecarImage?: string;
  /**
   * Wait for product `/ready` before returning. Defaults to true, so every
   * existing caller keeps the strict /health + /ready startup contract. The
   * live CHALLENGE bootstrap starts the product before platform custody exists
   * and polls `/ready` explicitly around the deferred custody start instead.
   */
  waitForInitialReady?: boolean;
  /**
   * Join this Docker network with the sidecar so the platform proxy can target
   * the API container directly (`<platformContainerHost>:3000`) and the API
   * observes the genuine container source address instead of the host NAT
   * address. Optional; omitted keeps the legacy host-published target.
   */
  dockerNetwork?: string;
  /** Platform API container name on `dockerNetwork` (direct target, port 3000). */
  platformContainerHost?: string;
}

export interface StandaloneContainerHandle {
  readonly name: string;
  readonly sidecarName: string;
  readonly unit: ManagedContainerUnit;
  readonly sidecar: ManagedContainerUnit;
  /** Host product URL (published through the sidecar). */
  readonly baseUrl: string;
  /** Host-published proxy of the actual platform API (browser/config view). */
  readonly platformProxyUrl: string;
  /** Actual host platform URL (operator SDK/metrics; unchanged). */
  readonly platformUrl: string;
  /** In-namespace provider proxy URL (informational). */
  readonly providerProxyUrl: string;
  readonly databasePath: string;
  readonly containerDatabasePath: string;
  readonly derivedAgentsConfigPath: string;
  waitForHealth(): Promise<void>;
  waitForReady(): Promise<void>;
  healthState(): Promise<{ health: number; ready: number }>;
  /** Restart only the product; the sidecar and roster persist. */
  restart(mode: 'graceful' | 'kill'): Promise<void>;
  /** Full (never truncated) redacted product + sidecar logs into the artifact. */
  captureLogs(): Promise<void>;
  /** Online SQLite backup inside the container, copied outside artifacts. */
  backupEvidence(destination: string): Promise<string>;
  stop(): Promise<void>;
}

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Fail closed when the product image predates the current source tree. The
 * Dockerfile builds the product inside the image, so an image created before
 * the newest source change cannot contain the current fixes.
 */
export async function assertProductImageFresh(imageRef: string): Promise<string> {
  const inspect = await runCommand('docker', ['image', 'inspect', '--format', '{{.Created}}', imageRef], {
    timeoutMs: 30_000,
  });
  if (inspect.code !== 0) {
    throw new Error(
      `product image ${imageRef} is not available; build it from current source (docker build -t ${imageRef} .)`
    );
  }
  const created = Date.parse(inspect.stdout.trim());
  if (!Number.isFinite(created)) throw new Error(`product image ${imageRef} has an unreadable Created timestamp`);
  const newestSource = Math.max(newestMtime(join(ROOT, 'src')), newestMtime(join(ROOT, 'web')));
  if (created < newestSource) {
    throw new Error(
      `product image ${imageRef} is stale (created ${new Date(created).toISOString()} < newest source ${new Date(newestSource).toISOString()}); rebuild before running the gate`
    );
  }
  return new Date(created).toISOString();
}

/**
 * Rewrite only loopback fake-provider base URLs to the in-namespace provider
 * proxy port. Live HTTPS provider catalogs (or a null mapping) are returned
 * unchanged. Pure so it can be regression-tested without Docker.
 */
export function deriveProxiedAgentsConfig(
  agentsConfigPath: string,
  hostProviderPort: number | null,
  providerProxyPort: number | null
): { value: string; remapped: number; preserved: number } {
  const parsed = JSON.parse(readFileSync(agentsConfigPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`agent catalog at ${agentsConfigPath} must be a JSON array`);
  const canRemap = hostProviderPort !== null && providerProxyPort !== null;
  let remapped = 0;
  let preserved = 0;
  const agents = parsed.map((entry) => {
    const agent = entry as Record<string, unknown>;
    const baseUrl = agent.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) return entry;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`agent catalog baseUrl is not a URL: ${baseUrl}`);
    }
    if (canRemap && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(hostProviderPort)) {
      url.port = String(providerProxyPort);
      remapped += 1;
      return { ...agent, baseUrl: url.toString().replace(/\/$/, '') };
    }
    preserved += 1;
    return entry;
  });
  return { value: `${JSON.stringify(agents, null, 2)}\n`, remapped, preserved };
}

export function buildStandaloneEnv(
  options: Pick<
    StandaloneContainerOptions,
    | 'orchestrationToken'
    | 'productAdminToken'
    | 'maxProviderCalls'
    | 'maxHands'
    | 'extraEnv'
  >,
  urls: {
    /** In-namespace platform proxy URL (http://127.0.0.1:<apiProxyPort>). */
    platformUrlForContainer: string;
    /** In-namespace provider proxy URL (http://127.0.0.1:<providerProxyPort>). */
    providerBaseUrlForContainer: string;
    providerApiKey: string;
    providerModel: string;
    publicOrigin: string;
    containerDatabasePath: string;
  }
): NodeJS.ProcessEnv {
  const declared: Record<string, string> = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3001',
    PUBLIC_ORIGIN: urls.publicOrigin,
    POKERTOOLS_API_URL: urls.platformUrlForContainer,
    DATABASE_PATH: urls.containerDatabasePath,
    AGENTS_CONFIG_PATH: '/catalog/agents.json',
    OPENAI_BASE_URL: urls.providerBaseUrlForContainer,
    OPENAI_API_KEY: urls.providerApiKey,
    OPENAI_MODEL: urls.providerModel,
    POKERTOOLS_ORCHESTRATION_TOKEN: options.orchestrationToken,
    PRODUCT_ADMIN_TOKEN: options.productAdminToken,
    MAX_PROVIDER_CALLS: String(options.maxProviderCalls ?? 5_000),
    MAX_COST_USD_MICRO: '0',
    PER_CALL_TIMEOUT_MS: '5000',
    OVERALL_RUNTIME_MS: '600000',
    MAX_HANDS: String(options.maxHands ?? 40),
    MAX_PROVIDER_CONCURRENCY: '4',
    CHALLENGE_ENABLED: '0',
    LOG_LEVEL: 'info',
    ...(options.extraEnv ?? {}),
  };
  const env = buildChildEnv({ purpose: 'nlhe', declared });
  for (const name of Object.keys(declared)) {
    if (PLATFORM_SECRET_ENV_NAME_RE.test(name)) {
      throw new Error(`standalone container env boundary: platform secret name ${name} is not allowed`);
    }
  }
  return env;
}

function hostPort(url: string, label: string): number {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${label} must include an explicit port: ${url}`);
  return port;
}

/** `[listenPort, targetHost, targetPort]`; explicit host, container or gateway. */
export type ProxyMapping = [listenPort: number, targetHost: string, targetPort: number];

/** Legacy route: the actual service is published on the host gateway. */
export function publishedHostMapping(listenPort: number, hostPort: number): ProxyMapping {
  return [listenPort, 'host.docker.internal', hostPort];
}

/** Direct route: target a container on the shared Docker network. */
export function containerTargetMapping(
  listenPort: number,
  containerHost: string,
  containerPort = 3000
): ProxyMapping {
  return [listenPort, containerHost, containerPort];
}

/** Loopback in-namespace URL for the same path as the actual service URL. */
function loopbackProxyUrl(actualUrl: string, proxyPort: number): string {
  const parsed = new URL(actualUrl);
  return `http://127.0.0.1:${proxyPort}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '');
}

export async function startStandaloneContainer(
  options: StandaloneContainerOptions
): Promise<StandaloneContainerHandle> {
  const imageCreatedAt = await assertProductImageFresh(options.productImage);
  options.context.log(`standalone product image ${options.productImage} created ${imageCreatedAt} (fresh vs source)`);

  const hostPlatformPort = hostPort(options.platformUrl, 'platform URL');
  const providerHost = new URL(options.providerBaseUrl).hostname;
  const providerIsLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(providerHost);
  const hostProviderPort = providerIsLoopback ? hostPort(options.providerBaseUrl, 'provider URL') : null;
  const productPort = hostPort(options.productUrl, 'product URL');

  // In-namespace ports: apiProxyPort is also published on the host for the
  // browser/operator SDK; providerProxyPort stays namespace-internal.
  const apiProxyPort = await freePort();
  const providerProxyPort = await freePort();
  const platformUrlForContainer = `http://127.0.0.1:${apiProxyPort}`;
  const providerBaseUrlForContainer = providerIsLoopback
    ? loopbackProxyUrl(options.providerBaseUrl, providerProxyPort) : options.providerBaseUrl;
  const baseUrl = `http://127.0.0.1:${productPort}`;
  const publicOrigin = baseUrl;
  const containerDatabasePath = `/data/${options.databasePath.split('/').pop() ?? 'product.sqlite'}`;

  // Narrow actual-routing choice: when the caller supplies the topology network
  // and API container name, the sidecar joins that network and targets the API
  // container directly, so the platform sees the genuine container source
  // address instead of the host-NAT address (which collapses every host
  // client into one rate-limit bucket). Omitted fields keep the legacy
  // host-published target for regressions.
  const directPlatformTarget =
    typeof options.dockerNetwork === 'string' && options.dockerNetwork.length > 0 &&
    typeof options.platformContainerHost === 'string' && options.platformContainerHost.length > 0;
  const platformMapping = directPlatformTarget
    ? containerTargetMapping(apiProxyPort, options.platformContainerHost!)
    : publishedHostMapping(apiProxyPort, hostPlatformPort);
  const providerMapping = hostProviderPort === null ? null : publishedHostMapping(providerProxyPort, hostProviderPort);
  options.context.log(
    `standalone platform route: ${
      directPlatformTarget
        ? `container-direct ${options.platformContainerHost}:3000 (network ${options.dockerNetwork})`
        : `host-published 127.0.0.1:${hostPlatformPort}`
    }`
  );
  options.context.log(
    `standalone provider route: ${
      providerMapping === null ? 'real-provider-direct (unchanged)' : `host-gateway:${hostProviderPort}`
    }`
  );

  const short = options.context.runId.replace(/[^a-z0-9]/gi, '').slice(-12);
  const name = `nlhe-standalone-${short}`;
  const sidecarName = `nlhe-standalone-proxy-${short}`;
  const sidecarImage = options.sidecarImage ?? process.env.NLHE_IT_SIDECAR_IMAGE ?? 'node:24-slim';

  // Derived non-secret catalog: only loopback fake-provider ports are remapped.
  const derived = deriveProxiedAgentsConfig(options.agentsConfigPath, hostProviderPort ?? -1, providerProxyPort);
  const derivedAgentsConfigPath = join(options.runtimeDir, 'agents-proxied.json');
  writeFileSync(derivedAgentsConfigPath, derived.value, { mode: 0o644 });
  options.context.log(
    `standalone catalog remapped to provider proxy: ${derived.remapped} loopback agent(s), ${derived.preserved} preserved`
  );

  const env = buildStandaloneEnv(options, {
    platformUrlForContainer,
    providerBaseUrlForContainer,
    providerApiKey: options.providerApiKey,
    providerModel: options.providerModel,
    publicOrigin,
    containerDatabasePath,
  });
  options.secretRegistry.assertNoPlatformSecrets(env, 'standalone container env boundary');

  const envPath = join(options.runtimeDir, `${name}.env`);
  writeFileSync(
    envPath,
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n')}\n`,
    { mode: 0o600 }
  );

  const sidecar = await startContainerUnit({
    name: sidecarName,
    imageRef: sidecarImage,
    runArgs: [
      ...(directPlatformTarget ? ['--network', options.dockerNetwork!] : []),
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      `127.0.0.1:${productPort}:3001`,
      '-p',
      `127.0.0.1:${apiProxyPort}:${apiProxyPort}`,
      '-e',
      `PROXY_PORTS=${JSON.stringify([platformMapping, ...(providerMapping === null ? [] : [providerMapping])])}`,
      '-v',
      `${join(ROOT, 'tests', 'integration', 'infra', 'tcp-proxy.mjs')}:/tcp-proxy.mjs:ro`,
      sidecarImage,
      'node',
      '/tcp-proxy.mjs',
    ],
  });
  // Register the sidecar before the product so teardown stops the product first.
  options.supervisor.add(sidecar);

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  let unit: ManagedContainerUnit;
  try {
    unit = await startContainerUnit({
      name,
      imageRef: options.productImage,
      transientFiles: [envPath],
      runArgs: [
        '--network',
        `container:${sidecarName}`,
        '-v',
        `${options.databasePath.replace(/\/[^/]+$/, '')}:/data`,
        '-v',
        `${derivedAgentsConfigPath}:/catalog/agents.json:ro`,
        '--env-file',
        envPath,
        ...(uid !== null && gid !== null ? ['--user', `${uid}:${gid}`] : []),
        options.productImage,
      ],
    });
  } catch (error) {
    // Product failed to start: the sidecar must not leak; the supervisor owns
    // its permanent stop, but stop it now so the failure is clean.
    await options.supervisor.stopUnit(sidecarName).catch(() => undefined);
    throw error;
  }
  options.supervisor.add(unit);

  const logPath = join(options.context.logDir, 'nlhe-standalone.log');
  const waitForHealth = async (): Promise<void> => {
    await waitForHttp(`${baseUrl}/health`, { timeoutMs: 90_000, accept: (response) => response.ok });
  };
  const waitForReady = async (): Promise<void> => {
    await waitForHttp(`${baseUrl}/ready`, { timeoutMs: 120_000, accept: (response) => response.ok });
  };

  const handle: StandaloneContainerHandle = {
    name,
    sidecarName,
    unit,
    sidecar,
    baseUrl,
    platformProxyUrl: `http://127.0.0.1:${apiProxyPort}`,
    platformUrl: options.platformUrl,
    providerProxyUrl: providerBaseUrlForContainer,
    databasePath: options.databasePath,
    containerDatabasePath,
    derivedAgentsConfigPath,
    waitForHealth,
    waitForReady,
    async healthState() {
      const [health, ready] = await Promise.all([
        fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }),
        fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(10_000) }),
      ]);
      return { health: health.status, ready: ready.status };
    },
    async restart(mode) {
      options.supervisor.beginMaintenance(name);
      try {
        await handle.captureLogs();
        if (mode === 'graceful') {
          await runCommandOrThrow('docker', ['restart', name], { timeoutMs: 120_000 });
        } else {
          await runCommandOrThrow('docker', ['kill', '--signal', 'KILL', name], { timeoutMs: 60_000 });
          await runCommandOrThrow('docker', ['start', name], { timeoutMs: 60_000 });
        }
        await waitForHealth();
        await waitForReady();
      } finally {
        await options.supervisor.endMaintenance(name);
      }
      options.context.log(`standalone container restarted (${mode}) and ready at ${baseUrl}`);
    },
    async captureLogs() {
      // Full logs (never truncated) for every child, redacted before writing.
      // Overwrite rather than append so repeated captures (restarts, stop,
      // pre-final-scan) remain idempotent and complete.
      let content = '';
      for (const [label, container] of [
        ['product', name],
        ['sidecar', sidecarName],
      ] as const) {
        const result = await runCommand('docker', ['logs', container], { timeoutMs: 120_000 });
        content += `===== ${label} (${container}) =====\n${result.stdout}${result.stderr}\n`;
      }
      writeFileSync(logPath, options.secretRegistry.redact(content), { mode: 0o600 });
    },
    async backupEvidence(destination) {
      // Back up inside the container's /tmp (never /data, which is bind-mounted
      // to the artifact directory) and copy the result outside artifacts.
      const script =
        "const Database=require('better-sqlite3');const db=new Database(process.env.DATABASE_PATH);" +
        "db.backup('/tmp/.gate-evidence.sqlite').then(()=>db.close());";
      await runCommandOrThrow('docker', ['exec', name, 'node', '-e', script], { timeoutMs: 60_000 });
      await runCommandOrThrow('docker', ['cp', `${name}:/tmp/.gate-evidence.sqlite`, destination], {
        timeoutMs: 60_000,
      });
      return destination;
    },
    async stop() {
      await handle.captureLogs().catch(() => undefined);
      await options.supervisor.stopUnit(name).catch(() => undefined);
      // Teardown after NLHE: the sidecar is stopped once the product is gone.
      await options.supervisor.stopUnit(sidecarName).catch(() => undefined);
    },
  };

  const metadata = {
    container: name,
    sidecar: sidecarName,
    image: options.productImage,
    port: productPort,
    apiProxyPort,
    providerProxyPort,
    database: options.databasePath,
    derivedAgentsConfig: derivedAgentsConfigPath,
    healthPath: '/health',
    readyPath: '/ready',
  };
  writeFileSync(join(options.context.artifactDir, 'standalone-container.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  await waitForHealth();
  if (shouldWaitForInitialReady(options.waitForInitialReady)) await waitForReady();
  return handle;
}

/** Runtime-dir helper used by callers that need a scratch path under temp. */
export function defaultRuntimeDir(runId: string): string {
  return join(tmpdir(), 'opencode', 'nlhe-container-gate', runId);
}

/**
 * Default-true initial readiness wait. Only an explicit `false` skips it (the
 * acceptance-only deferred CHALLENGE bootstrap), so a missing flag can never
 * weaken the normal standalone startup contract.
 */
export function shouldWaitForInitialReady(waitForInitialReady: boolean | undefined): boolean {
  return waitForInitialReady !== false;
}

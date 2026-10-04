/**
 * The ACTUAL built NLHE product process under acceptance.
 *
 * The harness always runs `dist/main.js` (never source or mocks), on a loopback
 * port, with the product configured to use the public platform SDK. The platform
 * topology is external and stays running across an NLHE restart: `restart()`
 * stops and respawns only this process against the same persisted database.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunContext } from './context.js';
import { ROOT } from './context.js';
import { freePort, runCommandOrThrow, spawnManaged, waitForHttp, type ManagedProcess } from './proc.js';
import { FIXTURE_MODEL } from './fixtures.js';
import { buildChildEnv } from './env-boundary.js';

const NLHE_DIST = join(ROOT, 'dist', 'main.js');

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

export function nlheBuildFreshness(): { distExists: boolean; stale: boolean } {
  const distDir = join(ROOT, 'dist');
  if (!existsSync(distDir)) return { distExists: false, stale: true };
  const newestSource = newestMtime(join(ROOT, 'src'));
  const stampPath = join(distDir, '.nlhe-build-stamp');
  if (existsSync(stampPath)) {
    return { distExists: true, stale: newestSource > statSync(stampPath).mtimeMs };
  }
  return { distExists: true, stale: newestSource > newestMtime(distDir) };
}

/**
 * Strict NLHE product build. A red product build fails the run; a stale dist is
 * never executed (`never` refuses both missing and stale artifacts).
 */
export async function ensureNlheBuild(context: RunContext): Promise<void> {
  const freshness = nlheBuildFreshness();
  if (context.build === 'never') {
    if (!freshness.distExists) throw new Error('dist/ is missing; NLHE_IT_BUILD=never refuses to build');
    if (freshness.stale) throw new Error('dist/ is older than src/; NLHE_IT_BUILD=never refuses a stale build');
    return;
  }
  if (!freshness.stale && context.build !== 'force') return;
  context.log('building NLHE product from source (tsc + vite)...');
  // A failed build throws: the harness never runs a stale or partial product.
  await runCommandOrThrow('npm', ['run', 'build'], {
    cwd: ROOT,
    timeoutMs: 600_000,
    logFile: join(context.logDir, 'build-nlhe.log'),
  });
  writeFileSync(join(ROOT, 'dist', '.nlhe-build-stamp'), `${Date.now()}\n`);
}

export interface AgentRosterFile {
  path: string;
  agentIds: string[];
}

export interface FakeAgentRosterOptions {
  /** Provider base URL embedded in each agent config (no secrets). */
  baseUrl?: string | null;
  /** Model override (live opt-in only). Defaults to the loopback fixture. */
  model?: string;
  /** Integer micro-USD per million tokens. */
  pricing?: { input: number; output: number };
  /** Per-room integer call/cost limits. */
  limits?: { maxCallsPerRoom: number; maxCostMicroUsdPerRoom: number; maxCostMicroUsdPerCall: number };
  /**
   * Durable platform SERVICE principals provisioned by explicit infrastructure
   * (one per agent). The product catalog stores principal ids, never tokens.
   */
  principals: ReadonlyArray<{ agentId: string; principalId: string }>;
}

/**
 * Deterministic fake-agent roster in the product's strict array format.
 *
 * All agents are OpenAI-compatible and point at the same loopback provider; the
 * prompt policy identity is read from the product source so the catalog's
 * content-addressed assertion cannot drift. Zero human/provider cost.
 */
export async function writeFakeAgentRoster(
  context: RunContext,
  options: FakeAgentRosterOptions
): Promise<AgentRosterFile> {
  const policy = await loadSeatPromptPolicy();
  const pricing = options.pricing ?? { input: 0, output: 0 };
  // Zero-priced fixture agents declare zero per-call/per-room reserves: a zero
  // cost cap is a real fail-closed spend cap and zero-priced calls settle at 0.
  const limits =
    options.limits ?? { maxCallsPerRoom: 500, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 };
  const agents = options.principals.map((principal) => ({
    id: principal.agentId,
    name: `Fake Agent ${principal.agentId}`,
    model: options.model ?? FIXTURE_MODEL,
    provider: 'openai-compatible',
    baseUrl: options.baseUrl ?? null,
    keyEnv: 'OPENAI_API_KEY',
    principalId: principal.principalId,
    promptPolicyId: policy.id,
    promptPolicyHash: policy.hash,
    pricing: {
      inputMicroUsdPerMillionTokens: pricing.input,
      outputMicroUsdPerMillionTokens: pricing.output,
    },
    limits: {
      maxCallsPerRoom: limits.maxCallsPerRoom,
      maxCostMicroUsdPerRoom: limits.maxCostMicroUsdPerRoom,
      maxCostMicroUsdPerCall: limits.maxCostMicroUsdPerCall,
    },
    enabled: true,
  }));
  const path = join(context.artifactDir, 'agents.json');
  writeFileSync(path, `${JSON.stringify(agents, null, 2)}\n`);
  return { path, agentIds: agents.map((agent) => agent.id) };
}

interface SeatPromptPolicy {
  id: string;
  hash: string;
}

async function loadSeatPromptPolicy(): Promise<SeatPromptPolicy> {
  try {
    const module = (await import('../../../src/llm/prompt-policy.js')) as {
      seatPromptPolicy: SeatPromptPolicy;
    };
    return module.seatPromptPolicy;
  } catch (error) {
    throw new Error(
      `cannot resolve the product seat prompt policy (product source must compile): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export interface NlheConfig {
  platformBaseUrl: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  databasePath: string;
  agentsConfigPath: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Bounds; acceptance must never be unbounded. */
  maxProviderCalls?: number;
  maxCostUsdMicro?: number;
  perCallTimeoutMs?: number;
  overallRuntimeMs?: number;
  maxHands?: number;
}

export interface NlheHandle {
  baseUrl: string;
  port: number;
  process: ManagedProcess;
  databasePath: string;
  healthPath: string;
  restart: () => Promise<void>;
  /** Hard SIGKILL for deterministic crash-window proofs. */
  kill: () => Promise<void>;
  stop: () => Promise<void>;
}

function nlheEnv(config: NlheConfig, port: number): NodeJS.ProcessEnv {
  return buildChildEnv({
    purpose: 'nlhe',
    declared: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      POKERTOOLS_API_URL: config.platformBaseUrl,
      DATABASE_PATH: config.databasePath,
      AGENTS_CONFIG_PATH: config.agentsConfigPath,
      OPENAI_BASE_URL: config.openaiBaseUrl,
      OPENAI_API_KEY: config.openaiApiKey,
      OPENAI_MODEL: config.openaiModel,
      // Canonical new product config names.
      MAX_PROVIDER_CALLS: String(config.maxProviderCalls ?? 500),
      MAX_COST_USD_MICRO: String(config.maxCostUsdMicro ?? 0),
      PER_CALL_TIMEOUT_MS: String(config.perCallTimeoutMs ?? 5000),
      OVERALL_RUNTIME_MS: String(config.overallRuntimeMs ?? 600_000),
      MAX_HANDS: String(config.maxHands ?? 50),
      MAX_PROVIDER_CONCURRENCY: '4',
      CHALLENGE_ENABLED: '0',
      // Transitional names consumed by the previous runtime while the product
      // build converges; both resolve to the same loopback fake provider.
      LIVE_LLM_MAX_CALLS: String(config.maxProviderCalls ?? 500),
      LIVE_LLM_MAX_USD_MICRO: String(config.maxCostUsdMicro ?? 0),
      LIVE_E2E_MAX_HANDS: String(config.maxHands ?? 50),
      ...config.extraEnv,
    },
  });
}

async function waitForNlheHealth(port: number, logPath: string): Promise<{ healthPath: string }> {
  // The product exposes exactly /health (liveness) and /ready (readiness).
  const candidates = ['/health'];
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${candidate}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return { healthPath: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const { tailFile } = await import('./proc.js');
  throw new Error(
    `NLHE process did not become healthy on ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${tailFile(logPath)}`
  );
}

export async function startNlhe(context: RunContext, config: NlheConfig): Promise<NlheHandle> {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const port = await freePort();
  const env = nlheEnv(config, port);
  const managed = spawnManaged('nlhe-product', process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env,
    logDir: context.logDir,
  });

  let healthPath: string;
  try {
    ({ healthPath } = await waitForNlheHealth(port, managed.logPath));
  } catch (error) {
    await managed.stop();
    throw error;
  }
  context.log(`NLHE product ready at http://127.0.0.1:${port} (${healthPath})`);

  const handle: NlheHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    process: managed,
    databasePath: config.databasePath,
    healthPath,
    restart: async () => {
      context.log('restarting NLHE product process (platform stays up)...');
      await handle.process.stop();
      const restarted = spawnManaged('nlhe-product-restart', process.execPath, ['dist/main.js'], {
        cwd: ROOT,
        env: nlheEnv(config, port),
        logDir: context.logDir,
      });
      handle.process = restarted;
      try {
        ({ healthPath } = await waitForNlheHealth(port, restarted.logPath));
      } catch (error) {
        await restarted.stop();
        throw error;
      }
      context.log(`NLHE product restarted at ${handle.baseUrl} (${healthPath})`);
    },
    kill: async () => {
      await handle.process.kill();
    },
    stop: async () => {
      await handle.process.stop();
    },
  };
  return handle;
}

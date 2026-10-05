#!/usr/bin/env tsx
/**
 * Deterministic financial CHALLENGE entrypoint (fresh disposable topology).
 *
 *   tsx tests/integration/container-challenge.ts          # full deterministic run
 *   tsx tests/integration/container-challenge.ts --check  # prerequisites/plan only
 *
 * This is the deterministic counterpart of the guarded live CHALLENGE wrapper
 * (`container-live-challenge.ts`): it reuses the exact same reviewed wiring
 * seams -- fresh `startStagingTopology` with `deferCustodyStartup`, the
 * supervised public payer/sponsor deposit claims with the declared sponsor
 * classification, the standalone product container and the shared
 * `runChallengeScenario` -- but it NEVER contacts a paid provider, NEVER loads
 * a local dotenv file, and has NO live gate, NO one-run marker and NO
 * paid-capable path. The only provider is the loopback
 * `infra/fake-provider.ts` instance, asserted loopback before the product
 * container is started, so no code path can reach a non-loopback provider.
 *
 * What this proves on the ACTUAL built container with real custody/finance
 * authority from the external staging fixture:
 * - a fresh valueless Anvil topology, planned-not-started custody, then the
 *   public payer entry claim, the supervised API restart for deposit-verifier
 *   cache isolation, the public sponsor prize claim, the declared
 *   USER_AVAILABLE -> OPERATOR sponsor classification, and only then the
 *   actual custody worker + heartbeat, actual central READY and product
 *   `/ready` 200 BEFORE room admission or any provider call;
 * - one product-orchestrated 1H1A CHALLENGE room through the shared
 *   `runChallengeScenario`: the terminal winner's entry state is PAID exactly
 *   once (the SERVICE entrant is NOT_REQUIRED), the prize is RESERVED before
 *   the first hand and disposed exactly once (PAID to a WALLET winner /
 *   RELEASED to the sponsor);
 * - the exactly-once, balanced and sealed financial journals are byte-identical
 *   across the ONE existing product restart (settlement/restart safety);
 * - zero platform HTTP 429 responses in the platform's own `/metrics` counter
 *   before/after the run and inside the shared scenario;
 * - one deterministic post-terminal race regression on the SAME completed
 *   CHALLENGE: a real server-issued pre-terminal legal action is submitted
 *   after the room is authoritative terminal, the platform's canonical
 *   stale/turn conflict (HTTP 409) is reproduced, and the durable failure
 *   packet must anchor to the completed hand, classify the late request as
 *   BENIGN_POST_TERMINAL_RACE and stay complete (durableComplete=true);
 * - every supervised unit alive with no unexpected death, and the mandatory
 *   final external secret scan over every captured log/artifact with the
 *   runtime secret manifest (there is no skip path).
 *
 * Caps match the existing deterministic acceptance
 * (`tests/integration/acceptance/run.ts`): 5 000 provider calls, 0 micro-USD
 * cost, 5 000 ms per call, 600 000 ms overall runtime, 100 hands, concurrency
 * 8. The deterministic wrapper injects those assertion bounds (5 000 calls /
 * 0 micro-USD / 600 000 ms terminal wait) into the shared
 * `runChallengeScenario`, so its outcome and wait gates enforce the
 * deterministic acceptance caps; the frozen live `LIVE_CAPS` (24 / 50 000 /
 * 120 000) remains the EXACT default for every paid call site and is never
 * raised. The fixed valueless terms are entry=1 / prize=2.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 not runnable (missing fixture/scanner/env).
 *
 * External prerequisites:
 *   NLHE_IT_STAGING_FIXTURE   absolute path to the built staging fixture
 *                             (exporting `startStagingPlatform`, with deferred
 *                             custody + finance surface)
 *   NLHE_IT_SECRET_SCANNER    absolute existing final secret scanner
 *                             (mandatory; the scan is never skipped)
 *   NLHE_IT_PRODUCT_IMAGE     product image built from current source
 *                             (default: nlhe-product:container-gate)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import {
  startStagingTopology,
  type StagingPlatformFinance,
  type StagingTopology,
} from './infra/staging.js';
import {
  startStandaloneContainer,
  type StandaloneContainerHandle,
} from './infra/standalone-container.js';
import { startFakeProvider, type FakeProviderHandle } from './infra/fake-provider.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { ephemeralWallet, getAccount, loginWallet } from './infra/wallet.js';
import { ensureOperator } from './infra/admin.js';
import {
  mintOrchestrationToken,
  productAdminToken,
  provisionFakeAgentPrincipals,
} from './infra/agents.js';
import { writeFakeAgentRoster } from './infra/nlhe.js';
import { runCommandOrThrow } from './infra/proc.js';
import type { PlatformHandle } from './infra/platform.js';
import { ProductClient } from './acceptance/product-client.js';
import { readRoomEvidence } from './acceptance/evidence.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import {
  collectLiveFailurePacket,
  isExpectedTerminalActionConflict,
  type LastCanonicalHumanAction,
} from './acceptance/live-failure-packet.js';
import {
  LIVE_CHALLENGE_ENTRY_ATOMIC,
  LIVE_CHALLENGE_PRIZE_ATOMIC,
  runChallengeScenario,
  type ChallengeAssertionCaps,
  type LiveChallengeOutcome,
  type LiveChallengeProgress,
} from './live.js';
import { activateDeferredCustody, buildChallengeFinancialTopology } from './container-live-challenge.js';
import { requireSecretScanner } from './container-live-sponsored.js';

/**
 * Deterministic acceptance caps, copied from the existing acceptance run
 * (`tests/integration/acceptance/run.ts`). Never loosened at runtime; the
 * shared `runChallengeScenario` receives these as injected assertion caps
 * (see `DETERMINISTIC_CHALLENGE_ASSERTION_CAPS`).
 */
export const DETERMINISTIC_CHALLENGE_CAPS = Object.freeze({
  maxProviderCalls: 5_000,
  maxCostUsdMicro: 0,
  perCallTimeoutMs: 5_000,
  overallRuntimeMs: 600_000,
  maxHands: 100,
  maxProviderConcurrency: 8,
});

export const DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT = 'deterministic-challenge-result.json';

/**
 * Assertion bounds injected into the shared `runChallengeScenario`. They are
 * derived from the same deterministic acceptance caps the product container is
 * started with (5 000 calls / 0 micro-USD / 600 000 ms terminal wait), never
 * from the frozen live `LIVE_CAPS`; live call sites keep the exact LIVE_CAPS
 * default and the live constants are never changed.
 */
export const DETERMINISTIC_CHALLENGE_ASSERTION_CAPS: ChallengeAssertionCaps = Object.freeze({
  maxCalls: DETERMINISTIC_CHALLENGE_CAPS.maxProviderCalls,
  maxCostUsdMicro: BigInt(DETERMINISTIC_CHALLENGE_CAPS.maxCostUsdMicro),
  overallRuntimeMs: DETERMINISTIC_CHALLENGE_CAPS.overallRuntimeMs,
});

export interface DeterministicChallengeArgs {
  check: boolean;
}

/** Strict CLI: only the side-effect-free prerequisite check is accepted. */
export function parseDeterministicChallengeArgs(
  argv: readonly string[]
): DeterministicChallengeArgs {
  const args: DeterministicChallengeArgs = { check: false };
  for (const argument of argv) {
    if (argument === '--check') {
      args.check = true;
      continue;
    }
    throw new Error(`unknown deterministic-challenge argument: ${argument}`);
  }
  return args;
}

/**
 * The deterministic run may only ever talk to the loopback fake provider. Any
 * other host (a real paid endpoint) fails before a container can be started.
 */
export function assertLoopbackProviderUrl(url: string, label = 'provider URL'): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${label} is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw new Error(
      `${label} must be loopback for the deterministic CHALLENGE run (no paid provider path), saw ${host}`
    );
  }
  return url;
}

function requireAbsoluteFixture(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value) || !/\.m?js$/.test(value) || !existsSync(value)) {
    throw new Error(
      'NLHE_IT_STAGING_FIXTURE is required (absolute existing path to the built external staging fixture exporting startStagingPlatform)'
    );
  }
  return value;
}

/**
 * The external scanner is mandatory. The shared `requireSecretScanner` helper
 * owns the absolute/existing-path semantics; this wrapper only reports the
 * deterministic wording (no paid run involved).
 */
function requireDeterministicScanner(value: string | undefined): string {
  try {
    return requireSecretScanner(value);
  } catch {
    throw new Error(
      'NLHE_IT_SECRET_SCANNER is required (absolute path to the existing final secret scanner); the deterministic CHALLENGE run never skips the supervisor/log secret scan'
    );
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChallengeRoomEvidence {
  calls: number;
  committed: number;
  costMicroUsd: number;
  providerFailures: string[];
}

/** Same-room SQLite outcome for FAILED artifacts; never validates or repairs. */
function summarizeRoomEvidence(databasePath: string, roomId: string): ChallengeRoomEvidence | null {
  try {
    const evidence = readRoomEvidence(databasePath, roomId);
    return {
      calls: evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length,
      committed: evidence.decisions.filter(
        (decision) =>
          decision.status === 'COMMITTED' &&
          evidence.attempts.some(
            (attempt) => attempt.decision_id === decision.id && attempt.status === 'SUCCEEDED'
          )
      ).length,
      costMicroUsd: evidence.attempts.reduce((sum, attempt) => sum + attempt.cost_micro_usd, 0),
      providerFailures: evidence.attempts
        .filter((attempt) => attempt.status === 'FAILED')
        .map((attempt) => attempt.error ?? 'unknown')
        .slice(0, 5),
    };
  } catch {
    return null;
  }
}

/** Bounded HTTP status of a canonical action rejection (SDK error shape). */
export function actionRejectionStatus(error: unknown): number | null {
  const record = error as { statusCode?: unknown; status?: unknown };
  if (typeof record?.statusCode === 'number' && Number.isInteger(record.statusCode)) {
    return record.statusCode;
  }
  if (typeof record?.status === 'number' && Number.isInteger(record.status)) {
    return record.status;
  }
  return null;
}

/**
 * One exact server-issued stale action captured BEFORE the room reached its
 * authoritative terminal state. The late request reuses the platform's own
 * turn/version/action identity; the harness never invents poker semantics.
 */
export interface StaleHumanActionCapture {
  requestId: string;
  tableId: string;
  handId: string | null;
  turnId: string;
  expectedVersion: number;
  actionId: string;
}

/**
 * Choose the late action from a real server-issued legal menu (FOLD preferred,
 * so the aggressive deterministic driver is unlikely to have submitted the same
 * action identity). Returns null when the observation carries no exact
 * turn/version/action identity.
 */
export function selectStaleAction(observation: {
  turnId?: unknown;
  version?: unknown;
  handId?: unknown;
  legalActions?: ReadonlyArray<{ actionId?: unknown; family?: unknown }>;
}): { turnId: string; expectedVersion: number; actionId: string; handId: string | null } | null {
  const turnId =
    typeof observation.turnId === 'string' && observation.turnId.length > 0
      ? observation.turnId
      : null;
  const expectedVersion =
    typeof observation.version === 'number' && Number.isInteger(observation.version)
      ? observation.version
      : null;
  const actions = Array.isArray(observation.legalActions) ? observation.legalActions : [];
  const chosen =
    actions.find((action) => action.family === 'FOLD' && typeof action.actionId === 'string') ??
    actions.find((action) => typeof action.actionId === 'string');
  if (turnId === null || expectedVersion === null || chosen === undefined) return null;
  return {
    turnId,
    expectedVersion,
    actionId: chosen.actionId as string,
    handId:
      typeof observation.handId === 'string' && observation.handId.length > 0
        ? observation.handId
        : null,
  };
}

/**
 * Mandatory final scan after all teardown logs exist. The scanner child gets
 * only the system allowlist plus `NLHE_REPO` (the checkout root holding the
 * local `.env` whose values are the detection needles) -- no provider or
 * platform credential is inherited by the scan process.
 */
async function runFinalSecretScan(
  context: RunContext,
  scanner: string,
  manifestPath: string
): Promise<'pass'> {
  const env = buildChildEnv({
    purpose: 'platform',
    declared: { NLHE_REPO: process.env.NLHE_REPO ?? ROOT },
  });
  const result = await runCommandOrThrow(
    process.execPath,
    [scanner, '--manifest', manifestPath, context.artifactDir],
    { timeoutMs: 120_000, env }
  );
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    context.log(`secret scan: ${line}`);
  }
  return 'pass';
}

async function main(): Promise<number> {
  let args: DeterministicChallengeArgs;
  try {
    args = parseDeterministicChallengeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`BLOCKED deterministic challenge: ${safeError(error)}`);
    return 2;
  }

  // ---- Prerequisites first: no context, no topology, no provider, no paid path ----
  let fixturePath: string;
  let scannerPath: string;
  try {
    fixturePath = requireAbsoluteFixture(process.env.NLHE_IT_STAGING_FIXTURE);
    scannerPath = requireDeterministicScanner(process.env.NLHE_IT_SECRET_SCANNER);
  } catch (error) {
    console.log(`BLOCKED deterministic challenge: ${safeError(error)}`);
    return 2;
  }

  if (args.check) {
    console.log(
      [
        'deterministic CHALLENGE plan: loopback fake provider only; no live gate, no one-run marker, no local dotenv load, no paid-capable path',
        `  fixture: ${fixturePath}`,
        `  secret scanner: ${scannerPath} (mandatory; scanned with NLHE_REPO=${process.env.NLHE_REPO ?? ROOT})`,
        `  caps: calls=${DETERMINISTIC_CHALLENGE_CAPS.maxProviderCalls} costMicroUsd=${DETERMINISTIC_CHALLENGE_CAPS.maxCostUsdMicro} perCallMs=${DETERMINISTIC_CHALLENGE_CAPS.perCallTimeoutMs} overallMs=${DETERMINISTIC_CHALLENGE_CAPS.overallRuntimeMs} hands=${DETERMINISTIC_CHALLENGE_CAPS.maxHands} concurrency=${DETERMINISTIC_CHALLENGE_CAPS.maxProviderConcurrency}`,
        `  terms: entryAtomic=${LIVE_CHALLENGE_ENTRY_ATOMIC} prizeAtomic=${LIVE_CHALLENGE_PRIZE_ATOMIC}`,
        '  ordering: fresh deferred-custody topology -> public payer claim -> supervised API restart -> public sponsor claim -> declared sponsor classification -> actual custody worker/READY -> product /ready 200 -> CHALLENGE room',
        '  shared helper: runChallengeScenario with injected assertion caps (5000 calls / 0 microUsd / 600000 ms); the live default stays LIVE_CAPS 24 / 50000 / 120000',
        '  post-terminal race regression: one real pre-terminal legal action is submitted after the authoritative terminal state (expect HTTP 409) and the durable packet must anchor to the completed hand with durableComplete=true and BENIGN_POST_TERMINAL_RACE',
        '  prerequisites: NLHE_IT_STAGING_FIXTURE, NLHE_IT_SECRET_SCANNER, NLHE_IT_PRODUCT_IMAGE built from current source; --check starts nothing',
      ].join('\n')
    );
    return 0;
  }

  const context = createRunContext();
  const startedAt = new Date().toISOString();
  const databasePath = join(context.artifactDir, 'nlhe-deterministic-challenge.sqlite');
  const sponsorPrincipalId = randomUUID();
  const sponsorAddress = getAccount(2).address;

  let topology: StagingTopology | null = null;
  let provider: FakeProviderHandle | null = null;
  let runtime: StandaloneContainerHandle | null = null;
  let productBaseUrl: string | null = null;
  let outcome: LiveChallengeOutcome | null = null;
  const challengeProgress: { current: LiveChallengeProgress | null } = { current: null };
  let roomEvidence: ChallengeRoomEvidence | null = null;
  let platform429Before: number | null = null;
  let platform429After: number | null = null;
  let providerRequests = 0;
  let supervisedUnits: string[] = [];
  let unexpectedDeaths = 0;
  let failure: string | null = null;
  const teardownErrors: string[] = [];
  let scan: 'pending' | 'pass' | 'failed' | 'unavailable' = 'pending';
  let cleanupFailure: string | null = null;
  const staleCapture: { current: StaleHumanActionCapture | null } = { current: null };
  let lateActionStatus: number | null = null;
  let lateActionPacketComplete: boolean | null = null;
  let lateActionDurableComplete: boolean | null = null;
  let lateActionClassification: string | null = null;
  let lateActionPacketPath: string | null = null;
  let redact: (text: string) => string = (text) => text;
  const sanitize = (value: unknown): string =>
    redact(typeof value === 'string' ? value : String(value)).replace(/[\r\n]+/g, ' ').slice(0, 2_000);

  try {
    const started = await startStagingTopology({
      context,
      sponsor: { principalId: sponsorPrincipalId, address: sponsorAddress },
      // Acceptance-only deferred custody: the planned worker is held in
      // supervisor maintenance until the existing startCustody contract
      // creates it, after the real deposits and sponsor classification.
      deferCustodyStartup: true,
    });
    topology = started;
    redact = (text) => started.secretRegistry.redact(text);
    assertLoopbackProviderUrl(started.platformUrl, 'platform URL');
    started.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);
    supervisedUnits = started.supervisor.identityLines();
    // Bootstrap contract: API /health is live while /ready is expected
    // non-READY (custody planned, not started). All non-custody units must
    // already be alive; actual READY is asserted after startCustody.
    await started.supervisor.assertAllAlive('deterministic challenge deferred bootstrap');
    context.log(
      'deterministic challenge deferred bootstrap: API /health 200, readiness expected non-READY until the custody worker starts'
    );
    platform429Before = await readPlatform429Total(started.platformMetrics);
    if (platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${platform429Before} HTTP 429 response(s)`);
    }

    const finance = started.platform.finance;
    if (!finance) {
      throw new Error(
        'the external staging fixture exposes no finance handle; the deterministic CHALLENGE run requires it'
      );
    }
    if (
      typeof finance.restartApi !== 'function' ||
      typeof finance.apiContainerName !== 'string' ||
      finance.apiContainerName.length === 0
    ) {
      throw new Error(
        'the external staging fixture must expose finance.restartApi + finance.apiContainerName for supervised API cache isolation'
      );
    }
    const deferredCustodyUnit = started.deferredCustodyUnit;
    if (deferredCustodyUnit === null) {
      throw new Error(
        'deterministic CHALLENGE requires the deferred custody bootstrap but the topology declared no planned custody unit'
      );
    }
    const apiUnitName = finance.apiContainerName;
    const supervisedApiRestart = async (): Promise<void> => {
      // API process metrics reset on restart. Never let maintenance erase an
      // unexpected limiter response from the public deposit bootstrap.
      const beforeRestart429 = await readPlatform429Total(started.platformMetrics);
      context.log(`pre-admission API restart: platform429=${beforeRestart429}`);
      if (beforeRestart429 !== 0) throw new Error('unexpected platform HTTP 429 before API maintenance');
      // Deposit-verifier cache isolation: restart ONLY the platform API
      // container inside a supervisor maintenance window. Anvil, quorum,
      // workers and custody are never restarted.
      started.supervisor.beginMaintenance(apiUnitName);
      try {
        await finance.restartApi!();
      } finally {
        await started.supervisor.endMaintenance(apiUnitName);
      }
    };
    const supervisedFinance: StagingPlatformFinance = {
      ...finance,
      async startCustody() {
        await activateDeferredCustody({
          unit: deferredCustodyUnit,
          startCustody: async () => {
            await finance.startCustody!();
          },
          endMaintenance: (unit) => started.supervisor.endMaintenance(unit),
          waitForCentralReady: async () => {
            await finance.waitForReady!();
          },
          assertFinancialEvidence: async () => {
            await started.assertHealthy('deferred custody actual READY', {
              requireCustodyHeartbeat: true,
            });
          },
          waitForProductReady: async () => {
            if (runtime === null) {
              throw new Error('product runtime is not started for deferred custody activation');
            }
            await runtime.waitForReady();
          },
        });
      },
    };
    const financial = buildChallengeFinancialTopology({
      finance: supervisedFinance,
      sponsorPrincipalId,
      sponsorAddress,
      custodyLogPath: join(started.runtimeDir, 'custody-container.log'),
      restartApi: supervisedApiRestart,
    });
    const platform: PlatformHandle = {
      baseUrl: started.platformUrl,
      port: Number(new URL(started.platformUrl).port),
      databaseUrl: started.databaseUrl,
      redisUrl: started.redisUrl,
      stop: async () => undefined,
      restartApi: financial.restartApi,
    };

    // Deterministic loopback provider ONLY: zero cost, no credential, no
    // non-loopback route. `fold` keeps the agent passive until the fixed
    // aggression window, which terminates the room well inside the caps.
    const fakeProvider = await startFakeProvider({ mode: 'fold', aggressiveAfter: 12 });
    provider = fakeProvider;
    assertLoopbackProviderUrl(fakeProvider.baseUrl, 'fake provider URL');
    context.log(
      `deterministic loopback fake provider at ${fakeProvider.baseUrl} (no paid provider, no credential)`
    );

    const admin = await loginWallet(started.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(started.adminTarget, admin);
    if (!promotion.promoted) throw new Error('deterministic challenge operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: fakeProvider.baseUrl,
      principals,
    });
    const adminToken = productAdminToken();
    started.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    started.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);

    runtime = await startStandaloneContainer({
      supervisor: started.supervisor,
      context,
      runtimeDir: started.runtimeDir,
      secretRegistry: started.secretRegistry,
      productImage: started.productImage,
      platformUrl: started.platformUrl,
      productUrl: started.productUrl,
      providerBaseUrl: fakeProvider.baseUrl,
      providerApiKey: FIXTURE_API_KEY,
      providerModel: FIXTURE_MODEL,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath,
      maxProviderCalls: DETERMINISTIC_CHALLENGE_CAPS.maxProviderCalls,
      maxHands: DETERMINISTIC_CHALLENGE_CAPS.maxHands,
      // Direct container route: the API observes the genuine container source
      // address instead of the host-NAT address (rate-limit key separation).
      dockerNetwork: started.network,
      platformContainerHost: finance.apiContainerName,
      // Bootstrap without custody: /health + /config are available with zero
      // rooms/models; /ready is asserted explicitly after actual custody READY.
      waitForInitialReady: false,
      extraEnv: {
        MAX_COST_USD_MICRO: String(DETERMINISTIC_CHALLENGE_CAPS.maxCostUsdMicro),
        PER_CALL_TIMEOUT_MS: String(DETERMINISTIC_CHALLENGE_CAPS.perCallTimeoutMs),
        OVERALL_RUNTIME_MS: String(DETERMINISTIC_CHALLENGE_CAPS.overallRuntimeMs),
        MAX_PROVIDER_CONCURRENCY: String(DETERMINISTIC_CHALLENGE_CAPS.maxProviderConcurrency),
        CHALLENGE_ENABLED: '1',
        CHALLENGE_ASSET_ID: financial.assetId,
        CHALLENGE_ENTRY_ATOMIC: LIVE_CHALLENGE_ENTRY_ATOMIC,
        CHALLENGE_PRIZE_ATOMIC: LIVE_CHALLENGE_PRIZE_ATOMIC,
        CHALLENGE_SPONSOR_PRINCIPAL_ID: sponsorPrincipalId,
      },
    });
    productBaseUrl = runtime.baseUrl;
    await started.supervisor.assertAllAlive('deterministic challenge container start');
    context.log(
      `deterministic challenge product bootstrap healthy at ${runtime.baseUrl} (container ${runtime.name}); /ready is deferred until actual custody READY`
    );

    // ---- Post-terminal race regression fixture: a second session for the SAME
    // human wallet records one REAL server-issued legal action while the room is
    // active. It is submitted only AFTER the room is authoritative terminal, so
    // the platform's canonical stale/turn conflict (HTTP 409) is reproduced
    // deterministically with no invented poker semantics. ----
    const observerSession = await loginWallet(started.platformUrl, getAccount(1));
    let observing = true;
    let observerStarted = false;
    let observerLoop: Promise<void> = Promise.resolve();
    const startObserver = (tableId: string): void => {
      if (observerStarted) return;
      observerStarted = true;
      observerLoop = (async () => {
        while (observing && staleCapture.current === null) {
          try {
            const observation = await observerSession.client.getObservation(tableId);
            const selected = selectStaleAction(observation);
            if (selected !== null) {
              staleCapture.current = { requestId: randomUUID(), tableId, ...selected };
            }
          } catch {
            // Observation races are retried until the room is terminal.
          }
          if (staleCapture.current === null) {
            await new Promise((resolve) => setTimeout(resolve, 1_200));
          }
        }
      })();
    };

    outcome = await runChallengeScenario(
      {
        context,
        environment: { platform, adminTarget: started.adminTarget, financial },
        nlhe: {
          restart: async () => {
            await runtime!.restart('graceful');
          },
        },
        product: new ProductClient(runtime.baseUrl),
        principals,
        databasePath,
        platformMetrics: started.platformMetrics,
      },
      {
        onProgress: (value) => {
          challengeProgress.current = value;
          if (value.tableId !== null && value.status === 'ACTIVE') {
            startObserver(value.tableId);
          }
        },
      },
      DETERMINISTIC_CHALLENGE_ASSERTION_CAPS
    );

    // Stop observing BEFORE the late submission: the exact pre-terminal request
    // identity is what a real driver would have retained across terminal.
    observing = false;
    await observerLoop.catch(() => undefined);
    if (staleCapture.current === null) {
      throw new Error(
        'deterministic post-terminal race: no pre-terminal human observation was captured'
      );
    }
    let lateRejection: unknown = null;
    try {
      await observerSession.client.action(staleCapture.current.tableId, {
        requestId: staleCapture.current.requestId,
        turnId: staleCapture.current.turnId,
        expectedVersion: staleCapture.current.expectedVersion,
        actionId: staleCapture.current.actionId,
      });
    } catch (error) {
      lateRejection = error;
    }
    if (lateRejection === null) {
      throw new Error(
        'deterministic post-terminal race: the late canonical action was accepted instead of rejected'
      );
    }
    lateActionStatus = actionRejectionStatus(lateRejection);
    if (!isExpectedTerminalActionConflict(lateActionStatus)) {
      throw new Error(
        `deterministic post-terminal race: late canonical action status ${lateActionStatus ?? 'unknown'} is not the expected terminal conflict`
      );
    }
    context.log(
      `deterministic post-terminal race: late canonical action ${staleCapture.current.requestId} rejected with HTTP ${lateActionStatus}`
    );
    const lateActionIdentity: LastCanonicalHumanAction = {
      requestIds: [staleCapture.current.requestId],
      requestId: staleCapture.current.requestId,
      actionId: staleCapture.current.actionId,
      turnId: staleCapture.current.turnId,
      tableId: staleCapture.current.tableId,
      handId: staleCapture.current.handId,
      httpStatus: lateActionStatus,
    };
    const lateActionPacket = await collectLiveFailurePacket({
      context,
      adminTarget: started.adminTarget,
      redisContainer: started.redisContainer,
      secretRegistry: started.secretRegistry,
      productDatabasePath: databasePath,
      platformMetrics: started.platformMetrics,
      apiContainerName: finance.apiContainerName ?? null,
      reason: 'deterministic post-terminal race classification',
      lastCanonicalHumanAction: lateActionIdentity,
      agentPrincipalIds: principals.map((principal) => principal.principalId),
      roomId: outcome.roomId,
    });
    lateActionPacketComplete = lateActionPacket.complete;
    lateActionPacketPath = lateActionPacket.packetPath;
    if (!lateActionPacket.complete || lateActionPacket.retainTopology) {
      throw new Error(
        `deterministic post-terminal race: durable failure packet incomplete (${lateActionPacket.reason ?? 'no reason'})`
      );
    }
    const lateActionPacketPayload = JSON.parse(readFileSync(lateActionPacket.packetPath!, 'utf8')) as {
      terminal?: {
        durableComplete?: unknown;
        actionAnchor?: { classification?: unknown; reasons?: unknown };
        scopedIdentifiers?: { source?: unknown; requestId?: unknown; handId?: unknown };
      };
      humanAction?: { committed?: unknown; basis?: unknown };
    };
    lateActionDurableComplete = lateActionPacketPayload.terminal?.durableComplete === true;
    lateActionClassification =
      typeof lateActionPacketPayload.terminal?.actionAnchor?.classification === 'string'
        ? lateActionPacketPayload.terminal.actionAnchor.classification
        : null;
    if (!lateActionDurableComplete) {
      throw new Error('deterministic post-terminal race: terminal.durableComplete != true');
    }
    if (lateActionClassification !== 'BENIGN_POST_TERMINAL_RACE') {
      throw new Error(
        `deterministic post-terminal race: classification ${lateActionClassification ?? 'missing'} != BENIGN_POST_TERMINAL_RACE`
      );
    }
    if (lateActionPacketPayload.terminal?.scopedIdentifiers?.source !== 'completed-terminal-hand') {
      throw new Error(
        `deterministic post-terminal race: terminal anchor source ${String(
          lateActionPacketPayload.terminal?.scopedIdentifiers?.source
        )} != completed-terminal-hand`
      );
    }
    if (lateActionPacketPayload.humanAction?.committed !== false) {
      throw new Error('deterministic post-terminal race: the rejected late request was reported committed');
    }
    context.log(
      `deterministic post-terminal race PASS: packetComplete=${lateActionPacketComplete} durableComplete=${lateActionDurableComplete} classification=${lateActionClassification} anchorHand=${String(
        lateActionPacketPayload.terminal?.scopedIdentifiers?.handId
      )}`
    );

    providerRequests =
      outcome.tableId !== null
        ? fakeProvider.requestCountForTable(outcome.tableId)
        : fakeProvider.requestCount();
    platform429After = await readPlatform429Total(started.platformMetrics);
    if (platform429After !== 0) {
      throw new Error(
        `platform recorded ${platform429After} actual HTTP 429 response(s) during the deterministic CHALLENGE run`
      );
    }
    await started.supervisor.assertAllAlive('deterministic challenge complete');
    context.log(
      `deterministic challenge COMPLETE: room=${outcome.roomId} competition=${outcome.competitionId} winner=${outcome.winnerKind} prizeStatus=${outcome.prizeStatus} calls=${outcome.calls} committed=${outcome.committed} providerRequests=${providerRequests} journalFingerprint=${outcome.journalFingerprint.slice(0, 16)}`
    );
  } catch (error) {
    failure = sanitize(safeError(error));
    // Safe same-run capture even on failure: the room's SQLite evidence
    // (same deterministic name fallback). Credentials are never echoed.
    try {
      let roomId = outcome?.roomId ?? challengeProgress.current?.roomId ?? null;
      if (roomId === null && productBaseUrl !== null) {
        try {
          const rooms = await new ProductClient(productBaseUrl).getRooms();
          roomId =
            rooms.rooms.find((room) => room.name === `live-challenge-1H1A-${context.runId}`)?.id ?? null;
        } catch {
          roomId = null;
        }
      }
      if (roomId !== null) roomEvidence = summarizeRoomEvidence(databasePath, roomId);
    } catch {
      // Bounded failure capture only; the original failure is preserved.
    }
  }

  if (topology !== null) unexpectedDeaths = topology.supervisor.deaths().length;

  // ---- Teardown FIRST: product container, loopback provider, then every fixture child ----
  try {
    if (runtime !== null) await runtime.stop();
  } catch (error) {
    teardownErrors.push(`container stop: ${sanitize(safeError(error))}`);
  }
  try {
    if (provider !== null) await provider.stop();
  } catch (error) {
    teardownErrors.push(`provider stop: ${sanitize(safeError(error))}`);
  }
  const runtimeDirForScan: string | null = topology?.runtimeDir ?? null;
  try {
    if (topology !== null) {
      for (const cleanupError of await topology.stop()) {
        teardownErrors.push(`topology stop: ${sanitize(cleanupError)}`);
      }
    }
  } catch (error) {
    teardownErrors.push(`topology stop: ${sanitize(safeError(error))}`);
  }

  // ---- Mandatory final scan AFTER all teardown logs; no skip path. ----
  if (topology !== null && runtimeDirForScan !== null) {
    try {
      const scanDir = mkdtempSync(join(dirname(runtimeDirForScan), 'nlhe-deterministic-challenge-scan-'));
      try {
        const manifestPath = topology.secretRegistry.persistEnvManifest(
          join(scanDir, 'runtime-secrets.env')
        );
        scan = await runFinalSecretScan(context, scannerPath, manifestPath);
      } finally {
        rmSync(scanDir, { recursive: true, force: true });
      }
    } catch (error) {
      scan = 'failed';
      cleanupFailure = sanitize(safeError(error));
    }
  } else {
    scan = 'unavailable';
    cleanupFailure = 'staging topology never started; the mandatory final supervisor/log secret scan could not run';
  }
  if (teardownErrors.length > 0) cleanupFailure = cleanupFailure ?? teardownErrors.join(' | ');
  if (unexpectedDeaths > 0 && failure === null) {
    failure = `${unexpectedDeaths} unexpected supervised unit death(s)`;
  }

  // ---- Final status: any failure, teardown error or non-pass scan is FAIL. ----
  if (failure === null && cleanupFailure !== null) failure = cleanupFailure;
  const status = failure === null ? 'COMPLETE' : 'FAILED';
  const payload: Record<string, unknown> = {
    runId: context.runId,
    mode: 'DETERMINISTIC_CHALLENGE',
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    provider: 'loopback-fake',
    providerBaseUrlHost: provider !== null ? new URL(provider.baseUrl).hostname : null,
    fixturePath,
    sponsorPrincipalId,
    roomId: outcome?.roomId ?? challengeProgress.current?.roomId ?? null,
    tableId: outcome?.tableId ?? challengeProgress.current?.tableId ?? null,
    competitionId: outcome?.competitionId ?? challengeProgress.current?.competitionId ?? null,
    calls: outcome?.calls ?? roomEvidence?.calls ?? null,
    committed: outcome?.committed ?? roomEvidence?.committed ?? null,
    costMicroUsd: outcome?.costMicroUsd ?? roomEvidence?.costMicroUsd ?? null,
    winnerKind: outcome?.winnerKind ?? null,
    prizeStatus: outcome?.prizeStatus ?? null,
    entryAtomic: outcome?.entryAtomic ?? LIVE_CHALLENGE_ENTRY_ATOMIC,
    prizeAtomic: outcome?.prizeAtomic ?? LIVE_CHALLENGE_PRIZE_ATOMIC,
    journalFingerprint: outcome?.journalFingerprint ?? null,
    journalCount: outcome?.journalCount ?? null,
    entryDebitCount: outcome?.entryDebitCount ?? null,
    restart: outcome?.restart ?? null,
    caps: DETERMINISTIC_CHALLENGE_CAPS,
    providerRequests,
    postTerminalRace: {
      requestId: staleCapture.current?.requestId ?? null,
      handId: staleCapture.current?.handId ?? null,
      turnId: staleCapture.current?.turnId ?? null,
      httpStatus: lateActionStatus,
      packetComplete: lateActionPacketComplete,
      durableComplete: lateActionDurableComplete,
      classification: lateActionClassification,
      packetPath: lateActionPacketPath,
    },
    platform429Before,
    platform429After,
    supervisedUnits,
    unexpectedDeaths,
    scan,
    cleanupFailure,
    teardownErrors,
    providerFailures: roomEvidence?.providerFailures ?? [],
    error: failure,
  };
  writeFileSync(
    join(context.artifactDir, DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT),
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (status === 'COMPLETE') {
    context.log(`deterministic challenge acceptance PASS: ${DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT}`);
    return 0;
  }
  console.error(`deterministic challenge acceptance FAILED: ${failure ?? 'cleanup failure'}`);
  return 1;
}

/**
 * Only execute when this file is the process entrypoint: importing the pure
 * helpers (for example from the focused Vitest regression) must never start
 * anything.
 */
function invokedAsEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

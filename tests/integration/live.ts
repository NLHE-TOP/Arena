#!/usr/bin/env tsx
/**
 * Opt-in live-provider acceptance (PAID). Never runs by default.
 *
 *   NLHE_LIVE_ENABLED=1 tsx tests/integration/live.ts
 *     mixed SPONSORED 1H1A room (default);
 *   NLHE_LIVE_ENABLED=1 NLHE_IT_ANVIL=1 tsx tests/integration/live.ts --challenge
 *     valueless real-money ASSET CHALLENGE on the real financial topology.
 *
 * Contract:
 * - loads local `.env` and requires OPENAI_BASE_URL / OPENAI_API_KEY /
 *   OPENAI_MODEL (names only are printed; values are never printed, logged or
 *   passed to any PokerTools child);
 * - caps are FIXED before the run and are never loosened:
 *   calls 24, cost 50_000 micro-USD, per call 5_000 ms, overall 120_000 ms,
 *   hands 8; accounting uses conservative upper rates (input 200_000,
 *   output 1_000_000 micro-USD per million tokens). Agent limits bound each
 *   call at floor(cost cap / call cap) micro-USD so the room budget admits
 *   multiple calls while the room cap stays binding;
 * - a completed room is not enough: the run only passes when at least one
 *   decision reaches COMMITTED through a SUCCEEDED provider attempt (a real
 *   tool call that resolved and was accepted). A room completed purely by
 *   runtime fallback after failed attempts is a FAIL;
 * - `--challenge` requires NLHE_IT_ANVIL=1 and reuses the acceptance financial
 *   topology exactly: real Anvil + in-tree MockUSDC + quorum proxies, platform
 *   COMPETITION_PAID_ENABLED=1, real on-chain payer/sponsor transfers claimed
 *   through the public `claimDeposit` API, the declared
 *   USER_AVAILABLE -> OPERATOR sponsor budget classification, and central
 *   financial READY from the actual custody worker's reconciliation. The payer
 *   opts in directly through the public `CompetitionClient`; the product never
 *   forwards paid entry. In addition to the shared strict checks it requires
 *   the entry charged exactly once, the prize paid/released exactly once
 *   winner-aware, and no duplicate settlement across an actual product restart;
 * - the model is called with a plain forced `choose_action` tool (temperature
 *   0, max_tokens 256). No provider-specific reasoning parameters are sent;
 *   reasoning tokens share the output cap and a missing tool call is recorded
 *   as a validation failure, never worked around by raising caps;
 * - the run goes through the product's own room orchestration and the actual
 *   NLHE runtime. There is no manual provider-decision fallback;
 * - any failure once opted in (including a red platform/product build, missing
 *   runtime, cap exhaustion or an invalid model response) is reported as the
 *   actual FAIL with a non-zero exit, not as "unavailable credentials".
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompetitionClient } from '@pokertools/sdk';
import { createRunContext, type RunContext } from './infra/context.js';
import { startEnvironment, type TestEnvironment } from './infra/environment.js';
import { probeProductSurface, surfaceReady, describeSurface } from './infra/capabilities.js';
import { ensureNlheBuild, startNlhe, writeFakeAgentRoster, type NlheHandle } from './infra/nlhe.js';
import { ephemeralWallet, loginWallet, type WalletSession } from './infra/wallet.js';
import { ensureOperator, type AdminDatabaseTarget } from './infra/admin.js';
import {
  mintOrchestrationToken,
  productAdminToken,
  provisionFakeAgentPrincipals,
  type ProvisionedAgent,
} from './infra/agents.js';
import { ProductApiError, ProductClient, type ProductRoomView } from './acceptance/product-client.js';
import { readRoomEvidence, inspectRoomEvidence } from './acceptance/evidence.js';
import {
  adminDatabaseQuery,
  assertExactlyOnceFinancialJournalsAcrossRestart,
} from './acceptance/financial-journals.js';
import {
  driveHumanSeats,
  type HumanActionObserver,
  type HumanActionRejectionReason,
  type HumanDriverStats,
} from './acceptance/product-room.js';
import { readPlatform429Total, type PlatformMetricsSource } from './acceptance/platform-metrics.js';
import { rateLimitContextLabel } from './infra/trace-platform.js';
import type { FinancialTopology } from './infra/anvil-finance.js';
import { getAccount } from './infra/wallet.js';

/** Fixed, conservative live bounds. Never loosened at runtime. */
export const LIVE_CAPS: Readonly<{
  maxCalls: number;
  maxCostUsdMicro: bigint;
  perCallTimeoutMs: number;
  overallRuntimeMs: number;
  maxHands: number;
}> = Object.freeze({
  maxCalls: 24,
  maxCostUsdMicro: 50_000n,
  perCallTimeoutMs: 5_000,
  overallRuntimeMs: 120_000,
  maxHands: 8,
});

/** Conservative upper rates, micro-USD per 1,000,000 tokens. */
export const LIVE_PRICING = Object.freeze({ input: 200_000, output: 1_000_000 });

/**
 * Bounded per-call cost ceiling derived from the fixed room budget and call
 * cap: floor(50_000 / 24) = 2083 micro-USD. The product reserves each call
 * against the room aggregate, so a per-call ceiling equal to the whole room
 * cap would admit only one billable call; this keeps the room cap binding.
 */
export const LIVE_PER_CALL_COST_USD_MICRO = Math.floor(
  Number(LIVE_CAPS.maxCostUsdMicro) / LIVE_CAPS.maxCalls
);

/** Fixed valueless challenge terms configured into the product (atomic units). */
export const LIVE_CHALLENGE_ENTRY_ATOMIC = '1';
export const LIVE_CHALLENGE_PRIZE_ATOMIC = '2';

/**
 * Assertion bounds injected into the shared live outcome helper, typed from
 * the frozen `LIVE_CAPS`. A call site that passes nothing keeps EXACTLY
 * `LIVE_CAPS` (24 calls / 50 000 micro-USD / 120 000 ms); the deterministic
 * CHALLENGE entrypoint injects its own acceptance bounds explicitly. The live
 * constants are never changed or raised by injection.
 */
export type ChallengeAssertionCaps = Pick<
  typeof LIVE_CAPS,
  'maxCalls' | 'maxCostUsdMicro' | 'overallRuntimeMs'
>;

/**
 * Pure injected cap gate for the shared outcome assertion. Keeping the exact
 * bounds separately testable proves both the LIVE_CAPS default and the
 * deterministic injection without a topology.
 */
export function assertLiveOutcomeCaps(
  calls: number,
  costMicroUsd: number,
  caps: ChallengeAssertionCaps = LIVE_CAPS
): void {
  if (calls > caps.maxCalls) throw new Error(`live call cap exceeded: ${calls}`);
  if (BigInt(costMicroUsd) > caps.maxCostUsdMicro) {
    throw new Error(`live cost cap exceeded: ${costMicroUsd} micro-USD`);
  }
}

/**
 * The product rate-limits its HTTP surface at 120 requests/minute, so room
 * polling is paced at 5s (well under the limit) and any 429 is retried with a
 * bounded backoff instead of hammering the limiter.
 */
const ROOM_POLL_INTERVAL_MS = 5_000;
const RATE_LIMIT_BACKOFF_MS = Object.freeze({ initial: 1_000, max: 15_000, maxRetries: 4 });

/** Product 429s observed by the focused live scenario (must gate to zero). */
const productRateLimits = { responses: 0, retries: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET /api/rooms/:id with bounded backoff on the product's 429 rate limit. */
async function getRoomPaced(product: ProductClient, roomId: string): Promise<ProductRoomView> {
  let delayMs: number = RATE_LIMIT_BACKOFF_MS.initial;
  for (let retry = 0; ; retry += 1) {
    try {
      return await product.getRoom(roomId);
    } catch (error) {
      if (!(error instanceof ProductApiError) || error.status !== 429) throw error;
      productRateLimits.responses += 1;
      const advised = error.retryAfterMs;
      if (advised !== null && advised > RATE_LIMIT_BACKOFF_MS.max) {
        // Never retry earlier than the limiter requires; fail explicitly.
        throw new Error(
          `product advised a ${advised}ms retry wait above the ${RATE_LIMIT_BACKOFF_MS.max}ms bound for ${roomId}; refusing to retry early (last 429: ${
            rateLimitContextLabel() ?? 'endpoint unknown'
          })`,
          { cause: error }
        );
      }
      if (retry >= RATE_LIMIT_BACKOFF_MS.maxRetries) throw error;
      const waitMs = advised ?? delayMs;
      productRateLimits.retries += 1;
      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, RATE_LIMIT_BACKOFF_MS.max);
    }
  }
}

/**
 * Poll one room until `isTarget` accepts it. Every poll is paced at 5s and a
 * FAILED room is surfaced immediately; an optional `abort` fails the wait the
 * moment an attached driver rejects (never waiting for the room timeout), and
 * a timeout names the last observed status so a room that never reaches ACTIVE
 * fails with a clear reason.
 */
async function waitForRoom(
  product: ProductClient,
  roomId: string,
  label: string,
  timeoutMs: number,
  isTarget: (room: ProductRoomView) => boolean,
  abort?: { error: () => unknown }
): Promise<ProductRoomView> {
  const deadline = Date.now() + timeoutMs;
  let last: ProductRoomView | null = null;
  for (;;) {
    const failure = abort?.error();
    if (failure !== null && failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    last = await getRoomPaced(product, roomId);
    if (isTarget(last)) return last;
    if (last.status === 'FAILED') {
      throw new Error(
        `live room ${roomId} failed while waiting for ${label}: ${last.failureReason ?? 'no reason'}`
      );
    }
    if (Date.now() + ROOM_POLL_INTERVAL_MS > deadline) break;
    await sleep(ROOM_POLL_INTERVAL_MS);
  }
  throw new Error(
    `live room ${roomId} did not reach ${label} within ${timeoutMs}ms: last status ${last?.status ?? 'unknown'}${
      last?.failureReason ? ` (${last.failureReason})` : ''
    }`
  );
}

/**
 * Focused live gate: no unexpected rate limit anywhere in the run. An
 * exhausted human backoff is rethrown; a bounded-aside 429 (product or
 * platform, including ones the SDK retried internally) is reported as the
 * actual FAIL instead of disappearing behind a later terminal timeout.
 */
function assertNoRateLimits(
  label: string,
  humanStats: HumanDriverStats,
  humanError: unknown,
  platform429Delta: number
): void {
  if (humanError !== null) {
    throw humanError instanceof Error ? humanError : new Error(String(humanError));
  }
  if (humanStats.rateLimitResponses > 0 || productRateLimits.responses > 0 || platform429Delta > 0) {
    throw new Error(
      `${label}: unexpected rate limit observed (independent platform 429 delta=${platform429Delta}, driver platform 429s=${humanStats.rateLimitResponses} boundedRetries=${humanStats.rateLimitRetries}, product 429s=${productRateLimits.responses} productRetries=${productRateLimits.retries}); normal pacing must gate zero`
    );
  }
}

function loadDotEnv(): void {
  const path = join(process.cwd(), '.env');
  try {
    process.loadEnvFile(path);
  } catch {
    // No local .env: the environment must already carry the credential names.
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`live run opted in but ${name} is not configured`);
  }
  return value;
}

/** Reject any attempt to loosen the fixed caps through the environment. */
export function assertFixedCaps(): void {
  const declared: Array<[string, number]> = [
    ['LIVE_LLM_MAX_CALLS', LIVE_CAPS.maxCalls],
    ['LIVE_LLM_MAX_USD_MICRO', Number(LIVE_CAPS.maxCostUsdMicro)],
    ['LIVE_E2E_MAX_HANDS', LIVE_CAPS.maxHands],
    ['LIVE_E2E_MAX_MS', LIVE_CAPS.overallRuntimeMs],
  ];
  for (const [name, cap] of declared) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value > cap) {
      throw new Error(`${name} may not exceed the fixed live cap ${cap}`);
    }
  }
}

interface LiveMode {
  challenge: boolean;
}

function parseLiveMode(argv: readonly string[]): LiveMode {
  const unknown = argv.filter((argument) => argument !== '--challenge');
  if (unknown.length > 0) throw new Error(`unknown live arguments: ${unknown.join(' ')}`);
  return { challenge: argv.includes('--challenge') };
}

/**
 * Only the environment surface both live scenarios actually consume. The
 * in-repo suite passes a full `TestEnvironment`; the guarded standalone
 * CHALLENGE wrapper builds this from the fresh staging topology (platform
 * handle + admin DB target + read-only financial adapter) without a full
 * `TestEnvironment`.
 */
export type LiveScenarioEnvironment = Pick<TestEnvironment, 'platform' | 'adminTarget' | 'financial'>;

export interface LiveScenarioInput {
  context: RunContext;
  environment: LiveScenarioEnvironment;
  /**
   * The scenarios need exactly the restart capability. The in-repo suite
   * passes the full `NlheHandle`; the guarded standalone CHALLENGE wrapper
   * passes `{ restart: () => runtime.restart('graceful') }` so the standalone
   * container is usable without the process-based handle type.
   */
  nlhe: Pick<NlheHandle, 'restart'>;
  product: ProductClient;
  principals: ProvisionedAgent[];
  databasePath: string;
  /** Independent platform /metrics source for the focused zero-429 gate. */
  platformMetrics: PlatformMetricsSource;
}

export interface LiveRoomOutcome {
  calls: number;
  costMicroUsd: number;
  committed: number;
}

function availableBalance(
  balances: Awaited<ReturnType<WalletSession['client']['getBalances']>>,
  assetId: string
): bigint {
  const row = balances.find((balance) => balance.assetId === assetId);
  return row ? BigInt(row.availableAtomic) : 0n;
}

async function readChallengeBalances(
  financial: FinancialTopology,
  payer: WalletSession,
  sponsor: WalletSession
): Promise<{ payer: bigint; sponsor: bigint; sponsorOperator: bigint }> {
  const [payerBalances, sponsorBalances, sponsorAccounts] = await Promise.all([
    payer.client.getBalances(),
    sponsor.client.getBalances(),
    financial.readPrincipalAccounts(financial.sponsorPrincipalId),
  ]);
  return {
    payer: availableBalance(payerBalances, financial.assetId),
    sponsor: availableBalance(sponsorBalances, financial.assetId),
    sponsorOperator: sponsorAccounts.operator,
  };
}

/**
 * Shared strict outcome assertion for both live modes: room COMPLETE, the
 * injected call/cost caps (absent injection keeps EXACTLY `LIVE_CAPS`),
 * inspector clean over every attempt (including failed), and at least one
 * COMMITTED decision backed by a SUCCEEDED provider attempt.
 */
export async function assertLiveRoomOutcome(input: {
  context: RunContext;
  room: ProductRoomView;
  databasePath: string;
  agentPrincipalIds: ReadonlySet<string>;
  /** Assertion bounds; absent keeps EXACTLY the frozen LIVE_CAPS. */
  caps?: ChallengeAssertionCaps;
}): Promise<LiveRoomOutcome> {
  const evidence = readRoomEvidence(input.databasePath, input.room.id);
  const inspection = await inspectRoomEvidence(evidence, {
    agentPrincipalIds: input.agentPrincipalIds,
  });
  const calls = evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length;
  const cost = evidence.attempts.reduce((sum, attempt) => sum + attempt.cost_micro_usd, 0);
  // A real accepted decision: COMMITTED is only reachable from a SUCCEEDED
  // provider attempt whose legal action the table accepted.
  const committed = evidence.decisions.filter((decision) => decision.status === 'COMMITTED');
  const committedAccepted = committed.filter((decision) =>
    evidence.attempts.some(
      (attempt) => attempt.decision_id === decision.id && attempt.status === 'SUCCEEDED'
    )
  );
  input.context.log(
    `live room ${input.room.status}: calls=${calls} costMicroUsd=${cost} committed=${committedAccepted.length}`
  );

  if (input.room.status !== 'COMPLETE') {
    const failures = evidence.attempts
      .filter((attempt) => attempt.status === 'FAILED')
      .map((attempt) => attempt.error ?? 'unknown')
      .slice(0, 3);
    throw new Error(
      `live room ended ${input.room.status}: ${input.room.failureReason ?? 'no reason'}; attempt failures: ${failures.join(' | ') || 'none'}`
    );
  }
  assertLiveOutcomeCaps(calls, cost, input.caps);
  if (inspection.violations.length > 0) {
    throw new Error(`live evidence violations: ${inspection.violations[0]!.detail}`);
  }
  if (committedAccepted.length === 0) {
    const failures = evidence.attempts
      .filter((attempt) => attempt.status === 'FAILED')
      .map((attempt) => attempt.error ?? 'unknown')
      .slice(0, 3);
    throw new Error(
      `live room produced no COMMITTED decision with a SUCCEEDED attempt: decisions=${evidence.decisions.length} committed=${committed.length} attemptFailures=${failures.join(' | ') || 'none'}`
    );
  }
  return { calls, costMicroUsd: cost, committed: committedAccepted.length };
}

/** Default mixed SPONSORED 1H1A live room (unchanged behavior). */
async function runSponsoredScenario(input: LiveScenarioInput): Promise<void> {
  const { context, environment, product, principals, databasePath } = input;
  const platform429Before = await readPlatform429Total(input.platformMetrics);
  const human = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
  const created = await product.createRoom(
    { name: `live-1H1A-${context.runId}`, mode: 'SPONSORED', humanCount: 1, agentIds: [principals[0]!.agentId] },
    { walletToken: human.token }
  );
  // A SPONSORED room created by a human stays WAITING_FOR_ROSTER until its
  // creator starts it; without this the product never provisions and the
  // room can never make a provider call.
  const started = await product.startRoom(created.id, { walletToken: human.token });
  context.log(`live room ${created.id} started: status=${started.status}`);
  const active = await waitForRoom(
    product,
    created.id,
    'ACTIVE',
    60_000,
    (room) => room.status === 'ACTIVE'
  );
  if (active.pokerTableId === null) throw new Error('live room ACTIVE without a table');
  context.log(`live room ${created.id} ACTIVE: table=${active.pokerTableId}`);

  let terminal = false;
  let humanStats: HumanDriverStats = { observations: 0, actions: 0, rateLimitResponses: 0, rateLimitRetries: 0 };
  let humanError: unknown = null;
  let notifyDriverSettled: () => void = () => {};
  const driverSettled = new Promise<void>((resolve) => {
    notifyDriverSettled = resolve;
  });
  const humanDriver = driveHumanSeats({
    humans: [human],
    tableId: active.pokerTableId,
    isTerminal: () => terminal,
  })
    .then((stats) => {
      humanStats = stats;
    })
    .catch((error: unknown) => {
      // Captured immediately; the terminal wait below aborts on it so the
      // exact failure is never masked by the room timeout.
      humanError = error;
    })
    .finally(notifyDriverSettled);
  const driverFailure: Promise<never> = driverSettled.then(async (): Promise<never> => {
    if (humanError !== null) throw humanError;
    return await new Promise<never>(() => {});
  });
  const roomWait = waitForRoom(
    product,
    created.id,
    'terminal',
    LIVE_CAPS.overallRuntimeMs,
    (room) => room.status === 'COMPLETE' || room.status === 'FAILED',
    { error: () => humanError }
  );
  let finished: ProductRoomView;
  try {
    finished = await Promise.race([roomWait, driverFailure]);
  } finally {
    // Bounded cancellation/drain: stop the driver loop and settle every
    // branch so no promise is left unhandled.
    terminal = true;
    void driverFailure.catch(() => undefined);
    await humanDriver.catch(() => undefined);
    void roomWait.catch(() => undefined);
  }
  context.log(
    `live human driver: observations=${humanStats.observations} actions=${humanStats.actions} platform429s=${humanStats.rateLimitResponses} boundedRetries=${humanStats.rateLimitRetries}`
  );
  const platform429After = await readPlatform429Total(input.platformMetrics);
  assertNoRateLimits('live sponsored', humanStats, humanError, platform429After - platform429Before);

  const outcome = await assertLiveRoomOutcome({
    context,
    room: finished,
    databasePath,
    agentPrincipalIds: new Set(principals.map((principal) => principal.principalId)),
  });
  // eslint-disable-next-line no-console
  console.log(
    `live acceptance completed: calls=${outcome.calls} costMicroUsd=${outcome.costMicroUsd} committed=${outcome.committed}`
  );
}

interface ChallengeSettlementInput {
  context: RunContext;
  nlhe: Pick<NlheHandle, 'restart'>;
  product: ProductClient;
  financial: FinancialTopology;
  payer: WalletSession;
  sponsor: WalletSession;
  agentPrincipalId: string;
  competitionId: string;
  competitions: CompetitionClient;
  entryAtomic: bigint;
  prizeAtomic: bigint;
  room: ProductRoomView;
  /** Operator database target for read-only exactly-once journal evidence. */
  adminTarget: AdminDatabaseTarget;
}

/** Safe, serializable settlement + journal result for the live CHALLENGE run. */
export interface ChallengeSettlementOutcome {
  winnerKind: 'HUMAN' | 'AGENT';
  prizeStatus: string;
  journalFingerprint: string;
  journalCount: number;
  entryDebitCount: number;
}

/**
 * Winner-aware exactly-once settlement on the real ledger: the reserved prize
 * is either paid to the WALLET winner or released to the sponsor; the entry
 * stays with the sponsor's OPERATOR account. Exact equality (never `>=`) proves
 * one charge and one disposition, and an actual product restart must not change
 * any of it.
 */
export async function assertChallengeSettlement(
  input: ChallengeSettlementInput
): Promise<ChallengeSettlementOutcome> {
  const { context, financial, payer, sponsor, competitions, entryAtomic, prizeAtomic, room } = input;
  const winner = (room.results ?? []).find((placement) => placement.finishPosition === 1) ?? null;
  if (winner === null) throw new Error('completed challenge room has no placement-1 winner');
  const payerWon = winner.participantId === payer.userId;
  const settled = await competitions.getCompetition(input.competitionId);
  const expectedPrizeStatus = winner.kind === 'HUMAN' ? 'PAID' : 'RELEASED';
  if (settled.prizeStatus !== expectedPrizeStatus) {
    throw new Error(
      `prize status ${settled.prizeStatus} != ${expectedPrizeStatus} for a ${winner.kind} winner (prize must be paid/released exactly once)`
    );
  }
  const settledPayer = settled.entrants.find((entrant) => entrant.principalId === payer.userId);
  if (settledPayer?.entryState !== 'PAID') {
    throw new Error(`payer entry state after settlement ${settledPayer?.entryState ?? 'missing'} != PAID`);
  }
  const settledAgent = settled.entrants.find(
    (entrant) => entrant.principalId === input.agentPrincipalId
  );
  if (settledAgent?.entryState !== 'NOT_REQUIRED') {
    throw new Error(
      `agent entry state after settlement ${settledAgent?.entryState ?? 'missing'} != NOT_REQUIRED (SERVICE entrants never pay)`
    );
  }
  const after = await readChallengeBalances(financial, payer, sponsor);
  const expectedPayer = payerWon ? prizeAtomic : 0n;
  const expectedOperator = winner.kind === 'HUMAN' ? entryAtomic : entryAtomic + prizeAtomic;
  if (after.payer !== expectedPayer) {
    throw new Error(
      `payer available ${after.payer} != expected ${expectedPayer} (winner=${winner.kind}, payerWon=${payerWon})`
    );
  }
  if (after.sponsor !== 0n) {
    throw new Error(`sponsor prize budget was not consumed exactly once: ${after.sponsor}`);
  }
  if (after.sponsorOperator !== expectedOperator) {
    throw new Error(
      `sponsor operator balance ${after.sponsorOperator} != expected ${expectedOperator} (winner=${winner.kind})`
    );
  }
  context.log(
    `challenge settlement: winner=${winner.kind} payerWon=${payerWon} prizeStatus=${settled.prizeStatus} entryAtomic=${entryAtomic} prizeAtomic=${prizeAtomic}`
  );

  // Restart the actual product process: durable recovery/reconciliation must
  // not charge the entry or settle the prize a second time. Exactly-once
  // journal evidence is captured around this EXISTING restart only: validate
  // the terminal ledger first, restart once, then require byte-identical
  // evidence (no extra paid run, no second financial restart).
  const journalEvidence = await assertExactlyOnceFinancialJournalsAcrossRestart({
    query: adminDatabaseQuery(input.adminTarget),
    competitionId: input.competitionId,
    expectations: {
      status: 'FINISHED',
      prizeStatus: expectedPrizeStatus,
      expectedPayerPrincipalIds: [payer.userId],
      expectedServicePrincipalIds: [input.agentPrincipalId],
    },
    restart: async () => {
      await input.nlhe.restart();
      await sleep(8_000);
    },
  });
  context.log(
    `challenge financial journals: fingerprint=${journalEvidence.fingerprint.slice(0, 16)} journals=${journalEvidence.digest.journalCount} entryDebits=${journalEvidence.digest.entryDebits.length} prize=${journalEvidence.digest.prizeStatus}`
  );
  writeFileSync(
    join(context.artifactDir, 'challenge-financial-journals.json'),
    `${JSON.stringify(
      {
        competitionId: journalEvidence.digest.competitionId,
        status: journalEvidence.digest.status,
        prizeStatus: journalEvidence.digest.prizeStatus,
        winnerKind: winner.kind,
        entryDebits: journalEvidence.digest.entryDebits,
        journalCount: journalEvidence.digest.journalCount,
        requestIds: journalEvidence.digest.requestIds,
        fingerprint: journalEvidence.fingerprint,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  const afterRestart = await readChallengeBalances(financial, payer, sponsor);
  if (
    afterRestart.payer !== after.payer ||
    afterRestart.sponsor !== after.sponsor ||
    afterRestart.sponsorOperator !== after.sponsorOperator
  ) {
    throw new Error('restart/reconcile settled the valueless challenge a second time');
  }
  const settledAfterRestart = await competitions.getCompetition(input.competitionId);
  if (settledAfterRestart.prizeStatus !== settled.prizeStatus) {
    throw new Error(
      `prize status changed across restart: ${settled.prizeStatus} -> ${settledAfterRestart.prizeStatus}`
    );
  }
  const payerAfterRestart = settledAfterRestart.entrants.find(
    (entrant) => entrant.principalId === payer.userId
  );
  if (payerAfterRestart?.entryState !== 'PAID') {
    throw new Error(`payer entry state changed across restart: ${payerAfterRestart?.entryState ?? 'missing'}`);
  }
  const roomAfterRestart = await input.product.getRoom(room.id);
  if (roomAfterRestart.status !== 'COMPLETE') {
    throw new Error(`challenge room after restart ${roomAfterRestart.status} != COMPLETE`);
  }
  return {
    winnerKind: winner.kind,
    prizeStatus: settled.prizeStatus,
    journalFingerprint: journalEvidence.fingerprint,
    journalCount: journalEvidence.digest.journalCount,
    entryDebitCount: journalEvidence.digest.entryDebits.length,
  };
}

/** Safe progress snapshot emitted by the live CHALLENGE scenario. */
export interface LiveChallengeProgress {
  roomId: string;
  status: string;
  tableId: string | null;
  competitionId: string | null;
  /**
   * Latest canonical SDK human action identity (metadata only). `pending`
   * after submission, then `accepted`/`rejected`; a rejected or
   * network-interrupted request keeps its exact requestId so the failure
   * packet never falls back to an older agent FOLD.
   */
  canonicalHumanAction?: LiveChallengeHumanAction | null;
}

export interface LiveChallengeHumanAction {
  tableId: string;
  handId: string | null;
  requestId: string;
  turnId: string;
  actionId: string;
  state: 'pending' | 'accepted' | 'rejected';
  /** Bounded reason when `state === 'rejected'`; never free text. */
  rejection: HumanActionRejectionReason | null;
  /** HTTP status when known (metadata only). */
  status: number | null;
}

export interface LiveChallengeObserver {
  /** Called after each durable room transition; never carries credentials. */
  onProgress?(progress: LiveChallengeProgress): void;
}

/**
 * Safe, serializable outcome of one completed live CHALLENGE scenario. It
 * carries exactly the evidence the guarded standalone wrapper persists:
 * calls/committed/cost, winner, entry/prize disposition, the unchanged journal
 * fingerprint and the completed restart.
 */
export interface LiveChallengeOutcome {
  roomId: string;
  tableId: string | null;
  competitionId: string;
  calls: number;
  costMicroUsd: number;
  committed: number;
  winnerKind: 'HUMAN' | 'AGENT';
  prizeStatus: string;
  entryAtomic: string;
  prizeAtomic: string;
  /** Journal evidence fingerprint captured around the one existing restart. */
  journalFingerprint: string;
  journalCount: number;
  entryDebitCount: number;
  /** The one existing product restart completed with unchanged evidence. */
  restart: true;
}

/**
 * Valueless real-money CHALLENGE 1H1A on the actual financial topology. The
 * room itself is product-orchestrated; the harness only funds/claims real
 * on-chain value, opts the payer in through the public SDK and asserts the
 * exactly-once, winner-aware settlement. The optional `caps` injection binds
 * the terminal wait and the shared outcome assertion; absent injection keeps
 * EXACTLY `LIVE_CAPS`, so every paid call site is unchanged.
 */
export async function runChallengeScenario(
  input: LiveScenarioInput,
  observer?: LiveChallengeObserver,
  /** Terminal-wait/outcome assertion bounds; default EXACTLY LIVE_CAPS. */
  caps: ChallengeAssertionCaps = LIVE_CAPS
): Promise<LiveChallengeOutcome> {
  const { context, environment, product, principals, databasePath } = input;
  let lastRoom: ProductRoomView | null = null;
  let humanAction: LiveChallengeHumanAction | null = null;
  const emit = (room: ProductRoomView): void => {
    lastRoom = room;
    observer?.onProgress?.({
      roomId: room.id,
      status: room.status,
      tableId: room.pokerTableId,
      competitionId: room.pokerCompetitionId,
      canonicalHumanAction: humanAction,
    });
  };
  const notify = (room: ProductRoomView): void => emit(room);
  const emitHumanAction = (): void => {
    if (lastRoom === null) return;
    emit(lastRoom);
  };
  const platform429Before = await readPlatform429Total(input.platformMetrics);
  const financial = environment.financial;
  if (financial === null) {
    throw new Error(
      'the live CHALLENGE scenario requires the real financial topology (NLHE_IT_ANVIL=1 with locally provisioned PostgreSQL)'
    );
  }
  const platformBaseUrl = environment.platform.baseUrl;

  // Deterministic Anvil-funded wallets: index 1 pays the entry, index 2 is the
  // pre-seeded prize sponsor. Both are real on-chain token holders.
  const payer = await loginWallet(platformBaseUrl, getAccount(1));
  const sponsor = await loginWallet(platformBaseUrl, getAccount(2));
  if (sponsor.userId !== financial.sponsorPrincipalId) {
    throw new Error('challenge sponsor wallet did not resolve to the pre-seeded sponsor principal');
  }

  // Server-configured terms are authoritative; the client only mirrors them.
  const config = (await product.getConfig()) as {
    challenge?: {
      enabled?: boolean;
      terms?: { assetId?: string; entryAtomic?: string; prizeAtomic?: string; termsVersion?: string } | null;
    } | null;
  };
  const terms = config.challenge?.terms ?? null;
  if (config.challenge?.enabled !== true || !terms?.assetId || !terms.entryAtomic || !terms.prizeAtomic) {
    throw new Error(`live challenge product terms are not enabled/configured: ${JSON.stringify(config)}`);
  }
  if (terms.assetId !== financial.assetId) {
    throw new Error(
      `product challenge asset ${terms.assetId} does not match the provisioned asset ${financial.assetId}`
    );
  }
  if (
    terms.entryAtomic !== LIVE_CHALLENGE_ENTRY_ATOMIC ||
    terms.prizeAtomic !== LIVE_CHALLENGE_PRIZE_ATOMIC
  ) {
    throw new Error(
      `product challenge terms entry=${terms.entryAtomic} prize=${terms.prizeAtomic} do not match the fixed live terms ${LIVE_CHALLENGE_ENTRY_ATOMIC}/${LIVE_CHALLENGE_PRIZE_ATOMIC}`
    );
  }
  const entryAtomic = BigInt(terms.entryAtomic);
  const prizeAtomic = BigInt(terms.prizeAtomic);

  // Real on-chain backing for exactly the claimed amounts: payer funds the
  // entry, sponsor funds the prize. Every balance below comes from a public
  // claim of an exact on-chain Transfer log.
  await financial.fundAndClaim(payer, 1, entryAtomic);
  // The API caches one lazy deposit-verifier registry per process. Restart only
  // the API between the two public claims so the second claim cannot inherit a
  // poisoned cached registry (workers and the platform stay up).
  await environment.platform.restartApi?.();
  await financial.fundAndClaim(sponsor, 2, prizeAtomic);
  context.log('challenge: on-chain payer/sponsor transfers claimed through the public claimDeposit API');

  const payerBefore = availableBalance(await payer.client.getBalances(), financial.assetId);
  if (payerBefore !== entryAtomic) throw new Error(`payer available ${payerBefore} != entry ${entryAtomic}`);
  const sponsorBefore = await financial.readPrincipalAccounts(financial.sponsorPrincipalId);
  if (sponsorBefore.available !== prizeAtomic || sponsorBefore.operator !== 0n) {
    throw new Error(
      `sponsor claimed funds are not USER_AVAILABLE=${sponsorBefore.available}/OPERATOR=${sponsorBefore.operator} as expected before bootstrap`
    );
  }
  // Declared infrastructure fixture ONLY (documented): classify the already
  // claimed prize budget from the sponsor's USER_AVAILABLE to the same
  // principal's OPERATOR account, which the platform prize reserve debits.
  // Balanced and idempotent; it creates no value and touches no payer balance.
  const sponsorBudget = await financial.bootstrapSponsorBudget(prizeAtomic);
  if (sponsorBudget.available !== 0n || sponsorBudget.operator !== prizeAtomic) {
    throw new Error(
      `sponsor budget bootstrap failed: available=${sponsorBudget.available} operator=${sponsorBudget.operator}`
    );
  }
  context.log('challenge: declared sponsor budget classification applied (USER_AVAILABLE -> OPERATOR)');

  // Only now start the ACTUAL custody worker: it produces heartbeats and
  // matched reconciliation evidence without ever observing the transient
  // transfer/claim window (which would open a shortfall incident and freeze the
  // asset before the paid flow begins).
  await financial.startCustody();
  await financial.waitForReady();
  context.log('challenge: central financial state READY from real custody reconciliation');

  // CHALLENGE room with the server-configured terms. The product API never
  // forwards paid entry: the payer opts in directly through the public
  // CompetitionClient once provisioning has returned the competition reference.
  const created = await product.createRoom(
    {
      name: `live-challenge-1H1A-${context.runId}`,
      mode: 'CHALLENGE',
      humanCount: 1,
      agentIds: [principals[0]!.agentId],
      finance: {
        assetId: financial.assetId,
        entryAtomic: terms.entryAtomic,
        prizeAtomic: terms.prizeAtomic,
        optIn: true,
      },
    },
    { walletToken: payer.token }
  );
  let room = await product.startRoom(created.id, { walletToken: payer.token });
  notify(room);
  context.log(
    `challenge room ${created.id} started: status=${room.status} competition=${room.pokerCompetitionId ?? 'pending'}`
  );
  if (room.status === 'PROVISIONING' && room.pokerCompetitionId === null) {
    throw new Error(
      'challenge room is PROVISIONING without a competition reference (platform provisioning did not record the paid competition)'
    );
  }
  if (room.status === 'PROVISIONING' && room.pokerCompetitionId !== null) {
    const payerCompetitions = new CompetitionClient({
      baseUrl: platformBaseUrl,
      token: payer.token,
      timeout: 30_000,
    });
    await payerCompetitions.optIn(room.pokerCompetitionId);
    room = await product.startRoom(created.id, { walletToken: payer.token });
    notify(room);
    context.log(`challenge room ${created.id} resumed after payer opt-in: status=${room.status}`);
  }
  const active = await waitForRoom(
    product,
    created.id,
    'ACTIVE',
    60_000,
    (candidate) => candidate.status === 'ACTIVE'
  );
  if (active.pokerTableId === null) throw new Error('challenge room ACTIVE without a table');
  const competitionId = active.pokerCompetitionId;
  if (competitionId === null) throw new Error('challenge room ACTIVE without a competition id');
  notify(active);
  context.log(
    `challenge room ${created.id} ACTIVE: table=${active.pokerTableId} competition=${competitionId}`
  );

  // Entry charged exactly once, before a single hand is played.
  const competitions = new CompetitionClient({
    baseUrl: platformBaseUrl,
    token: payer.token,
    timeout: 30_000,
  });
  const funded = await competitions.getCompetition(competitionId);
  if (funded.mode !== 'ASSET') throw new Error(`challenge competition mode ${funded.mode} != ASSET`);
  const payerEntrant = funded.entrants.find((entrant) => entrant.principalId === payer.userId);
  if (payerEntrant?.entryState !== 'PAID') {
    throw new Error(
      `payer entry state ${payerEntrant?.entryState ?? 'missing'} != PAID (entry must be charged exactly once)`
    );
  }
  const agentEntrant = funded.entrants.find(
    (entrant) => entrant.principalId === principals[0]!.principalId
  );
  if (agentEntrant?.entryState !== 'NOT_REQUIRED') {
    throw new Error(
      `agent entry state ${agentEntrant?.entryState ?? 'missing'} != NOT_REQUIRED (SERVICE entrants never pay)`
    );
  }
  if (funded.prizeStatus !== 'RESERVED') {
    throw new Error(`prize status ${funded.prizeStatus} != RESERVED before play`);
  }
  const payerAfterEntry = availableBalance(await payer.client.getBalances(), financial.assetId);
  if (payerAfterEntry !== 0n) {
    throw new Error(`payer available after entry ${payerAfterEntry} != 0 (entry charged exactly once)`);
  }

  let terminal = false;
  let humanStats: HumanDriverStats = { observations: 0, actions: 0, rateLimitResponses: 0, rateLimitRetries: 0 };
  let humanError: unknown = null;
  let notifyDriverSettled: () => void = () => {};
  const driverSettled = new Promise<void>((resolve) => {
    notifyDriverSettled = resolve;
  });
  const humanActionObserver: HumanActionObserver = {
    onSubmitted: (submitted) => {
      humanAction = { ...submitted, state: 'pending', rejection: null, status: null };
      emitHumanAction();
    },
    onAcceptedAction: (capture) => {
      if (humanAction !== null && humanAction.requestId === capture.receipt.requestId) {
        humanAction = { ...humanAction, state: 'accepted' };
        emitHumanAction();
      }
    },
    onRejected: (rejected) => {
      if (humanAction !== null && humanAction.requestId === rejected.requestId) {
        humanAction = {
          ...humanAction,
          state: 'rejected',
          rejection: rejected.reason,
          status: rejected.status,
        };
        emitHumanAction();
      }
    },
  };
  const humanDriver = driveHumanSeats({
    humans: [payer],
    tableId: active.pokerTableId,
    isTerminal: () => terminal,
    humanActionObserver,
  })
    .then((stats) => {
      humanStats = stats;
    })
    .catch((error: unknown) => {
      humanError = error;
    })
    .finally(notifyDriverSettled);
  const driverFailure: Promise<never> = driverSettled.then(async (): Promise<never> => {
    if (humanError !== null) throw humanError;
    return await new Promise<never>(() => {});
  });
  const roomWait = waitForRoom(
    product,
    created.id,
    'terminal',
    caps.overallRuntimeMs,
    (candidate) => candidate.status === 'COMPLETE' || candidate.status === 'FAILED',
    { error: () => humanError }
  );
  let finished: ProductRoomView;
  try {
    finished = await Promise.race([roomWait, driverFailure]);
  } finally {
    terminal = true;
    void driverFailure.catch(() => undefined);
    await humanDriver.catch(() => undefined);
    void roomWait.catch(() => undefined);
  }
  context.log(
    `live challenge human driver: observations=${humanStats.observations} actions=${humanStats.actions} platform429s=${humanStats.rateLimitResponses} boundedRetries=${humanStats.rateLimitRetries}`
  );
  notify(finished);
  const platform429After = await readPlatform429Total(input.platformMetrics);
  assertNoRateLimits('live challenge', humanStats, humanError, platform429After - platform429Before);

  // The room may have failed on the provider budget/runtime; in that case the
  // shared assertion below reports the room failure and its attempt errors.
  const settlement =
    finished.status === 'COMPLETE'
      ? await assertChallengeSettlement({
          context,
          nlhe: input.nlhe,
          product,
          financial,
          payer,
          sponsor,
          agentPrincipalId: principals[0]!.principalId,
          competitionId,
          competitions,
          entryAtomic,
          prizeAtomic,
          room: finished,
          adminTarget: environment.adminTarget,
        })
      : null;
  const outcome = await assertLiveRoomOutcome({
    context,
    room: finished,
    databasePath,
    agentPrincipalIds: new Set(principals.map((principal) => principal.principalId)),
    caps,
  });
  if (settlement === null) {
    throw new Error(`challenge room ${finished.id} ended ${finished.status} without a settlement`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `live challenge acceptance completed: calls=${outcome.calls} costMicroUsd=${outcome.costMicroUsd} committed=${outcome.committed} winner=${settlement.winnerKind} prizeStatus=${settlement.prizeStatus} journalFingerprint=${settlement.journalFingerprint.slice(0, 16)}`
  );
  return {
    roomId: created.id,
    tableId: active.pokerTableId,
    competitionId,
    calls: outcome.calls,
    costMicroUsd: outcome.costMicroUsd,
    committed: outcome.committed,
    winnerKind: settlement.winnerKind,
    prizeStatus: settlement.prizeStatus,
    entryAtomic: entryAtomic.toString(),
    prizeAtomic: prizeAtomic.toString(),
    journalFingerprint: settlement.journalFingerprint,
    journalCount: settlement.journalCount,
    entryDebitCount: settlement.entryDebitCount,
    restart: true,
  };
}

async function main(): Promise<void> {
  if (process.env.NLHE_LIVE_ENABLED !== '1') {
    // eslint-disable-next-line no-console
    console.log('PENDING live suite: set NLHE_LIVE_ENABLED=1 to opt in explicitly');
    process.exitCode = 2;
    return;
  }

  const mode = parseLiveMode(process.argv.slice(2));
  loadDotEnv();
  if (mode.challenge && process.env.NLHE_IT_ANVIL !== '1') {
    throw new Error(
      'the live CHALLENGE scenario requires NLHE_IT_ANVIL=1 so the harness provisions the real Anvil financial topology (Anvil + MockUSDC + quorum proxies + actual custody worker) before the platform starts'
    );
  }
  assertFixedCaps();
  const baseUrl = requireEnv('OPENAI_BASE_URL');
  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = requireEnv('OPENAI_MODEL');
  const providerHost = new URL(baseUrl).host;
  // Non-secret metadata only. Credential values are never printed.
  // eslint-disable-next-line no-console
  console.log(
    [
      'live suite configuration:',
      `  provider host: ${providerHost}`,
      `  model: ${model}`,
      `  caps: calls=${LIVE_CAPS.maxCalls} costMicroUsd=${LIVE_CAPS.maxCostUsdMicro} perCallCostMicroUsd=${LIVE_PER_CALL_COST_USD_MICRO} perCallMs=${LIVE_CAPS.perCallTimeoutMs} overallMs=${LIVE_CAPS.overallRuntimeMs} hands=${LIVE_CAPS.maxHands}`,
      `  conservative rates (microUsd/1M): input=${LIVE_PRICING.input} output=${LIVE_PRICING.output}`,
    ].join('\n')
  );

  const context = createRunContext();
  context.log(
    `live acceptance ${context.runId} (${mode.challenge ? 'challenge' : 'sponsored'}; host ${providerHost}, model ${model})`
  );
  // The valueless challenge needs the real financial topology provisioned
  // before the platform starts (Asset registry, sponsor allowlist, paid
  // admission); the default SPONSORED path starts no financial topology.
  const sponsorFixture = mode.challenge
    ? { sponsorPrincipalId: randomUUID(), sponsorAddress: getAccount(2).address }
    : null;
  const environment = await startEnvironment(context, {
    allowExternal: true,
    ...(sponsorFixture ? { financial: sponsorFixture } : {}),
  });
  let nlhe: NlheHandle | null = null;
  try {
    const admin = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('live operator wallet was not promoted to ADMIN');
    // The orchestrator credential must exist before the SERVICE principals so
    // every agent is delegated to it; the platform rejects SERVICE entrants
    // that are not delegated to the competition organizer.
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl,
      model,
      pricing: LIVE_PRICING,
      limits: {
        maxCallsPerRoom: LIVE_CAPS.maxCalls,
        maxCostMicroUsdPerRoom: Number(LIVE_CAPS.maxCostUsdMicro),
        maxCostMicroUsdPerCall: LIVE_PER_CALL_COST_USD_MICRO,
      },
      principals,
    });
    const databasePath = join(context.artifactDir, 'nlhe-live.sqlite');

    if (mode.challenge && environment.financial === null) {
      throw new Error(
        'the live CHALLENGE scenario requires the real financial topology (NLHE_IT_ANVIL=1 with locally provisioned PostgreSQL)'
      );
    }

    await ensureNlheBuild(context);
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: baseUrl,
      openaiApiKey: apiKey,
      openaiModel: model,
      databasePath,
      agentsConfigPath: roster.path,
      maxProviderCalls: LIVE_CAPS.maxCalls,
      maxCostUsdMicro: Number(LIVE_CAPS.maxCostUsdMicro),
      perCallTimeoutMs: LIVE_CAPS.perCallTimeoutMs,
      overallRuntimeMs: LIVE_CAPS.overallRuntimeMs,
      maxHands: LIVE_CAPS.maxHands,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: productAdminToken(),
        MAX_PROVIDER_CONCURRENCY: '2',
        // Challenge mode configures the fixed valueless terms server-side; the
        // scenario reads them back from /api/config and never trusts the client.
        ...(environment.financial
          ? {
              CHALLENGE_ENABLED: '1',
              CHALLENGE_ASSET_ID: environment.financial.assetId,
              CHALLENGE_ENTRY_ATOMIC: LIVE_CHALLENGE_ENTRY_ATOMIC,
              CHALLENGE_PRIZE_ATOMIC: LIVE_CHALLENGE_PRIZE_ATOMIC,
              CHALLENGE_SPONSOR_PRINCIPAL_ID: environment.financial.sponsorPrincipalId,
            }
          : {}),
      },
    });

    const surface = await probeProductSurface(nlhe.baseUrl);
    if (!surfaceReady(surface)) {
      throw new Error(`product surface is incomplete: ${describeSurface(surface)}`);
    }
    const product = new ProductClient(nlhe.baseUrl);
    const scenario: LiveScenarioInput = {
      context,
      environment,
      nlhe,
      product,
      principals,
      databasePath,
      platformMetrics: {
        url: environment.platform.baseUrl,
        token: process.env.NLHE_IT_PLATFORM_METRICS_TOKEN ?? null,
      },
    };
    if (mode.challenge) {
      await runChallengeScenario(scenario);
    } else {
      await runSponsoredScenario(scenario);
    }
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
}

/**
 * Only execute when this file is the process entrypoint. Importing the shared
 * caps or outcome helper (for example from the guarded standalone live
 * wrapper) must never start a paid scenario or print PENDING.
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
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

/**
 * One mandatory roster run against the product's own room orchestration.
 *
 * The product (not this harness) creates/starts the generic platform
 * competition and attaches the agent runtime; agents decide through the real
 * loopback provider. The harness only:
 * - authenticates human participants with real SIWE wallets and plays their
 *   seats through the public SDK (a human is a player, not an orchestrator);
 * - waits for the product-owned runtime to drive every agent seat;
 * - reads the product's persisted decisions/attempts read-only and inspects
 *   the exact recorded requests against the saved observation and chat source.
 */
import type { CanonicalActionResult, SeatObservation } from '@pokertools/types';
import {
  buildCanonicalActionCapture,
  type CanonicalActionCapture,
  type CapturedCanonicalRequest,
} from './canonical-capture.js';
import type { TestEnvironment } from '../infra/environment.js';
import type { RunContext } from '../infra/context.js';
import type { FakeProviderHandle } from '../infra/fake-provider.js';
import type { WalletSession } from '../infra/wallet.js';
import { waitFor } from '../infra/gameplay.js';
import { rateLimitContextLabel } from '../infra/trace-platform.js';
import { readRoomEvidence, inspectRoomEvidence, type EvidenceInspection, type RoomEvidence } from './evidence.js';
import { readPlatform429Total, type PlatformMetricsSource } from './platform-metrics.js';
import type { ProductClient, ProductRoomView } from './product-client.js';
import type { RosterSpec } from './roster.js';

export interface ProductRoomRunInput {
  spec: RosterSpec;
  context: RunContext;
  environment: TestEnvironment;
  product: ProductClient;
  /** Human wallet sessions (at least spec.humans). */
  humans: readonly WalletSession[];
  /** Provisioned agent ids for this roster (at least spec.agents). */
  agentIds: readonly string[];
  /** Durable agent principals for evidence ownership checks. */
  agentPrincipalIds: ReadonlySet<string>;
  fakeProvider: FakeProviderHandle;
  /** Product SQLite path (read-only evidence). */
  productDatabasePath: string;
  /** Paid ASSET terms; when present the room is CHALLENGE with the human payer. */
  challenge?: {
    assetId: string;
    entryAtomic: string;
    prizeAtomic: string;
  } | null;
  /** Hook after the room is ACTIVE and before completion waiting. */
  onActive?: (room: ProductRoomView) => Promise<void>;
  /** Evidence hook called only after a human canonical SDK action succeeds. */
  onHumanAction?: (observation: SeatObservation) => void;
  /**
   * Mixed-audit rooms: drive human seats passively (CHECK/CALL/FOLD only)
   * until the loopback provider has served this many requests for the table,
   * then switch to aggressive play. Keeps the bounded family/sizing intro real.
   */
  passiveHumanIntro?: { untilProviderRequests: number } | null;
  /** Human seat pacing overrides (idle sweep/think time/429 bounds). */
  humanPacing?: HumanDriverPacing;
  /**
   * Optional forced human action policy (for example the first legal FOLD)
   * whose accepted capture hook is awaited before the driver continues.
   */
  humanActionSelection?: HumanActionSelection | null;
  /**
   * Focused gates (deterministic 1H1A): fail when the run observed any rate
   * limit. Requires `platformMetrics` so the gate is backed by the platform's
   * own 429 counter, not only by errors that survived the SDK's internal
   * retries.
   */
  requireNoRateLimit?: boolean;
  /** Independent platform `/metrics` source for the zero-429 gate. */
  platformMetrics?: PlatformMetricsSource | null;
  /** Hook invoked on every poll while the room is not yet terminal. */
  onTick?: (room: ProductRoomView) => Promise<void>;
  maxWaitMs?: number;
  /** Called when the room reaches a terminal state (for restart planning). */
  onTerminal?: (room: ProductRoomView, evidence: RoomEvidence) => Promise<void>;
}

export interface ProductRoomRunResult {
  room: ProductRoomView;
  evidence: RoomEvidence;
  inspection: EvidenceInspection;
  providerRequests: number;
  persistedAttempts: number;
  tableId: string;
  /** Human seat driver counters, including any bounded rate-limit backoff. */
  humanDriver: HumanDriverStats;
  /** Platform 429 delta measured from `/metrics` (null when not measured). */
  platform429: number | null;
}

/** Auditable counters for one human seat driving pass. */
export interface HumanDriverStats {
  observations: number;
  actions: number;
  /** Calls that exhausted the SDK's own retries with an HTTP 429. */
  rateLimitResponses: number;
  /** Bounded retries the driver itself performed after a 429. */
  rateLimitRetries: number;
}

/**
 * Human-plausible pacing. The sweep cadence applies to ACTIVE and idle sweeps
 * alike: after a successful quick CHECK/CALL the driver still waits the
 * residual minimum before its next observation sweep, so a fast server cannot
 * turn the loop into a busy request stream. The acting human pauses for a short
 * think time before submitting, and a platform 429 is retried a bounded number
 * of times honoring the server's advised delay.
 */
export interface HumanDriverPacing {
  /** Minimum interval between full seat sweeps (active and idle). */
  pollIntervalMs?: number;
  /** Think time before submitting a server-issued action. */
  actionDelayMs?: number;
  /** Bounded driver-level retries after the SDK's own 429 retries are spent. */
  rateLimitMaxRetries?: number;
  /** Hard cap for one 429 backoff wait, whatever the server advises. */
  rateLimitMaxDelayMs?: number;
}

export const HUMAN_DRIVER_PACING = Object.freeze({
  // One human: a 2.5s cadence between observation/action exchanges. Multi-seat
  // rooms sweep every seat within one cadence window.
  pollIntervalMs: 2_500,
  actionDelayMs: 200,
  rateLimitMaxRetries: 3,
  rateLimitMaxDelayMs: 15_000,
});

/** One caller-selected server-issued action for a human seat. */
export interface HumanSelectedAction {
  action: SeatObservation['legalActions'][number];
  /** Optional chip amount for a BET/RAISE selection; omitted keeps the UI default. */
  amount?: number;
}

/** Metadata-only canonical human action identity (never cards or bodies). */
export interface HumanActionIdentity {
  tableId: string;
  /** Observation hand id; null when the observation carries none. */
  handId: string | null;
  requestId: string;
  turnId: string;
  actionId: string;
}

/** Bounded rejection reason for a submitted canonical human request. */
export type HumanActionRejectionReason =
  | 'stale'
  | 'superseded'
  | 'timeout'
  | 'conflict'
  | 'terminal'
  | 'rate-limit'
  | 'unknown';

export interface HumanActionRejection extends HumanActionIdentity {
  reason: HumanActionRejectionReason;
  status: number | null;
}

/**
 * Optional selection-independent observer for every canonical human action.
 * Metadata only; absent observer keeps the aggressive driver behavior and the
 * selection/pacing/retry semantics exactly as they are.
 */
export interface HumanActionObserver {
  /**
   * Called once BEFORE the canonical SDK request is first sent; the same
   * requestId is reused across every SDK retry of that request.
   */
  onSubmitted?: (submitted: HumanActionIdentity) => void;
  /** Every accepted canonical action, with the sanitized capture. */
  onAcceptedAction?: (capture: CanonicalActionCapture) => void;
  /** A submitted canonical request that was definitively rejected/abandoned. */
  onRejected?: (rejected: HumanActionRejection) => void;
}

/**
 * Classify one ignorable driver race into a bounded rejection reason and HTTP
 * status. Unknown free text never leaves this function; only the enum and a
 * numeric status are returned.
 */
export function classifyHumanActionRejection(
  error: unknown,
  terminal: boolean
): { reason: HumanActionRejectionReason; status: number | null } {
  const record = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const status = typeof record?.statusCode === 'number' ? record.statusCode : null;
  const text = `${typeof record?.code === 'string' ? record.code : ''} ${
    typeof record?.message === 'string' ? record.message : ''
  }`;
  if (/stale|superseded|obsolete|expired/i.test(text)) return { reason: 'stale', status };
  if (/timeout|timed out/i.test(text)) return { reason: 'timeout', status };
  if (/conflict|version/i.test(text)) return { reason: 'conflict', status };
  if (/not open for play|not_actionable|table.?closed|table_closed/i.test(text)) {
    return { reason: 'terminal', status };
  }
  if (status === 429) return { reason: 'rate-limit', status };
  if (terminal && (status === 404 || status === 409)) return { reason: 'terminal', status };
  return { reason: 'unknown', status };
}

/**
 * Optional human action-selection policy (for example a forced first legal
 * FOLD). `choose` is consulted on every server-issued turn; returning
 * null/undefined keeps the existing aggressive default for that turn, so a
 * driver without a selection behaves exactly as before.
 *
 * By default (`once !== false`) the selection applies only until its first
 * accepted action. When a selected action is accepted, the driver awaits
 * `onAccepted` with the sanitized canonical capture (request, receipt and the
 * EXACT result observation, never hole cards or deck) before its next sweep:
 * hook diagnostics always complete before play continues. An unsanitized or
 * malformed capture is never produced (the builder fails closed).
 */
export interface HumanActionSelection {
  choose?: (observation: SeatObservation) => HumanSelectedAction | null | undefined;
  /** Apply `choose` only until the first accepted selected action. Default true. */
  once?: boolean;
  /** Awaited after a selected action is accepted, before the driver continues. */
  onAccepted?: (capture: CanonicalActionCapture) => void | Promise<void>;
}

/**
 * Play the human seats of a room through the public SDK with ordinary
 * aggressive play: an all-in BET/RAISE at the server-issued maximum when
 * offered, otherwise CALL/CHECK/FOLD. This completes human and mixed rooms in
 * a few hands without touching caps. Agents are never driven here.
 *
 * Only documented race outcomes are swallowed (stale/turn/version conflicts,
 * timeouts, and terminal platform rejections after the room ended); auth,
 * broken-SDK and unexpected errors are rethrown.
 */
/** A malformed caller action selection: never an ordinary race, always visible. */
export class HumanActionSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HumanActionSelectionError';
  }
}

function isIgnorableHumanRace(error: unknown, terminal: boolean): boolean {
  if (error instanceof HumanActionSelectionError) return false;
  const record = error as { name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = typeof record?.message === 'string' ? record.message : '';
  const status = typeof record?.statusCode === 'number' ? record.statusCode : null;
  // Auth, rate-limit and server failures are never ordinary races: they stay
  // visible as failures even when they surface while the room is settling.
  if (status !== null && (status === 401 || status === 403 || status === 429 || status >= 500)) {
    return false;
  }
  if (code === 'TIMEOUT' || code === 'NOT_MODIFIED') return true;
  if (/(stale|superseded|conflict|turn|version|illegal|obsolete|expired)/i.test(`${code} ${message}`)) return true;
  // The competition/table can stop being actionable the moment the room
  // settles; a human racing that boundary is a documented terminal race.
  if (/(not open for play|COMPETITION_NOT_ACTIONABLE|NOT_ACTIONABLE|table is closed|TABLE_CLOSED)/i.test(`${code} ${message}`)) {
    return true;
  }
  if (terminal && (status === 404 || status === 409)) return true;
  return false;
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 429
  );
}

/** A bounded 429 failure that must never be mistaken for an ignorable race. */
export class HumanRateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'HumanRateLimitError';
  }
}

const RETRY_AFTER_MESSAGE = /retry (?:in|after)\s+(?:(\d+)\s*minutes?)?\s*(?:(\d+)\s*seconds?)?/i;

/**
 * Server-advised delay extracted from a rate-limit error, in milliseconds.
 *
 * `retryAfterMs` fields are already milliseconds; `retryAfter` fields are
 * delay-seconds (or an HTTP-date). The platform's limiter message
 * ("Rate limit exceeded, retry in 1 minute") is parsed as a fallback.
 */
export function parseRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { details?: unknown; retryAfterMs?: unknown; message?: unknown };
  if (typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)) {
    return Math.max(0, record.retryAfterMs);
  }
  const details = record.details;
  if (typeof details === 'object' && details !== null) {
    const milliseconds = (details as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) {
      return Math.max(0, milliseconds);
    }
    const retryAfter = (details as { retryAfter?: unknown }).retryAfter;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      return Math.max(0, retryAfter * 1000);
    }
    if (typeof retryAfter === 'string') {
      const trimmed = retryAfter.trim();
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(0, Number.parseFloat(trimmed) * 1000);
      const date = Date.parse(trimmed);
      if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    }
  }
  const message = typeof record.message === 'string' ? record.message : '';
  const match = RETRY_AFTER_MESSAGE.exec(message);
  if (match !== null) {
    const minutes = Number.parseInt(match[1] ?? '0', 10);
    const seconds = Number.parseInt(match[2] ?? '0', 10);
    const total = minutes * 60_000 + seconds * 1_000;
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}

/**
 * One bounded 429 wait. When the server advises a delay larger than the
 * configured bound the caller must FAIL explicitly: retrying earlier than the
 * limiter requires would just consume the retry budget and hammer the limit.
 */
function rateLimitWaitMs(
  error: unknown,
  attempt: number,
  pacing: Required<HumanDriverPacing>
): { waitMs: number } | { failure: string } {
  const advised = parseRetryAfterMs(error);
  if (advised !== null && advised > pacing.rateLimitMaxDelayMs) {
    return {
      failure:
        `server advised a ${advised}ms retry wait above the ${pacing.rateLimitMaxDelayMs}ms bound; refusing to retry early` +
        ` (last 429: ${rateLimitContextLabel() ?? 'endpoint unknown'})`,
    };
  }
  const fallback = Math.min(1_000 * 2 ** attempt, pacing.rateLimitMaxDelayMs);
  return { waitMs: advised ?? fallback };
}

/**
 * Run one human SDK call with bounded 429 backoff. The wait is exactly the
 * server-advised Retry-After (never shorter); when the advice exceeds the
 * bound, or the bounded retries are exhausted, the 429 is rethrown as a
 * visible {@link HumanRateLimitError}.
 */
async function withRateLimitBackoff<T>(
  call: () => Promise<T>,
  stats: HumanDriverStats,
  pacing: Required<HumanDriverPacing>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      stats.rateLimitResponses += 1;
      const wait = rateLimitWaitMs(error, attempt, pacing);
      if ('failure' in wait) throw new HumanRateLimitError(wait.failure, error);
      if (attempt >= pacing.rateLimitMaxRetries) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HumanRateLimitError(
          `human driver stayed rate-limited after ${attempt + 1} bounded 429 retries (last wait=${wait.waitMs}ms; last 429: ${
            rateLimitContextLabel() ?? 'endpoint unknown'
          }): ${message}`,
          error
        );
      }
      stats.rateLimitRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, wait.waitMs));
    }
  }
}

/**
 * Submit one canonical action with a single stable request id across every
 * retry. After a 429 backoff the authoritative turn/version is re-read; if the
 * table moved on (or no longer offers the actionId) the submission is reported
 * as superseded instead of sending a stale action.
 *
 * The accepted canonical result is returned (never discarded): its receipt
 * proves the durable turn/action identity and its observation is the exact
 * resulting snapshot, which callers may capture before play continues.
 */
async function submitHumanAction(
  session: WalletSession,
  tableId: string,
  observation: SeatObservation,
  action: SeatObservation['legalActions'][number],
  amount: number | undefined,
  stats: HumanDriverStats,
  pacing: Required<HumanDriverPacing>,
  hooks?: { observer?: HumanActionObserver; isTerminal: () => boolean }
): Promise<
  { status: 'accepted'; request: CapturedCanonicalRequest; result: CanonicalActionResult } | { status: 'superseded' }
> {
  const request: CapturedCanonicalRequest = {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: action.actionId,
    ...(amount !== undefined && amount > 0 ? { amount } : {}),
  };
  const identity: HumanActionIdentity = {
    tableId,
    handId:
      typeof observation.handId === 'string' && observation.handId.length > 0
        ? observation.handId
        : null,
    requestId: request.requestId,
    turnId: request.turnId,
    actionId: request.actionId,
  };
  // Metadata only, BEFORE the first canonical send. The same requestId is
  // reused across every SDK retry of this request.
  hooks?.observer?.onSubmitted?.(identity);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await session.client.action(tableId, request);
      return { status: 'accepted', request, result };
    } catch (error) {
      if (!isRateLimitError(error)) {
        if (hooks?.observer?.onRejected && isIgnorableHumanRace(error, hooks.isTerminal())) {
          // The exact submitted request id is reported with a bounded reason;
          // a hard (non-race) failure leaves the identity pending instead.
          hooks.observer.onRejected({
            ...identity,
            ...classifyHumanActionRejection(error, hooks.isTerminal()),
          });
        }
        throw error;
      }
      stats.rateLimitResponses += 1;
      const wait = rateLimitWaitMs(error, attempt, pacing);
      if ('failure' in wait) throw new HumanRateLimitError(wait.failure, error);
      if (attempt >= pacing.rateLimitMaxRetries) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HumanRateLimitError(
          `human action stayed rate-limited after ${attempt + 1} bounded 429 retries (last wait=${wait.waitMs}ms; last 429: ${
            rateLimitContextLabel() ?? 'endpoint unknown'
          }): ${message}`,
          error
        );
      }
      stats.rateLimitRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, wait.waitMs));
      // Authoritative re-check before resubmitting the identical request: only
      // the exact still-current turn/version may be retried.
      const current = await withRateLimitBackoff(
        () => session.client.getObservation(tableId),
        stats,
        pacing
      );
      stats.observations += 1;
      if (current.turnId !== request.turnId || current.version !== request.expectedVersion) {
        hooks?.observer?.onRejected?.({ ...identity, reason: 'superseded', status: 429 });
        return { status: 'superseded' };
      }
      if (!current.legalActions.some((candidate) => candidate.actionId === request.actionId)) {
        hooks?.observer?.onRejected?.({ ...identity, reason: 'superseded', status: 429 });
        return { status: 'superseded' };
      }
    }
  }
}

/**
 * Play the human seats of a room through the public SDK with ordinary
 * aggressive play: an all-in BET/RAISE at the server-issued maximum when
 * offered, otherwise CALL/CHECK/FOLD. This completes human and mixed rooms in
 * a few hands without touching caps. Agents are never driven here.
 *
 * Seats are swept at a human-plausible cadence (paced idle sweeps plus a short
 * think time before submitting) and every observation/action call is wrapped
 * in a bounded 429 backoff. Only documented race outcomes are swallowed
 * (stale/turn/version conflicts, timeouts, and terminal platform rejections
 * after the room ended); auth, broken-SDK, rate-limit and unexpected errors
 * are rethrown. The returned counters let focused gates prove that normal
 * pacing produced zero rate-limit responses.
 *
 * An optional {@link HumanActionSelection} can force a specific legal action
 * for the first accepted selected turn (for example the first legal FOLD) and
 * receive the awaited, sanitized canonical capture. Without a selection the
 * behavior and pacing are exactly the aggressive default above.
 */
export async function driveHumanSeats(input: {
  humans: readonly WalletSession[];
  tableId: string;
  isTerminal: () => boolean;
  /** While true, play passively (CHECK/CALL/FOLD) to expose family variety. */
  isPassive?: () => boolean;
  onAction?: (observation: SeatObservation) => void;
  /** Optional forced-action policy with an awaited accepted-action capture hook. */
  actionSelection?: HumanActionSelection;
  /** Optional selection-independent metadata observer for every action. */
  humanActionObserver?: HumanActionObserver;
  pacing?: HumanDriverPacing;
}): Promise<HumanDriverStats> {
  const pacing: Required<HumanDriverPacing> = { ...HUMAN_DRIVER_PACING, ...input.pacing };
  const stats: HumanDriverStats = {
    observations: 0,
    actions: 0,
    rateLimitResponses: 0,
    rateLimitRetries: 0,
  };
  let selectionActive = input.actionSelection?.choose !== undefined;
  // Minimum cadence between full seat sweeps, applied to ACTIVE and idle
  // sweeps alike. A successful quick CHECK/CALL must not let the loop sweep
  // (and re-request observations/actions) every think-time; the residual wait
  // always elapses before the next sweep.
  let previousSweepStartedAt: number | null = null;
  while (!input.isTerminal()) {
    if (previousSweepStartedAt !== null) {
      const residualMs = previousSweepStartedAt + pacing.pollIntervalMs - Date.now();
      if (residualMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, residualMs));
        if (input.isTerminal()) return stats;
      }
    }
    previousSweepStartedAt = Date.now();
    for (const session of input.humans) {
      if (input.isTerminal()) return stats;
      let accepted:
        | {
            selection: HumanSelectedAction;
            action: SeatObservation['legalActions'][number];
            request: CapturedCanonicalRequest;
            result: CanonicalActionResult;
          }
        | null = null;
      let acceptedAction:
        | {
            family: SeatObservation['legalActions'][number]['family'];
            request: CapturedCanonicalRequest;
            result: CanonicalActionResult;
          }
        | null = null;
      try {
        const observation = await withRateLimitBackoff(
          () => session.client.getObservation(input.tableId),
          stats,
          pacing
        );
        stats.observations += 1;
        if (observation.legalActions.length === 0) continue;
        if (pacing.actionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pacing.actionDelayMs));
          if (input.isTerminal()) return stats;
        }
        const passive = input.isPassive?.() === true;
        const selection =
          selectionActive ? (input.actionSelection?.choose?.(observation) ?? null) : null;
        if (
          selection !== null &&
          !observation.legalActions.some(
            (candidate) => candidate.actionId === selection.action.actionId
          )
        ) {
          throw new HumanActionSelectionError(
            `human action selection returned actionId ${selection.action.actionId} outside the server-issued legal menu`
          );
        }
        const aggressive =
          selection !== null || passive
            ? undefined
            : (observation.legalActions.find((candidate) => candidate.family === 'RAISE' && candidate.maxAmount !== undefined) ??
              observation.legalActions.find((candidate) => candidate.family === 'BET' && candidate.maxAmount !== undefined));
        const action =
          selection?.action ??
          aggressive ??
          observation.legalActions.find((candidate) => candidate.family === 'CHECK') ??
          observation.legalActions.find((candidate) => candidate.family === 'CALL') ??
          observation.legalActions.find((candidate) => candidate.family === 'FOLD') ??
          observation.legalActions[0]!;
        const amount =
          selection !== null
            ? selection.amount
            : aggressive !== undefined
              ? (aggressive.maxAmount ?? aggressive.amount)
              : action.family === 'BET' || action.family === 'RAISE'
                ? (action.amount ?? action.minAmount)
                : action.amount;
        const outcome = await submitHumanAction(
          session,
          input.tableId,
          observation,
          action,
          amount,
          stats,
          pacing,
          { ...(input.humanActionObserver ? { observer: input.humanActionObserver } : {}), isTerminal: input.isTerminal }
        );
        if (outcome.status === 'accepted') {
          stats.actions += 1;
          input.onAction?.(observation);
          acceptedAction = { family: action.family, request: outcome.request, result: outcome.result };
          accepted =
            selection === null
              ? null
              : { selection, action, request: outcome.request, result: outcome.result };
        }
      } catch (error) {
        // All SDK calls are inside this catch; documented terminal/turn races
        // are swallowed while 429/auth/server failures stay visible. Canonical
        // capture/hook work runs AFTER this catch: a capture or hook failure is
        // never an ordinary race and must stay visible.
        if (isIgnorableHumanRace(error, input.isTerminal())) continue;
        throw error;
      }
      if (acceptedAction !== null && input.humanActionObserver?.onAcceptedAction !== undefined) {
        // Selection-independent acceptance confirmation, built from the EXACT
        // canonical result (sanitized, no cards) so the caller can crosscheck
        // the receipt against the submitted request id.
        const capture = buildCanonicalActionCapture({
          family: acceptedAction.family,
          request: acceptedAction.request,
          result: acceptedAction.result,
          acceptedAt: Date.now(),
        });
        input.humanActionObserver.onAcceptedAction(capture);
      }
      if (accepted !== null) {
        if (input.actionSelection?.once !== false) selectionActive = false;
        if (input.actionSelection?.onAccepted !== undefined) {
          // The capture is built from the EXACT canonical result the action
          // returned (never a later observation read) and is sanitized of every
          // card/deck field. The hook is awaited before the next sweep so
          // diagnostics complete before play continues.
          const capture = buildCanonicalActionCapture({
            family: accepted.action.family,
            request: accepted.request,
            result: accepted.result,
            acceptedAt: Date.now(),
          });
          await input.actionSelection.onAccepted(capture);
        }
      }
    }
  }
  return stats;
}

export async function runProductRoom(input: ProductRoomRunInput): Promise<ProductRoomRunResult> {
  const { spec, context, product, fakeProvider } = input;
  const humans = input.humans.slice(0, spec.humans);
  const agentIds = input.agentIds.slice(0, spec.agents);
  if (humans.length !== spec.humans) throw new Error(`${spec.label}: not enough human wallets`);
  if (agentIds.length !== spec.agents) throw new Error(`${spec.label}: not enough agents`);
  if (input.requireNoRateLimit === true && !input.platformMetrics) {
    throw new Error(
      `${spec.label}: requireNoRateLimit needs an independent platformMetrics source (a 429-only driver counter cannot prove zero)`
    );
  }
  const platform429Before =
    input.platformMetrics != null ? await readPlatform429Total(input.platformMetrics) : null;

  const roomName = `accept-${spec.label}-${Date.now().toString(36)}`;

  let room: ProductRoomView;
  const challenge = input.challenge ?? null;
  if (humans.length > 0) {
    room = await product.createRoom(
      {
        name: roomName,
        mode: challenge ? 'CHALLENGE' : 'SPONSORED',
        humanCount: spec.humans,
        agentIds,
        ...(challenge
          ? {
              finance: {
                assetId: challenge.assetId,
                entryAtomic: challenge.entryAtomic,
                prizeAtomic: challenge.prizeAtomic,
                optIn: true,
              },
            }
          : {}),
      },
      { walletToken: humans[0]!.token }
    );
    for (const session of humans.slice(1)) {
      room = await product.joinRoom(room.id, session.token);
    }
  } else {
    room = await product.createRoom(
      { name: roomName, mode: 'SPONSORED', humanCount: 0, agentIds },
      { admin: true }
    );
  }

  const startActor =
    humans.length > 0 ? { walletToken: humans[0]!.token } : { admin: true as const };
  room = await product.startRoom(room.id, startActor);
  if (challenge && room.status === 'PROVISIONING' && room.pokerCompetitionId !== null && humans.length > 0) {
    // Paid start is intentionally pending in the product: the payer must opt in
    // directly through the public CompetitionClient (the product API never
    // forwards paid entry). Then start resumes provisioning to ACTIVE.
    const { CompetitionClient } = await import('@pokertools/sdk');
    const payer = new CompetitionClient({
      baseUrl: input.environment.platform.baseUrl,
      token: humans[0]!.token,
      timeout: 30_000,
    });
    await payer.optIn(room.pokerCompetitionId);
    room = await product.startRoom(room.id, startActor);
  }
  context.log(`room ${spec.label}: ${room.id} status=${room.status} table=${room.pokerTableId ?? 'pending'}`);

  let terminal = room.status === 'COMPLETE' || room.status === 'FAILED';
  let humanDriver: Promise<void> = Promise.resolve();
  let humanStats: HumanDriverStats = { observations: 0, actions: 0, rateLimitResponses: 0, rateLimitRetries: 0 };
  let humanError: unknown = null;
  let tableId: string | null = room.pokerTableId;

  if (room.status !== 'COMPLETE' && room.status !== 'FAILED') {
    const active = await waitFor(
      `${spec.label} room ACTIVE`,
      async () => {
        const current = await product.getRoom(room.id);
        return current.status === 'ACTIVE' ? current : null;
      },
      // The product rate-limits at 120 requests/minute; poll well under it.
      { timeoutMs: input.maxWaitMs ?? 120_000, intervalMs: 1500 }
    );
    room = active;
    context.log(`room ${spec.label}: ACTIVE table=${room.pokerTableId}`);
    await input.onActive?.(room);

    tableId = room.pokerTableId;
    if (tableId === null) throw new Error(`${spec.label}: ACTIVE room has no table id`);
    const activeTableId: string = tableId;
    let notifyDriverSettled: () => void = () => {};
    const driverSettled = new Promise<void>((resolve) => {
      notifyDriverSettled = resolve;
    });
    humanDriver = driveHumanSeats({
      humans,
      tableId: activeTableId,
      isTerminal: () => terminal,
      onAction: input.onHumanAction,
      actionSelection: input.humanActionSelection ?? undefined,
      pacing: input.humanPacing,
      isPassive: () => {
        const intro = input.passiveHumanIntro ?? null;
        return intro !== null && fakeProvider.requestCountForTable(activeTableId) < intro.untilProviderRequests;
      },
    })
      .then((stats) => {
        humanStats = stats;
      })
      .catch((error: unknown) => {
        // Capture immediately so an unexpected failure can never become an
        // unhandled rejection; rethrown after the room is terminal (only
        // documented stale/timeout races are swallowed inside).
        humanError = error;
      })
      .finally(notifyDriverSettled);

    // The terminal wait aborts the moment the human driver rejects: the exact
    // failure (for example a bounded 429) must never hide behind a long room
    // timeout while provider calls keep being spent.
    const driverFailure: Promise<never> = driverSettled.then(async (): Promise<never> => {
      if (humanError !== null) throw humanError;
      return await new Promise<never>(() => {});
    });

    const terminalWait = waitFor(
      `${spec.label} room terminal`,
      async () => {
        if (humanError !== null) throw humanError;
        const current = await product.getRoom(room.id);
        await input.onTick?.(current);
        if (current.status === 'COMPLETE' || current.status === 'FAILED') {
          terminal = true;
          return current;
        }
        return null;
      },
      // The product rate-limits at 120 requests/minute; with up to nine
      // concurrent rooms a 5s poll stays well under it.
      { timeoutMs: input.maxWaitMs ?? 900_000, intervalMs: 5000 }
    ).catch(async (error: unknown) => {
      // A driver failure is rethrown untouched (and never wrapped as a
      // terminal timeout); only a genuine wait timeout gets diagnostics.
      if (humanError !== null) throw humanError;
      // Terminal timeout diagnostics: durable decision statuses plus the last
      // product read error make a stalled room actionable.
      const evidence = readRoomEvidence(input.productDatabasePath, room.id);
      const statuses = evidence.decisions.reduce<Record<string, number>>((accumulator, decision) => {
        accumulator[decision.status] = (accumulator[decision.status] ?? 0) + 1;
        return accumulator;
      }, {});
      const lastRoom = await product.getRoom(room.id).catch((readError: unknown) => ({
        status: `read-failed: ${readError instanceof Error ? readError.message : String(readError)}`,
      }));
      throw new Error(
        `${spec.label}: room terminal timeout (status=${String((lastRoom as { status?: unknown }).status)}; decisions=${JSON.stringify(
          statuses
        )}; attempts=${evidence.attempts.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    });

    let finished: ProductRoomView;
    try {
      finished = await Promise.race([terminalWait, driverFailure]);
    } finally {
      // Bounded cancellation/drain: stop the driver loop, settle it, and let
      // the losing wait branch finish (bounded by its next poll) without
      // becoming an unhandled rejection.
      terminal = true;
      void driverFailure.catch(() => undefined);
      await humanDriver.catch(() => undefined);
      void terminalWait.catch(() => undefined);
    }
    room = finished;
  }
  terminal = true;
  await humanDriver.catch(() => undefined);
  if (humanError !== null) {
    throw humanError instanceof Error ? humanError : new Error(String(humanError));
  }
  const platform429After =
    input.platformMetrics != null ? await readPlatform429Total(input.platformMetrics) : null;
  const platform429 =
    platform429After !== null && platform429Before !== null ? platform429After - platform429Before : null;
  if (platform429 !== null && platform429 > 0) {
    // Never hidden: the platform's own counter catches 429s the SDK retried
    // internally, even when no driver call ever surfaced one.
    context.log(
      `room ${spec.label}: WARNING platform /metrics recorded ${platform429} new HTTP 429 response(s) (independent of SDK retries)`
    );
  }
  if (humanStats.rateLimitResponses > 0) {
    context.log(
      `room ${spec.label}: WARNING human driver observed ${humanStats.rateLimitResponses} rate-limit response(s) (bounded retries=${humanStats.rateLimitRetries})`
    );
  }
  if (input.requireNoRateLimit === true) {
    if (platform429 === null) {
      throw new Error(`${spec.label}: zero-429 gate could not read the independent platform metrics`);
    }
    if (platform429 > 0 || humanStats.rateLimitResponses > 0) {
      throw new Error(
        `${spec.label}: focused pacing must gate zero, observed platform429Delta=${platform429} driver429s=${humanStats.rateLimitResponses} boundedRetries=${humanStats.rateLimitRetries}`
      );
    }
  }

  // Grace period: an in-flight attempt recorded at the terminal boundary is
  // recovered (recorded exactly once) before evidence inspection.
  let evidence = readRoomEvidence(input.productDatabasePath, room.id);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!evidence.attempts.some((row) => row.status === 'PENDING')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    evidence = readRoomEvidence(input.productDatabasePath, room.id);
  }
  await input.onTerminal?.(room, evidence);
  const inspection = await inspectRoomEvidence(evidence, { agentPrincipalIds: input.agentPrincipalIds });
  // Total per-table provider exchanges: every persisted attempt must map 1:1 to
  // a loopback HTTP exchange, independent of when the harness first observed
  // the table (the runtime can act before the start response returns).
  const providerRequests = tableId === null ? 0 : fakeProvider.requestCountForTable(tableId);

  if (room.status === 'FAILED') {
    throw new Error(`${spec.label}: room failed: ${room.failureReason ?? 'unknown reason'}`);
  }
  if (room.status !== 'COMPLETE') {
    throw new Error(`${spec.label}: room did not complete (status ${room.status})`);
  }
  const persistedAttempts = evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length;
  if (providerRequests !== persistedAttempts) {
    throw new Error(
      `${spec.label}: loopback provider saw ${providerRequests} request(s) but ${persistedAttempts} attempt(s) were recorded`
    );
  }
  if (spec.agents > 0 && evidence.decisions.length === 0) {
    throw new Error(`${spec.label}: no durable decisions were recorded`);
  }
  if (spec.agents === 0 && (evidence.decisions.length !== 0 || providerRequests !== 0)) {
    throw new Error(
      `${spec.label}: human-only room recorded ${evidence.decisions.length} decisions and ${providerRequests} provider requests`
    );
  }
  if (inspection.violations.length > 0) {
    const first = inspection.violations[0]!;
    throw new Error(
      `${spec.label}: evidence violations (${inspection.violations.length}); first: ${first.decisionId}#${first.attemptNo ?? '-'}: ${first.detail}`
    );
  }
  return {
    room,
    evidence,
    inspection,
    providerRequests,
    persistedAttempts,
    tableId: room.pokerTableId!,
    humanDriver: humanStats,
    platform429,
  };
}

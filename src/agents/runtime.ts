/**
 * Durable, restart-safe product AgentRuntime.
 *
 * One runtime drives one authenticated agent principal across a bounded set of
 * rooms. For every turn it:
 *
 * 1. consumes the authoritative masked observation over the agent's own SDK
 *    socket, using REST only for startup and transport recovery;
 * 2. persists the exact observation boundary plus the allowed public chat
 *    source at `(tableId, turnId, principalId)` before any provider I/O;
 * 3. persists the exact sanitized provider request as an immutable attempt
 *    before HTTP, independently inspects that exact request and fails closed
 *    on corruption, then persists the exact sanitized response before
 *    resolving the action;
 * 4. submits the canonical action under the decision's stable `requestId`,
 *    trying the stored request first on every restart so a crash-accepted
 *    platform receipt is reused instead of being mistaken for a stale turn;
 * 5. only ever accepts a provider choice through `validateActionChoice`
 *    against the exact stored observation menu, and never calls a provider
 *    again once a successful response is recorded.
 *
 * Provider attempts are bounded to two distinctly audited attempts per
 * decision: one recorded response, plus at most one recovery of an attempt
 * abandoned by a previous process. All durable state transitions are CAS in
 * the single-process `ProductStore`.
 */
import { createHash } from 'node:crypto';
import {
  CanonicalActionRequestSchema,
  ChatMessageSchema,
  SeatObservationSchema as CanonicalSeatObservationSchema,
  type CanonicalActionRequest,
  type ChatMessage,
  type SeatObservation as CanonicalSeatObservation,
} from '@pokertools/types';
import { inspectDecisionRequest } from '../audit/decision-request-inspector.js';
import { estimateRequestCostCeilingUsdMicro } from '../llm/cost.js';
import {
  DEFAULT_MAX_CHAT_MESSAGES,
  computeObservationHash,
  deriveDecisionMenu,
  type ChatSelectionOptions,
  type DecisionPrompt,
} from '../llm/decision-prompt.js';
import {
  ProductDecisionProvider,
  validateActionChoice,
  type ChosenAction,
  type DecisionRequestRecord,
  type DecisionResponseRecord,
} from '../llm/decision-provider.js';
import { assertPromptPolicy } from '../llm/prompt-policy.js';
import { sanitizeSecretText, sanitizeSecretValue, resolveKnownSecrets } from '../security/sanitize.js';
import { DecisionConcurrencyLimiter } from './limiter.js';
import {
  type AgentAuditCode,
  type AgentAuditEvent,
  type AgentAuditSink,
  type AgentDecisionRecord,
  type AgentDecisionStorePort,
  type AgentModelAttempt,
  type AgentRoomBinding,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentTurnTransport,
  type DecisionConcurrencyLimiterLike,
  type DecisionProviderCallContext,
  type DecisionProviderFactory,
  type DecisionProviderPort,
} from './contracts.js';

const DEFAULT_SAFETY_MARGIN_MS = 250;
// Silent subscriptions cannot prove freshness indefinitely. This watchdog is
// recovery, not a turn poll; ongoing canonical WS delivery resets it.
const DEFAULT_RESYNC_INTERVAL_MS = 300_000;
const DEFAULT_MAX_CONCURRENCY = 4;
/** Provider attempts per decision: one call plus one abandoned-attempt recovery. */
export const MAX_PROVIDER_ATTEMPTS_PER_DECISION = 2;
/** Action submissions per resolved request; the stable requestId makes replays safe. */
const MAX_ACTION_SUBMISSIONS = 2;

/** Optional platform deadline fields read from the observation state. */
const PLATFORM_DEADLINE_FIELDS = ['turnDeadline', 'actionDeadline', 'deadline'] as const;

/** Seconds that still fit in a safe epoch-ms addition without inventing values. */
const MAX_DEADLINE_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

const TERMINAL_STATUSES: ReadonlySet<AgentDecisionRecord['status']> = new Set([
  'COMMITTED',
  'STALE',
  'FAILED',
]);

export class AgentAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAuthorityError';
  }
}

export class AgentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIntegrityError';
  }
}

export type AgentActionFailureClass = 'STALE' | 'RETRY' | 'FAILED' | 'ABORT';

/**
 * Deterministic per-call budget. When the observation state exposes an
 * explicit platform deadline field, the remaining time bounds the configured
 * per-call budget; otherwise the canonical server-issued action window
 * (`config.actionTimeoutSeconds` from `state.timestamp`, plus the acting
 * viewer seat's positive time bank) is used. When neither is present the
 * configured per-call budget applies. A timing safety margin is always
 * subtracted and the result is clamped at zero. No deadline is ever invented.
 */
export function resolveCallBudgetMs(input: {
  state: unknown;
  now: number;
  perCallTimeoutMs: number;
  safetyMarginMs?: number;
}): number {
  const margin = input.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  let budget = input.perCallTimeoutMs;
  const state = input.state;
  if (state !== null && typeof state === 'object') {
    const record = state as Record<string, unknown>;
    let platformDeadline: number | null = null;
    for (const field of PLATFORM_DEADLINE_FIELDS) {
      const value = record[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        platformDeadline = value;
        break;
      }
    }
    if (platformDeadline === null) {
      platformDeadline = canonicalActionDeadlineMs(record);
    }
    if (platformDeadline !== null) {
      budget = Math.min(budget, platformDeadline - input.now);
    }
  }
  return Math.max(0, Math.floor(budget - margin));
}

/**
 * Canonical server-issued action deadline in epoch ms:
 * `state.timestamp + state.config.actionTimeoutSeconds * 1000`, plus the
 * acting viewer seat's positive time bank when `state.actionTo` is that seat.
 * Returns `null` when the canonical fields are absent or implausible; the
 * caller then falls back to the configured budget.
 */
function canonicalActionDeadlineMs(state: Record<string, unknown>): number | null {
  const timestamp = state.timestamp;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    return null;
  }
  const config = state.config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const actionTimeoutSeconds = (config as Record<string, unknown>).actionTimeoutSeconds;
  if (
    typeof actionTimeoutSeconds !== 'number' ||
    !Number.isSafeInteger(actionTimeoutSeconds) ||
    actionTimeoutSeconds <= 0 ||
    actionTimeoutSeconds > MAX_DEADLINE_SECONDS
  ) {
    return null;
  }
  let deadline = timestamp + actionTimeoutSeconds * 1000;
  const timeBankSeconds = viewerTimeBankSeconds(state);
  if (timeBankSeconds > 0) deadline += timeBankSeconds * 1000;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

/** Positive time bank of the acting viewer seat, or 0 when not applicable. */
function viewerTimeBankSeconds(state: Record<string, unknown>): number {
  const viewingPlayerId = state.viewingPlayerId;
  const players = state.players;
  if (typeof viewingPlayerId !== 'string' || !Array.isArray(players)) return 0;
  const viewer = players.find(
    (player) =>
      player !== null &&
      typeof player === 'object' &&
      (player as { id?: unknown }).id === viewingPlayerId,
  ) as { seat?: unknown } | undefined;
  const seat = viewer?.seat;
  if (typeof seat !== 'number' || !Number.isSafeInteger(seat)) return 0;
  // Only the seat on the clock can spend its time bank.
  if (state.actionTo !== seat) return 0;
  const timeBanks = state.timeBanks;
  if (timeBanks === null || typeof timeBanks !== 'object' || Array.isArray(timeBanks)) return 0;
  const value = (timeBanks as Record<string, unknown>)[String(seat)];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_DEADLINE_SECONDS
  ) {
    return 0;
  }
  return value;
}

/**
 * Classify one SDK action failure. Definite platform rejections are STALE
 * (after the stored request was already replayed), rate limits and server or
 * transport failures are RETRY, and everything else is RETRY until the bounded
 * submission budget is spent, then FAILED.
 */
export function classifyActionFailure(error: unknown): AgentActionFailureClass {
  if (isAbortError(error)) return 'ABORT';
  const record =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown; statusCode?: unknown; message?: unknown })
      : null;
  const code = record !== null && typeof record.code === 'string' ? record.code : '';
  if (code.length > 0 && STALE_CODE_HINTS.test(code)) return 'STALE';
  const status =
    record !== null && typeof record.statusCode === 'number' ? record.statusCode : null;
  if (status !== null) {
    if (status === 408 || status === 429 || status >= 500) return 'RETRY';
    if (status >= 400) return 'STALE';
  }
  if (record !== null && typeof record.message === 'string' && STALE_CODE_HINTS.test(record.message)) {
    return status !== null && status >= 400 ? 'STALE' : 'RETRY';
  }
  return 'RETRY';
}

const STALE_CODE_HINTS = /(turn|stale|version|illegal|obsolete|expired|superseded|conflict)/i;

// ---------------------------------------------------------------------------
// Real provider factory
// ---------------------------------------------------------------------------

export interface ProductDecisionProviderRuntimeConfig {
  baseUrl: string;
  model: string;
  /** Secret; only ever sent as a bearer header and never audited. */
  apiKey?: string;
  provider?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Integer micro-USD per 1,000,000 tokens. */
  inputUsdMicroPerMillionTokens: number;
  outputUsdMicroPerMillionTokens: number;
  selection?: ChatSelectionOptions;
  knownSecrets?: readonly string[];
  includeEnvSecrets?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Build a `DecisionProviderFactory` over the product decision provider. Every
 * provider binds the exact persistence callbacks of its durable attempt; the
 * API key stays inside this closure and is never recorded or logged.
 */
export function createProductDecisionProviderFactory(
  config: ProductDecisionProviderRuntimeConfig,
): DecisionProviderFactory {
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
    throw new TypeError('provider baseUrl is required');
  }
  if (typeof config.model !== 'string' || config.model.trim() === '') {
    throw new TypeError('provider model is required');
  }
  assertMicroUsdRate(config.inputUsdMicroPerMillionTokens, 'inputUsdMicroPerMillionTokens');
  assertMicroUsdRate(config.outputUsdMicroPerMillionTokens, 'outputUsdMicroPerMillionTokens');
  let baseUrlHost: string;
  try {
    baseUrlHost = new URL(config.baseUrl).hostname;
  } catch {
    throw new TypeError('provider baseUrl must be an absolute URL');
  }
  if (baseUrlHost.length === 0) throw new TypeError('provider baseUrl must have a host');
  const identity = {
    model: config.model,
    provider: config.provider ?? 'openai-compatible',
    baseUrlHost,
  };
  // Resolved once with the provider's exact policy: explicit provider key plus
  // declared secrets plus (by default) credential-named env values.
  const knownSecrets = resolveKnownSecrets({
    knownSecrets: [
      ...(config.apiKey !== undefined && config.apiKey.length > 0 ? [config.apiKey] : []),
      ...(config.knownSecrets ?? []),
    ],
    includeEnvSecrets: config.includeEnvSecrets ?? true,
  });
  const sanitizeSourceChat = (entries: readonly ChatMessage[]): ChatMessage[] =>
    sanitizeSecretValue(entries, { knownSecrets }) as ChatMessage[];
  const inputPrice = BigInt(config.inputUsdMicroPerMillionTokens);
  const outputPrice = BigInt(config.outputUsdMicroPerMillionTokens);
  /**
   * Deterministic pre-HTTP ceiling over the exact request bytes this provider
   * will serialize (same sanitization policy) and the configured output cap.
   */
  const costCeilingUsdMicro = (prompt: DecisionPrompt): bigint =>
    estimateRequestCostCeilingUsdMicro({
      requestBytes: Buffer.byteLength(
        JSON.stringify(sanitizeSecretValue(prompt.body, { knownSecrets })),
        'utf8',
      ),
      maxOutputTokens: prompt.maxOutputTokens,
      inputUsdMicroPerMillion: inputPrice,
      outputUsdMicroPerMillion: outputPrice,
    });
  const factory = ((context: DecisionProviderCallContext): DecisionProviderPort =>
    new ProductDecisionProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      provider: config.provider,
      timeoutMs: context.timeoutMs,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      knownSecrets,
      includeEnvSecrets: false,
      inputUsdMicroPerMillion: inputPrice,
      outputUsdMicroPerMillion: outputPrice,
      selection: config.selection,
      fetchImpl: config.fetchImpl,
      onRequest: (record) => context.onRequest(record),
      onResponse: (record) => context.onResponse(record),
    })) as DecisionProviderFactory;
  return Object.assign(factory, {
    identity,
    sanitizeSourceChat,
    knownSecrets,
    costCeilingUsdMicro,
  });
}

function assertMicroUsdRate(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer micro-USD rate`);
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface ProviderCallState {
  attempt: AgentModelAttempt | null;
  prompt: DecisionPrompt | null;
  requestJson: string | null;
  reserved: boolean;
  settled: boolean;
  /** True once the request passed every pre-HTTP check and HTTP may follow. */
  requestStarted: boolean;
  /** True once an HTTP exchange produced a response record, even if it could not be persisted. */
  responseSeen: boolean;
  startedAt: number;
}

export class AgentRuntime {
  private readonly config: AgentRuntimeConfig;
  private readonly transport: AgentTurnTransport;
  private readonly store: AgentDecisionStorePort;
  private readonly providerFactory: DecisionProviderFactory;
  private readonly limiter: DecisionConcurrencyLimiterLike;
  private readonly auditSink: AgentAuditSink | null;
  private readonly clock: () => number;
  private readonly safetyMarginMs: number;
  private readonly maxAttempts: number;
  private readonly speechPolicy: 'OFF' | 'AFTER_COMMIT';
  private readonly resyncIntervalMs: number;

  private readonly roomsByTable = new Map<string, AgentRoomBinding>();
  private readonly tableIds: string[] = [];
  private readonly unsubscribeTriggers: Array<() => void> = [];
  private readonly inFlightDecisions = new Set<string>();
  private readonly tableChains = new Map<string, Promise<void>>();
  private readonly queuedTables = new Set<string>();
  private readonly dirtyTables = new Set<string>();
  private readonly pendingObservations = new Map<string, CanonicalSeatObservation>();
  private readonly latestObservations = new Map<string, CanonicalSeatObservation>();
  private readonly lastSocketAt = new Map<string, number>();
  private readonly recoveryPending = new Set<string>();
  private readonly gapObservations = new Map<string, CanonicalSeatObservation>();
  private readonly tracked = new Set<Promise<void>>();

  private controller = new AbortController();
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private pumpScheduled = false;
  private running = false;
  private stopping = false;
  private startedAtMs = 0;

  constructor(config: AgentRuntimeConfig, deps: AgentRuntimeDependencies) {
    if (config === null || typeof config !== 'object') {
      throw new TypeError('AgentRuntime requires a configuration object');
    }
    if (deps === null || typeof deps !== 'object') {
      throw new TypeError('AgentRuntime requires dependencies');
    }
    assertRequiredText(config.agentId, 'agentId');
    assertRequiredText(config.principalId, 'principalId');
    assertRequiredText(config.promptPolicyId, 'promptPolicyId');
    assertRequiredText(config.promptPolicyHash, 'promptPolicyHash');
    if (!Number.isSafeInteger(config.perCallTimeoutMs) || config.perCallTimeoutMs <= 0) {
      throw new RangeError('perCallTimeoutMs must be a positive safe integer');
    }
    const maxAttempts = config.maxProviderAttempts ?? MAX_PROVIDER_ATTEMPTS_PER_DECISION;
    if (maxAttempts < 1 || maxAttempts > MAX_PROVIDER_ATTEMPTS_PER_DECISION) {
      throw new RangeError(
        `maxProviderAttempts must be 1..${MAX_PROVIDER_ATTEMPTS_PER_DECISION}`,
      );
    }
    if (!Array.isArray(config.rooms)) throw new TypeError('rooms must be an array');

    // Prompt policy is asserted before any provider can exist.
    assertPromptPolicy(config.promptPolicyId, config.promptPolicyHash);

    this.config = config;
    this.transport = deps.transport;
    this.store = deps.store;
    this.providerFactory = deps.providerFactory;
    this.limiter =
      deps.limiter ?? new DecisionConcurrencyLimiter(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.auditSink = deps.audit ?? null;
    this.clock = deps.now ?? (() => Date.now());
    this.safetyMarginMs = config.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    if (!Number.isSafeInteger(this.safetyMarginMs) || this.safetyMarginMs < 0) {
      throw new RangeError('safetyMarginMs must be a non-negative safe integer');
    }
    if (
      config.overallDeadlineAtMs !== undefined &&
      config.overallDeadlineAtMs !== null &&
      (!Number.isSafeInteger(config.overallDeadlineAtMs) || config.overallDeadlineAtMs <= 0)
    ) {
      throw new RangeError('overallDeadlineAtMs must be a positive safe integer epoch-ms');
    }
    if (
      config.overallRuntimeMs !== undefined &&
      config.overallRuntimeMs !== null &&
      (!Number.isSafeInteger(config.overallRuntimeMs) || config.overallRuntimeMs <= 0)
    ) {
      throw new RangeError('overallRuntimeMs must be a positive safe integer');
    }
    this.maxAttempts = maxAttempts;
    this.speechPolicy = config.speech ?? 'OFF';
    this.resyncIntervalMs = config.socketResyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    if (!Number.isSafeInteger(this.resyncIntervalMs) || this.resyncIntervalMs <= 0) {
      throw new RangeError('socketResyncIntervalMs must be a positive safe integer');
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Tables actually served; a human-only room binding is never added. */
  get servedTableIds(): readonly string[] {
    return this.tableIds;
  }

  /**
   * Connect the authenticated transport, verify the principal matches the
   * configured one, subscribe canonical observations and start recovery watchdog.
   */
  async start(): Promise<void> {
    if (this.running) return;
    assertPromptPolicy(this.config.promptPolicyId, this.config.promptPolicyHash);
    this.stopping = false;
    this.controller = new AbortController();
    this.startedAtMs = this.clock();
    try {
      await this.transport.connect();
      const principal = this.transport.principalId;
      if (principal === null) {
        throw new AgentAuthorityError('transport did not authenticate a principal');
      }
      if (principal !== this.config.principalId) {
        throw new AgentAuthorityError(
          `transport principal ${principal} does not match configured principal`,
        );
      }
      for (const room of this.config.rooms) {
        if (!room.agentPrincipalIds.includes(this.config.principalId)) {
          this.audit('HUMAN_ONLY_ROOM', {
            tableId: room.tableId,
            detail: { roomId: room.roomId, agents: room.agentPrincipalIds.length },
          });
          continue;
        }
        if (this.roomsByTable.has(room.tableId)) continue;
        this.roomsByTable.set(room.tableId, room);
        this.tableIds.push(room.tableId);
        this.unsubscribeTriggers.push(
          this.transport.onObservation(room.tableId, (observation) => {
            this.receiveObservation(room.tableId, observation);
          }),
        );
      }
      this.audit('AUTHORITY_ESTABLISHED', { detail: { servedTables: this.tableIds.length } });
      if (this.transport.onRecovery !== undefined) {
        this.unsubscribeTriggers.push(this.transport.onRecovery(() => {
          for (const tableId of this.tableIds) this.scheduleTable(tableId);
        }));
      }
      for (const tableId of this.tableIds) {
        if (!this.latestObservations.has(tableId)) this.scheduleTable(tableId);
      }
      if (this.tableIds.length > 0) {
        this.resyncTimer = setInterval(() => {
          for (const tableId of this.tableIds) {
            if (this.clock() - (this.lastSocketAt.get(tableId) ?? this.startedAtMs) >= this.resyncIntervalMs) {
              this.scheduleTable(tableId);
            }
          }
        }, this.resyncIntervalMs);
        const timer = this.resyncTimer as { unref?: () => void };
        if (typeof timer.unref === 'function') timer.unref();
      }
      await this.drain();
    } catch (error) {
      this.stopTimer();
      for (const unsubscribe of this.unsubscribeTriggers.splice(0)) unsubscribe();
      this.roomsByTable.clear();
      this.tableIds.length = 0;
      this.transport.close();
      throw error;
    }
    this.running = true;
  }

  /** Force one coalesced REST resync across every served table and await it. */
  async syncNow(): Promise<void> {
    for (const tableId of this.tableIds) this.scheduleTable(tableId);
    await this.drain();
  }

  /**
   * Bounded terminal-close path. Records every PENDING provider attempt owned
   * by this runtime as FAILED `runtime_stopped` (no fabricated response or
   * usage; cost analytics stay 0/unknown) and settles the reservation
   * conservatively at its exact reserved ceiling for budget accounting only.
   *
   * Idempotent and race-safe: attempts already recorded (SUCCEEDED/FAILED) and
   * decisions that moved past `CALLING_PROVIDER` are skipped, so immutable
   * evidence is never overwritten and a recorded success is never turned into
   * a failure. Called by terminal room detach; process-level `stop()`
   * deliberately leaves PENDING rows for restart recovery.
   */
  closeAbandonedAttempts(): void {
    let closed = 0;
    for (const tableId of this.tableIds) {
      const room = this.roomsByTable.get(tableId);
      if (room === undefined) continue;
      let decisions: readonly AgentDecisionRecord[];
      try {
        decisions = this.store.listDecisions({
          tableId,
          principalId: this.config.principalId,
        });
      } catch (error) {
        this.audit('SYNC_FAILED', {
          tableId,
          detail: { reason: describeError(error), close: true },
        });
        continue;
      }
      for (const decision of decisions) {
        if (decision.status !== 'CALLING_PROVIDER') continue;
        let attempts: AgentModelAttempt[];
        try {
          attempts = this.store.listAttempts(decision.id);
        } catch {
          continue;
        }
        for (const attempt of attempts) {
          if (attempt.status !== 'PENDING') continue;
          if (!this.recordFailedAttempt(decision, attempt, 'runtime_stopped')) continue;
          closed += 1;
          try {
            this.store.settleUnknownCall(room.roomId, this.config.agentId);
          } catch (error) {
            if (storeErrorCode(error) !== 'RESERVATION_NOT_FOUND') {
              this.audit('RESERVATION_SETTLE_REJECTED', {
                tableId: decision.tableId,
                turnId: decision.turnId,
                decisionId: decision.id,
                detail: { reason: describeError(error), close: true },
              });
            }
          }
        }
      }
    }
    if (closed > 0) {
      this.audit('ABANDONED_ATTEMPTS_CLOSED', { detail: { closed } });
    }
  }

  /**
   * Abort in-flight provider exchanges and await settlement. Durable attempt
   * states are left exactly as they are; a later process resumes them.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort(new Error('agent runtime stopped'));
    this.stopTimer();
    for (const unsubscribe of this.unsubscribeTriggers.splice(0)) unsubscribe();
    await this.drain();
    this.transport.close();
    this.running = false;
  }

  // -------------------------------------------------------------------------
  // Canonical WS observations + coalesced REST recovery
  // -------------------------------------------------------------------------

  private scheduleTable(tableId: string): void {
    if (this.stopping || !this.roomsByTable.has(tableId)) return;
    if (this.recoveryPending.has(tableId)) return;
    this.recoveryPending.add(tableId);
    this.markDirty(tableId);
  }

  private receiveObservation(tableId: string, observation: CanonicalSeatObservation): void {
    const room = this.roomsByTable.get(tableId);
    if (this.stopping || room === undefined) return;
    // Validate without substituting Zod's cloned/normalized result: the exact
    // object received from the authenticated server is the durable boundary.
    if (!CanonicalSeatObservationSchema.safeParse(observation).success ||
        observation.tableId !== tableId || this.viewingPlayerGuard(room, observation) !== null) return;
    const previous = this.latestObservations.get(tableId);
    if (previous !== undefined) {
      if (observation.version < previous.version || observation.eventSeq <= previous.eventSeq) return;
      // The published socket drains notifications by reading the latest full
      // projection: intermediate versions are NOT guaranteed to be delivered.
      // Neither version + 1 nor eventSeq + 1 is a stream continuity rule.
      // A changed turn at the SAME state version is an incoherent boundary,
      // unlike a perfectly valid newer snapshot that skips intermediate state.
      if (observation.version === previous.version && observation.turnId !== previous.turnId) {
        const gap = this.gapObservations.get(tableId);
        if (gap !== undefined && observation.version <= gap.version && observation.eventSeq <= gap.eventSeq) return;
        this.gapObservations.set(tableId, observation);
        this.scheduleTable(tableId);
        return;
      }
    }
    this.lastSocketAt.set(tableId, this.clock());
    this.latestObservations.set(tableId, observation);
    this.pendingObservations.set(tableId, observation);
    this.markDirty(tableId);
  }

  private markDirty(tableId: string): void {
    this.dirtyTables.add(tableId);
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      for (const dirty of this.dirtyTables) {
        this.dirtyTables.delete(dirty);
        this.enqueueTableSync(dirty);
      }
    });
  }

  private enqueueTableSync(tableId: string): void {
    // While a decision is in flight, retain only one queued drain of the
    // latest boundary. Separate WS microtasks must not build an unbounded
    // chain of empty durable-replay passes.
    if (this.queuedTables.has(tableId)) return;
    this.queuedTables.add(tableId);
    const previous = this.tableChains.get(tableId) ?? Promise.resolve();
    const next = previous
      .then(() => {
        this.queuedTables.delete(tableId);
        return this.syncTable(tableId);
      })
      .catch((error: unknown) => {
        this.audit('SYNC_FAILED', { tableId, detail: { reason: describeError(error) } });
      });
    const settled = next.catch(() => {});
    this.tableChains.set(tableId, settled);
    this.tracked.add(settled);
    void settled.finally(() => {
      this.tracked.delete(settled);
    });
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.tracked.size > 0) {
      await Promise.allSettled([...this.tracked]);
      await Promise.resolve();
    }
  }

  private async syncTable(tableId: string): Promise<void> {
    if (this.stopping) return;
    const room = this.roomsByTable.get(tableId);
    if (room === undefined) return;

    let current: CanonicalSeatObservation | null = this.pendingObservations.get(tableId) ?? null;
    this.pendingObservations.delete(tableId);
    if (this.recoveryPending.has(tableId)) {
      try {
        current = await this.transport.fetchObservation(tableId);
      } catch (error) {
        this.audit('OBSERVATION_FAILED', { tableId, detail: { reason: describeError(error) } });
      } finally {
        this.recoveryPending.delete(tableId);
      }
    }
    if (this.stopping) return;
    if (current !== null && !CanonicalSeatObservationSchema.safeParse(current).success) {
      current = null;
    }
    if (current !== null && current.tableId !== tableId) {
      this.audit('OBSERVATION_IDENTITY_MISMATCH', {
        tableId,
        detail: { observedTableId: current.tableId },
      });
      current = null;
    }
    if (current !== null) {
      const guard = this.viewingPlayerGuard(room, current);
      if (guard !== null) {
        this.audit('OBSERVATION_IDENTITY_MISMATCH', {
          tableId,
          turnId: current.turnId,
          detail: {
            reason: guard,
            viewingPlayerId: current.state.viewingPlayerId,
            expectedPlayerId: room.expectedPlayerId ?? null,
          },
        });
        current = null;
      }
    }

    if (current !== null) {
      const latest = this.latestObservations.get(tableId);
      if (latest !== undefined && (current.version < latest.version || current.eventSeq < latest.eventSeq ||
          (current.version > latest.version && current.eventSeq === latest.eventSeq) ||
          (current.version === latest.version && current.turnId !== latest.turnId))) {
        current = latest;
      } else {
        this.latestObservations.set(tableId, current);
      }
    }

    let decisions: readonly AgentDecisionRecord[];
    try {
      decisions = this.store.listDecisions({
        tableId,
        principalId: this.config.principalId,
      });
    } catch (error) {
      this.audit('SYNC_FAILED', { tableId, detail: { reason: describeError(error) } });
      return;
    }

    // Durable work first: restart-pending decisions are resolved before the
    // current turn is considered, and without deriving turn authority locally.
    for (const decision of decisions) {
      if (this.stopping) return;
      if (isTerminal(decision.status)) continue;
      await this.driveDecision(decision, current);
    }

    if (current === null || current.legalActions.length === 0) return;
    await this.observeAndDrive(room, current);
  }

  private async observeAndDrive(
    room: AgentRoomBinding,
    observation: CanonicalSeatObservation,
  ): Promise<void> {
    const existing = this.store.getDecisionForTurn(
      observation.tableId,
      observation.turnId,
      this.config.principalId,
    );
    if (existing !== null) {
      await this.driveDecision(existing, observation);
      return;
    }
    const source = await this.fetchDecisionSource(observation);
    let decision: AgentDecisionRecord;
    try {
      decision = this.store.observeDecision({
        tableId: observation.tableId,
        turnId: observation.turnId,
        principalId: this.config.principalId,
        roomId: room.roomId,
        observation,
        observationHash: computeObservationHash(observation),
        source,
        promptPolicyId: this.config.promptPolicyId,
        eventCursor: observation.eventSeq,
      });
    } catch (error) {
      if (storeErrorCode(error) === 'OBSERVATION_CONFLICT') {
        this.audit('OBSERVATION_CONFLICT', {
          tableId: observation.tableId,
          turnId: observation.turnId,
        });
        return;
      }
      throw error;
    }
    this.audit('DECISION_OBSERVED', {
      tableId: observation.tableId,
      turnId: observation.turnId,
      decisionId: decision.id,
      detail: { eventCursor: observation.eventSeq, legalActions: observation.legalActions.length },
    });
    await this.driveDecision(decision, observation);
  }

  private async fetchDecisionSource(
    observation: CanonicalSeatObservation,
  ): Promise<{ publicChat: ChatMessage[] }> {
    const selection = this.config.chatSelection ?? {};
    const maxMessages = selection.maxMessages ?? DEFAULT_MAX_CHAT_MESSAGES;
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) return { publicChat: [] };
    try {
      const page = await this.transport.fetchChat(observation.tableId, {
        limit: maxMessages,
        beforeSeq: observation.eventSeq + 1,
      });
      const publicChat: ChatMessage[] = [];
      for (const raw of page) {
        const parsed = ChatMessageSchema.safeParse(raw);
        if (!parsed.success) continue;
        const entry = parsed.data;
        if (entry.tableId !== observation.tableId) continue;
        if (entry.handId !== observation.handId) continue;
        if (entry.eventSeq > observation.eventSeq) continue;
        publicChat.push(entry);
      }
      // The source is persisted sanitized with the provider's exact secret
      // policy: a chat body can never smuggle a known provider credential
      // into durable storage. The inspector replays from this sanitized text.
      return { publicChat: this.providerFactory.sanitizeSourceChat(publicChat) };
    } catch (error) {
      this.audit('CHAT_FETCH_FAILED', {
        tableId: observation.tableId,
        turnId: observation.turnId,
        detail: { reason: describeError(error) },
      });
      return { publicChat: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Durable decision driving
  // -------------------------------------------------------------------------

  private async driveDecision(
    seed: AgentDecisionRecord,
    current: CanonicalSeatObservation | null,
  ): Promise<void> {
    if (this.stopping || isTerminal(seed.status)) return;
    if (this.inFlightDecisions.has(seed.id)) return;
    this.inFlightDecisions.add(seed.id);
    try {
      let decision = this.store.getDecision(seed.id) ?? seed;
      for (;;) {
        if (this.stopping) return;
        if (isTerminal(decision.status)) return;

        // The stored canonical request is always replayed before the turn is
        // ever considered stale: a crash-accepted platform receipt is
        // idempotent under the same requestId.
        if (decision.requestJson !== null) {
          await this.driveStoredAction(decision, null);
          return;
        }

        if (decision.status === 'PROVIDER_RECORDED') {
          await this.resolveRecordedDecision(decision);
          return;
        }

        if (decision.status === 'CALLING_PROVIDER') {
          this.recoverAbandonedAttempt(decision);
          const recovered = this.store.getDecision(decision.id) ?? decision;
          if (isTerminal(recovered.status)) return;
          if (recovered.status === 'CALLING_PROVIDER') {
            // The in-flight attempt could not be closed (contended store);
            // leave the durable state untouched for a later resync.
            this.audit('TRANSITION_CONTENDED', {
              tableId: decision.tableId,
              turnId: decision.turnId,
              decisionId: decision.id,
              detail: { state: 'CALLING_PROVIDER' },
            });
            return;
          }
          decision = recovered;
          continue;
        }

        if (decision.attemptCount >= this.maxAttempts) {
          this.markFailed(decision, 'provider_attempts_exhausted');
          return;
        }
        if (decision.status !== 'OBSERVED') {
          this.markFailed(decision, `unsupported_decision_state:${decision.status}`);
          return;
        }

        const retry = await this.runProviderOnce(decision, current);
        if (!retry) return;
        decision = this.store.getDecision(decision.id) ?? decision;
      }
    } finally {
      this.inFlightDecisions.delete(seed.id);
    }
  }

  /**
   * A `CALLING_PROVIDER` row observed with no live holder in this process is
   * an attempt abandoned by a previous process (the store is single-process).
   * Record it as a distinct FAILED attempt so a bounded second attempt can
   * start. Never called for the attempt this runtime is currently driving.
   */
  private recoverAbandonedAttempt(decision: AgentDecisionRecord): void {
    let attempts: AgentModelAttempt[];
    try {
      attempts = this.store.listAttempts(decision.id);
    } catch {
      return;
    }
    const pending = attempts.find((attempt) => attempt.status === 'PENDING');
    if (pending === undefined) return;
    if (this.recordFailedAttempt(decision, pending, 'inflight_abandoned')) {
      this.audit('IN_FLIGHT_AMBIGUITY_RECOVERED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: pending.attemptNo,
      });
    }
  }

  private recordFailedAttempt(
    decision: AgentDecisionRecord,
    attempt: AgentModelAttempt,
    error: string,
  ): boolean {
    const identity = this.providerFactory.identity;
    try {
      this.store.recordAttemptResponse(decision.id, attempt.id, {
        status: 'FAILED',
        responseJson: null,
        error: sanitizeReason(error),
        model: identity.model,
        provider: identity.provider,
        promptPolicyId: this.config.promptPolicyId,
        usage: { promptTokens: 0, completionTokens: 0, costMicroUsd: 0, latencyMs: 0 },
      });
      return true;
    } catch (failure) {
      const code = storeErrorCode(failure);
      if (code === 'DECISION_STATE' || code === 'ATTEMPT_STATE') return false;
      throw failure;
    }
  }

  /**
   * Run at most one durable provider attempt for an OBSERVED decision. Returns
   * `true` when the caller should re-drive the decision (a recorded failure
   * left attempts available), `false` when the decision reached a durable
   * resting point.
   */
  private async runProviderOnce(
    decision: AgentDecisionRecord,
    current: CanonicalSeatObservation | null,
  ): Promise<boolean> {
    if (current !== null) {
      if (current.turnId !== decision.turnId) {
        this.markStale(decision, 'turn_superseded');
        return false;
      }
      if (current.handId !== decision.observation.handId) {
        this.markStale(decision, 'hand_superseded');
        return false;
      }
    }
    const room = this.roomsByTable.get(decision.tableId);
    if (room === undefined) return false;

    // Product availability guard: blocks only new provider calls. Recorded
    // responses/actions are resolved before this method and are never blocked.
    if (this.config.providerCallsEnabled === false) {
      this.audit('PROVIDER_UNAVAILABLE', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
      });
      this.markFailed(decision, 'provider_unavailable');
      return false;
    }

    let observation: CanonicalSeatObservation;
    try {
      observation = this.canonicalObservationOf(decision);
    } catch (error) {
      this.markFailed(decision, `observation_integrity_failure:${describeError(error)}`);
      return false;
    }

    // Authoritative hand cap from the canonical platform state: a fresh
    // competition table starts at handNumber 1 and the counter never resets,
    // so this survives restarts without any local seen-hand set.
    if (this.exceedsRoomHands(room, observation)) {
      this.markFailed(decision, 'room_max_hands_exhausted');
      return false;
    }
    // Run budget gates provider calls only; recorded response/action recovery
    // is resolved before this method and is never blocked by it.
    if (this.overallDeadlineExceeded()) {
      this.markFailed(decision, 'runtime_deadline_exhausted');
      return false;
    }

    const timeoutMs = resolveCallBudgetMs({
      state: observation.state,
      now: this.clock(),
      perCallTimeoutMs: this.config.perCallTimeoutMs,
      safetyMarginMs: this.safetyMarginMs,
    });
    if (timeoutMs <= 0) {
      this.markFailed(decision, 'deadline_margin_exhausted');
      return false;
    }
    try {
      assertPromptPolicy(this.config.promptPolicyId, this.config.promptPolicyHash);
    } catch (error) {
      this.audit('PROMPT_POLICY_REJECTED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
      this.markFailed(decision, 'prompt_policy_rejected');
      return false;
    }

    const callState: ProviderCallState = {
      attempt: null,
      prompt: null,
      requestJson: null,
      reserved: false,
      settled: false,
      requestStarted: false,
      responseSeen: false,
      startedAt: 0,
    };
    const provider = this.providerFactory({
      decision,
      attempt: () => callState.attempt,
      timeoutMs,
      onRequest: (record) => this.handleProviderRequest(decision, observation, callState, record),
      onResponse: (record) => this.handleProviderResponse(decision, room, callState, record),
    });

    let prompt: DecisionPrompt;
    try {
      // The chat source is restored exactly from the observed boundary; the
      // outbound payload is never used to reconstruct it.
      prompt = provider.buildPrompt(observation, decision.source?.publicChat ?? []);
    } catch (error) {
      this.audit('PROMPT_BUILD_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
      this.markFailed(decision, `prompt_build_failed:${describeError(error)}`);
      return false;
    }
    callState.prompt = prompt;
    const requestJson = serializeDecisionRequest(
      prompt,
      this.providerFactory.knownSecrets ?? [],
    );
    callState.requestJson = requestJson;

    // Deterministic pre-HTTP cost admission: the declared per-call ceiling must
    // fit the agent's configured maximum, and the room-wide caps are enforced
    // atomically by the store's own transaction when the fixed per-call maximum
    // is reserved. No read-then-await gap and no incoming-reserve blind spot.
    const agentConfig = this.store.getAgentConfig(this.config.agentId);
    if (agentConfig === null) {
      this.audit('ROOM_RESERVATION_DENIED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: 'agent_config_missing' },
      });
      this.markFailed(decision, 'agent_config_missing');
      return false;
    }
    const perCallMaxUsdMicro = agentConfig.limits.maxCostMicroUsdPerCall;
    const costCeilingUsdMicro = this.providerFactory.costCeilingUsdMicro(prompt);
    if (costCeilingUsdMicro > BigInt(perCallMaxUsdMicro)) {
      this.audit('PROVIDER_COST_CEILING_EXCEEDED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: {
          ceiling: costCeilingUsdMicro.toString(),
          perCallMaxUsdMicro,
        },
      });
      this.markFailed(decision, 'provider_cost_ceiling_exceeded');
      return false;
    }

    // The exact request bytes plus the full sanitized pre-HTTP transport
    // metadata (never headers or credentials) are persisted with the attempt
    // before any provider I/O; `onRequest` then asserts the actual record
    // matches this immutable metadata.
    const identity = this.providerFactory.identity;
    const requestMetadata = {
      provider: identity.provider,
      model: identity.model,
      baseUrlHost: identity.baseUrlHost,
      promptVersion: prompt.promptVersion,
      promptHash: prompt.promptHash,
      observationHash: prompt.observationHash,
      requestBytes: Buffer.byteLength(requestJson, 'utf8'),
      startedAt: this.clock(),
    };

    let started;
    try {
      started = this.store.startAttempt(decision.id, requestJson, requestMetadata);
    } catch (error) {
      const code = storeErrorCode(error);
      if (code === 'ATTEMPT_IN_FLIGHT' || code === 'DECISION_STATE') {
        this.audit('TRANSITION_CONTENDED', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
          detail: { code },
        });
        return false;
      }
      throw error;
    }
    if (started.kind === 'reuse') {
      this.audit('PROVIDER_RESPONSE_REUSED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: started.attempt.attemptNo,
      });
      const reloaded = this.store.getDecision(decision.id);
      if (reloaded !== null) await this.resolveRecordedDecision(reloaded);
      return false;
    }
    callState.attempt = started.attempt;
    this.audit('PROVIDER_ATTEMPT_STARTED', {
      tableId: decision.tableId,
      turnId: decision.turnId,
      decisionId: decision.id,
      attemptNo: started.attempt.attemptNo,
    });

    try {
      // The exact token-based ceiling is reserved instead of the declared
      // per-call maximum: it is a true upper bound on this call, so actual
      // cost always settles lower and room caps admit only real spend.
      const reserveMicroUsd = Number(costCeilingUsdMicro);
      this.store.reserveCall(
        room.roomId,
        this.config.agentId,
        {
          maxCalls: room.maxCalls ?? null,
          maxCostMicroUsd: room.maxCostMicroUsd ?? null,
        },
        reserveMicroUsd,
      );
      callState.reserved = true;
    } catch (error) {
      const code = storeErrorCode(error) || describeError(error);
      this.audit('ROOM_RESERVATION_DENIED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: started.attempt.attemptNo,
        detail: { code },
      });
      this.recordFailedAttempt(decision, started.attempt, `room_reservation_denied:${code}`);
      this.markFailed(decision, `room_reservation_denied:${code}`);
      return false;
    }

    callState.startedAt = this.clock();
    const signal = this.callSignal(timeoutMs);
    let callError: unknown = null;
    try {
      await this.limiter.run(() => provider.sendPrompt(prompt, { signal }));
    } catch (error) {
      callError = error;
    }

    const attempt =
      this.store.listAttempts(decision.id).find((row) => row.id === started.attempt.id) ?? null;
    const reloaded = this.store.getDecision(decision.id) ?? decision;

    if (this.stopping) {
      this.finishUnsettledReservation(decision, room, callState);
      this.audit('ABORTED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
      });
      return false;
    }
    if (attempt !== null && attempt.status === 'SUCCEEDED') {
      await this.resolveRecordedDecision(reloaded);
      return false;
    }
    if (attempt !== null && attempt.status === 'FAILED') {
      if (reloaded.attemptCount < this.maxAttempts) {
        this.audit('PROVIDER_ATTEMPT_RETRY', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
          attemptNo: attempt.attemptNo,
          detail: { error: attempt.error },
        });
        return true;
      }
      this.markFailed(
        reloaded,
        `provider_attempts_exhausted:${sanitizeReason(attempt.error ?? describeError(callError))}`,
      );
      return false;
    }

    // No response recorded: the provider never reached HTTP (preflight
    // failure) or persistence itself failed. A reservation is never leaked:
    // when the request was started (or a response was seen) the call settles
    // conservatively at the reserved maximum; otherwise it is released.
    this.finishUnsettledReservation(decision, room, callState);
    this.recordFailedAttempt(
      decision,
      started.attempt,
      `provider_preflight_failed:${describeError(callError)}`,
    );
    const after = this.store.getDecision(decision.id) ?? reloaded;
    if (after.attemptCount < this.maxAttempts) {
      this.audit('PROVIDER_ATTEMPT_RETRY', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: started.attempt.attemptNo,
      });
      return true;
    }
    this.markFailed(after, 'provider_attempts_exhausted');
    return false;
  }

  // -------------------------------------------------------------------------
  // Provider persistence callbacks (synchronous, before HTTP / before action)
  // -------------------------------------------------------------------------

  private handleProviderRequest(
    decision: AgentDecisionRecord,
    observation: CanonicalSeatObservation,
    callState: ProviderCallState,
    record: DecisionRequestRecord,
  ): void {
    const attempt = callState.attempt;
    if (attempt === null) {
      throw new AgentIntegrityError('provider request received before the durable attempt');
    }
    const prompt = callState.prompt;
    if (
      callState.requestJson === null ||
      prompt === null ||
      record.requestJson !== callState.requestJson
    ) {
      this.audit('PROVIDER_REQUEST_MISMATCH', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
        detail: { promptHash: record.promptHash },
      });
      throw new AgentIntegrityError('recorded provider request does not match the persisted attempt');
    }
    // Mandatory pre-HTTP metadata assertions: exact request hash, full
    // transport metadata, prompt identity and observation identity of the
    // persisted prompt. The actual onRequest record must match the immutable
    // attempt metadata byte for byte (headers are never part of any record).
    const identity = this.providerFactory.identity;
    const requestHash = createHash('sha256').update(record.requestJson, 'utf8').digest('hex');
    if (
      record.requestHash !== requestHash ||
      record.requestBytes !== Buffer.byteLength(record.requestJson, 'utf8') ||
      record.promptHash !== prompt.promptHash ||
      record.promptVersion !== prompt.promptVersion ||
      record.observationHash !== prompt.observationHash ||
      record.model !== prompt.model ||
      record.provider !== identity.provider ||
      record.baseUrlHost !== identity.baseUrlHost
    ) {
      this.audit('PROVIDER_REQUEST_MISMATCH', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
        detail: { promptHash: record.promptHash, requestHash: record.requestHash },
      });
      throw new AgentIntegrityError('recorded provider request metadata does not match the persisted attempt');
    }
    try {
      assertPromptPolicy(this.config.promptPolicyId, this.config.promptPolicyHash);
    } catch (error) {
      this.audit('PROMPT_POLICY_REJECTED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
        detail: { reason: describeError(error) },
      });
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(record.requestJson) as unknown;
    } catch {
      body = null;
    }
    try {
      // Independent re-derivation from the stored canonical observation and
      // the stored allowed chat source; fails closed before any HTTP.
      inspectDecisionRequest({
        request: body,
        record: {
          model: record.model,
          promptVersion: record.promptVersion,
          promptHash: record.promptHash,
          observationHash: record.observationHash,
          requestHash: record.requestHash,
          temperature: callState.prompt?.temperature,
          maxOutputTokens: callState.prompt?.maxOutputTokens,
        },
        observation,
        publicChat: decision.source?.publicChat ?? [],
        selection: this.config.chatSelection,
        knownSecrets: this.providerFactory.knownSecrets ?? [],
      });
    } catch (error) {
      this.audit('PROVIDER_REQUEST_INSPECTION_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
        detail: { reason: describeError(error) },
      });
      throw error;
    }
    // Every pre-HTTP check passed: the provider will now perform the exchange.
    callState.requestStarted = true;
    this.audit('PROVIDER_REQUEST_PERSISTED', {
      tableId: decision.tableId,
      turnId: decision.turnId,
      decisionId: decision.id,
      attemptNo: attempt.attemptNo,
    });
  }

  private handleProviderResponse(
    decision: AgentDecisionRecord,
    room: AgentRoomBinding,
    callState: ProviderCallState,
    record: DecisionResponseRecord,
  ): void {
    const attempt = callState.attempt;
    if (attempt === null) {
      throw new AgentIntegrityError('provider response received before the durable attempt');
    }
    if (this.stopping) {
      // The exchange was aborted; leave the attempt durably pending so a
      // later process recovers it within the bounded attempt budget.
      this.audit('PROVIDER_RESPONSE_DROPPED_ON_STOP', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
      });
      return;
    }
    callState.responseSeen = true;
    const costMicroUsd = bigintToMicroUsd(record.costUsdMicro);
    const succeeded = record.ok && record.errorCode === null && record.responseJson !== null;
    // When usage is unknown the actual cost is unknown; the reservation is
    // left in flight so the conservative per-call maximum keeps counting
    // against the room caps instead of being released as a zero-cost call.
    const usageKnown = record.inputTokens !== null && record.outputTokens !== null;
    const identity = this.providerFactory.identity;
    try {
      this.store.recordAttemptResponse(decision.id, attempt.id, {
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        responseJson: record.responseJson,
        error: succeeded ? null : (record.errorCode ?? `provider_http_${record.status}`),
        model: identity.model,
        provider: identity.provider,
        promptPolicyId: this.config.promptPolicyId,
        usage: {
          promptTokens: record.inputTokens ?? 0,
          completionTokens: record.outputTokens ?? 0,
          costMicroUsd,
          latencyMs: Math.max(0, Math.floor(record.finishedAt - callState.startedAt)),
        },
      });
      this.audit(succeeded ? 'PROVIDER_RESPONSE_SUCCEEDED' : 'PROVIDER_RESPONSE_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: attempt.attemptNo,
        detail: {
          status: record.status,
          errorCode: record.errorCode,
          costMicroUsd,
        },
      });
    } finally {
      this.settleReservation(decision, room, callState, costMicroUsd, usageKnown);
    }
  }

  /**
   * Settle a recorded call. Known usage settles at the actual integer cost;
   * unknown usage settles conservatively at the reserved per-call maximum so
   * no in-flight reservation leaks and room caps stay exact.
   */
  private settleReservation(
    decision: AgentDecisionRecord,
    room: AgentRoomBinding,
    callState: ProviderCallState,
    costMicroUsd: number,
    usageKnown: boolean,
  ): void {
    if (!callState.reserved || callState.settled) return;
    try {
      if (usageKnown) {
        this.store.settleCall(room.roomId, this.config.agentId, costMicroUsd);
      } else {
        // The store releases the exact ceiling reserved for this call.
        this.store.settleUnknownCall(room.roomId, this.config.agentId);
        this.audit('RESERVATION_SETTLED_UNKNOWN', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
        });
      }
      callState.settled = true;
    } catch (error) {
      try {
        this.store.releaseCall(room.roomId, this.config.agentId);
      } catch {
        // Last resort only; the conservative settlement above is preferred.
      }
      callState.settled = true;
      this.audit('RESERVATION_SETTLE_REJECTED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error), costMicroUsd },
      });
    }
  }

  /**
   * Finish a reservation whose outcome was never recorded. A started request
   * (or seen response) settles conservatively at the reserved maximum; a
   * preflight failure that never reached HTTP is released.
   */
  private finishUnsettledReservation(
    decision: AgentDecisionRecord,
    room: AgentRoomBinding,
    callState: ProviderCallState,
  ): void {
    if (!callState.reserved || callState.settled) return;
    if (callState.requestStarted || callState.responseSeen) {
      this.settleReservation(decision, room, callState, 0, false);
      return;
    }
    try {
      this.store.releaseCall(room.roomId, this.config.agentId);
      callState.settled = true;
    } catch (error) {
      this.audit('RESERVATION_SETTLE_REJECTED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Recorded response resolution + action submission
  // -------------------------------------------------------------------------

  /**
   * Resolve a recorded successful response strictly from durable state: parse
   * the stored exact response, validate it against the stored observation's
   * exact menu for the same turn, persist the canonical request and submit it.
   */
  private async resolveRecordedDecision(decision: AgentDecisionRecord): Promise<void> {
    const attempts = this.store.listAttempts(decision.id);
    const recorded = [...attempts]
      .reverse()
      .find((attempt) => attempt.status === 'SUCCEEDED' && attempt.responseJson !== null);
    if (recorded === undefined) {
      this.audit('PROVIDER_RESPONSE_MISSING', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
      });
      this.markFailed(decision, 'recorded_response_missing');
      return;
    }

    let observation: CanonicalSeatObservation;
    try {
      observation = this.canonicalObservationOf(decision);
    } catch (error) {
      this.markFailed(decision, `observation_integrity_failure:${describeError(error)}`);
      return;
    }

    let chosen: ChosenAction;
    try {
      const payload = JSON.parse(recorded.responseJson as string) as unknown;
      const menu = deriveDecisionMenu(observation.legalActions);
      chosen = validateActionChoice(payload, menu.actions);
    } catch (error) {
      this.audit('MALFORMED_PROVIDER_RESPONSE', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: recorded.attemptNo,
        detail: { reason: describeError(error) },
      });
      this.markFailed(decision, `invalid_provider_response:${describeError(error)}`);
      return;
    }

    let request: CanonicalActionRequest;
    try {
      request = buildCanonicalActionRequest(decision, observation, chosen);
    } catch (error) {
      this.markFailed(decision, `invalid_provider_action:${describeError(error)}`);
      return;
    }

    let submitted: AgentDecisionRecord;
    try {
      submitted = this.store.submitResolvedAction(decision.id, JSON.stringify(request));
    } catch (error) {
      const code = storeErrorCode(error);
      if (code === 'DECISION_STATE') {
        this.audit('TRANSITION_CONTENDED', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
          detail: { code },
        });
        return;
      }
      this.audit('ACTION_REQUEST_PERSIST_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
      throw error;
    }
    this.audit('ACTION_REQUEST_PERSISTED', {
      tableId: decision.tableId,
      turnId: decision.turnId,
      decisionId: decision.id,
      attemptNo: recorded.attemptNo,
      detail: {
        actionId: request.actionId,
        family: chosen.family,
        normalization: chosen.normalization,
      },
    });
    if (chosen.normalization === 'amount_ignored') {
      // The raw provider response supplied an amount for an action whose menu
      // entry takes none; it was discarded and the canonical request carries
      // the exact server amount. Audited distinctly for operators.
      this.audit('PROVIDER_AMOUNT_IGNORED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        attemptNo: recorded.attemptNo,
        detail: {
          actionId: request.actionId,
          family: chosen.family,
          normalization: chosen.normalization,
          serverAmount: chosen.amount,
        },
      });
    }
    await this.driveStoredAction(submitted, chosen.speech);
  }

  /**
   * Replay the exact stored canonical request under its stable `requestId`
   * before any staleness conclusion. The platform returns the original stored
   * receipt for a crash-accepted action.
   */
  private async driveStoredAction(
    decision: AgentDecisionRecord,
    speech: string | null,
  ): Promise<void> {
    if (decision.requestJson === null) {
      this.markFailed(decision, 'stored_request_missing');
      return;
    }
    let request: CanonicalActionRequest;
    try {
      request = parseStoredActionRequest(decision.requestJson);
    } catch (error) {
      this.markFailed(decision, `stored_request_invalid:${describeError(error)}`);
      return;
    }

    for (let submission = 1; submission <= MAX_ACTION_SUBMISSIONS; submission += 1) {
      if (this.stopping) {
        this.audit('ACTION_ABORTED', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
        });
        return;
      }
      try {
        const result = await this.limiter.run(() =>
          this.transport.submitAction(decision.tableId, request),
        );
        const receipt = result.receipt;
        if (
          receipt.requestId !== request.requestId ||
          receipt.actionId !== request.actionId ||
          receipt.turnId !== request.turnId
        ) {
          this.markFailed(decision, 'action_receipt_mismatch');
          return;
        }
        // An accepted platform receipt is durable truth: it is committed
        // before any shutdown consideration. Stopping only prevents new
        // speech (and other new mutations), never the recording of an
        // accepted action.
        this.store.commitDecision(decision.id, JSON.stringify(receipt));
        this.audit('COMMITTED', {
          tableId: decision.tableId,
          turnId: decision.turnId,
          decisionId: decision.id,
          detail: { actionId: request.actionId, eventSeq: receipt.eventSeq },
        });
        if (this.stopping) {
          this.audit('ACTION_ACCEPTED_ON_STOP', {
            tableId: decision.tableId,
            turnId: decision.turnId,
            decisionId: decision.id,
          });
          return;
        }
        await this.maybeSpeak(decision, speech);
        return;
      } catch (error) {
        if (this.stopping || isAbortError(error)) {
          this.audit('ACTION_ABORTED', {
            tableId: decision.tableId,
            turnId: decision.turnId,
            decisionId: decision.id,
            detail: { reason: describeError(error) },
          });
          return;
        }
        const failure = classifyActionFailure(error);
        if (failure === 'STALE') {
          this.markStale(decision, `action_stale:${describeError(error)}`);
          return;
        }
        if (failure === 'RETRY' && submission < MAX_ACTION_SUBMISSIONS) {
          this.audit('ACTION_SUBMIT_RETRY', {
            tableId: decision.tableId,
            turnId: decision.turnId,
            decisionId: decision.id,
            detail: { submission, reason: describeError(error) },
          });
          continue;
        }
        this.markFailed(decision, `action_failed:${describeError(error)}`);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // At-most-once public speech (after an accepted receipt only)
  // -------------------------------------------------------------------------

  /**
   * Optional public speech, only after an accepted receipt and only when the
   * store's write-once intention is granted. The SDK chat append has no
   * idempotency key, so a denied or ambiguous send is never retried and never
   * rolls back the committed action.
   */
  private async maybeSpeak(decision: AgentDecisionRecord, speech: string | null): Promise<void> {
    if (this.speechPolicy !== 'AFTER_COMMIT' || speech === null || speech.length === 0) return;
    let firstIntention: boolean;
    try {
      firstIntention = this.store.markSpeechIntended(decision.id);
    } catch (error) {
      this.audit('SPEECH_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
      return;
    }
    if (!firstIntention) {
      this.audit('SPEECH_AT_MOST_ONCE_ABANDONED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
      });
      return;
    }
    try {
      await this.limiter.run(() =>
        this.transport.sendChat({
          tableId: decision.tableId,
          body: speech,
          requestId: decision.id,
        }),
      );
      this.audit('SPEECH_SENT', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
      });
    } catch (error) {
      // Speech failure never rolls back the accepted action and is never retried.
      this.audit('SPEECH_FAILED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { reason: describeError(error) },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Guards and helpers
  // -------------------------------------------------------------------------

  private canonicalObservationOf(decision: AgentDecisionRecord): CanonicalSeatObservation {
    const parsed = CanonicalSeatObservationSchema.safeParse(decision.observation);
    if (!parsed.success) {
      throw new AgentIntegrityError(
        `stored observation is not canonical: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    const observation = parsed.data;
    if (
      observation.tableId !== decision.tableId ||
      observation.turnId !== decision.turnId ||
      observation.version !== decision.version
    ) {
      throw new AgentIntegrityError('stored observation identity does not match its decision');
    }
    if (computeObservationHash(observation) !== decision.observationHash) {
      throw new AgentIntegrityError('stored observation hash mismatch');
    }
    return observation;
  }

  /**
   * Seat-scoped observation guard. `null` means the observation may be used;
   * otherwise the returned reason names the rejected identity.
   */
  private viewingPlayerGuard(
    room: AgentRoomBinding,
    observation: CanonicalSeatObservation,
  ): string | null {
    const viewingPlayerId = observation.state.viewingPlayerId;
    if (viewingPlayerId === null) return 'observation_is_not_seat_scoped';
    const expected = room.expectedPlayerId ?? null;
    if (expected !== null && viewingPlayerId !== expected) return 'viewing_player_mismatch';
    return null;
  }

  /**
   * Authoritative hand cap. `state.handNumber` is the canonical monotonic
   * platform counter (a fresh competition table starts at 1), so the guard is
   * identical before and after a restart and never consults other
   * observations, replay or hidden state.
   */
  private exceedsRoomHands(
    room: AgentRoomBinding,
    observation: CanonicalSeatObservation,
  ): boolean {
    const maxHands = room.maxHands ?? null;
    if (maxHands === null) return false;
    if (!Number.isSafeInteger(maxHands) || maxHands < 1) return false;
    const handNumber = observation.state.handNumber;
    if (!Number.isSafeInteger(handNumber) || handNumber <= maxHands) return false;
    this.audit('ROOM_MAX_HANDS_EXCEEDED', {
      tableId: observation.tableId,
      turnId: observation.turnId,
      detail: { maxHands, handNumber },
    });
    return true;
  }

  /**
   * Run-budget guard. An absolute deadline (production: genuine orchestration
   * activation + run window) is restart-stable and never reset by `start()`;
   * the relative window is only the standalone/unit fallback. Either way this
   * gates new provider calls only, never recorded mutation recovery.
   */
  private overallDeadlineExceeded(): boolean {
    const absolute = this.config.overallDeadlineAtMs ?? null;
    if (absolute !== null) {
      if (this.clock() < absolute) return false;
      this.audit('RUNTIME_DEADLINE_EXCEEDED', {
        detail: { source: 'absolute', overallDeadlineAtMs: absolute },
      });
      return true;
    }
    const relative = this.config.overallRuntimeMs ?? null;
    if (relative === null) return false;
    if (this.clock() - this.startedAtMs < relative) return false;
    this.audit('RUNTIME_DEADLINE_EXCEEDED', {
      detail: { source: 'relative', overallRuntimeMs: relative },
    });
    return true;
  }

  private callSignal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
    return AbortSignal.any([this.controller.signal, timeout]);
  }

  private markStale(decision: AgentDecisionRecord, reason: string): void {
    const sanitized = sanitizeReason(reason);
    try {
      this.store.markDecisionStale(decision.id, sanitized);
    } catch (error) {
      this.audit('TRANSITION_CONTENDED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { code: storeErrorCode(error), reason: sanitized },
      });
      return;
    }
    this.audit('DECISION_STALE', {
      tableId: decision.tableId,
      turnId: decision.turnId,
      decisionId: decision.id,
      detail: { reason: sanitized },
    });
  }

  private markFailed(decision: AgentDecisionRecord, reason: string): void {
    const sanitized = sanitizeReason(reason);
    try {
      this.store.failDecision(decision.id, sanitized);
    } catch (error) {
      this.audit('TRANSITION_CONTENDED', {
        tableId: decision.tableId,
        turnId: decision.turnId,
        decisionId: decision.id,
        detail: { code: storeErrorCode(error), reason: sanitized },
      });
      return;
    }
    this.audit('DECISION_FAILED', {
      tableId: decision.tableId,
      turnId: decision.turnId,
      decisionId: decision.id,
      detail: { reason: sanitized },
    });
  }

  private stopTimer(): void {
    if (this.resyncTimer !== null) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private audit(
    code: AgentAuditCode,
    context: {
      tableId?: string | null;
      turnId?: string | null;
      decisionId?: string | null;
      attemptNo?: number | null;
      detail?: Record<string, unknown> | null;
    } = {},
  ): void {
    if (this.auditSink === null) return;
    const event: AgentAuditEvent = {
      at: this.clock(),
      code,
      agentId: this.config.agentId,
      principalId: this.config.principalId,
      tableId: context.tableId ?? null,
      turnId: context.turnId ?? null,
      decisionId: context.decisionId ?? null,
      attemptNo: context.attemptNo ?? null,
      detail:
        context.detail === undefined || context.detail === null
          ? null
          : sanitizeSecretText(JSON.stringify(context.detail)),
    };
    try {
      this.auditSink(event);
    } catch {
      // Auditing never breaks decision durability.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRequiredText(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

export function serializeDecisionRequest(
  prompt: DecisionPrompt,
  knownSecrets: readonly string[] = [],
): string {
  return JSON.stringify(sanitizeSecretValue(prompt.body, { knownSecrets }));
}

function buildCanonicalActionRequest(
  decision: AgentDecisionRecord,
  observation: CanonicalSeatObservation,
  chosen: ChosenAction,
): CanonicalActionRequest {
  const amount = chosen.amount !== null && chosen.amount > 0 ? chosen.amount : null;
  const takesAmount = chosen.family === 'BET' || chosen.family === 'RAISE';
  if (takesAmount && amount === null) {
    throw new AgentIntegrityError('bounded provider action requires a positive amount');
  }
  const candidate: CanonicalActionRequest = {
    // The decision id is stable across restarts, so the platform idempotency
    // receipt for a crash-accepted action is always reused instead of
    // generating a second logical action.
    requestId: decision.id,
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: chosen.actionId,
    ...(amount !== null ? { amount } : {}),
  };
  const parsed = CanonicalActionRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AgentIntegrityError(
      `canonical action request invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

function parseStoredActionRequest(requestJson: string): CanonicalActionRequest {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(requestJson) as unknown;
  } catch {
    throw new AgentIntegrityError('stored action request is not valid JSON');
  }
  const parsed = CanonicalActionRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AgentIntegrityError(
      `stored action request is not canonical: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

function isTerminal(status: AgentDecisionRecord['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

function bigintToMicroUsd(value: bigint): number {
  if (value < 0n) throw new AgentIntegrityError('provider cost is negative');
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AgentIntegrityError('provider cost exceeds the safe integer range');
  }
  return Number(value);
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function storeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return sanitizeReason(code);
    return sanitizeReason(`${error.name}:${error.message}`);
  }
  return sanitizeReason(String(error));
}

function sanitizeReason(value: string): string {
  const sanitized = sanitizeSecretText(value)
    .replace(/[^A-Za-z0-9_.:@-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : 'unknown_error';
}

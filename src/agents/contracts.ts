/**
 * Public contracts of the durable product `AgentRuntime`.
 *
 * The runtime is deliberately narrow at every boundary:
 *
 * - Authority comes only from an authenticated per-agent `AgentTurnTransport`
 *   (the ordinary `PokerClient` / `PokerSocket` credential): observations are
 *   fetched over the agent's own REST session and socket messages are used
 *   only as coalesced resync triggers, never as local turn authority.
 * - Durability comes only from `AgentDecisionStorePort`, the `ProductStore`
 *   subset keyed by `(tableId, turnId, principalId)`. The port is owned here
 *   so the runtime can be unit-tested and so persistence can be adapted
 *   without moving poker authority into product code.
 * - Provider I/O is produced by a `DecisionProviderFactory` that binds the
 *   exact `onRequest`/`onResponse` persistence callbacks of one durable
 *   attempt. Secrets live only inside the factory configuration and never
 *   reach audit events.
 *
 * No poker legality is implemented here: legal actions always come from the
 * platform observation and provider output is only accepted through
 * `validateActionChoice` over that exact menu.
 */
import type {
  CanonicalActionRequest,
  CanonicalActionResult,
  ChatMessage,
  SeatObservation,
} from '@pokertools/types';
import type { ChatSelectionOptions, DecisionPrompt } from '../llm/decision-prompt.js';
import type {
  DecisionRequestRecord,
  DecisionResponseRecord,
} from '../llm/decision-provider.js';
import type {
  AgentReservation,
  ModelAttempt,
  ProductDecision,
  ProductStore,
} from '../product/store.js';

// ---------------------------------------------------------------------------
// Durable store port (the ProductStore decision subset)
// ---------------------------------------------------------------------------

/**
 * Narrow typed port over the durable decision store.
 *
 * `ProductStore` satisfies this port structurally (compile-time proof below),
 * so product wiring passes the store directly; tests may substitute an
 * equivalent durable fake. Every CAS transition, attempt row, speech intention
 * and reservation remains owned by the store:
 *
 * - `reserveCall(roomId, agentId, roomLimits)` admits the fixed per-call
 *   maximum atomically inside the store's own transaction, comparing the
 *   incoming reserve against the room's declared caps (strict `>`), so
 *   simultaneous agents can never overspend a room.
 * - `settleUnknownCall` conservatively settles a call whose actual usage is
 *   unknown at the reserved per-call maximum instead of leaking an in-flight
 *   reservation.
 * - `markSpeechIntended` is the write-once at-most-once speech gate.
 */
export type AgentDecisionStorePort = Pick<
  ProductStore,
  | 'observeDecision'
  | 'getDecision'
  | 'getDecisionForTurn'
  | 'listDecisions'
  | 'startAttempt'
  | 'recordAttemptResponse'
  | 'submitResolvedAction'
  | 'commitDecision'
  | 'markDecisionStale'
  | 'failDecision'
  | 'listAttempts'
  | 'getAgentConfig'
  | 'reserveCall'
  | 'settleCall'
  | 'settleUnknownCall'
  | 'releaseCall'
  | 'listRoomReservations'
  | 'markSpeechIntended'
>;

/** One durable decision record (alias of the store row view). */
export type AgentDecisionRecord = ProductDecision;
/** One immutable provider attempt row (alias of the store row view). */
export type AgentModelAttempt = ModelAttempt;
/** Conservative per-room reservation counters (alias of the store row view). */
export type AgentReservationCounters = AgentReservation;

// ---------------------------------------------------------------------------
// Authenticated transport
// ---------------------------------------------------------------------------

/** Bounded chat page request; `beforeSeq` is exclusive on the platform side. */
export interface AgentChatQuery {
  limit: number;
  beforeSeq?: number;
}

/** Acknowledgement of one public chat append. */
export interface AgentChatReceipt {
  messageId: string;
}

/**
 * The authenticated per-agent poker transport. Implementations wrap the
 * ordinary SDK `PokerClient` / `PokerSocket` for exactly one credential.
 */
export interface AgentTurnTransport {
  /**
   * Authenticated principal of this transport, once connected. `null` before
   * `connect()`; a runtime refuses to act unless it equals the configured
   * principal.
   */
  readonly principalId: string | null;
  connect(): Promise<void>;
  close(): void;
  /** Authoritative per-seat observation for the acting turn (REST). */
  fetchObservation(tableId: string): Promise<SeatObservation>;
  /** Submit one canonical action, replay-safe under its stable `requestId`. */
  submitAction(tableId: string, request: CanonicalActionRequest): Promise<CanonicalActionResult>;
  /** Bounded page of the append-only public chat stream. */
  fetchChat(tableId: string, options: AgentChatQuery): Promise<readonly unknown[]>;
  /**
   * Public chat append. `requestId` is the runtime's durable at-most-once
   * intention identity; the platform SDK carries no chat idempotency key, so
   * the runtime never blindly retries.
   */
  sendChat(input: {
    tableId: string;
    body: string;
    requestId: string;
  }): Promise<AgentChatReceipt>;
  /**
   * Trigger subscription. Payloads are never decision authority; runtimes
   * coalesce them and then resync through `fetchObservation`.
   */
  onObservation(tableId: string, listener: (observation: SeatObservation) => void): () => void;
}

// ---------------------------------------------------------------------------
// Decision provider factory
// ---------------------------------------------------------------------------

/** Context of exactly one durable provider attempt. */
export interface DecisionProviderCallContext {
  /** Durable decision this attempt belongs to. */
  decision: AgentDecisionRecord;
  /** Durable attempt row; set before any HTTP, `null` before it exists. */
  attempt(): AgentModelAttempt | null;
  /** Effective per-call budget for the whole HTTP exchange. */
  timeoutMs: number;
  /** Exact sanitized request, persisted synchronously before HTTP. */
  onRequest(record: DecisionRequestRecord): void;
  /** Exact sanitized response, persisted synchronously before returning. */
  onResponse(record: DecisionResponseRecord): void;
}

/** One provider call surface; the runtime owns prompt construction order. */
export interface DecisionProviderPort {
  buildPrompt(observation: SeatObservation, publicChat?: readonly unknown[]): DecisionPrompt;
  sendPrompt(prompt: DecisionPrompt, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * Builds one provider per durable attempt so persistence callbacks always
 * target the right attempt. `identity` labels immutable attempt rows; secrets
 * stay inside the factory closure.
 */
export interface DecisionProviderFactory {
  (context: DecisionProviderCallContext): DecisionProviderPort;
  readonly identity: { model: string; provider: string; baseUrlHost: string };
  /**
   * Deterministic worst-case cost ceiling in integer micro-USD for exactly
   * this prompt (exact serialized request bytes as input-token bound, the
   * configured output-token cap, fixed provider pricing). The runtime requires
   * `ceiling <= agent maxCostMicroUsdPerCall` before any HTTP.
   */
  readonly costCeilingUsdMicro: (prompt: DecisionPrompt) => bigint;
  /**
   * Resolved exact secret values of this provider policy (configured key,
   * declared secrets and, when enabled, env-discovered values). The runtime
   * passes them to the independent inspector so its replay is deterministic.
   */
  readonly knownSecrets?: readonly string[];
  /**
   * Sanitize the allowed public chat source with the provider's exact secret
   * policy before the runtime persists it. This keeps any known provider
   * credential out of `sourceJson` even if a chat body contains one; the
   * inspector replays from this sanitized source, never from raw text.
   */
  readonly sanitizeSourceChat: (entries: readonly ChatMessage[]) => ChatMessage[];
}

// ---------------------------------------------------------------------------
// Audit and optional speech ledger
// ---------------------------------------------------------------------------

/** Stable audit codes for lifecycle, guard, ambiguity and speech events. */
export type AgentAuditCode =
  | 'AUTHORITY_ESTABLISHED'
  | 'HUMAN_ONLY_ROOM'
  | 'DECISION_OBSERVED'
  | 'OBSERVATION_FAILED'
  | 'OBSERVATION_IDENTITY_MISMATCH'
  | 'OBSERVATION_CONFLICT'
  | 'CHAT_FETCH_FAILED'
  | 'PROVIDER_ATTEMPT_STARTED'
  | 'PROVIDER_REQUEST_PERSISTED'
  | 'PROVIDER_REQUEST_MISMATCH'
  | 'PROVIDER_REQUEST_INSPECTION_FAILED'
  | 'PROVIDER_RESPONSE_SUCCEEDED'
  | 'PROVIDER_RESPONSE_FAILED'
  | 'PROVIDER_RESPONSE_DROPPED_ON_STOP'
  | 'PROVIDER_RESPONSE_REUSED'
  | 'PROVIDER_RESPONSE_MISSING'
  | 'PROVIDER_AMOUNT_IGNORED'
  | 'PROVIDER_ATTEMPT_RETRY'
  | 'IN_FLIGHT_AMBIGUITY_RECOVERED'
  | 'ABANDONED_ATTEMPTS_CLOSED'
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'ACTION_REQUEST_PERSISTED'
  | 'ACTION_REQUEST_PERSIST_FAILED'
  | 'ACTION_SUBMIT_RETRY'
  | 'ACTION_ACCEPTED_ON_STOP'
  | 'ACTION_ABORTED'
  | 'COMMITTED'
  | 'DECISION_STALE'
  | 'DECISION_FAILED'
  | 'TRANSITION_CONTENDED'
  | 'PROMPT_BUILD_FAILED'
  | 'PROMPT_POLICY_REJECTED'
  | 'PROVIDER_COST_CEILING_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'ROOM_MAX_HANDS_EXCEEDED'
  | 'ROOM_RESERVATION_DENIED'
  | 'RUNTIME_DEADLINE_EXCEEDED'
  | 'DEADLINE_MARGIN_EXHAUSTED'
  | 'RESERVATION_SETTLE_REJECTED'
  | 'RESERVATION_SETTLED_UNKNOWN'
  | 'ABORTED'
  | 'SYNC_FAILED'
  | 'SPEECH_SENT'
  | 'SPEECH_FAILED'
  | 'SPEECH_AT_MOST_ONCE_ABANDONED';

/** One runtime audit event. Never carries credentials or provider payloads. */
export interface AgentAuditEvent {
  at: number;
  code: AgentAuditCode;
  agentId: string;
  principalId: string;
  tableId: string | null;
  turnId: string | null;
  decisionId: string | null;
  attemptNo: number | null;
  detail: string | null;
}

export type AgentAuditSink = (event: AgentAuditEvent) => void;

// ---------------------------------------------------------------------------
// Runtime configuration and dependencies
// ---------------------------------------------------------------------------

/** One room/table binding served by this agent runtime. */
export interface AgentRoomBinding {
  roomId: string;
  tableId: string;
  /**
   * Authenticated principals of the room's AGENT participants. A room whose
   * list is empty (human-only) or does not contain this runtime's principal is
   * never synced and makes zero provider calls.
   */
  agentPrincipalIds: readonly string[];
  /**
   * Platform player id this agent authenticates as in the room. When set, an
   * observation whose `state.viewingPlayerId` differs is never used and no
   * provider call is made (wrong-credential routing guard).
   */
  expectedPlayerId?: string | null;
  /** Optional durable hand cap enforced by stopping provider calls. */
  maxHands?: number | null;
  /** Optional aggregate room cap across all agents (calls). */
  maxCalls?: number | null;
  /** Optional aggregate room cap across all agents (integer micro-USD). */
  maxCostMicroUsd?: number | bigint | null;
}

export type AgentSpeechPolicy = 'OFF' | 'AFTER_COMMIT';

export interface AgentRuntimeConfig {
  agentId: string;
  principalId: string;
  /** Mandatory prompt policy identity; asserted before any provider call. */
  promptPolicyId: string;
  promptPolicyHash: string;
  rooms: readonly AgentRoomBinding[];
  /** Fixed per-provider-exchange budget used when no platform deadline exists. */
  perCallTimeoutMs: number;
  /** Timing safety margin subtracted from every derived deadline. */
  safetyMarginMs?: number;
  /**
   * Absolute epoch-ms run deadline. Production wiring passes the genuine
   * orchestration activation timestamp plus the configured run window (for
   * example `ACTIVE product room.updatedAt + OVERALL_RUNTIME_MS`), so the
   * window survives process restarts and is never reset by `start()`.
   */
  overallDeadlineAtMs?: number | null;
  /**
   * Standalone/unit relative run budget from `start()`; used only when no
   * absolute deadline is supplied.
   */
  overallRuntimeMs?: number | null;
  /** Bounded provider attempts per decision; fixed at 2 by contract. */
  maxProviderAttempts?: number;
  /**
   * Product availability guard (default true). When false the runtime never
   * starts a new provider call and audits `PROVIDER_UNAVAILABLE`; recorded
   * `PROVIDER_RECORDED`/`ACTION_SUBMITTED` decisions still resolve and replay.
   * Used for terminal-trace recovery or missing provider credentials — never a
   * poker-protocol branch.
   */
  providerCallsEnabled?: boolean;
  /** Optional public speech, only after an accepted receipt; default OFF. */
  speech?: AgentSpeechPolicy;
  /** Periodic REST resync interval; socket events only trigger resyncs. */
  socketResyncIntervalMs?: number;
  /** Chat selection bounds shared by the store source and provider prompt. */
  chatSelection?: ChatSelectionOptions;
  /** Platform-call concurrency bound, shared across rooms when injected. */
  maxConcurrency?: number;
}

export interface AgentRuntimeDependencies {
  transport: AgentTurnTransport;
  store: AgentDecisionStorePort;
  providerFactory: DecisionProviderFactory;
  /** Shared bounded-concurrency limiter; a private one is created otherwise. */
  limiter?: DecisionConcurrencyLimiterLike;
  audit?: AgentAuditSink;
  now?: () => number;
}

/** Minimal surface used by the runtime for bounded platform concurrency. */
export interface DecisionConcurrencyLimiterLike {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Compile-time proof that the real `ProductStore` satisfies the runtime port.
 * If a store signature drifts, the build fails before integration.
 */
type ProductStoreSatisfiesAgentPort = ProductStore extends AgentDecisionStorePort ? true : never;
export const PRODUCT_STORE_PORT_PROOF: ProductStoreSatisfiesAgentPort = true;

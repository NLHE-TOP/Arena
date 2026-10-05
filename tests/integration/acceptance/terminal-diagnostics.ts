/**
 * Acceptance-only sanitized durable diagnostic bundle for a terminal fold.
 *
 * The public SDK cannot explain why a table/hand ended (or refused to end):
 * outbox dispatch state, the durable action receipt, the ordered event cursor,
 * the archived hand history and the backing competition/tournament
 * reconciliation are operator-database facts. This helper captures those facts
 * as ONE read-only PostgreSQL statement (single snapshot) and returns a plain,
 * serializable, sanitized JSON bundle.
 *
 * Replayed determination: the strict `CanonicalActionResult` intentionally has
 * no `replayed` flag, but the accepted-action route writes the transient replay
 * outcome into the whitelisted `AuditLog` metadata (`requestId`, `turnId`,
 * `actionId`, `version`, `eventSeq`, `replayed`). The receipt carries the
 * matching audit row plus a tri-state `replayed` value; when no matching audit
 * evidence exists it is `null` (unknown), never `false`.
 *
 * Action family: `foldReceipt` is the generic explicit-action receipt (legacy
 * name). An explicit `requestId` selects that exact `GameActionRequest`
 * regardless of family (CALL/RAISE/CHECK/FOLD), with a LEFT JOIN to its
 * committed event so a rejected request without an event is captured
 * (`action: null`, `status: REJECTED`, `errorCode` sanitized) rather than
 * misreported as absent. Without an explicit `requestId` the legacy latest
 * accepted FOLD inference of the requested hand is retained. This keeps a
 * normal committed CALL/RAISE from failing the terminal-stall packet.
 *
 * Job state: an outbox row that reached `DISPATCHED` alone cannot prove the
 * BullMQ handler ran. Callers may inject a read-only `readJobState` callback
 * (their Redis/BullMQ projection); the bundle records the sanitized
 * state/attempts/failedReason per row. Without the callback the state is
 * `null` (unknown), and a callback failure is `unavailable`, never a fabricated
 * completion. `pubsub` is not a BullMQ kind and is never probed; COMPLETED
 * rows are not probed either (completion plus hand history already prove the
 * worker processed them). Reads are bounded and prioritized: affected-hand
 * archive/next/settle rows first, then other unresolved rows newest-first, so
 * the blocking last-hand failure is always classified within the budget. When
 * a callback was supplied but a required unresolved affected-hand archive/next
 * job state is `unavailable`/`unknown` (or was not read within the bound), the
 * contract reports `affectedHandJobs: 'missing'` and completeness raises
 * `job-state-unreadable`, so a live wrapper does not tear down PostgreSQL with
 * an unclassifiable worker state. A legitimately absent BullMQ job is captured
 * evidence (`missing`), not a collector error.
 *
 * Boundaries enforced here:
 * - Read-only by construction: one `SELECT` with sanitized column projections.
 *   `GameEvent.payload`, `HandHistory.data` and raw `GameOutbox.payload` are
 *   NEVER selected. `Table.state` and `GameActionRequest.response` are
 *   projected ONLY through explicit public semantic key lists (`handId`,
 *   `handNumber`, `street`, `actionTo`, `winners`, player
 *   `id/seat/status/stack`, `currentBets`, pot `amount/eligibleSeats/type`,
 *   receipt/observation scalars); deck order, hole cards, board cards, action
 *   history, raw wire state and raw response bodies are never referenced. The
 *   projections are re-sanitized in process as defense in depth.
 * - The bundle never carries hole cards, deck order, private engine snapshots,
 *   credentials, raw provider/platform payloads or unbounded free text.
 * - Released PokerTools 2.0.3 writers persist `Table.state` as a Prisma JSON
 *   STRING (`JSON.stringify`); every `Table.state` read normalizes
 *   `jsonb_typeof(state) = 'string'` back to JSON before projecting, so real
 *   packets report the authoritative snapshot and current stacks instead of a
 *   false `snapshot-missing` / null stacks. Object-shaped storage passes
 *   through unchanged.
 * - Entrant stacks are CURRENT authoritative stacks read from the latest
 *   `Table.state.players` projection of each entrant's table, never a prior
 *   HAND_STARTED snapshot, so post-action chips and eliminations are reflected.
 *   Each entrant also carries its explicit nullable `currentTableId`.
 * - `competition.settlementReady` is the EXACT released public predicate
 *   projected read-only across every backing table: FINISHED => true;
 *   non-RUNNING => false; RUNNING => exactly one ACTIVE tournament entry, no
 *   REGISTERED entry, at least one backing table, every backing table at a
 *   settled boundary (`handNumber = 0` with null `actionTo`, or non-empty
 *   `winners` with null `actionTo`), and the active winner's summed stack > 0.
 *   A missing projection field is `null` and raises `settlement-ready-missing`
 *   in completeness; it is never treated as `false`.
 * - `subsequentHandStarts` carries canonical HAND_STARTED events strictly after
 *   the requested hand's last event, so a driver can prove the next hand began
 *   through the committed platform path instead of room polling.
 * - Error strings are retained only when they are registry-known durable codes
 *   (`OUTBOX_*`, game-authority codes, ...) or when redaction maps them exactly
 *   onto such a code; every other error value is replaced with an omission
 *   marker. Unknown errors fail closed instead of exposing raw text.
 * - Derived warnings are harness-authored summaries over already-sanitized
 *   evidence (latest reconciliation event, failed/stalled outbox work,
 *   reconcile-failure metrics, missing hand history); raw database error/log
 *   bytes are never copied into them.
 * - Collection NEVER throws: a failed query/parse/shape is recorded in
 *   `collection.status === 'FAILED'` with a sanitized reason, so a diagnostic
 *   capture can run inside a failure path without masking the original failure.
 *
 * Completeness and teardown retention: `collection.status === 'COMPLETE'` only
 * means the read-only capture ran. It is NOT a verdict on the durable packet.
 * `terminalDiagnosticCompleteness(bundle)` (or the pure
 * `isTerminalDiagnosticComplete(bundle)`) evaluates the requested identities —
 * table, required `Table.state` snapshot fields, hand, competition/tournament,
 * the canonical `settlementReady` boolean and the durable action receipt —
 * separately and returns `collectionErrors`.
 * Wrappers MUST fail the terminal-fold regression and RETAIN the live topology
 * (including PostgreSQL, outside captured artifacts) for operator recovery when
 * `collectionErrors > 0`; a partially saved error bundle is not sufficient
 * evidence. Valid outcome absence (no HAND_COMPLETED event, no archived history
 * yet, empty outbox, no subsequent hand start) is reported in `bundle.contract`
 * but is never a completeness error: the absence itself is the diagnosis.
 *
 * Schema knowledge is the pinned PokerTools 2.0.3 Prisma schema (operator SQL
 * columns only); this module imports no PokerTools source and makes no paid
 * calls or source mutations.
 *
 * Wrapper/driver integration:
 *
 *   const bundle = await collectTerminalDiagnostics({
 *     query: terminalDiagnosticsQuery(environment.adminTarget),
 *     identifiers: {
 *       roomId: room.id,
 *       tableId: room.pokerTableId,
 *       competitionId: room.pokerCompetitionId,
 *       handId: terminalHandId,
 *     },
 *     knownSecrets: secretRegistry.values(),
 *     metrics: platformMetricsSnapshot,   // optional, sanitized
 *     apiLogWarning,                      // optional, sanitized
 *     readJobState: async ({ outboxId, kind }) => queue(kind).getJob(outboxId)
 *       ?.then((job) => job ? { state: job.getState(), attemptsMade: job.attemptsMade, failedReason: job.failedReason } : null)
 *       ?? null,
 *   });
 *
 * `roomId` is the product-side room identity and is echoed for correlation
 * only; the operator query is table-scoped. Either `tableId` or
 * `competitionId` must be provided; a `handId` scopes the ordered events, the
 * durable fold receipt and the hand-history existence check.
 */
import { redactSecretText } from '../infra/env-boundary.js';
import type { AdminDatabaseTarget } from '../infra/admin.js';
import { psqlContainer, psqlUrl } from '../infra/docker.js';

/** Injected operator SQL executor: container psql or host psql, read-only. */
export type TerminalDiagnosticsSqlQuery = (sql: string) => Promise<string>;

/** Bundle schema version; bump only for an incompatible field change. */
export const TERMINAL_DIAGNOSTICS_BUNDLE_VERSION = 1;

/** Replacement for any error value that is not a registry-known durable code. */
export const OMITTED_DIAGNOSTIC_ERROR = '<omitted:unregistered-error>';

/**
 * Durable error codes this bundle may carry VERBATIM. Everything else is
 * omitted fail-closed. Callers may extend the set for their topology via
 * `registry`.
 */
export const TERMINAL_DIAGNOSTICS_ERROR_REGISTRY: readonly string[] = Object.freeze([
  'GAME_ACTION_REJECTED',
  'GAME_CONFLICT',
  'GAME_EVENT_SEQUENCE_DRIFT',
  'IDENTITY_MISMATCH',
  'INVALID_CANONICAL_ACTION',
  'INVALID_SEAT',
  'NOT_SEATED',
  'REQUEST_ID_CONFLICT',
  'STALE_TURN',
  'TABLE_CLOSED',
  'TABLE_NOT_FOUND',
  'JOB_EXECUTION_FAILED',
  'OUTBOX_ATTEMPTS_EXHAUSTED',
  'OUTBOX_FAILED',
  'OUTBOX_STALE_PENDING',
  'TOURNAMENT_NOT_FOUND',
  'TOURNAMENT_STATE_UNAVAILABLE',
]);

/** Per-kind `GameOutbox.payload` semantic whitelist (no snapshot/deck/cards). */
export const OUTBOX_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'settle-hand': Object.freeze(['handId', 'rakeTotal', 'playerNetChanges']),
  'archive-hand': Object.freeze(['handId']),
  'tournament-reconcile': Object.freeze(['tableId', 'tournamentId', 'handId', 'actorId']),
  'next-hand': Object.freeze(['handId', 'expectedHandId', 'expectedVersion']),
  'player-timeout': Object.freeze(['handId', 'playerId', 'anchorEventSeq', 'expectedVersion']),
  pubsub: Object.freeze(['type', 'version', 'eventSeq', 'timestamp']),
});

/** `TournamentEvent.payload` semantic whitelist for the reconcile audit. */
export const RECONCILIATION_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  TOURNAMENT_RECONCILED: Object.freeze(['status', 'tables', 'entries']),
});

const DURABLE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CANONICAL_ATOMIC_RE = /^-?\d{1,40}$/;
const MAX_TEXT_LENGTH = 256;
const MAX_ERROR_TEXT_LENGTH = 400;
const MAX_IDENTIFIER_TEXT_LENGTH = 128;
const MAX_SECTION_ROWS = 2000;
const MAX_NET_CHANGE_ENTRIES = 64;
const MAX_RECONCILIATION_ROWS = 128;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_ITEMS = 128;
const MAX_DIAGNOSTIC_KEYS = 64;
const MAX_DIAGNOSTIC_STRING = 512;
const DEFAULT_MAX_EVENTS = 500;
const MAX_MAX_EVENTS = 5000;
const DEFAULT_MAX_OUTBOX_ROWS = 500;
const MAX_MAX_OUTBOX_ROWS = 5000;
const DEFAULT_MAX_JOB_STATE_READS = 25;
const MAX_MAX_JOB_STATE_READS = 200;
const MAX_WARNINGS = 32;

/** BullMQ job states plus the explicit unknown/unavailable/missing markers. */
export const TERMINAL_DIAGNOSTICS_JOB_STATES: readonly string[] = Object.freeze([
  'completed',
  'failed',
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
  'missing',
  'unavailable',
  'unknown',
]);

export type TerminalDiagnosticsJobStateName = (typeof TERMINAL_DIAGNOSTICS_JOB_STATES)[number];

/**
 * Key names dropped from optional caller inputs (`metrics`, `apiLogWarning`):
 * credential material AND private game state. Anchored, case-insensitive.
 */
const SENSITIVE_INPUT_KEY_RE = new RegExp(
  '^(?:' +
    [
      'authorization',
      'proxy[-_]?authorization',
      'cookie',
      'set[-_]?cookie',
      'headers?',
      '(?:[a-z0-9]+[-_])*api[-_]?key',
      '(?:[a-z0-9]+[-_])*(?:access|refresh|id|auth|service|bearer|session)[-_]?token',
      'token',
      'secret',
      '(?:client|session|service)[-_]?secret',
      'password',
      'passwd',
      'passphrase',
      'private[-_]?key',
      'privatekey',
      'mnemonic',
      'seed(?:[-_]?phrase)?',
      'credential',
      'signature',
      'session(?:[-_]?id)?',
    ].join('|') +
    ')$',
  'i'
);

/** Private engine/ledger keys dropped from optional caller inputs. */
const PRIVATE_GAME_KEY_RE =
  /^(?:deck|cards|hole[-_]?cards|private[-_]?cards|snapshot|engine[-_]?state|table[-_]?state|state|response|data|raw|raw[-_]?payload|raw[-_]?response)$/i;

/** One injected redaction policy over every diagnostic string. */
export interface TerminalDiagnosticsSanitizeOptions {
  /**
   * Exact secret values generated in-process (for example
   * `SecretRegistry.values()`); always redacted before any output.
   */
  knownSecrets?: readonly string[];
  /**
   * Injected whole-text redactor (for example `secretRegistry.redact`). The
   * explicit `knownSecrets` pass always runs after it, so both authorities are
   * honored.
   */
  redactText?: (text: string) => string;
  /** Additional registry-known error codes retained verbatim. */
  registry?: readonly string[];
}

type Redact = (text: string) => string;

function resolveRedact(options: TerminalDiagnosticsSanitizeOptions = {}): Redact {
  const known = (options.knownSecrets ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  const injected = options.redactText;
  return (text: string): string => {
    const first = injected ? injected(text) : text;
    // Deterministic: only explicitly declared values are treated as secrets;
    // ambient environment discovery is deliberately not performed here.
    return redactSecretText(first, known, {});
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordText(value: unknown, redact: Redact, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Redact the FULL value before bounding it: a bounded slice of a secret is
  // still a disclosure.
  return redact(trimmed).slice(0, max);
}

function recordInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function recordCount(value: unknown): number | null {
  const direct = recordInteger(value);
  if (direct !== null) return direct;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function recordBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = recordInteger(value);
  if (parsed === null) return fallback;
  return Math.min(Math.max(1, parsed), maximum);
}

/**
 * Sanitize one durable error value.
 *
 * `registry`-known codes are retained exactly. Otherwise the value is redacted
 * (known secrets, bearer/API-key/service-token shapes, credential URLs) and
 * re-checked against the registry, so a redaction that leaves exactly a known
 * code may still be retained. Every other error value fails closed to
 * `OMITTED_DIAGNOSTIC_ERROR`: raw unknown error text is never emitted.
 */
export function sanitizeDiagnosticError(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {}
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const bounded = trimmed.length > MAX_ERROR_TEXT_LENGTH ? trimmed.slice(0, MAX_ERROR_TEXT_LENGTH) : trimmed;
  const registry = new Set<string>([...TERMINAL_DIAGNOSTICS_ERROR_REGISTRY, ...(options.registry ?? [])]);
  if (registry.has(bounded)) return bounded;
  const redacted = resolveRedact(options)(bounded).trim();
  if (registry.has(redacted)) return redacted;
  return OMITTED_DIAGNOSTIC_ERROR;
}

/**
 * Project one `GameOutbox.payload` through its kind's semantic whitelist.
 * Unknown kinds project `{}`; objects/arrays not explicitly modeled are
 * dropped; `playerNetChanges` keys/values are validated and redacted.
 */
export function sanitizeOutboxPayload(
  kind: unknown,
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {}
): Record<string, unknown> {
  if (typeof kind !== 'string') return {};
  const allowed = OUTBOX_PAYLOAD_ALLOWLIST[kind];
  if (allowed === undefined || !isRecord(raw)) return {};
  const redact = resolveRedact(options);
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key === 'playerNetChanges') {
      if (!isRecord(raw[key])) continue;
      const entries: Record<string, string> = {};
      let count = 0;
      for (const [principalId, amount] of Object.entries(raw[key] as Record<string, unknown>)) {
        if (count >= MAX_NET_CHANGE_ENTRIES) break;
        if (typeof amount !== 'string' || !CANONICAL_ATOMIC_RE.test(amount)) continue;
        const safePrincipal = recordText(principalId, redact, MAX_IDENTIFIER_TEXT_LENGTH) ?? '<redacted>';
        entries[safePrincipal] = amount;
        count += 1;
      }
      out[key] = entries;
      continue;
    }
    const value = raw[key];
    if (typeof value === 'string') {
      const text = recordText(value, redact);
      if (text !== null) out[key] = text;
      continue;
    }
    if (typeof value === 'number') {
      const integer = recordInteger(value);
      if (integer !== null) out[key] = integer;
      continue;
    }
    if (typeof value === 'boolean') out[key] = value;
    // Nested objects/arrays are never projected: only the explicitly
    // whitelisted scalars and the validated net-change map may appear.
  }
  return out;
}

/**
 * Project one `TournamentEvent.payload` for the latest reconcile audit.
 * Unknown event types project `{}` (fail closed).
 */
export function sanitizeReconciliationPayload(
  type: unknown,
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {}
): Record<string, unknown> {
  if (typeof type !== 'string' || !isRecord(raw)) return {};
  const allowed = RECONCILIATION_PAYLOAD_ALLOWLIST[type];
  if (allowed === undefined) return {};
  const redact = resolveRedact(options);
  const out: Record<string, unknown> = {};
  if (allowed.includes('status')) {
    const status = recordText(raw.status, redact, 64);
    if (status !== null) out.status = status;
  }
  if (allowed.includes('tables')) {
    const tables: Array<{ id: string; status: string | null }> = [];
    for (const row of asArray(raw.tables).slice(0, MAX_RECONCILIATION_ROWS)) {
      if (!isRecord(row)) continue;
      const id = recordText(row.id, redact);
      if (id === null) continue;
      tables.push({ id, status: recordText(row.status, redact, 64) });
    }
    out.tables = tables;
  }
  if (allowed.includes('entries')) {
    const entries: Array<{
      id: string;
      status: string | null;
      placement: number | null;
      currentTableId: string | null;
      currentSeat: number | null;
    }> = [];
    for (const row of asArray(raw.entries).slice(0, MAX_RECONCILIATION_ROWS)) {
      if (!isRecord(row)) continue;
      const id = recordText(row.id, redact);
      if (id === null) continue;
      entries.push({
        id,
        status: recordText(row.status, redact, 64),
        placement: recordInteger(row.placement),
        currentTableId: recordText(row.currentTableId, redact),
        currentSeat: recordInteger(row.currentSeat),
      });
    }
    out.entries = entries;
  }
  return out;
}

/**
 * Sanitize an optional caller-supplied diagnostic input (`metrics`,
 * `apiLogWarning`). Sensitive/credential keys and private game keys are
 * dropped; every string is redacted; depth, item, key and string sizes are
 * bounded. The result is always JSON-serializable.
 */
export function sanitizeDiagnosticInput(
  value: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {},
  depth = 0
): unknown {
  if (depth > MAX_DIAGNOSTIC_DEPTH) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return recordText(value, resolveRedact(options), MAX_DIAGNOSTIC_STRING);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => sanitizeDiagnosticInput(item, options, depth + 1));
  }
  if (isRecord(value)) {
    const redact = resolveRedact(options);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= MAX_DIAGNOSTIC_KEYS) break;
      if (SENSITIVE_INPUT_KEY_RE.test(key) || PRIVATE_GAME_KEY_RE.test(key)) continue;
      const safeKey = recordText(key, redact, MAX_IDENTIFIER_TEXT_LENGTH) ?? '<redacted>';
      out[safeKey] = sanitizeDiagnosticInput(entry, options, depth + 1);
      count += 1;
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

export interface TerminalDiagnosticsIdentifiers {
  /** NLHE product room identity (echoed correlation only, product-side). */
  roomId?: string | null;
  /** PokerTools table identity; required unless `competitionId` resolves one. */
  tableId?: string | null;
  /** Competition identity; optional cross-check and table resolver. */
  competitionId?: string | null;
  /** Engine hand identity from the public event payload. */
  handId?: string | null;
  /** Accepted-action request identity (exact durable action receipt). */
  requestId?: string | null;
  /** Turn identity (echoed correlation only). */
  turnId?: string | null;
}

export interface TerminalDiagnosticsWinner {
  seat: number | null;
  amount: number | null;
  handRank: string | null;
}

export interface TerminalDiagnosticsPlayerSnapshot {
  id: string | null;
  seat: number | null;
  status: string | null;
  stack: number | null;
  /** Chips bet on the current street. */
  betThisStreet: number | null;
  /** Chips invested in the current hand (drives side pots). */
  totalInvestedThisHand: number | null;
  /**
   * Public sitting-out flag. The engine does not use a `SITTING_OUT` player
   * status here, so this flag is the authoritative way to distinguish an
   * ordinary fold from a live-shaped sit-out/timeout regression.
   */
  isSittingOut: boolean | null;
}

export interface TerminalDiagnosticsPotSnapshot {
  amount: number | null;
  eligibleSeats: number[];
  type: string | null;
  capPerPlayer: number | null;
}

/**
 * Sanitized public semantic projection of an authoritative state JSON
 * (`Table.state` engine snapshot or an accepted observation's public wire
 * state). Deck order, hole cards, board cards, action history and every other
 * unmasked field are never projected.
 */
export interface TerminalDiagnosticsStateSnapshot {
  handId: string | null;
  handNumber: number | null;
  street: string | null;
  actionTo: number | null;
  /**
   * Literal authoritative winners value preserved exactly: `null` (hand not
   * settled / key absent), `[]` (settled with no winner rows), or a non-empty
   * winner list. Consumers must branch on null vs length, exactly like the
   * platform's `handCompleted` semantics.
   */
  winners: TerminalDiagnosticsWinner[] | null;
  players: TerminalDiagnosticsPlayerSnapshot[];
  /** Seat → amount bet this street. */
  currentBets: Record<string, number>;
  pots: TerminalDiagnosticsPotSnapshot[];
  /**
   * True only when every REQUIRED raw key above was present in the projected
   * JSON (`present` presence object from the SQL projection). A key with a
   * legitimate JSON null (for example `winners: null` at hand end) is present.
   */
  present: boolean;
  /** Required key names absent from the projection; fixed harness labels. */
  missing: string[];
}

export interface TerminalDiagnosticsTableSnapshot {
  id: string;
  status: string;
  stateVersion: number;
  eventSeq: number;
  /** Sanitized authoritative `Table.state`; null when the table has no state. */
  state: TerminalDiagnosticsStateSnapshot | null;
}

export interface TerminalDiagnosticsActionReceipt {
  requestId: string | null;
  turnId: string | null;
  actionId: string | null;
  handId: string | null;
  version: number | null;
  eventSeq: number | null;
  acceptedAt: number | null;
}

export interface TerminalDiagnosticsObservationProjection {
  tableId: string | null;
  handId: string | null;
  turnId: string | null;
  version: number | null;
  eventSeq: number | null;
  state: TerminalDiagnosticsStateSnapshot | null;
}

export interface TerminalDiagnosticsEvent {
  id: string;
  eventSeq: number;
  type: string;
  version: number;
  turnId: string | null;
  requestId: string | null;
  actionId: string | null;
  /** Public payload `handId` (never the payload itself). */
  handId: string | null;
  /** Public payload engine action (`FOLD`, `CHECK`, ...). */
  action: string | null;
}

export interface TerminalDiagnosticsActionAudit {
  id: string;
  /** Accepted-action audit action (`GAME_<opaque action id>`). */
  action: string;
  createdAt: string;
  /** Tri-state replay determination from the durable audit metadata. */
  replayed: boolean | null;
  version: number | null;
  eventSeq: number | null;
}

/**
 * Durable explicit-action receipt (legacy field name `foldReceipt`).
 *
 * With an explicit `requestId` this is the exact `GameActionRequest` row for
 * that identity, regardless of action family (CALL/RAISE/CHECK/FOLD), LEFT
 * JOINed to its committed event so a rejected request with no event is still
 * captured (`action: null`). Without an explicit requestId it falls back to
 * the latest accepted FOLD of the requested hand.
 */
export interface TerminalDiagnosticsFoldReceipt {
  id: string;
  requestId: string;
  principalId: string;
  turnId: string;
  actionId: string;
  expectedVersion: number;
  status: string;
  resultVersion: number | null;
  eventSeq: number | null;
  /** Sanitized: registry-known code or omission marker. */
  errorCode: string | null;
  /**
   * Engine action family from the committed event (`FOLD`, `CALL`, `RAISE`,
   * ...), or null when the request has no committed event (for example a
   * rejected request). Explicit requestIds therefore never require a FOLD.
   */
  action: string | null;
  /**
   * Latest matching accepted-action audit row, whitelisted. `null` when the
   * best-effort audit write never landed (evidence absent, not a failure).
   */
  audit: TerminalDiagnosticsActionAudit | null;
  /**
   * Replay determination. `true`/`false` only from durable audit evidence;
   * `null` whenever that evidence is absent (unknown, never assumed false).
   */
  replayed: boolean | null;
  /**
   * Canonical accepted receipt projected from `GameActionRequest.response`
   * with explicit semantic keys (the raw response object is never selected).
   * Fallback evidence when the action event row does not suffice.
   */
  responseReceipt: TerminalDiagnosticsActionReceipt | null;
  /**
   * Accepted observation's semantic fields, including the post-action public
   * state snapshot (cards and deck never projected). Fallback classification
   * evidence for `winners: null` / director elimination when the action event
   * row does not suffice.
   */
  observation: TerminalDiagnosticsObservationProjection | null;
}

export interface TerminalDiagnosticsOutboxJobState {
  state: TerminalDiagnosticsJobStateName;
  /** Coarse presence: `false` only for an explicit missing job. */
  exists: boolean | null;
  attemptsMade: number | null;
  /** Sanitized: registry-known code or omission marker. */
  failedReason: string | null;
  processedOn: number | null;
  finishedOn: number | null;
}

export interface TerminalDiagnosticsOutboxRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  dedupeKey: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  /** Sanitized: registry-known code or omission marker. */
  lastError: string | null;
  /** Per-kind semantic whitelist only. */
  payload: Record<string, unknown>;
  /**
   * Read-only BullMQ projection injected by the caller; `null` when no
   * `readJobState` callback was supplied (state unknown).
   */
  jobState: TerminalDiagnosticsOutboxJobState | null;
}

export interface TerminalDiagnosticsHandHistory {
  exists: boolean;
  id: string | null;
  timestamp: string | null;
}

export interface TerminalDiagnosticsCompetition {
  id: string;
  mode: string;
  status: string;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  entryAssetId: string | null;
  entryAmountAtomic: string | null;
  prizeAssetId: string | null;
  prizeAmountAtomic: string | null;
  prizeStatus: string;
  tournamentId: string;
  /**
   * Released canonical public `settlementReady` predicate, projected read-only
   * from the backing tournament/table state (FINISHED => true; non-RUNNING =>
   * false; RUNNING => exactly one ACTIVE entry, no REGISTERED, >= 1 backing
   * table, every table at a settled boundary, and the active winner's summed
   * stack > 0). `null` only when the projection is absent (fail closed).
   */
  settlementReady: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
}

export interface TerminalDiagnosticsTournament {
  id: string;
  status: string;
  startingStack: number;
  buyIn: number;
  fee: number;
  maxPlayers: number;
  tableId: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TerminalDiagnosticsEntrant {
  id: string;
  principalId: string;
  kind: string;
  seat: number;
  entryState: string;
  tournamentEntryId: string | null;
  tournamentStatus: string | null;
  placement: number | null;
  /** Current tournament-table assignment; null when unassigned/eliminated. */
  currentTableId: string | null;
  currentSeat: number | null;
  /** Exact tournament prize as a canonical atomic string (never a float). */
  prizeAtomic: string | null;
  /**
   * Current authoritative stack for this principal, read from the latest
   * `Table.state.players` projection of the entrant's `currentTableId`
   * (falling back to the target table when unassigned). Never derived from a
   * prior HAND_STARTED snapshot, so post-action chips and eliminations are
   * reflected; null when the principal is not seated in that state.
   */
  authoritativeStack: number | null;
}

export interface TerminalDiagnosticsReconciliationEvent {
  id: string;
  eventSeq: number;
  type: string;
  requestRef: string | null;
  stateFingerprint: string;
  occurredAt: string;
  /** Semantic whitelist only (status/tables/entries for a reconcile event). */
  payload: Record<string, unknown>;
}

export interface TerminalDiagnosticsSections {
  table: TerminalDiagnosticsTableSnapshot | null;
  events: TerminalDiagnosticsEvent[];
  /**
   * Canonical HAND_STARTED events strictly AFTER the requested hand's last
   * event: direct evidence that the next hand began through the platform's own
   * committed DEAL/next-hand path, not room-poll inference.
   */
  subsequentHandStarts: TerminalDiagnosticsEvent[];
  foldReceipt: TerminalDiagnosticsFoldReceipt | null;
  outbox: TerminalDiagnosticsOutboxRow[];
  handHistory: TerminalDiagnosticsHandHistory;
  competition: TerminalDiagnosticsCompetition | null;
  tournament: TerminalDiagnosticsTournament | null;
  entrants: TerminalDiagnosticsEntrant[];
  reconciliation: TerminalDiagnosticsReconciliationEvent | null;
}

/** Requested durable identity presence: `missing` is a completeness error. */
export type TerminalDiagnosticsEvidencePresence = 'present' | 'missing' | 'not-requested';
/** Outcome evidence presence: `absent` is a valid diagnostic outcome. */
export type TerminalDiagnosticsOutcomePresence = 'present' | 'absent';

/**
 * Explicit per-section contract. Required identities (table/hand/
 * competition/tournament/receipt) are distinguished from valid outcome
 * absence (no HAND_COMPLETED event, no archived history, empty outbox).
 */
export interface TerminalDiagnosticsContract {
  capture: 'complete' | 'failed';
  table: 'present' | 'missing';
  /** Required public `Table.state` fields (players/winners/pots/...). */
  snapshot: 'present' | 'missing';
  hand: TerminalDiagnosticsEvidencePresence;
  competition: TerminalDiagnosticsEvidencePresence;
  tournament: TerminalDiagnosticsEvidencePresence;
  /**
   * Canonical `competition.settlementReady` boolean presence. `missing` means
   * the operator projection omitted the field: never treat that as `false`.
   */
  settlementReady: TerminalDiagnosticsEvidencePresence;
  receipt: TerminalDiagnosticsEvidencePresence;
  handCompleted: TerminalDiagnosticsOutcomePresence;
  handHistory: TerminalDiagnosticsOutcomePresence;
  outbox: 'present' | 'empty';
  /** Canonical HAND_STARTED after the requested hand; absence is valid. */
  nextHandStarted: TerminalDiagnosticsOutcomePresence | 'not-requested';
  /**
   * Readability of the REQUIRED unresolved affected-hand archive/next job
   * states when a job-state callback was supplied. `missing` means the live
   * wrapper cannot classify worker liveness and must retain the topology.
   * A legitimately absent BullMQ job is captured evidence (`missing` state),
   * not a completeness error.
   */
  affectedHandJobs: 'present' | 'missing' | 'not-requested';
}

export type TerminalDiagnosticsCompletenessError =
  | 'capture-failed'
  | 'table-missing'
  | 'snapshot-missing'
  | 'competition-missing'
  | 'tournament-missing'
  | 'settlement-ready-missing'
  | 'hand-missing'
  | 'receipt-missing'
  | 'job-state-unreadable';

export interface TerminalDiagnosticsCompleteness {
  complete: boolean;
  errors: TerminalDiagnosticsCompletenessError[];
  /**
   * Terminal-fold regression gate: fail (and retain the live topology) when
   * this is greater than zero.
   */
  collectionErrors: number;
}

export interface TerminalDiagnosticsBundle extends TerminalDiagnosticsSections {
  version: number;
  collectedAt: string;
  identifiers: {
    roomId: string | null;
    tableId: string | null;
    competitionId: string | null;
    handId: string | null;
    requestId: string | null;
    turnId: string | null;
  };
  collection: { status: 'COMPLETE' | 'FAILED'; error: string | null };
  /** True when a read-only BullMQ job-state callback was supplied. */
  jobStateRequested: boolean;
  /** Explicit per-identity/outcome contract (see `deriveTerminalDiagnosticsContract`). */
  contract: TerminalDiagnosticsContract;
  /** Sanitized optional caller input. */
  metrics: unknown;
  /** Sanitized optional caller input. */
  apiLogWarning: unknown;
  /**
   * Harness-authored summaries over sanitized evidence: the latest
   * reconciliation event, failed/stalled outbox work, reconcile-failure
   * metrics, missing hand history and the presence of an API log warning.
   */
  warnings: string[];
}

/** Read-only identity of one outbox row handed to the job-state callback. */
export interface TerminalDiagnosticsJobStateInput {
  tableId: string;
  outboxId: string;
  kind: string;
  dedupeKey: string;
}

export interface TerminalDiagnosticsInput extends TerminalDiagnosticsSanitizeOptions {
  query: TerminalDiagnosticsSqlQuery;
  identifiers: TerminalDiagnosticsIdentifiers;
  /** Optional platform metrics snapshot; sanitized before inclusion. */
  metrics?: unknown;
  /** Optional API log warning; sanitized before inclusion. */
  apiLogWarning?: unknown;
  /**
   * Optional read-only Redis/BullMQ projection. Called only for non-COMPLETED
   * outbox rows, bounded by `maxJobStateReads`. The returned value is
   * whitelisted and redacted; a missing job resolves `state: 'missing'`.
   * No callback (or a throwing callback) never fabricates a completion.
   */
  readJobState?: (input: TerminalDiagnosticsJobStateInput) => Promise<unknown> | unknown;
  maxEvents?: number;
  maxOutboxRows?: number;
  maxJobStateReads?: number;
  /** Injectable clock (deterministic tests). */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Read-only SQL projection
// ---------------------------------------------------------------------------

class TerminalDiagnosticsInputError extends Error {}

function cleanIdentifier(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TerminalDiagnosticsInputError(`terminal diagnostics ${label} identifier must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!DURABLE_IDENTIFIER_RE.test(trimmed)) {
    throw new TerminalDiagnosticsInputError(
      `terminal diagnostics ${label} identifier is not a plain durable identifier`
    );
  }
  return trimmed;
}

export interface TerminalDiagnosticsSqlOptions {
  maxEvents?: number;
  maxOutboxRows?: number;
}

/**
 * Released PokerTools 2.0.3 writers persist `Table.state` with
 * `JSON.stringify`, so the Prisma `Json` column holds a JSON STRING
 * (`jsonb_typeof(state) = 'string'`) rather than an object. Normalize the
 * string form back to JSON before ANY state read; object storage passes
 * through unchanged. Invalid embedded JSON fails the statement closed.
 */
function normalizedStateSql(expression: string): string {
  return `CASE WHEN jsonb_typeof(${expression}) = 'string' THEN (${expression} #>> '{}')::jsonb ELSE ${expression} END`;
}

/**
 * Explicit public-key projection of one authoritative state JSON expression
 * (`Table.state` or `response.observation.state`). Only the semantic keys the
 * review requires are referenced; `deck`, player `hand`/`shownCards`, `board`,
 * action history and every other unmasked key are never mentioned, so raw
 * state can never reach the output even if the JSON shape grows.
 *
 * The nested `present` object distinguishes "key legitimately null" from
 * "key absent" for completeness classification.
 */
function stateProjectionSql(stateExpression: string): string {
  const s = stateExpression;
  return `json_build_object(
      'present', json_build_object(
        'state', COALESCE((${s}) IS NOT NULL, false),
        'handId', COALESCE((${s}) ? 'handId', false),
        'handNumber', COALESCE((${s}) ? 'handNumber', false),
        'street', COALESCE((${s}) ? 'street', false),
        'actionTo', COALESCE((${s}) ? 'actionTo', false),
        'players', jsonb_typeof((${s})->'players') = 'array',
        'winners', COALESCE((${s}) ? 'winners', false),
        'pots', jsonb_typeof((${s})->'pots') = 'array',
        'currentBets', jsonb_typeof((${s})->'currentBets') = 'object'
      ),
      'handId', (${s})->>'handId',
      'handNumber', CASE WHEN jsonb_typeof((${s})->'handNumber') = 'number'
                         THEN ((${s})->>'handNumber')::int ELSE NULL END,
      'street', (${s})->>'street',
      'actionTo', CASE WHEN jsonb_typeof((${s})->'actionTo') = 'number'
                       THEN ((${s})->>'actionTo')::int ELSE NULL END,
      'winners', CASE WHEN jsonb_typeof((${s})->'winners') = 'array' THEN (
        SELECT COALESCE(json_agg(json_build_object(
            'seat', winner.value->'seat',
            'amount', winner.value->'amount',
            'handRank', winner.value->>'handRank'
          ) ORDER BY winner.ord), '[]'::json)
        FROM jsonb_array_elements((${s})->'winners') WITH ORDINALITY AS winner(value, ord)
        WHERE jsonb_typeof(winner.value) = 'object'
      ) ELSE NULL END,
      'players', CASE WHEN jsonb_typeof((${s})->'players') = 'array' THEN (
        SELECT COALESCE(json_agg(json_build_object(
            'id', player.value->>'id',
            'seat', player.value->'seat',
            'status', player.value->>'status',
            'stack', player.value->'stack',
            'betThisStreet', player.value->'betThisStreet',
            'totalInvestedThisHand', player.value->'totalInvestedThisHand',
            'isSittingOut', player.value->'isSittingOut'
          ) ORDER BY player.ord), '[]'::json)
        FROM jsonb_array_elements((${s})->'players') WITH ORDINALITY AS player(value, ord)
        WHERE jsonb_typeof(player.value) = 'object'
      ) ELSE '[]'::json END,
      'currentBets', CASE WHEN jsonb_typeof((${s})->'currentBets') = 'object'
                          THEN (${s})->'currentBets' ELSE '{}'::jsonb END,
      'pots', CASE WHEN jsonb_typeof((${s})->'pots') = 'array' THEN (
        SELECT COALESCE(json_agg(json_build_object(
            'amount', pot.value->'amount',
            'eligibleSeats', CASE WHEN jsonb_typeof(pot.value->'eligibleSeats') = 'array'
                                  THEN pot.value->'eligibleSeats' ELSE '[]'::jsonb END,
            'type', pot.value->>'type',
            'capPerPlayer', pot.value->'capPerPlayer'
          ) ORDER BY pot.ord), '[]'::json)
        FROM jsonb_array_elements((${s})->'pots') WITH ORDINALITY AS pot(value, ord)
        WHERE jsonb_typeof(pot.value) = 'object'
      ) ELSE '[]'::json END
    )`;
}

/**
 * The single read-only statement behind one diagnostic capture. Every
 * interpolation is a validated durable identifier or a clamped integer; no
 * caller string reaches SQL unvalidated. The statement returns one JSON
 * document (one snapshot) whose payload projections are re-sanitized in
 * process before the bundle is returned.
 */
export function terminalDiagnosticsSql(
  identifiers: TerminalDiagnosticsIdentifiers,
  options: TerminalDiagnosticsSqlOptions = {}
): string {
  const tableId = cleanIdentifier(identifiers?.tableId, 'table');
  const competitionId = cleanIdentifier(identifiers?.competitionId, 'competition');
  const handId = cleanIdentifier(identifiers?.handId, 'hand');
  const requestId = cleanIdentifier(identifiers?.requestId, 'request');
  if (tableId === null && competitionId === null) {
    throw new TerminalDiagnosticsInputError(
      'terminal diagnostics requires a table or competition identifier'
    );
  }
  const maxEvents = boundedLimit(options.maxEvents, DEFAULT_MAX_EVENTS, MAX_MAX_EVENTS);
  const maxOutboxRows = boundedLimit(options.maxOutboxRows, DEFAULT_MAX_OUTBOX_ROWS, MAX_MAX_OUTBOX_ROWS);

  const tablePredicate =
    tableId !== null
      ? `t.id = '${tableId}'`
      : `t.id = (SELECT ctr."tableId" FROM "Competition" cc JOIN "Tournament" ctr ON ctr.id = cc."tournamentId" WHERE cc.id = '${competitionId}')`;
  const competitionPredicate = competitionId !== null ? `\n  AND c.id = '${competitionId}'` : '';
  const handEventPredicate = handId !== null ? `\n      AND e.payload->>'handId' = '${handId}'` : '';
  const handHistoryPredicate =
    handId !== null ? `\n      AND (h.id = tt.id || '_' || '${handId}' OR h.id = '${handId}')` : '';
  const foldHandPredicate = handId !== null ? `\n      AND e.payload->>'handId' = '${handId}'` : '';

  // Canonical evidence that the next hand began after the affected hand: only
  // HAND_STARTED events strictly after the anchor hand's last committed event,
  // and only when the anchor hand itself exists.
  const subsequentHandStartsProjection =
    handId !== null
      ? `COALESCE((
    SELECT json_agg(projected.row_data ORDER BY projected."eventSeq")
    FROM (
      SELECT json_build_object(
          'id', e.id,
          'eventSeq', e."eventSeq",
          'type', e.type,
          'version', e.version,
          'turnId', e."turnId",
          'requestId', e."requestId",
          'actionId', e."actionId",
          'handId', e.payload->>'handId',
          'action', e.payload->>'action'
        ) AS row_data,
        e."eventSeq" AS "eventSeq"
      FROM "GameEvent" e, target_table tt
      WHERE e."tableId" = tt.id
        AND e.type = 'HAND_STARTED'
        AND EXISTS (
          SELECT 1 FROM "GameEvent" anchor, target_table att
          WHERE anchor."tableId" = att.id AND anchor.payload->>'handId' = '${handId}'
        )
        AND e."eventSeq" > COALESCE((
          SELECT MAX(anchor."eventSeq") FROM "GameEvent" anchor, target_table att
          WHERE anchor."tableId" = att.id AND anchor.payload->>'handId' = '${handId}'
        ), 0)
      ORDER BY e."eventSeq" ASC
      LIMIT ${maxEvents}
    ) AS projected
  ), '[]'::json)`
      : `'[]'::json`;

  // Generic explicit-action receipt body. `action` is the engine action family
  // from the committed event (`FOLD`, `CALL`, `RAISE`, ...) or null when the
  // request has no committed event (for example a rejected request).
  const receiptFieldsSql = `json_build_object(
      'id', r.id,
      'requestId', r."requestId",
      'principalId', r."principalId",
      'turnId', r."turnId",
      'actionId', r."actionId",
      'expectedVersion', r."expectedVersion",
      'status', r.status,
      'resultVersion', r."resultVersion",
      'eventSeq', r."eventSeq",
      'errorCode', r."errorCode",
      'action', e.payload->>'action',
      'responseReceipt', CASE WHEN jsonb_typeof(r.response->'receipt') = 'object' THEN json_build_object(
          'requestId', r.response->'receipt'->>'requestId',
          'turnId', r.response->'receipt'->>'turnId',
          'actionId', r.response->'receipt'->>'actionId',
          'handId', r.response->'receipt'->>'handId',
          'version', CASE WHEN jsonb_typeof(r.response->'receipt'->'version') = 'number'
                          THEN (r.response->'receipt'->>'version')::int ELSE NULL END,
          'eventSeq', CASE WHEN jsonb_typeof(r.response->'receipt'->'eventSeq') = 'number'
                           THEN (r.response->'receipt'->>'eventSeq')::int ELSE NULL END,
          'acceptedAt', CASE WHEN jsonb_typeof(r.response->'receipt'->'acceptedAt') = 'number'
                             THEN (r.response->'receipt'->>'acceptedAt')::bigint ELSE NULL END
        ) ELSE NULL END,
      'observation', CASE WHEN jsonb_typeof(r.response->'observation') = 'object' THEN json_build_object(
          'tableId', r.response->'observation'->>'tableId',
          'handId', r.response->'observation'->>'handId',
          'turnId', r.response->'observation'->>'turnId',
          'version', CASE WHEN jsonb_typeof(r.response->'observation'->'version') = 'number'
                          THEN (r.response->'observation'->>'version')::int ELSE NULL END,
          'eventSeq', CASE WHEN jsonb_typeof(r.response->'observation'->'eventSeq') = 'number'
                           THEN (r.response->'observation'->>'eventSeq')::int ELSE NULL END,
          'state', CASE WHEN jsonb_typeof(r.response->'observation'->'state') = 'object'
                        THEN (${stateProjectionSql("r.response->'observation'->'state'")})
                        ELSE NULL END
        ) ELSE NULL END,
      'audit', (
        SELECT json_build_object(
          'id', a.id,
          'action', a.action,
          'createdAt', a."createdAt",
          'replayed', CASE WHEN a.metadata->>'replayed' IN ('true', 'false')
                           THEN (a.metadata->>'replayed')::boolean ELSE NULL END,
          'version', CASE WHEN a.metadata->>'version' ~ '^[0-9]+$'
                          THEN (a.metadata->>'version')::int ELSE NULL END,
          'eventSeq', CASE WHEN a.metadata->>'eventSeq' ~ '^[0-9]+$'
                           THEN (a.metadata->>'eventSeq')::int ELSE NULL END
        )
        FROM "AuditLog" a
        WHERE a."resource" = 'table:' || (SELECT id FROM target_table)
          AND a.metadata->>'requestId' = r."requestId"
        ORDER BY a."createdAt" DESC
        LIMIT 1
      )
    )`;

  // Explicit requestId: exact durable row regardless of action family, with a
  // LEFT JOIN so a rejected request with no committed event is still captured
  // (action null). No explicit requestId: legacy latest accepted FOLD
  // inference, scoped to the requested hand.
  const receiptProjection =
    requestId !== null
      ? `(
    SELECT ${receiptFieldsSql}
    FROM "GameActionRequest" r
    LEFT JOIN "GameEvent" e ON e."tableId" = r."tableId" AND e."requestId" = r."requestId"
    WHERE r."tableId" = (SELECT id FROM target_table)
      AND r."requestId" = '${requestId}'
    ORDER BY e."eventSeq" DESC NULLS LAST
    LIMIT 1
  )`
      : `(
    SELECT ${receiptFieldsSql}
    FROM "GameActionRequest" r
    JOIN "GameEvent" e ON e."tableId" = r."tableId" AND e."requestId" = r."requestId"
    WHERE r."tableId" = (SELECT id FROM target_table)
      AND e.payload->>'action' = 'FOLD'${foldHandPredicate}
    ORDER BY e."eventSeq" DESC
    LIMIT 1
  )`;

  return `WITH target_table AS (
  SELECT t.id, t.status, t."stateVersion", t."eventSeq", t."tournamentId", t.state
  FROM "Table" t
  WHERE ${tablePredicate}
  LIMIT 1
),
target_tournament AS (
  SELECT tr.id, tr.status, tr."startingStack", tr."buyIn", tr."fee", tr."maxPlayers",
         tr."tableId", tr."startedAt", tr."finishedAt"
  FROM "Tournament" tr
  JOIN target_table tt ON tt."tournamentId" = tr.id
  LIMIT 1
),
target_competition AS (
  SELECT c.id, c.mode, c.status, c."startingStack", c."smallBlind", c."bigBlind",
         c."entryAssetId", c."entryAmountAtomic", c."prizeAssetId", c."prizeAmountAtomic",
         c."prizeStatus", c."tournamentId", c."startedAt", c."finishedAt", c."cancelledAt",
         CASE
           WHEN c.status = 'FINISHED' THEN true
           WHEN c.status <> 'RUNNING' THEN false
           WHEN (SELECT count(*) FROM "TournamentEntry" active_entry
                 WHERE active_entry."tournamentId" = c."tournamentId"
                   AND active_entry.status = 'ACTIVE') <> 1 THEN false
           WHEN EXISTS (SELECT 1 FROM "TournamentEntry" registered_entry
                        WHERE registered_entry."tournamentId" = c."tournamentId"
                          AND registered_entry.status = 'REGISTERED') THEN false
           WHEN NOT EXISTS (SELECT 1 FROM "Table" backing_table
                            WHERE backing_table."tournamentId" = c."tournamentId") THEN false
           WHEN EXISTS (
             SELECT 1
             FROM "Table" backing_table
             CROSS JOIN LATERAL (SELECT ${normalizedStateSql('backing_table.state')} AS state) backing_state
             WHERE backing_table."tournamentId" = c."tournamentId"
               AND NOT (
                 (CASE WHEN jsonb_typeof(backing_state.state->'handNumber') = 'number'
                       THEN (backing_state.state->>'handNumber')::int = 0 ELSE false END
                  AND (COALESCE(backing_state.state->'actionTo' = 'null'::jsonb, false)
                       OR backing_state.state->'actionTo' IS NULL))
                 OR (CASE WHEN jsonb_typeof(backing_state.state->'winners') = 'array'
                          THEN jsonb_array_length(backing_state.state->'winners') > 0 ELSE false END
                     AND (COALESCE(backing_state.state->'actionTo' = 'null'::jsonb, false)
                          OR backing_state.state->'actionTo' IS NULL))
               )
           ) THEN false
           ELSE (
             SELECT COALESCE(bool_or(
               CASE WHEN jsonb_typeof(winner_player.value->'stack') = 'number'
                    THEN (winner_player.value->>'stack')::int > 0 ELSE false END
             ), false)
             FROM "Table" backing_table
             CROSS JOIN LATERAL (SELECT ${normalizedStateSql('backing_table.state')} AS state) backing_state
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(backing_state.state->'players') = 'array'
                    THEN backing_state.state->'players' ELSE '[]'::jsonb END
             ) AS winner_player(value)
             WHERE backing_table."tournamentId" = c."tournamentId"
               AND jsonb_typeof(winner_player.value) = 'object'
               AND winner_player.value->>'id' = (
                 SELECT active_entry."userId" FROM "TournamentEntry" active_entry
                 WHERE active_entry."tournamentId" = c."tournamentId"
                   AND active_entry.status = 'ACTIVE'
                 LIMIT 1
               )
           )
         END AS "settlementReady"
  FROM "Competition" c
  JOIN target_tournament ttr ON c."tournamentId" = ttr.id
  WHERE 1 = 1${competitionPredicate}
  LIMIT 1
)
SELECT json_build_object(
  'table', (SELECT json_build_object(
      'id', tt.id,
      'status', tt.status,
      'stateVersion', tt."stateVersion",
      'eventSeq', tt."eventSeq",
      'state', CASE WHEN table_state.state IS NULL THEN NULL ELSE (${stateProjectionSql('table_state.state')}) END
    ) FROM target_table tt
    CROSS JOIN LATERAL (SELECT ${normalizedStateSql('tt.state')} AS state) table_state),
  'events', COALESCE((
    SELECT json_agg(projected.row_data ORDER BY projected."eventSeq")
    FROM (
      SELECT json_build_object(
          'id', e.id,
          'eventSeq', e."eventSeq",
          'type', e.type,
          'version', e.version,
          'turnId', e."turnId",
          'requestId', e."requestId",
          'actionId', e."actionId",
          'handId', e.payload->>'handId',
          'action', e.payload->>'action'
        ) AS row_data,
        e."eventSeq" AS "eventSeq"
      FROM "GameEvent" e, target_table tt
      WHERE e."tableId" = tt.id${handEventPredicate}
      ORDER BY e."eventSeq" DESC
      LIMIT ${maxEvents}
    ) AS projected
  ), '[]'::json),
  'subsequentHandStarts', ${subsequentHandStartsProjection},
  'foldReceipt', ${receiptProjection},
  'outbox', COALESCE((
    SELECT json_agg(projected.row_data ORDER BY projected."createdAt", projected.id)
    FROM (
      SELECT json_build_object(
          'id', o.id,
          'kind', o.kind,
          'status', o.status,
          'attempts', o.attempts,
          'dedupeKey', o."dedupeKey",
          'availableAt', o."availableAt",
          'createdAt', o."createdAt",
          'updatedAt', o."updatedAt",
          'lastError', o."lastError",
          'payload', CASE o.kind
            WHEN 'settle-hand' THEN json_build_object(
              'handId', o.payload->>'handId',
              'rakeTotal', o.payload->>'rakeTotal',
              'playerNetChanges', CASE WHEN jsonb_typeof(o.payload->'playerNetChanges') = 'object'
                                       THEN o.payload->'playerNetChanges' ELSE '{}'::jsonb END)
            WHEN 'archive-hand' THEN json_build_object('handId', o.payload->>'handId')
            WHEN 'tournament-reconcile' THEN json_build_object(
              'tableId', o.payload->>'tableId',
              'tournamentId', o.payload->>'tournamentId',
              'handId', o.payload->>'handId',
              'actorId', o.payload->>'actorId')
            WHEN 'next-hand' THEN json_build_object(
              'handId', o.payload->>'handId',
              'expectedHandId', o.payload->>'expectedHandId',
              'expectedVersion', o.payload->'expectedVersion')
            WHEN 'player-timeout' THEN json_build_object(
              'handId', o.payload->>'handId',
              'playerId', o.payload->>'playerId',
              'anchorEventSeq', o.payload->'anchorEventSeq',
              'expectedVersion', o.payload->'expectedVersion')
            WHEN 'pubsub' THEN json_build_object(
              'type', o.payload->>'type',
              'version', o.payload->'version',
              'eventSeq', o.payload->'eventSeq',
              'timestamp', o.payload->'timestamp')
            ELSE '{}'::json
          END
        ) AS row_data,
        o."createdAt" AS "createdAt",
        o.id AS id
      FROM "GameOutbox" o, target_table tt
      WHERE o."tableId" = tt.id
      ORDER BY o."createdAt" DESC, o.id DESC
      LIMIT ${maxOutboxRows}
    ) AS projected
  ), '[]'::json),
  'handHistory', json_build_object(
    'exists', EXISTS (
      SELECT 1 FROM "HandHistory" h, target_table tt
      WHERE h."tableId" = tt.id${handHistoryPredicate}
    ),
    'id', (
      SELECT h.id FROM "HandHistory" h, target_table tt
      WHERE h."tableId" = tt.id${handHistoryPredicate}
      ORDER BY h."timestamp" DESC
      LIMIT 1
    ),
    'timestamp', (
      SELECT h."timestamp" FROM "HandHistory" h, target_table tt
      WHERE h."tableId" = tt.id${handHistoryPredicate}
      ORDER BY h."timestamp" DESC
      LIMIT 1
    )
  ),
  'competition', (SELECT json_build_object(
      'id', c.id,
      'mode', c.mode,
      'status', c.status,
      'startingStack', c."startingStack",
      'smallBlind', c."smallBlind",
      'bigBlind', c."bigBlind",
      'entryAssetId', c."entryAssetId",
      'entryAmountAtomic', c."entryAmountAtomic",
      'prizeAssetId', c."prizeAssetId",
      'prizeAmountAtomic', c."prizeAmountAtomic",
      'prizeStatus', c."prizeStatus",
      'tournamentId', c."tournamentId",
      'settlementReady', c."settlementReady",
      'startedAt', c."startedAt",
      'finishedAt', c."finishedAt",
      'cancelledAt', c."cancelledAt"
    ) FROM target_competition c),
  'tournament', (SELECT json_build_object(
      'id', ttr.id,
      'status', ttr.status,
      'startingStack', ttr."startingStack",
      'buyIn', ttr."buyIn",
      'fee', ttr."fee",
      'maxPlayers', ttr."maxPlayers",
      'tableId', ttr."tableId",
      'startedAt', ttr."startedAt",
      'finishedAt', ttr."finishedAt"
    ) FROM target_tournament ttr),
  'entrants', COALESCE((
    SELECT json_agg(entrant.row_data ORDER BY entrant.seat)
    FROM (
      SELECT json_build_object(
          'id', e.id,
          'principalId', e."principalId",
          'kind', e.kind,
          'seat', e.seat,
          'entryState', e."entryState",
          'tournamentEntryId', te.id,
          'tournamentStatus', te.status,
          'placement', te.placement,
          'currentTableId', te."currentTableId",
          'currentSeat', te."currentSeat",
          'prizeAtomic', te.prize::text,
          'authoritativeStack', (
            SELECT stack_player.value->'stack'
            FROM "Table" stack_table
            CROSS JOIN LATERAL (SELECT ${normalizedStateSql('stack_table.state')} AS state) stack_state
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(stack_state.state->'players') = 'array'
                   THEN stack_state.state->'players' ELSE '[]'::jsonb END
            ) WITH ORDINALITY AS stack_player(value, ord)
            WHERE stack_table.id = COALESCE(te."currentTableId", (SELECT id FROM target_table))
              AND jsonb_typeof(stack_player.value) = 'object'
              AND stack_player.value->>'id' = e."principalId"
            LIMIT 1
          )
        ) AS row_data,
        e.seat AS seat
      FROM "CompetitionEntrant" e
      LEFT JOIN "TournamentEntry" te
        ON te."tournamentId" = (SELECT id FROM target_tournament)
       AND te."userId" = e."principalId"
      WHERE e."competitionId" = (SELECT id FROM target_competition)
      ORDER BY e.seat
      LIMIT 100
    ) AS entrant
  ), '[]'::json),
  'reconciliation', (
    SELECT json_build_object(
      'id', te.id,
      'eventSeq', te."eventSeq",
      'type', te.type,
      'requestRef', te."requestRef",
      'stateFingerprint', te."stateFingerprint",
      'occurredAt', te."occurredAt",
      'payload', te.payload
    )
    FROM "TournamentEvent" te
    JOIN target_tournament ttr ON ttr.id = te."tournamentId"
    WHERE te.type = 'TOURNAMENT_RECONCILED'
    ORDER BY te."eventSeq" DESC
    LIMIT 1
  )
)::text`;
}

/** Default executor over the existing explicit-infrastructure query helpers. */
export function terminalDiagnosticsQuery(target: AdminDatabaseTarget): TerminalDiagnosticsSqlQuery {
  return target.kind === 'container'
    ? (sql) => psqlContainer(target.container, sql)
    : (sql) => psqlUrl(target.databaseUrl, sql);
}

// ---------------------------------------------------------------------------
// Raw-projection sanitizers
// ---------------------------------------------------------------------------

const REQUIRED_STATE_KEYS = [
  'state',
  'handId',
  'handNumber',
  'street',
  'actionTo',
  'players',
  'winners',
  'pots',
  'currentBets',
] as const;

/**
 * Preserve the authoritative winners value exactly: null (JSON null, absent or
 * non-array raw value), [] (settled with no winner rows), or a winner list.
 */
function sanitizeWinnerSection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsWinner[] | null {
  if (!Array.isArray(raw)) return null;
  const winners: TerminalDiagnosticsWinner[] = [];
  for (const item of raw.slice(0, 10)) {
    if (!isRecord(item)) continue;
    winners.push({
      seat: recordInteger(item.seat),
      amount: recordInteger(item.amount),
      handRank: recordText(item.handRank, redact, 128),
    });
  }
  return winners;
}

function sanitizePlayerSection(raw: unknown, redact: Redact): TerminalDiagnosticsPlayerSnapshot[] {
  const players: TerminalDiagnosticsPlayerSnapshot[] = [];
  for (const item of asArray(raw).slice(0, 10)) {
    if (!isRecord(item)) continue;
    players.push({
      id: recordText(item.id, redact, MAX_IDENTIFIER_TEXT_LENGTH),
      seat: recordInteger(item.seat),
      status: recordText(item.status, redact, 32),
      stack: recordInteger(item.stack),
      betThisStreet: recordInteger(item.betThisStreet),
      totalInvestedThisHand: recordInteger(item.totalInvestedThisHand),
      isSittingOut: recordBoolean(item.isSittingOut),
    });
  }
  return players;
}

function sanitizeSeatChipRecord(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const bets: Record<string, number> = {};
  let count = 0;
  for (const [seat, amount] of Object.entries(raw)) {
    if (count >= 10) break;
    if (!/^\d{1,2}$/.test(seat)) continue;
    const value = recordInteger(amount);
    if (value === null) continue;
    bets[seat] = value;
    count += 1;
  }
  return bets;
}

function sanitizePotSection(raw: unknown, redact: Redact): TerminalDiagnosticsPotSnapshot[] {
  const pots: TerminalDiagnosticsPotSnapshot[] = [];
  for (const item of asArray(raw).slice(0, 20)) {
    if (!isRecord(item)) continue;
    const eligibleSeats: number[] = [];
    for (const seat of asArray(item.eligibleSeats).slice(0, 10)) {
      const value = recordInteger(seat);
      if (value !== null) eligibleSeats.push(value);
    }
    pots.push({
      amount: recordInteger(item.amount),
      eligibleSeats,
      type: recordText(item.type, redact, 8),
      capPerPlayer: recordInteger(item.capPerPlayer),
    });
  }
  return pots;
}

/**
 * Sanitize one state projection. Returns null only when the raw JSON is not an
 * object (for example an absent `Table.state`); a projection with missing
 * required keys still returns an object with `present: false` and fixed
 * `missing` labels so completeness can fail closed.
 */
function sanitizeStateSnapshot(raw: unknown, redact: Redact): TerminalDiagnosticsStateSnapshot | null {
  if (!isRecord(raw)) return null;
  const presence = isRecord(raw.present) ? raw.present : {};
  const missing = REQUIRED_STATE_KEYS.filter((key) => presence[key] !== true);
  return {
    handId: recordText(raw.handId, redact),
    handNumber: recordInteger(raw.handNumber),
    street: recordText(raw.street, redact, 32),
    actionTo: recordInteger(raw.actionTo),
    winners: sanitizeWinnerSection(raw.winners, redact),
    players: sanitizePlayerSection(raw.players, redact),
    currentBets: sanitizeSeatChipRecord(raw.currentBets),
    pots: sanitizePotSection(raw.pots, redact),
    present: missing.length === 0,
    missing: [...missing],
  };
}

function sanitizeTableSection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsTableSnapshot | null {
  if (!isRecord(raw)) return null;
  const id = recordText(raw.id, redact);
  const status = recordText(raw.status, redact, 64);
  if (id === null || status === null) return null;
  return {
    id,
    status,
    stateVersion: recordInteger(raw.stateVersion) ?? 0,
    eventSeq: recordInteger(raw.eventSeq) ?? 0,
    state: sanitizeStateSnapshot(raw.state, redact),
  };
}

function sanitizeEventSection(raw: unknown, redact: Redact): TerminalDiagnosticsEvent[] {
  const events: TerminalDiagnosticsEvent[] = [];
  for (const item of asArray(raw).slice(0, MAX_SECTION_ROWS)) {
    if (!isRecord(item)) continue;
    const id = recordText(item.id, redact);
    const eventSeq = recordInteger(item.eventSeq);
    const type = recordText(item.type, redact, 64);
    if (id === null || eventSeq === null || type === null) continue;
    events.push({
      id,
      eventSeq,
      type,
      version: recordInteger(item.version) ?? 0,
      turnId: recordText(item.turnId, redact),
      requestId: recordText(item.requestId, redact),
      actionId: recordText(item.actionId, redact),
      handId: recordText(item.handId, redact),
      action: recordText(item.action, redact, 64),
    });
  }
  return events.sort((left, right) => left.eventSeq - right.eventSeq);
}

function sanitizeActionAuditSection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsActionAudit | null {
  if (!isRecord(raw)) return null;
  const id = recordText(raw.id, redact);
  const action = recordText(raw.action, redact, 128);
  const createdAt = recordText(raw.createdAt, redact);
  if (id === null || action === null || createdAt === null) return null;
  return {
    id,
    action,
    createdAt,
    replayed: recordBoolean(raw.replayed),
    version: recordInteger(raw.version),
    eventSeq: recordInteger(raw.eventSeq),
  };
}

function sanitizeActionReceiptProjection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsActionReceipt | null {
  if (!isRecord(raw)) return null;
  return {
    requestId: recordText(raw.requestId, redact),
    turnId: recordText(raw.turnId, redact),
    actionId: recordText(raw.actionId, redact),
    handId: recordText(raw.handId, redact),
    version: recordInteger(raw.version),
    eventSeq: recordInteger(raw.eventSeq),
    acceptedAt: recordInteger(raw.acceptedAt),
  };
}

function sanitizeObservationProjection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsObservationProjection | null {
  if (!isRecord(raw)) return null;
  return {
    tableId: recordText(raw.tableId, redact),
    handId: recordText(raw.handId, redact),
    turnId: recordText(raw.turnId, redact),
    version: recordInteger(raw.version),
    eventSeq: recordInteger(raw.eventSeq),
    state: sanitizeStateSnapshot(raw.state, redact),
  };
}

function sanitizeFoldReceiptSection(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions
): TerminalDiagnosticsFoldReceipt | null {
  if (!isRecord(raw)) return null;
  const redact = resolveRedact(options);
  const id = recordText(raw.id, redact);
  const requestId = recordText(raw.requestId, redact);
  const principalId = recordText(raw.principalId, redact);
  const turnId = recordText(raw.turnId, redact);
  const actionId = recordText(raw.actionId, redact);
  const status = recordText(raw.status, redact, 64);
  if (
    id === null ||
    requestId === null ||
    principalId === null ||
    turnId === null ||
    actionId === null ||
    status === null
  ) {
    return null;
  }
  const audit = sanitizeActionAuditSection(raw.audit, redact);
  // Primary source is the SQL's explicit semantic projection; a raw
  // `response` object (a projection regression) is still only ever read
  // through the same explicit whitelists, never copied.
  const rawResponse = isRecord(raw.response) ? raw.response : null;
  const responseReceiptSource = isRecord(raw.responseReceipt)
    ? raw.responseReceipt
    : rawResponse !== null && isRecord(rawResponse.receipt)
      ? rawResponse.receipt
      : null;
  const observationSource = isRecord(raw.observation)
    ? raw.observation
    : rawResponse !== null && isRecord(rawResponse.observation)
      ? rawResponse.observation
      : null;
  return {
    id,
    requestId,
    principalId,
    turnId,
    actionId,
    expectedVersion: recordInteger(raw.expectedVersion) ?? 0,
    status,
    resultVersion: recordInteger(raw.resultVersion),
    eventSeq: recordInteger(raw.eventSeq),
    errorCode: sanitizeDiagnosticError(raw.errorCode, options),
    action: recordText(raw.action, redact, 64),
    audit,
    // Unknown when the audit evidence is absent: never assume "not replayed".
    replayed: audit?.replayed ?? null,
    responseReceipt: sanitizeActionReceiptProjection(responseReceiptSource, redact),
    observation: sanitizeObservationProjection(observationSource, redact),
  };
}

function sanitizeOutboxSection(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions
): TerminalDiagnosticsOutboxRow[] {
  const redact = resolveRedact(options);
  const rows: TerminalDiagnosticsOutboxRow[] = [];
  for (const item of asArray(raw).slice(0, MAX_SECTION_ROWS)) {
    if (!isRecord(item)) continue;
    const id = recordText(item.id, redact);
    const kind = recordText(item.kind, redact, 64);
    const status = recordText(item.status, redact, 32);
    if (id === null || kind === null || status === null) continue;
    rows.push({
      id,
      kind,
      status,
      attempts: recordInteger(item.attempts) ?? 0,
      dedupeKey: recordText(item.dedupeKey, redact) ?? '',
      availableAt: recordText(item.availableAt, redact) ?? '',
      createdAt: recordText(item.createdAt, redact) ?? '',
      updatedAt: recordText(item.updatedAt, redact) ?? '',
      lastError: sanitizeDiagnosticError(item.lastError, options),
      payload: sanitizeOutboxPayload(kind, item.payload, options),
      jobState: null,
    });
  }
  return rows.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function sanitizeHandHistorySection(raw: unknown, redact: Redact): TerminalDiagnosticsHandHistory {
  if (!isRecord(raw)) return { exists: false, id: null, timestamp: null };
  return {
    exists: recordBoolean(raw.exists) ?? false,
    id: recordText(raw.id, redact),
    timestamp: recordText(raw.timestamp, redact),
  };
}

function sanitizeCompetitionSection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsCompetition | null {
  if (!isRecord(raw)) return null;
  const id = recordText(raw.id, redact);
  const mode = recordText(raw.mode, redact, 32);
  const status = recordText(raw.status, redact, 32);
  const prizeStatus = recordText(raw.prizeStatus, redact, 32);
  const tournamentId = recordText(raw.tournamentId, redact);
  if (id === null || mode === null || status === null || prizeStatus === null || tournamentId === null) {
    return null;
  }
  return {
    id,
    mode,
    status,
    startingStack: recordInteger(raw.startingStack) ?? 0,
    smallBlind: recordInteger(raw.smallBlind) ?? 0,
    bigBlind: recordInteger(raw.bigBlind) ?? 0,
    entryAssetId: recordText(raw.entryAssetId, redact),
    entryAmountAtomic: recordText(raw.entryAmountAtomic, redact, 64),
    prizeAssetId: recordText(raw.prizeAssetId, redact),
    prizeAmountAtomic: recordText(raw.prizeAmountAtomic, redact, 64),
    prizeStatus,
    tournamentId,
    settlementReady: recordBoolean(raw.settlementReady),
    startedAt: recordText(raw.startedAt, redact),
    finishedAt: recordText(raw.finishedAt, redact),
    cancelledAt: recordText(raw.cancelledAt, redact),
  };
}

function sanitizeTournamentSection(
  raw: unknown,
  redact: Redact
): TerminalDiagnosticsTournament | null {
  if (!isRecord(raw)) return null;
  const id = recordText(raw.id, redact);
  const status = recordText(raw.status, redact, 32);
  const tableId = recordText(raw.tableId, redact);
  if (id === null || status === null || tableId === null) return null;
  return {
    id,
    status,
    startingStack: recordInteger(raw.startingStack) ?? 0,
    buyIn: recordInteger(raw.buyIn) ?? 0,
    fee: recordInteger(raw.fee) ?? 0,
    maxPlayers: recordInteger(raw.maxPlayers) ?? 0,
    tableId,
    startedAt: recordText(raw.startedAt, redact),
    finishedAt: recordText(raw.finishedAt, redact),
  };
}

function sanitizeEntrantSection(raw: unknown, redact: Redact): TerminalDiagnosticsEntrant[] {
  const entrants: TerminalDiagnosticsEntrant[] = [];
  for (const item of asArray(raw).slice(0, MAX_SECTION_ROWS)) {
    if (!isRecord(item)) continue;
    const id = recordText(item.id, redact);
    const principalId = recordText(item.principalId, redact);
    const seat = recordInteger(item.seat);
    if (id === null || principalId === null || seat === null) continue;
    entrants.push({
      id,
      principalId,
      kind: recordText(item.kind, redact, 32) ?? 'UNKNOWN',
      seat,
      entryState: recordText(item.entryState, redact, 32) ?? 'UNKNOWN',
      tournamentEntryId: recordText(item.tournamentEntryId, redact),
      tournamentStatus: recordText(item.tournamentStatus, redact, 32),
      placement: recordInteger(item.placement),
      currentTableId: recordText(item.currentTableId, redact),
      currentSeat: recordInteger(item.currentSeat),
      prizeAtomic:
        typeof item.prizeAtomic === 'string' && CANONICAL_ATOMIC_RE.test(item.prizeAtomic)
          ? item.prizeAtomic
          : null,
      authoritativeStack: recordCount(item.authoritativeStack),
    });
  }
  return entrants.sort((left, right) => left.seat - right.seat);
}

function sanitizeReconciliationSection(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions
): TerminalDiagnosticsReconciliationEvent | null {
  if (!isRecord(raw)) return null;
  const redact = resolveRedact(options);
  const id = recordText(raw.id, redact);
  const eventSeq = recordInteger(raw.eventSeq);
  const type = recordText(raw.type, redact, 64);
  const stateFingerprint = recordText(raw.stateFingerprint, redact, 128);
  if (id === null || eventSeq === null || type === null || stateFingerprint === null) return null;
  return {
    id,
    eventSeq,
    type,
    requestRef: recordText(raw.requestRef, redact),
    stateFingerprint,
    occurredAt: recordText(raw.occurredAt, redact) ?? '',
    payload: sanitizeReconciliationPayload(type, raw.payload, options),
  };
}

/**
 * Sanitize one raw operator projection (the shape `terminalDiagnosticsSql`
 * returns) into the bundle sections. Every field is re-typechecked and every
 * string is redacted; malformed rows are dropped rather than surfaced raw.
 */
export function sanitizeTerminalDiagnosticsSections(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {}
): TerminalDiagnosticsSections {
  const record = isRecord(raw) ? raw : {};
  const redact = resolveRedact(options);
  return {
    table: sanitizeTableSection(record.table, redact),
    events: sanitizeEventSection(record.events, redact),
    subsequentHandStarts: sanitizeEventSection(record.subsequentHandStarts, redact),
    foldReceipt: sanitizeFoldReceiptSection(record.foldReceipt, options),
    outbox: sanitizeOutboxSection(record.outbox, options),
    handHistory: sanitizeHandHistorySection(record.handHistory, redact),
    competition: sanitizeCompetitionSection(record.competition, redact),
    tournament: sanitizeTournamentSection(record.tournament, redact),
    entrants: sanitizeEntrantSection(record.entrants, redact),
    reconciliation: sanitizeReconciliationSection(record.reconciliation, options),
  };
}

const UNKNOWN_JOB_STATE: TerminalDiagnosticsOutboxJobState = {
  state: 'unknown',
  exists: null,
  attemptsMade: null,
  failedReason: null,
  processedOn: null,
  finishedOn: null,
};

function jobStateName(value: unknown): TerminalDiagnosticsJobStateName {
  if (typeof value !== 'string') return 'unknown';
  const lowered = value.trim().toLowerCase();
  return (TERMINAL_DIAGNOSTICS_JOB_STATES as readonly string[]).includes(lowered)
    ? (lowered as TerminalDiagnosticsJobStateName)
    : 'unknown';
}

/**
 * Whitelist one caller-supplied BullMQ job projection. Only state, presence,
 * attempts, sanitized failure reason and processing/finish timestamps survive;
 * the raw job `data` (which can carry a private engine snapshot) never does.
 * A `null` projection means the job is missing; a non-object/unknown shape is
 * `unknown`.
 */
export function sanitizeOutboxJobState(
  raw: unknown,
  options: TerminalDiagnosticsSanitizeOptions = {}
): TerminalDiagnosticsOutboxJobState {
  if (raw === null || raw === undefined) {
    return { state: 'missing', exists: false, attemptsMade: null, failedReason: null, processedOn: null, finishedOn: null };
  }
  if (typeof raw === 'string') {
    const state = jobStateName(raw);
    return { ...UNKNOWN_JOB_STATE, state, exists: state === 'missing' ? false : state === 'unknown' ? null : true };
  }
  if (!isRecord(raw)) return { ...UNKNOWN_JOB_STATE };
  const state = jobStateName(raw.state);
  const explicitExists = recordBoolean(raw.exists);
  return {
    state,
    exists:
      explicitExists ??
      (state === 'missing' ? false : state === 'unavailable' || state === 'unknown' ? null : true),
    attemptsMade: recordInteger(raw.attemptsMade),
    failedReason: sanitizeDiagnosticError(raw.failedReason, options),
    processedOn: recordInteger(raw.processedOn),
    finishedOn: recordInteger(raw.finishedOn),
  };
}

const AFFECTED_HAND_JOB_KINDS = new Set(['archive-hand', 'next-hand', 'settle-hand']);
/** Worker-liveness jobs whose unreadable state is a completeness error. */
const REQUIRED_AFFECTED_HAND_JOB_KINDS = new Set(['archive-hand', 'next-hand']);

/**
 * True when an outbox row is scoped to the requested hand by its semantic
 * payload (`handId` / `expectedHandId`, raw or canonical
 * `<tableId>_<handId>`).
 */
function isAffectedHandJobRow(
  row: TerminalDiagnosticsOutboxRow,
  tableId: string | null,
  handId: string | null
): boolean {
  if (handId === null || !AFFECTED_HAND_JOB_KINDS.has(row.kind)) return false;
  const canonical = tableId !== null && tableId !== '' ? `${tableId}_${handId}` : null;
  return [row.payload.handId, row.payload.expectedHandId].some(
    (value) => value === handId || (canonical !== null && value === canonical)
  );
}

function isRequiredAffectedHandJobRow(
  row: TerminalDiagnosticsOutboxRow,
  tableId: string | null,
  handId: string | null
): boolean {
  return (
    row.status !== 'COMPLETED' &&
    REQUIRED_AFFECTED_HAND_JOB_KINDS.has(row.kind) &&
    isAffectedHandJobRow(row, tableId, handId)
  );
}

/**
 * Newest first, affected-hand rows before every other row. Used for both job
 * reads and warnings so the blocking last-hand failure is always classified
 * within the bounded read budget instead of older rows crowding it out.
 */
function prioritizedOutboxRows(
  rows: readonly TerminalDiagnosticsOutboxRow[],
  tableId: string | null,
  handId: string | null
): TerminalDiagnosticsOutboxRow[] {
  const affected: TerminalDiagnosticsOutboxRow[] = [];
  const rest: TerminalDiagnosticsOutboxRow[] = [];
  for (const row of rows) {
    (isAffectedHandJobRow(row, tableId, handId) ? affected : rest).push(row);
  }
  const newestFirst = (left: TerminalDiagnosticsOutboxRow, right: TerminalDiagnosticsOutboxRow): number => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    if (left.id !== right.id) return left.id < right.id ? 1 : -1;
    return 0;
  };
  return [...affected.sort(newestFirst), ...rest.sort(newestFirst)];
}

function collectReconcileFailureMetrics(
  value: unknown,
  path: string,
  warnings: string[],
  depth: number
): void {
  if (warnings.length >= MAX_WARNINGS || depth > MAX_DIAGNOSTIC_DEPTH) return;
  if (typeof value === 'number') {
    if (
      value > 0 &&
      /reconcil/i.test(path) &&
      /(fail|mismatch|defer|error|exhaust|unavailable)/i.test(path)
    ) {
      warnings.push(`reconcile-metrics:${path}=${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, MAX_DIAGNOSTIC_ITEMS).forEach((entry, index) => {
      collectReconcileFailureMetrics(entry, `${path}[${index}]`, warnings, depth + 1);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    collectReconcileFailureMetrics(entry, path === '' ? key : `${path}.${key}`, warnings, depth + 1);
  }
}

export interface TerminalDiagnosticsWarningInput {
  identifiers: TerminalDiagnosticsBundle['identifiers'];
  sections: TerminalDiagnosticsSections;
  metrics: unknown;
  apiLogWarning: unknown;
  /**
   * False when the operator capture failed: section-derived warnings are
   * suppressed (no evidence, not "missing"), while caller-supplied metric and
   * API-log warnings still surface.
   */
  collectionComplete?: boolean;
}

/**
 * Derive harness-authored warnings from ALREADY SANITIZED evidence. No raw
 * database, Redis or log bytes are copied: each warning contains only constant
 * prefixes plus enums/numbers/identifiers that survived the sanitizers.
 *
 * Signals:
 * - the latest reconciliation event (always surfaced while one exists);
 * - non-COMPLETED outbox rows, and DISPATCHED rows whose BullMQ job is
 *   missing/failed/unavailable (a dispatch row alone proves nothing);
 * - reconcile-failure counters found in the sanitized metrics input;
 * - a missing hand history for a requested hand;
 * - the presence of a caller-supplied API log warning.
 */
export function deriveTerminalDiagnosticsWarnings(
  input: TerminalDiagnosticsWarningInput
): string[] {
  const warnings: string[] = [];
  const { sections, metrics, apiLogWarning, identifiers } = input;
  const sectionsTrusted = input.collectionComplete !== false;

  if (sectionsTrusted && sections.reconciliation !== null) {
    warnings.push(
      `reconciliation-latest:${sections.reconciliation.type}#${sections.reconciliation.eventSeq}`
    );
  }

  if (sectionsTrusted) {
    const jobTableId = sections.table?.id ?? identifiers.tableId ?? null;
    for (const row of prioritizedOutboxRows(sections.outbox, jobTableId, identifiers.handId)) {
      if (warnings.length >= MAX_WARNINGS) return warnings;
      if (row.status === 'FAILED') {
        warnings.push(`outbox-failed:${row.kind}#${row.id}:attempts=${row.attempts}`);
      }
      // `pubsub` is not a BullMQ kind and is never probed for job state.
      if (row.kind === 'pubsub') continue;
      const job = row.jobState;
      if (
        job !== null &&
        (job.state === 'failed' ||
          job.state === 'missing' ||
          job.state === 'unavailable' ||
          job.state === 'unknown')
      ) {
        warnings.push(`outbox-job:${row.kind}#${row.id}:state=${job.state}`);
      }
    }
  }

  collectReconcileFailureMetrics(metrics, '', warnings, 0);

  if (sectionsTrusted && identifiers.handId !== null && !sections.handHistory.exists) {
    warnings.push(`hand-history-missing:${identifiers.handId}`);
  }
  if (apiLogWarning !== null && apiLogWarning !== undefined) {
    warnings.push('api-log-warning-present');
  }
  return warnings.slice(0, MAX_WARNINGS);
}

function latestAcceptedFoldRequestId(
  events: readonly TerminalDiagnosticsEvent[]
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.action === 'FOLD' && event.requestId !== null) return event.requestId;
  }
  return null;
}

/** Input view accepted by the contract/completeness derivations. */
export type TerminalDiagnosticsContractInput = Pick<
  TerminalDiagnosticsBundle,
  'identifiers' | 'collection' | 'jobStateRequested'
> &
  TerminalDiagnosticsSections;

/**
 * Derive the explicit contract from one assembled bundle. Pure and
 * independent of the persisted `contract` field, so a wrapper can re-derive
 * the verdict from saved evidence.
 */
export function deriveTerminalDiagnosticsContract(
  bundle: TerminalDiagnosticsContractInput
): TerminalDiagnosticsContract {
  const requestedHand = bundle.identifiers.handId !== null;
  const requestedCompetition = bundle.identifiers.competitionId !== null;
  const handPresent =
    requestedHand && (bundle.events.length > 0 || bundle.handHistory.exists || bundle.foldReceipt !== null);
  const expectedReceiptRequestId =
    bundle.identifiers.requestId ?? latestAcceptedFoldRequestId(bundle.events);
  const receiptPresent =
    bundle.foldReceipt !== null &&
    (expectedReceiptRequestId === null || bundle.foldReceipt.requestId === expectedReceiptRequestId);
  const jobTableId = bundle.table?.id ?? bundle.identifiers.tableId ?? null;
  const requiredAffectedJobs = bundle.jobStateRequested
    ? bundle.outbox.filter((row) =>
        isRequiredAffectedHandJobRow(row, jobTableId, bundle.identifiers.handId)
      )
    : [];
  const affectedHandJobs: TerminalDiagnosticsContract['affectedHandJobs'] = !bundle.jobStateRequested
    ? 'not-requested'
    : requiredAffectedJobs.some(
          (row) =>
            row.jobState === null ||
            row.jobState.state === 'unavailable' ||
            row.jobState.state === 'unknown'
        )
      ? 'missing'
      : 'present';
  const settlementReady: TerminalDiagnosticsContract['settlementReady'] =
    bundle.competition === null
      ? 'not-requested'
      : bundle.competition.settlementReady === null
        ? 'missing'
        : 'present';
  return {
    capture: bundle.collection.status === 'COMPLETE' ? 'complete' : 'failed',
    table: bundle.table !== null ? 'present' : 'missing',
    // Required public state fields; a table without authoritative state (or a
    // projection missing a required key) fails closed.
    snapshot: bundle.table?.state?.present === true ? 'present' : 'missing',
    hand: requestedHand ? (handPresent ? 'present' : 'missing') : 'not-requested',
    competition: requestedCompetition
      ? bundle.competition !== null
        ? 'present'
        : 'missing'
      : 'not-requested',
    tournament:
      bundle.tournament !== null
        ? 'present'
        : requestedCompetition || bundle.competition !== null
          ? 'missing'
          : 'not-requested',
    receipt:
      expectedReceiptRequestId !== null
        ? receiptPresent
          ? 'present'
          : 'missing'
        : bundle.foldReceipt !== null
          ? 'present'
          : 'not-requested',
    // Scoped to the exact requested hand's events only: a later hand's
    // HAND_COMPLETED can never satisfy this check.
    handCompleted: bundle.events.some((event) => event.type === 'HAND_COMPLETED')
      ? 'present'
      : 'absent',
    handHistory: bundle.handHistory.exists ? 'present' : 'absent',
    outbox: bundle.outbox.length > 0 ? 'present' : 'empty',
    nextHandStarted: requestedHand
      ? bundle.subsequentHandStarts.length > 0
        ? 'present'
        : 'absent'
      : 'not-requested',
    affectedHandJobs,
    settlementReady,
  };
}

// ---------------------------------------------------------------------------
// Authoritative terminal transition (anchor correlation, never a late action)
// ---------------------------------------------------------------------------

/**
 * Product/platform terminal authority from ALREADY SANITIZED evidence. Only the
 * exact authoritative markers count: the product room reached COMPLETE, the
 * platform table is CLOSED, the competition is FINISHED with the canonical
 * `settlementReady` predicate true, and the tournament/director progressed
 * terminally. A conflict observed while any of this is false is NOT benign.
 */
export interface TerminalRoomAuthority {
  roomStatus: string | null;
  tableStatus: string | null;
  competitionStatus: string | null;
  settlementReady: boolean | null;
  tournamentStatus: string | null;
}

export function isAuthoritativeTerminalRoom(input: TerminalRoomAuthority): boolean {
  return (
    input.roomStatus === 'COMPLETE' &&
    input.tableStatus === 'CLOSED' &&
    input.competitionStatus === 'FINISHED' &&
    input.settlementReady === true &&
    (input.tournamentStatus === 'FINISHED' || input.competitionStatus === 'FINISHED')
  );
}

/**
 * The hand that owns the authoritative terminal state: the LAST durable
 * HAND_COMPLETED event's hand. A later human action's stale/own hand reference
 * never overrides it, and no local poker semantics are inferred beyond the
 * platform's own committed HAND_COMPLETED event.
 */
export function terminalCompletedHandId(
  events: readonly TerminalDiagnosticsEvent[]
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'HAND_COMPLETED' && event.handId !== null) return event.handId;
  }
  return null;
}

export type TerminalTransitionEvidenceError =
  | 'capture-failed'
  | 'table-missing'
  | 'snapshot-missing'
  | 'hand-missing'
  | 'hand-completed-missing'
  | 'hand-history-missing'
  | 'outbox-empty'
  | 'job-state-unreadable'
  | 'competition-missing'
  | 'tournament-missing'
  | 'settlement-ready-missing'
  | 'settlement-not-ready'
  | 'competition-not-terminal'
  | 'financial-settlement-not-settled';

export interface TerminalTransitionEvidence {
  pass: boolean;
  reasons: TerminalTransitionEvidenceError[];
}

/**
 * Strict terminal-transition evidence over the COMPLETED-HAND bundle. This is
 * the additional gate used when a terminal room's latest human action was a
 * benign post-terminal rejection: the completed hand itself must carry the
 * durable HAND_COMPLETED / HandHistory / outbox / readable-job evidence, the
 * competition and tournament must be terminally settled, and a CHALLENGE ASSET
 * competition must carry a settled financial disposition (PAID/RELEASED). It
 * never replaces the existing per-identity completeness errors; both must pass.
 */
export function assessCompletedHandTerminalEvidence(
  bundle: TerminalDiagnosticsBundle
): TerminalTransitionEvidence {
  const contract = deriveTerminalDiagnosticsContract(bundle);
  const reasons: TerminalTransitionEvidenceError[] = [];
  if (contract.capture === 'failed') reasons.push('capture-failed');
  if (contract.table === 'missing') reasons.push('table-missing');
  if (contract.snapshot === 'missing') reasons.push('snapshot-missing');
  if (contract.hand === 'missing') reasons.push('hand-missing');
  if (contract.handCompleted !== 'present') reasons.push('hand-completed-missing');
  if (contract.handHistory !== 'present') reasons.push('hand-history-missing');
  if (contract.outbox !== 'present') reasons.push('outbox-empty');
  if (contract.affectedHandJobs === 'missing') reasons.push('job-state-unreadable');
  if (contract.competition === 'missing') reasons.push('competition-missing');
  if (contract.tournament === 'missing') reasons.push('tournament-missing');
  if (contract.settlementReady === 'missing') reasons.push('settlement-ready-missing');
  const competition = bundle.competition;
  if (competition === null || competition.settlementReady !== true) {
    reasons.push('settlement-not-ready');
  }
  if (
    competition !== null &&
    !(competition.status === 'FINISHED' || bundle.tournament?.status === 'FINISHED')
  ) {
    reasons.push('competition-not-terminal');
  }
  if (
    competition !== null &&
    competition.mode === 'ASSET' &&
    competition.prizeStatus !== 'PAID' &&
    competition.prizeStatus !== 'RELEASED'
  ) {
    reasons.push('financial-settlement-not-settled');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Evaluate the mandatory durable packet for one bundle. Required identities
 * (table/snapshot/hand/competition/tournament/receipt) that are missing produce
 * typed errors; valid outcome absence (no HAND_COMPLETED, no history, empty
 * outbox, no subsequent hand start) does not.
 */
export function terminalDiagnosticCompleteness(
  bundle: TerminalDiagnosticsBundle
): TerminalDiagnosticsCompleteness {
  const contract = deriveTerminalDiagnosticsContract(bundle);
  const errors: TerminalDiagnosticsCompletenessError[] = [];
  if (contract.capture === 'failed') errors.push('capture-failed');
  if (contract.table === 'missing') errors.push('table-missing');
  if (contract.table === 'present' && contract.snapshot === 'missing') errors.push('snapshot-missing');
  if (contract.competition === 'missing') errors.push('competition-missing');
  if (contract.tournament === 'missing') errors.push('tournament-missing');
  if (contract.settlementReady === 'missing') errors.push('settlement-ready-missing');
  if (contract.hand === 'missing') errors.push('hand-missing');
  if (contract.receipt === 'missing') errors.push('receipt-missing');
  if (contract.affectedHandJobs === 'missing') errors.push('job-state-unreadable');
  return { complete: errors.length === 0, errors, collectionErrors: errors.length };
}

/** Boolean wrapper convenience: true only for a complete durable packet. */
export function isTerminalDiagnosticComplete(bundle: TerminalDiagnosticsBundle): boolean {
  return terminalDiagnosticCompleteness(bundle).complete;
}

function emptySections(): TerminalDiagnosticsSections {
  return {
    table: null,
    events: [],
    subsequentHandStarts: [],
    foldReceipt: null,
    outbox: [],
    handHistory: { exists: false, id: null, timestamp: null },
    competition: null,
    tournament: null,
    entrants: [],
    reconciliation: null,
  };
}

function normalizeIdentifiers(
  raw: TerminalDiagnosticsIdentifiers | null | undefined,
  redact: Redact
): TerminalDiagnosticsBundle['identifiers'] {
  const normalized = (label: string): string | null => {
    const value = raw?.[label as keyof TerminalDiagnosticsIdentifiers];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return redact(trimmed).slice(0, MAX_IDENTIFIER_TEXT_LENGTH);
  };
  return {
    roomId: normalized('roomId'),
    tableId: normalized('tableId'),
    competitionId: normalized('competitionId'),
    handId: normalized('handId'),
    requestId: normalized('requestId'),
    turnId: normalized('turnId'),
  };
}

function collectionDetail(
  kind: string,
  error: unknown,
  options: TerminalDiagnosticsSanitizeOptions
): string {
  if (error === null || error === undefined) return `${kind}: <no error detail>`;
  const detail = sanitizeDiagnosticError(error instanceof Error ? error.message : error, options);
  return detail === null ? `${kind}: <no error detail>` : `${kind}: ${detail}`;
}

/** Attach the explicit per-identity/outcome contract to one assembled bundle. */
function finalizeBundle(
  core: Omit<TerminalDiagnosticsBundle, 'contract'>
): TerminalDiagnosticsBundle {
  return { ...core, contract: deriveTerminalDiagnosticsContract(core) };
}

/**
 * Capture one sanitized durable diagnostic bundle.
 *
 * Read-only and failure-tolerant: the injected `query` is the only operator
 * interaction, and ANY error (invalid identifiers, query failure, empty output,
 * unparseable JSON, unexpected shape) is recorded in
 * `collection.status === 'FAILED'` with a sanitized reason. This function never
 * throws, so calling it from a failure path cannot mask the original failure.
 */
export async function collectTerminalDiagnostics(
  input: TerminalDiagnosticsInput
): Promise<TerminalDiagnosticsBundle> {
  const options: TerminalDiagnosticsSanitizeOptions = {
    knownSecrets: input?.knownSecrets,
    redactText: input?.redactText,
    registry: input?.registry,
  };
  const redact = resolveRedact(options);
  const identifiers = normalizeIdentifiers(input?.identifiers, redact);
  const collectedAt = (input?.now ?? (() => new Date()))().toISOString();
  const metrics = sanitizeDiagnosticInput(input?.metrics, options);
  const apiLogWarning = sanitizeDiagnosticInput(input?.apiLogWarning, options);
  const jobStateRequested = typeof input?.readJobState === 'function';
  const failed = (error: string): TerminalDiagnosticsBundle => {
    const sections = emptySections();
    return finalizeBundle({
      version: TERMINAL_DIAGNOSTICS_BUNDLE_VERSION,
      collectedAt,
      identifiers,
      collection: { status: 'FAILED', error },
      jobStateRequested,
      ...sections,
      metrics,
      apiLogWarning,
      warnings: deriveTerminalDiagnosticsWarnings({
        identifiers,
        sections,
        metrics,
        apiLogWarning,
        collectionComplete: false,
      }),
    });
  };

  try {
    const sql = terminalDiagnosticsSql(input?.identifiers ?? {}, {
      maxEvents: input?.maxEvents,
      maxOutboxRows: input?.maxOutboxRows,
    });
    const output = (await input.query(sql)).trim();
    if (output === '') {
      return failed('operator terminal diagnostic query returned no row');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return failed('operator terminal diagnostic output is not parseable JSON');
    }
    if (!isRecord(parsed)) {
      return failed('operator terminal diagnostic output has an unexpected shape');
    }
    const sections = sanitizeTerminalDiagnosticsSections(parsed, options);
    await attachOutboxJobStates(sections, input, options);
    return finalizeBundle({
      version: TERMINAL_DIAGNOSTICS_BUNDLE_VERSION,
      collectedAt,
      identifiers,
      collection: { status: 'COMPLETE', error: null },
      jobStateRequested,
      ...sections,
      metrics,
      apiLogWarning,
      warnings: deriveTerminalDiagnosticsWarnings({ identifiers, sections, metrics, apiLogWarning }),
    });
  } catch (error) {
    if (error instanceof TerminalDiagnosticsInputError) {
      return failed('invalid terminal diagnostic identifiers');
    }
    return failed(collectionDetail('terminal diagnostics collection failed', error, options));
  }
}

/**
 * Fill in the read-only BullMQ projection for unresolved outbox rows.
 *
 * Selection and priority (bounded by `maxJobStateReads`):
 * - `pubsub` is NOT a BullMQ kind and is never probed (no wasted read budget,
 *   no misleading `missing` warning);
 * - COMPLETED rows are never probed: completion plus hand history already
 *   prove the worker processed them;
 * - affected-hand archive/next/settle rows come first, then every other
 *   unresolved row, newest first, so the blocking last-hand failure is always
 *   classified within the budget.
 *
 * Failure-tolerant: a throwing callback marks that row `unavailable`; a `null`
 * projection marks it `missing` (legitimate captured evidence); rows beyond
 * the budget keep `jobState: null`. All outbox rows are retained unchanged.
 */
async function attachOutboxJobStates(
  sections: TerminalDiagnosticsSections,
  input: TerminalDiagnosticsInput,
  options: TerminalDiagnosticsSanitizeOptions
): Promise<void> {
  const readJobState = input?.readJobState;
  if (typeof readJobState !== 'function') return;
  const limit = boundedLimit(input?.maxJobStateReads, DEFAULT_MAX_JOB_STATE_READS, MAX_MAX_JOB_STATE_READS);
  const tableId = sections.table?.id ?? input?.identifiers?.tableId ?? null;
  const handId = input?.identifiers?.handId ?? null;
  const candidates = prioritizedOutboxRows(sections.outbox, tableId, handId).filter(
    (row) => row.status !== 'COMPLETED' && row.kind !== 'pubsub'
  );
  for (const row of candidates.slice(0, limit)) {
    try {
      const raw = await readJobState({
        tableId: tableId ?? '',
        outboxId: row.id,
        kind: row.kind,
        dedupeKey: row.dedupeKey,
      });
      row.jobState = sanitizeOutboxJobState(raw, options);
    } catch {
      row.jobState = {
        state: 'unavailable',
        exists: null,
        attemptsMade: null,
        failedReason: null,
        processedOn: null,
        finishedOn: null,
      };
    }
  }
}

import { execFile as finiteDiagnosticExec } from 'node:child_process';
import { promisify as finiteDiagnosticPromisify } from 'node:util';
/**
 * Live-failure packet: one sanitized, read-only orchestration capture for a
 * live run that is about to abort.
 *
 * A wrapper's `catch`/`finally` calls {@link collectLiveFailurePacket} BEFORE
 * any teardown (`runtime.stop()`, `topology.stop()`, PostgreSQL/Redis removal).
 * The packet is the retained, allowlisted fact set: after it is persisted a
 * future wrapper may remove the raw captured `*.sqlite*` files once the
 * runtime has stopped and outcome stats were read. The packet is the only
 * artifact that may outlive the disposable topology; historical artifacts and
 * markers are never touched by this module.
 *
 * Collection steps (every step read-only, bounded and failure-tolerant):
 * 1. Product metadata from the product's own SQLite store with an explicit
 *    column whitelist (room/competition/table + decisions + provider attempts).
 *    `observation_json`, `source_json`, `response_json`,
 *    `request_metadata_json` and whole `request_json`/`receipt_json` rows are
 *    never selected; only `json_extract` scalars (requestId/actionId/version/
 *    eventSeq) and enum-classified errors survive. Unknown free-text errors are
 *    omitted, never emitted.
 * 2. An initial {@link collectTerminalDiagnostics} query over the discovered
 *    table/competition reads the ordered events and the latest accepted FOLD
 *    identifiers; when an exact human action identity exists (browser relay,
 *    else the latest non-agent persisted decision — including a rejected,
 *    uncommitted request) or a latest accepted FOLD exists, a second SCOPED
 *    capture re-reads the exact hand/request before finishing. When the exact
 *    request event carries a hand and the provided hand contradicts it, the
 *    identity check fails (`identityMismatch`, topology retained) instead of
 *    silently substituting either hand. An inferred accepted FOLD is always
 *    labeled (`identitySource`, `inferredFoldRequestId`), never silently
 *    substituted for a supplied or persisted human request.
 * 3. Actual BullMQ job state for the scoped outbox rows through targeted
 *    `redis-cli` over `docker exec`: `HGET <key> failedReason|attemptsMade|
 *    processedOn|finishedOn` plus queue sorted-set/list membership. The raw job
 *    hash `data` (private engine snapshot) is never read; no HGETALL, no GET.
 * 4. Reconcile metrics (numeric family only) from the platform `/metrics`
 *    surface and exact known API warning records parsed from `docker logs`
 *    (`known warn message` + validated `tableId` only, never a raw log line).
 *
 * Rejected/uncommitted human action evidence: the packet stores the exact
 * decision row (status, request/receipt ids, attempt states) for the supplied
 * or derived request id, or `decisionRowAbsent: true` when no row was
 * persisted, plus `foldReceiptAbsent` (the operator foldReceipt JOIN only
 * matches a committed FOLD event, so an uncommitted fold yields no receipt).
 * That absence is case-1 evidence, never a fabricated receipt.
 *
 * Verdict: `complete` requires the packet to be persisted, the product room
 * metadata to be present, every diagnostics capture to have run and
 * `isTerminalDiagnosticComplete` to hold for the authoritative bundle.
 * `retainTopology` is true whenever `complete` is false (the caller must keep
 * the runtime/PostgreSQL for operator recovery). An uncommitted human FOLD with
 * an absent receipt is classified `committed: false` with an explicit
 * `receipt-absent` basis when the capture completed; a failed capture is
 * `committed: null` (`capture-incomplete`) and never invents a verdict.
 *
 * Raw artifact disposition: paid wrappers place the product SQLite from the
 * start in the dedicated {@link privateProductDataDirectory} child of the
 * protected topology runtimeDir (mode 0700, outside captured artifacts); the
 * standalone container mounts ONLY that child, never the runtimeDir root with
 * its platform secret env files. Before any delete/teardown the runtime
 * container must be PROVEN stopped via {@link proveContainerStopped}; an
 * unproven/still-alive runtime retains the topology and the private DB (no
 * delete/move of an active database). The legacy
 * {@link cleanupDisposableSqliteArtifacts} / {@link relocateDisposableSqliteArtifacts}
 * helpers remain for explicitly supplied fresh artifact-root fallbacks only and
 * are never applied to the private runtime DB.
 *
 * This module makes no paid calls, no source mutations and never throws.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { AdminDatabaseTarget } from '../infra/admin.js';
import { redactSecretText } from '../infra/env-boundary.js';
import { buildChildEnv } from '../infra/env-boundary.js';
import { runCommand } from '../infra/proc.js';
import type { RunContext } from '../infra/context.js';
import {
  collectTerminalDiagnostics,
  isTerminalDiagnosticComplete,
  terminalDiagnosticsQuery,
  type TerminalDiagnosticsBundle,
  type TerminalDiagnosticsIdentifiers,
  type TerminalDiagnosticsJobStateName,
  type TerminalDiagnosticsSqlQuery,
} from './terminal-diagnostics.js';

/** Packet schema version; bump only for an incompatible field change. */
export const LIVE_FAILURE_PACKET_VERSION = 1;

/** Packet kind marker for consumers that bind a retained failure artifact. */
export const LIVE_FAILURE_PACKET_KIND = 'nlhe-live-failure-packet';

/** BullMQ default key prefix used by the pinned PokerTools 2.0.3 platform. */
export const DEFAULT_QUEUE_PREFIX = 'bull';

/** Outbox kinds that are actually dispatched to one BullMQ queue each. */
const QUEUED_OUTBOX_KINDS = Object.freeze([
  'settle-hand',
  'archive-hand',
  'next-hand',
  'player-timeout',
, 'tournament-reconcile']);

const DURABLE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const QUEUE_PREFIX_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TABLE_ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PACKET_REASON = 400;
const MAX_PACKET_STRING = 256;
const MAX_METADATA_DECISIONS = 500;
const MAX_METADATA_ATTEMPTS = 1000;
const MAX_RECONCILE_FAMILIES = 64;
const MAX_API_WARNING_RECORDS = 32;
const MAX_API_LOG_CHARS = 4 * 1024 * 1024;
const MAX_REDIS_FAILED_REASON = 400;
const REDIS_EXEC_TIMEOUT_MS = 20_000;

/** Durable platform error codes this packet may carry VERBATIM. */
export const KNOWN_FAILURE_ERROR_CODES: readonly string[] = Object.freeze([
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

/**
 * Exact pinned PokerTools 2.0.3 API warning messages that are table-scoped.
 * Only a record whose `msg` is one of these AND whose `tableId` is a plain
 * durable identifier is projected; the raw log line is never copied.
 */
export const KNOWN_API_WARNING_MESSAGES: readonly string[] = Object.freeze([
  'Tournament reconciliation deferred after accepted action',
  'Invalid table pub/sub message',
  'Cannot merge player to final table: no open seat available',
  'Cannot consolidate player: no open seat on destination table',
  'Cannot break short table: no open seat on target table',
  'Cannot rebalance: no open seat on min table',
  'Reconciliation iteration limit reached; deferring remaining work to next reconcile call',
]);

const DEFAULT_REDACT = (text: string): string => redactSecretText(text);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeNote(text: unknown, redact: (text: string) => string, max = MAX_PACKET_REASON): string | null {
  if (typeof text !== 'string') return null;
  const bounded = text.length > max ? text.slice(0, max) : text;
  const cleaned = redact(bounded).replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned.slice(0, max);
}

// ---------------------------------------------------------------------------
// Enum-classified errors (unknown free text is omitted)
// ---------------------------------------------------------------------------

/**
 * Map one free-text error onto a bounded category. Registry-known durable codes
 * are retained exactly; common transport/product shapes map onto a fixed enum;
 * anything else is `null` (omitted), never echoed.
 */
export function classifyFailureErrorCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (KNOWN_FAILURE_ERROR_CODES.includes(text)) return text;
  if (/(?:^|\D)429(?:\D|$)|rate[ _-]?limit/i.test(text)) return 'RATE_LIMITED';
  if (/timeout|timed out|etimedout|abort/i.test(text)) return 'TIMEOUT';
  if (/stale|superseded|conflict|version mismatch/i.test(text)) return 'STALE';
  if (/(?:^|\D)(?:401|403)(?:\D|$)|unauthori[sz]ed|forbidden/i.test(text)) return 'AUTH';
  if (/(?:^|\D)5\d\d(?:\D|$)|econn|socket hang up|fetch failed|bad gateway|service unavailable/i.test(text)) {
    return 'TRANSPORT';
  }
  if (/table.?closed|not open for play|not_actionable|terminal race/i.test(text)) return 'TERMINAL_RACE';
  if (/invalid|malformed|parse|schema|unexpected/i.test(text)) return 'MALFORMED';
  if (/provider|completion|model call/i.test(text)) return 'PROVIDER';
  return null;
}

// ---------------------------------------------------------------------------
// Product SQLite metadata projection (read-only SELECT whitelist)
// ---------------------------------------------------------------------------

type FailureFieldType = 'string' | 'integer' | 'error';

interface FailureFieldSpec {
  source: string;
  target: string;
  type: FailureFieldType;
  required?: boolean;
}

/** Room columns selected from `product_rooms` (nothing raw, nothing policy). */
export const PRODUCT_ROOM_SELECT_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'status',
  'policy_kind',
  'table_id',
  'platform_competition_id',
  'failure_reason',
  'created_at',
  'updated_at',
]);

/** Decision columns selected from `product_decisions` (payloads via json_extract only). */
export const PRODUCT_DECISION_SELECT_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'table_id',
  'turn_id',
  'principal_id',
  'status',
  'prompt_policy_id',
  'event_cursor',
  'attempt_count',
  'request_id',
  'action_id',
  'expected_version',
  'receipt_request_id',
  'receipt_action_id',
  'receipt_version',
  'receipt_event_seq',
  'error_reason',
  'created_at',
  'updated_at',
]);

/** Attempt columns selected from `product_model_attempts` (no payload bodies). */
export const PRODUCT_ATTEMPT_SELECT_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'decision_id',
  'attempt_no',
  'status',
  'model',
  'provider',
  'prompt_policy_id',
  'prompt_tokens',
  'completion_tokens',
  'cost_micro_usd',
  'latency_ms',
  'error',
  'created_at',
  'recorded_at',
]);

const ROOM_FIELDS: readonly FailureFieldSpec[] = Object.freeze([
  { source: 'id', target: 'id', type: 'string', required: true },
  { source: 'status', target: 'status', type: 'string', required: true },
  { source: 'policy_kind', target: 'policyKind', type: 'string' },
  { source: 'table_id', target: 'tableId', type: 'string' },
  { source: 'platform_competition_id', target: 'competitionId', type: 'string' },
  { source: 'failure_reason', target: 'failureCategory', type: 'error' },
  { source: 'created_at', target: 'createdAt', type: 'integer' },
  { source: 'updated_at', target: 'updatedAt', type: 'integer' },
]);

const DECISION_FIELDS: readonly FailureFieldSpec[] = Object.freeze([
  { source: 'id', target: 'id', type: 'string', required: true },
  { source: 'table_id', target: 'tableId', type: 'string', required: true },
  { source: 'turn_id', target: 'turnId', type: 'string', required: true },
  { source: 'principal_id', target: 'principalId', type: 'string', required: true },
  { source: 'status', target: 'status', type: 'string', required: true },
  { source: 'prompt_policy_id', target: 'promptPolicyId', type: 'string' },
  { source: 'event_cursor', target: 'eventCursor', type: 'integer' },
  { source: 'attempt_count', target: 'attemptCount', type: 'integer' },
  { source: 'request_id', target: 'requestId', type: 'string' },
  { source: 'action_id', target: 'actionId', type: 'string' },
  { source: 'expected_version', target: 'expectedVersion', type: 'integer' },
  { source: 'receipt_request_id', target: 'receiptRequestId', type: 'string' },
  { source: 'receipt_action_id', target: 'receiptActionId', type: 'string' },
  { source: 'receipt_version', target: 'receiptVersion', type: 'integer' },
  { source: 'receipt_event_seq', target: 'receiptEventSeq', type: 'integer' },
  { source: 'error_reason', target: 'errorCategory', type: 'error' },
  { source: 'created_at', target: 'createdAt', type: 'integer' },
  { source: 'updated_at', target: 'updatedAt', type: 'integer' },
]);

const ATTEMPT_FIELDS: readonly FailureFieldSpec[] = Object.freeze([
  { source: 'id', target: 'id', type: 'string', required: true },
  { source: 'decision_id', target: 'decisionId', type: 'string', required: true },
  { source: 'attempt_no', target: 'attemptNo', type: 'integer', required: true },
  { source: 'status', target: 'status', type: 'string', required: true },
  { source: 'model', target: 'model', type: 'string' },
  { source: 'provider', target: 'provider', type: 'string' },
  { source: 'prompt_policy_id', target: 'promptPolicyId', type: 'string' },
  { source: 'prompt_tokens', target: 'promptTokens', type: 'integer' },
  { source: 'completion_tokens', target: 'completionTokens', type: 'integer' },
  { source: 'cost_micro_usd', target: 'costMicroUsd', type: 'integer' },
  { source: 'latency_ms', target: 'latencyMs', type: 'integer' },
  { source: 'error', target: 'errorCategory', type: 'error' },
  { source: 'created_at', target: 'createdAt', type: 'integer' },
  { source: 'recorded_at', target: 'recordedAt', type: 'integer' },
]);

export type FailureMetadataRowKind = 'room' | 'decision' | 'attempt';

function fieldSpecs(kind: FailureMetadataRowKind): readonly FailureFieldSpec[] {
  return kind === 'room' ? ROOM_FIELDS : kind === 'decision' ? DECISION_FIELDS : ATTEMPT_FIELDS;
}

/**
 * Allowlist projection for one raw SQLite row. Only the per-kind scalar specs
 * survive: strings are redacted and bounded, integers must be safe integers,
 * errors are enum-classified. Nested objects/arrays (including any private
 * cards/deck/snapshot or credential smuggled into the raw record) are dropped
 * by construction because no spec ever copies them.
 */
export function projectFailureMetadata(
  kind: FailureMetadataRowKind,
  raw: unknown,
  options: { redactText?: (text: string) => string } = {}
): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const redact = options.redactText ?? DEFAULT_REDACT;
  const out: Record<string, unknown> = {};
  for (const spec of fieldSpecs(kind)) {
    const value = source[spec.source];
    if (value === null || value === undefined) {
      if (spec.required) return null;
      out[spec.target] = null;
      continue;
    }
    if (spec.type === 'integer') {
      const integer =
        typeof value === 'number' && Number.isSafeInteger(value)
          ? value
          : typeof value === 'string' && /^-?\d{1,15}$/.test(value)
            ? Number(value)
            : null;
      if (integer === null) {
        if (spec.required) return null;
        out[spec.target] = null;
        continue;
      }
      out[spec.target] = integer;
      continue;
    }
    if (typeof value !== 'string') {
      if (spec.required) return null;
      out[spec.target] = null;
      continue;
    }
    if (spec.type === 'error') {
      out[spec.target] = classifyFailureErrorCategory(value);
      continue;
    }
    const text = redact(value.trim()).slice(0, MAX_PACKET_STRING);
    if (text === '') {
      if (spec.required) return null;
      out[spec.target] = null;
      continue;
    }
    out[spec.target] = text;
  }
  return out;
}

function boundedLimit(limit: number, maximum: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(maximum, Math.floor(limit))) : maximum;
}

/** Read-only projection SQL for product decisions (payloads via json_extract only). */
export function productDecisionSelectSql(limit: number): string {
  return `SELECT
  id, table_id, turn_id, principal_id, status, prompt_policy_id, event_cursor, attempt_count,
  CASE WHEN json_valid(request_json) THEN json_extract(request_json, '$.requestId') END AS request_id,
  CASE WHEN json_valid(request_json) THEN json_extract(request_json, '$.actionId') END AS action_id,
  CASE WHEN json_valid(request_json) THEN json_extract(request_json, '$.expectedVersion') END AS expected_version,
  CASE WHEN json_valid(receipt_json) THEN json_extract(receipt_json, '$.requestId') END AS receipt_request_id,
  CASE WHEN json_valid(receipt_json) THEN json_extract(receipt_json, '$.actionId') END AS receipt_action_id,
  CASE WHEN json_valid(receipt_json) THEN json_extract(receipt_json, '$.version') END AS receipt_version,
  CASE WHEN json_valid(receipt_json) THEN json_extract(receipt_json, '$.eventSeq') END AS receipt_event_seq,
  error_reason, created_at, updated_at
FROM product_decisions
WHERE room_id = ?
ORDER BY created_at DESC, id DESC
LIMIT ${boundedLimit(limit, MAX_METADATA_DECISIONS)}`;
}

export function productAttemptSelectSql(placeholders: number, limit: number): string {
  const slots = boundedLimit(placeholders, MAX_METADATA_DECISIONS);
  return `SELECT
  id, decision_id, attempt_no, status, model, provider, prompt_policy_id,
  prompt_tokens, completion_tokens, cost_micro_usd, latency_ms, error, created_at, recorded_at
FROM product_model_attempts
WHERE decision_id IN (${Array.from({ length: slots }, () => '?').join(',')})
ORDER BY decision_id, attempt_no
LIMIT ${boundedLimit(limit, MAX_METADATA_ATTEMPTS)}`;
}

export interface ProductFailureMetadata {
  discovery: 'explicit' | 'active' | 'latest' | 'none';
  room: Record<string, unknown> | null;
  decisions: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  truncated: boolean;
}

/**
 * Read the product failure metadata with a read-only SQLite connection. Never
 * throws: an unreadable store resolves to `discovery: 'none'`.
 */
export function readProductFailureMetadata(
  productDatabasePath: string,
  options: {
    roomId?: string | null;
    redactText?: (text: string) => string;
    maxDecisions?: number;
    maxAttempts?: number;
  } = {}
): ProductFailureMetadata {
  const empty: ProductFailureMetadata = {
    discovery: 'none',
    room: null,
    decisions: [],
    attempts: [],
    truncated: false,
  };
  try {
    const db = new Database(productDatabasePath, { readonly: true, fileMustExist: true });
    try {
      const roomColumns = PRODUCT_ROOM_SELECT_COLUMNS.join(', ');
      const explicit =
        typeof options.roomId === 'string' && options.roomId.trim() !== '' ? options.roomId.trim() : null;
      let discovery: ProductFailureMetadata['discovery'] = 'none';
      let roomRow: Record<string, unknown> | undefined;
      if (explicit !== null) {
        roomRow = db.prepare(`SELECT ${roomColumns} FROM product_rooms WHERE id = ? LIMIT 1`).get(explicit) as
          | Record<string, unknown>
          | undefined;
        if (roomRow !== undefined) discovery = 'explicit';
      }
      if (roomRow === undefined) {
        roomRow = db
          .prepare(
            `SELECT ${roomColumns} FROM product_rooms WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`
          )
          .get() as Record<string, unknown> | undefined;
        if (roomRow !== undefined) discovery = 'active';
      }
      if (roomRow === undefined) {
        roomRow = db
          .prepare(`SELECT ${roomColumns} FROM product_rooms ORDER BY updated_at DESC LIMIT 1`)
          .get() as Record<string, unknown> | undefined;
        if (roomRow !== undefined) discovery = 'latest';
      }
      const room = roomRow === undefined ? null : projectFailureMetadata('room', roomRow, options);
      if (room === null || typeof room.id !== 'string') return empty;

      const roomTotal = Number(
        (db.prepare('SELECT count(*) AS total FROM product_decisions WHERE room_id = ?').get(room.id) as
          | { total?: unknown }
          | undefined)?.total ?? 0
      );
      const maxDecisions = boundedLimit(options.maxDecisions ?? MAX_METADATA_DECISIONS, MAX_METADATA_DECISIONS);
      const decisionRows = db
        .prepare(productDecisionSelectSql(maxDecisions))
        .all(room.id) as Array<Record<string, unknown>>;
      const decisions: Array<Record<string, unknown>> = [];
      for (const row of decisionRows) {
        const projected = projectFailureMetadata('decision', row, options);
        if (projected !== null) decisions.push(projected);
      }
      // Chronological order for a stable retained packet.
      decisions.reverse();

      const attempts: Array<Record<string, unknown>> = [];
      let attemptsTruncated = false;
      if (decisions.length > 0) {
        const ids = decisions.map((decision) => String(decision.id));
        const maxAttempts = boundedLimit(options.maxAttempts ?? MAX_METADATA_ATTEMPTS, MAX_METADATA_ATTEMPTS);
        const attemptRows = db
          .prepare(productAttemptSelectSql(ids.length, maxAttempts))
          .all(...ids) as Array<Record<string, unknown>>;
        attemptsTruncated = attemptRows.length >= maxAttempts;
        for (const row of attemptRows) {
          const projected = projectFailureMetadata('attempt', row, options);
          if (projected !== null) attempts.push(projected);
        }
      }
      return {
        discovery,
        room,
        decisions,
        attempts,
        truncated:
          (Number.isSafeInteger(roomTotal) && roomTotal > decisions.length) || attemptsTruncated,
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// BullMQ job state (targeted redis-cli, no raw job data)
// ---------------------------------------------------------------------------

/** Read-only redis-cli executor; injectable for focused tests. */
export interface RedisCliExecutor {
  /** Runs inline commands; returns exactly one reply line per command. */
  pipeline(commands: readonly string[]): Promise<string[]>;
  /** Runs one command; returns its raw reply text. */
  command(command: string): Promise<string>;
}

export interface JobStateReadInput {
  tableId: string;
  outboxId: string;
  kind: string;
  dedupeKey: string;
}

export interface BullMqJobProbe {
  outboxId: string;
  kind: string;
  queue: string | null;
  state: TerminalDiagnosticsJobStateName;
  exists: boolean | null;
  membership: string[];
  attemptsMade: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  /** Enum-classified/known-code only; unknown free text is omitted. */
  failedReason: string | null;
}

/** Membership probe order; matches one BullMQ queue structure per entry. */
export const BULLMQ_MEMBERSHIP_PROBES: readonly { key: string; structure: 'zset' | 'list' }[] = Object.freeze([
  { key: 'completed', structure: 'zset' },
  { key: 'failed', structure: 'zset' },
  { key: 'delayed', structure: 'zset' },
  { key: 'active', structure: 'list' },
  { key: 'prioritized', structure: 'zset' },
  { key: 'waiting-children', structure: 'zset' },
  { key: 'wait', structure: 'list' },
  { key: 'paused', structure: 'list' },
]);

/** Membership precedence used to derive the actual job state. */
const BULLMQ_STATE_PRECEDENCE: readonly TerminalDiagnosticsJobStateName[] = Object.freeze([
  'completed',
  'failed',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
  'waiting',
]);

function parseIntegerReply(reply: unknown): number | null {
  if (typeof reply !== 'string') return null;
  const trimmed = reply.trim();
  return /^-?\d{1,15}$/.test(trimmed) ? Number(trimmed) : null;
}

function membershipPresent(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed === '') return false;
  if (/^\(error\)/i.test(trimmed) || /^(?:ERR|WRONGTYPE)/.test(trimmed)) return false;
  return true;
}

/**
 * Pure parser for the fixed membership pipeline replies. The replies are, in
 * order: `EXISTS`, `HGET attemptsMade`, `HGET processedOn`, `HGET finishedOn`,
 * then {@link BULLMQ_MEMBERSHIP_PROBES}. No job `data` reply is ever part of
 * this contract.
 */
export function parseBullMqJobProbe(
  replies: readonly string[]
): Pick<BullMqJobProbe, 'state' | 'exists' | 'membership' | 'attemptsMade' | 'processedOn' | 'finishedOn'> {
  const expected = 4 + BULLMQ_MEMBERSHIP_PROBES.length;
  if (replies.length !== expected) throw new Error('BullMQ job probe reply count mismatch');
  const hashExists = replies[0]!.trim() === '1';
  const attemptsMade = parseIntegerReply(replies[1]);
  const processedOn = parseIntegerReply(replies[2]);
  const finishedOn = parseIntegerReply(replies[3]);
  const membership: string[] = [];
  for (let index = 0; index < BULLMQ_MEMBERSHIP_PROBES.length; index += 1) {
    const probe = BULLMQ_MEMBERSHIP_PROBES[index]!;
    if (membershipPresent(replies[4 + index]!)) membership.push(probe.key);
  }
  const matched = BULLMQ_STATE_PRECEDENCE.find((candidate) =>
    membership.includes(candidate === 'waiting' ? 'wait' : candidate)
  );
  const state: TerminalDiagnosticsJobStateName =
    matched ?? (hashExists ? 'unknown' : 'missing');
  return {
    state,
    exists: hashExists || membership.length > 0,
    membership,
    attemptsMade,
    processedOn,
    finishedOn,
  };
}

/** Default executor: one `docker exec -i <container> redis-cli --raw` process. */
export function dockerRedisCliExecutor(redisContainer: string): RedisCliExecutor {
  const run = (commands: readonly string[]): Promise<string> =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('docker', ['exec', '-i', redisContainer, 'redis-cli', '--raw'], {
        env: buildChildEnv({ purpose: 'platform', declared: {} }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, REDIS_EXEC_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          rejectPromise(new Error(`redis-cli exec exited ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolvePromise(stdout);
      });
      child.stdin.end(`${commands.join('\n')}\n`);
    });

  return {
    pipeline: async (commands) => {
      const stdout = await run(commands);
      const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
      if (lines.length !== commands.length) throw new Error('redis-cli reply count mismatch');
      return lines;
    },
    command: async (command) => (await run([command])).trim(),
  };
}

export interface BullMqJobStateReader {
  /** Same shape expected by `collectTerminalDiagnostics.readJobState`. */
  readJobState: (input: JobStateReadInput) => Promise<Record<string, unknown>>;
  /** Sanitized probes accumulated in read order (packet evidence). */
  probes: BullMqJobProbe[];
}

/**
 * Read-only BullMQ projection. Every probe is exactly:
 *   HGET <prefix>:<queue>:<jobId> attemptsMade|processedOn|finishedOn|failedReason
 * plus sorted-set/list membership on the queue's state structures. The job hash
 * `data` field (which can carry a private engine snapshot) is never requested.
 */
export function createBullMqJobStateReader(options: {
  redisContainer: string;
  queuePrefix?: string;
  executor?: RedisCliExecutor;
}): BullMqJobStateReader {
  const prefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
  const executor = options.executor ?? dockerRedisCliExecutor(options.redisContainer);
  const probes: BullMqJobProbe[] = [];

  return {
    probes,
    readJobState: async (input) => {
      const base: BullMqJobProbe = {
        outboxId: input.outboxId,
        kind: input.kind,
        queue: null,
        state: 'unavailable',
        exists: null,
        membership: [],
        attemptsMade: null,
        processedOn: null,
        finishedOn: null,
        failedReason: null,
      };
      if (
        options.redisContainer.trim() === '' ||
        !QUEUE_PREFIX_RE.test(prefix) ||
        !DURABLE_IDENTIFIER_RE.test(input.outboxId)
      ) {
        probes.push(base);
        return { state: 'unavailable', exists: null };
      }
      if (input.kind === 'pubsub' || !QUEUED_OUTBOX_KINDS.includes(input.kind)) {
        // pubsub is published directly; unknown kinds have no queue contract.
        base.state = 'missing';
        base.exists = false;
        probes.push(base);
        return { state: 'missing', exists: false };
      }
      // Real Redis probes use one read-only JSON reply; empty HGET values
      // cannot truncate or shift the positional interactive redis-cli output.
      if (!options.executor) {
        const lua = `local q=ARGV[1]; local id=ARGV[2]; local h=q..':'..id;
local st='unknown'; local exists=redis.call('EXISTS',h);
if exists==0 then st='missing' else
 for _,p in ipairs({{'completed','zset'},{'failed','zset'},{'active','list'},{'delayed','zset'},{'wait','list'},{'paused','list'},{'waiting-children','zset'}}) do
 local v; if p[2]=='zset' then v=redis.call('ZSCORE',q..':'..p[1],id) else v=redis.call('LPOS',q..':'..p[1],id) end;
 if v then st=p[1]; if st=='wait' or st=='paused' then st='waiting' end; break end; end; end;
local function num(k) local v=redis.call('HGET',h,k); return v and tonumber(v) or cjson.null end;
return cjson.encode({state=st,exists=exists==1,attemptsMade=num('attemptsMade'),processedOn=num('processedOn'),finishedOn=num('finishedOn')})`;
        try {
          const { stdout } = await finiteDiagnosticPromisify(finiteDiagnosticExec)('docker',
            ['exec', options.redisContainer, 'redis-cli', '--raw', 'EVAL', lua, '0', `${prefix}:${input.kind}`, input.outboxId],
            { timeout: 5_000, maxBuffer: 16_384 });
          const projected = JSON.parse(stdout) as { state: BullMqJobProbe['state']; exists: boolean; attemptsMade: number | null; processedOn: number | null; finishedOn: number | null };
          Object.assign(base, projected, { queue: input.kind });
          probes.push({ ...base });
          return { state: base.state, exists: base.exists, attemptsMade: base.attemptsMade,
            processedOn: base.processedOn, finishedOn: base.finishedOn, failedReason: null };
        } catch {
          probes.push({ ...base });
          return { state: 'unavailable', exists: null };
        }
      }
      const queue = input.kind;
      const hashKey = `${prefix}:${queue}:${input.outboxId}`;
      const queueKey = `${prefix}:${queue}`;
      const commands = [
        `EXISTS ${hashKey}`,
        `HGET ${hashKey} attemptsMade`,
        `HGET ${hashKey} processedOn`,
        `HGET ${hashKey} finishedOn`,
        ...BULLMQ_MEMBERSHIP_PROBES.map((probe) =>
          probe.structure === 'zset'
            ? `ZSCORE ${queueKey}:${probe.key} ${input.outboxId}`
            : `LPOS ${queueKey}:${probe.key} ${input.outboxId}`
        ),
      ];
      try {
        const replies = await executor.pipeline(commands);
        const parsed = parseBullMqJobProbe(replies);
        let failedReason: string | null = null;
        if (parsed.state === 'failed') {
          failedReason = classifyFailureErrorCategory(
            (await executor.command(`HGET ${hashKey} failedReason`)).slice(0, MAX_REDIS_FAILED_REASON)
          );
        }
        Object.assign(base, parsed, { queue, failedReason });
        probes.push({ ...base });
        return {
          state: base.state,
          exists: base.exists,
          attemptsMade: base.attemptsMade,
          failedReason: base.failedReason,
          processedOn: base.processedOn,
          finishedOn: base.finishedOn,
        };
      } catch {
        probes.push(base);
        return { state: 'unavailable', exists: null };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Platform /metrics reconcile family and API warning records
// ---------------------------------------------------------------------------

export interface ReconcileMetricFamily {
  family: string;
  value: number;
  samples: number;
}

/**
 * Parse the platform Prometheus text into numeric reconcile families only.
 * Labels are dropped by construction (only the validated family name and the
 * summed finite integer value survive).
 */
export function parseReconcileMetrics(metricsText: string): ReconcileMetricFamily[] {
  if (typeof metricsText !== 'string') return [];
  const byFamily = new Map<string, ReconcileMetricFamily>();
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('#')) continue;
    const sample =
      /^(pokertools_[A-Za-z0-9_]*reconcile[A-Za-z0-9_]*)(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.exec(
        line.trim()
      );
    if (sample === null) continue;
    const family = sample[1]!;
    const value = Number(sample[2]);
    if (!Number.isFinite(value) || family.length > 128) continue;
    const existing = byFamily.get(family);
    if (existing) {
      existing.value += value;
      existing.samples += 1;
    } else if (byFamily.size < MAX_RECONCILE_FAMILIES) {
      byFamily.set(family, { family, value, samples: 1 });
    }
  }
  return [...byFamily.values()];
}

export interface ApiWarningRecord {
  message: string;
  tableId: string | null;
  count: number;
}

/**
 * Project `docker logs` lines onto exact known API warning records. Only a
 * structured record whose `msg` is in the known set (and whose `tableId`
 * matches the scoped table when one is known) is retained, projected to
 * `{ message, tableId, count }`; raw log text is never copied.
 */
export function parseApiWarnings(
  logText: string,
  options: {
    tableId?: string | null;
    knownMessages?: readonly string[];
    max?: number;
  } = {}
): ApiWarningRecord[] {
  if (typeof logText !== 'string' || logText === '') return [];
  const known = new Set(options.knownMessages ?? KNOWN_API_WARNING_MESSAGES);
  const expectedTable = options.tableId ?? null;
  const max = Math.max(1, Math.min(MAX_API_WARNING_RECORDS, options.max ?? MAX_API_WARNING_RECORDS));
  const bounded = logText.length > MAX_API_LOG_CHARS ? logText.slice(-MAX_API_LOG_CHARS) : logText;
  const records = new Map<string, ApiWarningRecord>();
  for (const line of bounded.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || trimmed.length > 32_768) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.msg !== 'string' || !known.has(record.msg)) continue;
    const tableId =
      typeof record.tableId === 'string' && TABLE_ID_TOKEN_RE.test(record.tableId) ? record.tableId : null;
    if (expectedTable !== null && tableId !== expectedTable) continue;
    const key = `${record.msg}\u0000${tableId ?? ''}`;
    const existing = records.get(key);
    if (existing) {
      existing.count += 1;
    } else if (records.size < max) {
      records.set(key, { message: record.msg, tableId, count: 1 });
    }
  }
  return [...records.values()];
}

// ---------------------------------------------------------------------------
// Canonical human action commit classification
// ---------------------------------------------------------------------------

export interface LastCanonicalHumanAction {
  /** Exact canonical request ids captured by the harness/UI callback. */
  requestIds?: readonly string[] | null;
  requestId?: string | null;
  actionId?: string | null;
  turnId?: string | null;
  tableId?: string | null;
  handId?: string | null;
  /** Metadata-only HTTP status of the latest canonical action exchange. */
  httpStatus?: number | null;
  /** True when the callback could not build a canonical request at all. */
  captureFailed?: boolean | null;
}

/** Where the exact human action identity in the packet came from. */
export type HumanActionIdentitySource =
  | 'callback'
  | 'product-decisions'
  | 'latest-accepted-fold'
  | 'none';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exact latest human action identity from the read-only product decisions.
 *
 * The most recent decision whose principal is NOT a declared agent principal
 * and whose canonical request id was persisted wins, whatever its status
 * (`ACTION_SUBMITTED`, `STALE`, `FAILED`, ...). A rejected/uncommitted human
 * request therefore still yields its exact request id; an older accepted agent
 * FOLD can never be silently substituted.
 */
export function lastHumanActionFromDecisions(
  decisions: readonly Record<string, unknown>[],
  agentPrincipalIds: readonly string[]
): LastCanonicalHumanAction | null {
  const agents = new Set(agentPrincipalIds);
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    const principalId = typeof decision.principalId === 'string' ? decision.principalId : null;
    if (principalId === null || agents.has(principalId)) continue;
    const requestId = typeof decision.requestId === 'string' ? decision.requestId : null;
    if (requestId === null || !DURABLE_IDENTIFIER_RE.test(requestId)) continue;
    return {
      requestIds: [requestId],
      actionId: typeof decision.actionId === 'string' ? decision.actionId : null,
      turnId: typeof decision.turnId === 'string' ? decision.turnId : null,
      tableId: typeof decision.tableId === 'string' ? decision.tableId : null,
    };
  }
  return null;
}

export interface HumanActionAttemptEvidence {
  attemptNo: number;
  status: string;
  errorCategory: string | null;
  recordedAt: number | null;
}

/**
 * Explicit per-request product evidence for the exact human action identity.
 * `rowAbsent` is true when a request id was supplied but no persisted decision
 * row matches it: the absence itself is case-1 evidence, never a fabricated
 * receipt.
 */
export interface HumanActionDecisionEvidence {
  decisionId: string;
  status: string;
  turnId: string;
  principalId: string;
  requestId: string | null;
  actionId: string | null;
  receiptRequestId: string | null;
  receiptVersion: number | null;
  receiptEventSeq: number | null;
  attemptCount: number;
  attempts: HumanActionAttemptEvidence[];
}

export function humanActionDecisionEvidence(
  decisions: readonly Record<string, unknown>[],
  attempts: readonly Record<string, unknown>[],
  requestIds: readonly string[]
): { decision: HumanActionDecisionEvidence | null; rowAbsent: boolean } {
  const wanted = new Set(plainIdentifiers(requestIds));
  if (wanted.size === 0) return { decision: null, rowAbsent: false };
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    const matches =
      (typeof decision.requestId === 'string' && wanted.has(decision.requestId)) ||
      (typeof decision.receiptRequestId === 'string' && wanted.has(decision.receiptRequestId));
    if (!matches) continue;
    const decisionId = typeof decision.id === 'string' ? decision.id : null;
    if (decisionId === null) continue;
    return {
      decision: {
        decisionId,
        status: typeof decision.status === 'string' ? decision.status : 'UNKNOWN',
        turnId: typeof decision.turnId === 'string' ? decision.turnId : '',
        principalId: typeof decision.principalId === 'string' ? decision.principalId : '',
        requestId: typeof decision.requestId === 'string' ? decision.requestId : null,
        actionId: typeof decision.actionId === 'string' ? decision.actionId : null,
        receiptRequestId: typeof decision.receiptRequestId === 'string' ? decision.receiptRequestId : null,
        receiptVersion: typeof decision.receiptVersion === 'number' ? decision.receiptVersion : null,
        receiptEventSeq: typeof decision.receiptEventSeq === 'number' ? decision.receiptEventSeq : null,
        attemptCount: typeof decision.attemptCount === 'number' ? decision.attemptCount : 0,
        attempts: attempts
          .filter((attempt) => attempt.decisionId === decisionId)
          .map((attempt) => ({
            attemptNo: typeof attempt.attemptNo === 'number' ? attempt.attemptNo : 0,
            status: typeof attempt.status === 'string' ? attempt.status : 'UNKNOWN',
            errorCategory: typeof attempt.errorCategory === 'string' ? attempt.errorCategory : null,
            recordedAt: typeof attempt.recordedAt === 'number' ? attempt.recordedAt : null,
          })),
      },
      rowAbsent: false,
    };
  }
  return { decision: null, rowAbsent: true };
}

/**
 * Optional structural relay for the browser repro's canonical human action
 * hook. Reads `canonicalHumanAction` when the browser owner adds it, else falls
 * back to the accepted `humanFold` capture. Returns null when neither carries
 * an exact canonical request id.
 */
export function lastCanonicalHumanActionFromBrowserResult(result: unknown): LastCanonicalHumanAction | null {
  if (!isPlainRecord(result)) return null;
  const relayed = result.canonicalHumanAction;
  if (isPlainRecord(relayed)) {
    const action: LastCanonicalHumanAction = {
      requestIds: plainIdentifiers([
        ...(Array.isArray(relayed.requestIds) ? relayed.requestIds : []),
        typeof relayed.requestId === 'string' ? relayed.requestId : null,
      ]),
      requestId: typeof relayed.requestId === 'string' ? relayed.requestId : null,
      actionId: typeof relayed.actionId === 'string' ? relayed.actionId : null,
      turnId: typeof relayed.turnId === 'string' ? relayed.turnId : null,
      tableId: typeof relayed.tableId === 'string' ? relayed.tableId : null,
      handId: typeof relayed.handId === 'string' ? relayed.handId : null,
    };
    if (canonicalHumanActionRequestIds(action).length > 0) return action;
  }
  const fold = result.humanFold;
  if (isPlainRecord(fold)) {
    const request = isPlainRecord(fold.request) ? fold.request : {};
    const receipt = isPlainRecord(fold.receipt) ? fold.receipt : {};
    const observation = isPlainRecord(fold.observation) ? fold.observation : {};
    const state = isPlainRecord(observation.state) ? observation.state : {};
    const action: LastCanonicalHumanAction = {
      requestIds: plainIdentifiers([
        typeof request.requestId === 'string' ? request.requestId : null,
        typeof receipt.requestId === 'string' ? receipt.requestId : null,
      ]),
      requestId: typeof request.requestId === 'string' ? request.requestId : null,
      actionId:
        typeof receipt.actionId === 'string'
          ? receipt.actionId
          : typeof request.actionId === 'string'
            ? request.actionId
            : null,
      turnId:
        typeof receipt.turnId === 'string'
          ? receipt.turnId
          : typeof request.turnId === 'string'
            ? request.turnId
            : null,
      tableId: typeof receipt.tableId === 'string' ? receipt.tableId : null,
      handId: typeof state.handId === 'string' ? state.handId : null,
    };
    if (canonicalHumanActionRequestIds(action).length > 0) return action;
  }
  return null;
}

export type HumanActionCommitBasis =
  | 'durable-receipt'
  | 'durable-event'
  | 'receipt-absent'
  | 'request-not-committed'
  | 'capture-incomplete'
  | 'no-canonical-action';

export interface HumanActionCommitVerdict {
  committed: boolean | null;
  basis: HumanActionCommitBasis;
}

function plainIdentifiers(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!DURABLE_IDENTIFIER_RE.test(trimmed) || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Exact canonical human action ids, preferring the harness/UI callback over
 * any inference from the operator store.
 */
export function canonicalHumanActionRequestIds(action: LastCanonicalHumanAction | null | undefined): string[] {
  if (action === null || action === undefined) return [];
  return plainIdentifiers([...(action.requestIds ?? []), action.requestId ?? null]);
}

/**
 * Classify whether the exact canonical human action committed.
 *
 * A committed verdict requires durable authoritative EVENT evidence for the
 * exact request id, or a request receipt that is event-linked (`eventSeq`
 * present). A request row with no event (`eventSeq: null`, for example a
 * rejected/uncommitted action now returned by the explicit-requestId SQL) is
 * `committed: false` / `request-not-committed`, never a fabricated receipt.
 * With no matching request row at all it is `committed: false` /
 * `receipt-absent` when the capture completed: the absence itself is case-1
 * evidence. A failed capture is always `null` (`capture-incomplete`).
 */
export function classifyHumanActionCommit(input: {
  requestIds: readonly string[];
  capture: 'COMPLETE' | 'FAILED';
  events: readonly { requestId: string | null }[];
  receipt: { requestId: string; eventSeq?: number | null } | null;
}): HumanActionCommitVerdict {
  const requestIds = plainIdentifiers(input.requestIds);
  if (requestIds.length === 0) return { committed: null, basis: 'no-canonical-action' };
  if (input.capture !== 'COMPLETE') return { committed: null, basis: 'capture-incomplete' };
  if (
    input.events.some(
      (event) => event.requestId !== null && requestIds.includes(event.requestId)
    )
  ) {
    return { committed: true, basis: 'durable-event' };
  }
  if (input.receipt !== null && requestIds.includes(input.receipt.requestId)) {
    return input.receipt.eventSeq !== null && input.receipt.eventSeq !== undefined
      ? { committed: true, basis: 'durable-receipt' }
      : { committed: false, basis: 'request-not-committed' };
  }
  return { committed: false, basis: 'receipt-absent' };
}

export interface ScopedFoldIdentifiers {
  requestId: string | null;
  handId: string | null;
  turnId: string | null;
  source: 'canonical-human-action' | 'latest-accepted-fold' | 'none';
  /** True when an initial event with the exact provided request id was found. */
  eventMatched: boolean;
  /**
   * True when the provided hand id contradicts the matching event's hand id.
   * Callers must fail the identity check (and retain) instead of silently
   * substituting either hand.
   */
  identityMismatch: boolean;
}

/**
 * Scoped identifiers for the second capture.
 *
 * Exact canonical human action ids win. When a request id is provided but the
 * action's `handId` is missing, the exact hand/turn are derived from the
 * initial events carrying the SAME request id; a provided hand that contradicts
 * that event sets `identityMismatch` (never a silent fallback). An uncommitted
 * request with no matching event keeps a provided hand and is otherwise
 * unknown — no older accepted FOLD is ever substituted. Only when no exact
 * identity exists at all may the latest accepted FOLD be used, labeled as such.
 */
export function resolveScopedFoldIdentifiers(
  events: readonly { action: string | null; requestId: string | null; handId: string | null; turnId: string | null }[],
  action: LastCanonicalHumanAction | null | undefined
): ScopedFoldIdentifiers {
  const requestId = canonicalHumanActionRequestIds(action)[0] ?? null;
  const providedHand = plainIdentifiers([action?.handId ?? null])[0] ?? null;
  const providedTurn = plainIdentifiers([action?.turnId ?? null])[0] ?? null;

  if (requestId !== null) {
    const matching = events.filter((event) => event.requestId === requestId);
    const eventWithHand = matching.find((event) => event.handId !== null) ?? null;
    const eventWithTurn = matching.find((event) => event.turnId !== null) ?? null;
    const identityMismatch =
      providedHand !== null && eventWithHand !== null && providedHand !== eventWithHand.handId;
    return {
      requestId,
      // On a mismatch the EVENT hand is authoritative for the scoped query; the
      // mismatch itself is recorded and fails the packet identity check.
      handId: identityMismatch ? eventWithHand!.handId : (providedHand ?? eventWithHand?.handId ?? null),
      turnId: providedTurn ?? eventWithTurn?.turnId ?? null,
      source: 'canonical-human-action',
      eventMatched: matching.length > 0,
      identityMismatch,
    };
  }

  if (providedHand !== null) {
    const matchingHand = events.filter((event) => event.handId === providedHand);
    return {
      requestId: null,
      handId: providedHand,
      turnId: providedTurn ?? matchingHand.at(-1)?.turnId ?? null,
      source: 'canonical-human-action',
      eventMatched: matchingHand.length > 0,
      identityMismatch: false,
    };
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.action === 'FOLD' && event.requestId !== null) {
      return {
        requestId: event.requestId,
        handId: event.handId,
        turnId: event.turnId,
        source: 'latest-accepted-fold',
        eventMatched: true,
        identityMismatch: false,
      };
    }
  }
  return {
    requestId: null,
    handId: null,
    turnId: null,
    source: 'none',
    eventMatched: false,
    identityMismatch: false,
  };
}

// ---------------------------------------------------------------------------
// Disposable raw SQLite cleanup (explicit paths only)
// ---------------------------------------------------------------------------

export interface DisposableSqliteCleanupInput {
  /** Explicit SQLite artifact paths; never globs, never directories. */
  paths: readonly string[];
  /** Only paths inside this root may be removed (for example context.artifactDir). */
  root: string;
  /** Paths that must never be removed (for example the current live DB). */
  protectedPaths?: readonly string[];
}

export interface DisposableSqliteCleanupResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

const SQLITE_ARTIFACT_RE = /\.(?:sqlite|sqlite3|db)$/i;

function withinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
}

function removableRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function sqliteGuardReason(path: string, root: string, protectedSet: Set<string>): string | null {
  if (!isAbsolute(path) || !SQLITE_ARTIFACT_RE.test(path)) return 'outside-root-or-not-sqlite';
  const resolved = resolve(path);
  if (!withinRoot(root, resolved)) return 'outside-root-or-not-sqlite';
  if (protectedSet.has(resolved)) return 'protected-path';
  return null;
}

/**
 * Remove ONLY explicitly supplied fresh disposable SQLite artifacts after the
 * product runtime has stopped: the exact path plus its adjacent `-wal`/`-shm`
 * files. Refuses directories, symlinks, non-SQLite extensions, paths outside
 * `root` and any `protectedPaths` entry (for example the live product DB that a
 * running runtime must keep). Historical artifacts and markers are never
 * enumerated or discovered here.
 */
export function cleanupDisposableSqliteArtifacts(
  input: DisposableSqliteCleanupInput
): DisposableSqliteCleanupResult {
  const result: DisposableSqliteCleanupResult = { removed: [], skipped: [] };
  if (!isAbsolute(input.root)) {
    return result;
  }
  const protectedSet = new Set((input.protectedPaths ?? []).map((path) => resolve(path)));
  for (const path of input.paths) {
    const guard = sqliteGuardReason(path, input.root, protectedSet);
    if (guard !== null) {
      result.skipped.push({ path, reason: guard });
      continue;
    }
    const resolved = resolve(path);
    if (!removableRegularFile(resolved)) {
      result.skipped.push({ path, reason: 'missing-directory-or-symlink' });
      continue;
    }
    for (const candidate of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
      if (!removableRegularFile(candidate)) continue;
      try {
        rmSync(candidate, { force: false });
        result.removed.push(candidate);
      } catch {
        result.skipped.push({ path: candidate, reason: 'remove-failed' });
      }
    }
  }
  return result;
}

export interface DisposableSqliteRelocationInput {
  /** Explicit SQLite artifact paths; never globs, never directories. */
  paths: readonly string[];
  /** Only paths inside this root may be moved (for example context.artifactDir). */
  root: string;
  /** Protected destination outside captured artifacts (for example runtimeDir). */
  destinationDir: string;
  /** Paths that must never be moved (for example the current live DB). */
  protectedPaths?: readonly string[];
}

export interface DisposableSqliteRelocationResult {
  moved: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Move ONLY explicitly supplied fresh disposable SQLite artifacts into a
 * protected destination outside captured artifacts (operator recovery for an
 * incomplete packet). The exact path plus its adjacent `-wal`/`-shm` files are
 * moved; the same root/protected/extension/regular-file guards as the cleanup
 * helper apply, and an existing destination is never overwritten.
 */
export function relocateDisposableSqliteArtifacts(
  input: DisposableSqliteRelocationInput
): DisposableSqliteRelocationResult {
  const result: DisposableSqliteRelocationResult = { moved: [], skipped: [] };
  if (!isAbsolute(input.root) || !isAbsolute(input.destinationDir)) return result;
  const protectedSet = new Set((input.protectedPaths ?? []).map((path) => resolve(path)));
  mkdirSync(input.destinationDir, { recursive: true, mode: 0o700 });
  for (const path of input.paths) {
    const guard = sqliteGuardReason(path, input.root, protectedSet);
    if (guard !== null) {
      result.skipped.push({ path, reason: guard });
      continue;
    }
    const resolved = resolve(path);
    if (!removableRegularFile(resolved)) {
      result.skipped.push({ path, reason: 'missing-directory-or-symlink' });
      continue;
    }
    for (const candidate of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
      if (!removableRegularFile(candidate)) continue;
      const destination = join(input.destinationDir, basename(candidate));
      if (existsSync(destination)) {
        result.skipped.push({ path: candidate, reason: 'destination-exists' });
        continue;
      }
      try {
        renameSync(candidate, destination);
        result.moved.push(destination);
      } catch {
        try {
          copyFileSync(candidate, destination);
          rmSync(candidate, { force: false });
          result.moved.push(destination);
        } catch {
          result.skipped.push({ path: candidate, reason: 'move-failed' });
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Private product data boundary + stop assurance
// ---------------------------------------------------------------------------

/** Dedicated child of the protected runtime dir holding the product SQLite. */
export const PRIVATE_PRODUCT_DATA_DIR = 'private-product-data';

const PRIVATE_DB_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Dedicated private product-data directory inside the protected runtime dir
 * (outside captured artifacts). The standalone product container mounts ONLY
 * this child, never the runtimeDir root (which holds platform secret env
 * files).
 */
export function privateProductDataDirectory(runtimeDir: string): string {
  return join(runtimeDir, PRIVATE_PRODUCT_DATA_DIR);
}

/** Absolute SQLite path inside the dedicated private product-data child. */
export function privateProductDatabasePath(runtimeDir: string, fileName: string): string {
  if (!PRIVATE_DB_FILENAME_RE.test(fileName) || basename(fileName) !== fileName) {
    throw new Error('private product database file name is not a plain file name');
  }
  return join(privateProductDataDirectory(runtimeDir), fileName);
}

export type ContainerStopReason =
  | 'not-running'
  | 'removed'
  | 'still-running'
  | 'probe-failed'
  | 'no-container-name';

export interface ContainerStopProof {
  stopped: boolean;
  reason: ContainerStopReason;
}

/** Injectable docker runner for the stop proof (focused tests). */
export type ContainerInspectRun = (args: readonly string[]) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

const defaultInspectRun: ContainerInspectRun = (args) =>
  runCommand('docker', [...args], { timeoutMs: 15_000 });

/**
 * Prove the product container is NOT running before any private data is
 * deleted or moved. `docker inspect` of a removed container exits non-zero
 * ("No such object"), which also proves it is gone; any other probe failure is
 * UNKNOWN and is reported as not proven (the caller must retain). The reason is
 * a fixed enum; raw docker output is never surfaced.
 */
export async function proveContainerStopped(
  containerName: string,
  run: ContainerInspectRun = defaultInspectRun
): Promise<ContainerStopProof> {
  if (typeof containerName !== 'string' || containerName.trim() === '') {
    return { stopped: false, reason: 'no-container-name' };
  }
  try {
    const result = await run(['inspect', '-f', '{{.State.Running}}', containerName.trim()]);
    if (result.code === 0) {
      const value = result.stdout.trim();
      if (value === 'false') return { stopped: true, reason: 'not-running' };
      if (value === 'true') return { stopped: false, reason: 'still-running' };
      return { stopped: false, reason: 'probe-failed' };
    }
    const text = `${result.stdout}\n${result.stderr}`;
    if (/no such (?:object|container)/i.test(text)) return { stopped: true, reason: 'removed' };
    return { stopped: false, reason: 'probe-failed' };
  } catch {
    return { stopped: false, reason: 'probe-failed' };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface LiveFailurePacketInput {
  context: Pick<RunContext, 'artifactDir' | 'log'>;
  adminTarget: AdminDatabaseTarget;
  redisContainer: string;
  secretRegistry: { redact(text: string): string; values(): string[] };
  productDatabasePath: string;
  /** Platform `/metrics` surface (base URL or full /metrics) + optional token. */
  platformMetrics?: { url: string; token?: string | null } | null;
  /** Platform API container name for exact known warning records. */
  apiContainerName?: string | null;
  /** The failure being captured (sanitized, bounded; never emitted raw). */
  reason?: unknown;
  /** Exact canonical final human action ids captured by the harness/UI callback. */
  lastCanonicalHumanAction?: LastCanonicalHumanAction | null;
  /**
   * Durable agent principals. The latest NON-agent decision's exact request id
   * is derived when no callback identity is supplied, so a rejected/uncommitted
   * human request still owns its exact identity.
   */
  agentPrincipalIds?: readonly string[];
  /** Explicit product room id; otherwise the ACTIVE room is discovered. */
  roomId?: string | null;
  /** BullMQ key prefix; the pinned platform uses the default `bull`. */
  queuePrefix?: string;
  /** Packet destination; defaults under the artifact dir. */
  packetPath?: string;
  /** Overrides the known API warning message set (focused runs/tests). */
  knownApiWarningMessages?: readonly string[];
  /** Injected operator SQL executor (focused tests / alternate topology). */
  query?: TerminalDiagnosticsSqlQuery | null;
  /** Injected redis-cli executor (focused tests / alternate topology). */
  redisExecutor?: RedisCliExecutor | null;
  /** Injected `/metrics` fetch (focused tests). */
  readMetricsText?: (() => Promise<string>) | null;
  /** Injected API log read (focused tests). */
  readApiLog?: (() => Promise<string>) | null;
  maxJobStateReads?: number;
  now?: () => Date;
}

export interface LiveFailurePacketResult {
  /** Packet persisted AND room/table identity present AND every capture complete. */
  complete: boolean;
  packetPath: string | null;
  /** Sanitized top-level reason (failure or the first collection gap). */
  reason: string | null;
  /** True whenever the packet is incomplete: keep runtime/PostgreSQL for recovery. */
  retainTopology: boolean;
}

function packetDest(input: LiveFailurePacketInput): string {
  return input.packetPath ?? join(input.context.artifactDir, 'live-failure-packet', 'live-failure-packet.json');
}

async function readMetricsSection(
  input: LiveFailurePacketInput
): Promise<{ families: ReconcileMetricFamily[] } | null> {
  const source = input.platformMetrics;
  if (source === null || source === undefined) return null;
  try {
    if (input.readMetricsText) return { families: parseReconcileMetrics(await input.readMetricsText()) };
    const url = source.url.endsWith('/metrics') ? source.url : `${source.url.replace(/\/$/, '')}/metrics`;
    const headers: Record<string, string> = {};
    if (source.token) headers.authorization = `Bearer ${source.token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return { families: parseReconcileMetrics(await response.text()) };
  } catch {
    return null;
  }
}

async function readApiWarningsSection(
  input: LiveFailurePacketInput,
  tableId: string | null
): Promise<ApiWarningRecord[]> {
  const container = input.apiContainerName;
  if (container === null || container === undefined || container.trim() === '') return [];
  try {
    if (input.readApiLog) {
      return parseApiWarnings(await input.readApiLog(), {
        tableId,
        ...(input.knownApiWarningMessages ? { knownMessages: input.knownApiWarningMessages } : {}),
      });
    }
    const result = await runCommand('docker', ['logs', container.trim()], { timeoutMs: 30_000 });
    if (result.code !== 0) return [];
    return parseApiWarnings(`${result.stdout}\n${result.stderr}`, {
      tableId,
      ...(input.knownApiWarningMessages ? { knownMessages: input.knownApiWarningMessages } : {}),
    });
  } catch {
    return [];
  }
}

function scopedIdentifiers(
  room: Record<string, unknown> | null,
  scoped: ScopedFoldIdentifiers,
  roomId: string | null
): TerminalDiagnosticsIdentifiers {
  return {
    roomId,
    tableId: room !== null && typeof room.tableId === 'string' ? room.tableId : null,
    competitionId: room !== null && typeof room.competitionId === 'string' ? room.competitionId : null,
    handId: scoped.handId,
    requestId: scoped.requestId,
    turnId: scoped.turnId,
  };
}

/**
 * Capture one sanitized live-failure packet. Never throws: a partial or failed
 * capture is persisted with `complete: false` / `retainTopology: true` so the
 * caller's original failure is never masked and recovery state is preserved.
 */
export async function collectLiveFailurePacket(
  input: LiveFailurePacketInput
): Promise<LiveFailurePacketResult> {
  const redact = (text: string): string => input.secretRegistry.redact(text);
  const knownSecrets = input.secretRegistry.values();
  const now = input.now ?? (() => new Date());
  const notes: string[] = [];
  let packetPath: string | null = null;

  const reasonSource: string | null =
    input.reason instanceof Error
      ? input.reason.message
      : input.reason === undefined || input.reason === null
        ? null
        : typeof input.reason === 'string'
          ? input.reason
          : errorText(input.reason);
  const sanitizedReason = sanitizeNote(reasonSource, redact);

  try {
    const metadata = readProductFailureMetadata(input.productDatabasePath, {
      roomId: input.roomId ?? null,
      redactText: redact,
    });
    if (metadata.room === null) notes.push('product-room-metadata-missing');
    if (metadata.truncated) notes.push('product-metadata-truncated');
    const room = metadata.room;
    const roomId = typeof room?.id === 'string' ? room.id : null;
    const diagnosticsQuery: TerminalDiagnosticsSqlQuery =
      input.query ?? terminalDiagnosticsQuery(input.adminTarget);

    // Exact human action identity: the harness/UI callback wins; otherwise the
    // most recent non-agent persisted decision supplies its exact request id
    // (even when rejected/uncommitted). A callback capture failure carries no
    // identity: it forces an incomplete/retained packet and must never fall
    // back to an older accepted FOLD or a persisted decision.
    const callbackFailed = input.lastCanonicalHumanAction?.captureFailed === true;
    const callbackIds = callbackFailed
      ? []
      : canonicalHumanActionRequestIds(input.lastCanonicalHumanAction);
    const derivedAction =
      callbackIds.length > 0 || callbackFailed
        ? null
        : lastHumanActionFromDecisions(metadata.decisions, input.agentPrincipalIds ?? []);
    const effectiveAction: LastCanonicalHumanAction | null = callbackFailed
      ? (input.lastCanonicalHumanAction ?? null)
      : callbackIds.length > 0
        ? (input.lastCanonicalHumanAction ?? null)
        : derivedAction;
    let identitySource: HumanActionIdentitySource = callbackFailed
      ? 'none'
      : callbackIds.length > 0
        ? 'callback'
        : derivedAction !== null
          ? 'product-decisions'
          : 'none';

    const reader = createBullMqJobStateReader({
      redisContainer: input.redisContainer,
      ...(input.queuePrefix !== undefined ? { queuePrefix: input.queuePrefix } : {}),
      ...(input.redisExecutor ? { executor: input.redisExecutor } : {}),
    });

    const initialIdentifiers: TerminalDiagnosticsIdentifiers = {
      roomId,
      tableId: room !== null && typeof room.tableId === 'string' ? room.tableId : null,
      competitionId: room !== null && typeof room.competitionId === 'string' ? room.competitionId : null,
    };
    const initial = await collectTerminalDiagnostics({
      query: diagnosticsQuery,
      identifiers: initialIdentifiers,
      knownSecrets,
      redactText: redact,
      readJobState: reader.readJobState,
      ...(input.maxJobStateReads !== undefined ? { maxJobStateReads: input.maxJobStateReads } : {}),
    });

    const scoped = callbackFailed
      ? {
          requestId: null,
          handId: null,
          turnId: null,
          source: 'none' as const,
          eventMatched: false,
          identityMismatch: false,
        }
      : resolveScopedFoldIdentifiers(initial.events, effectiveAction);
    if (callbackFailed) {
      notes.push('human-action-capture-failed');
    }
    if (identitySource === 'none' && scoped.source === 'latest-accepted-fold') {
      // Explicit, never silent: no exact identity existed, so the packet labels
      // the inferred accepted FOLD separately from any canonical human action.
      identitySource = 'latest-accepted-fold';
    }
    let scopedBundle: TerminalDiagnosticsBundle | null = null;
    if (scoped.source !== 'none' && initial.collection.status === 'COMPLETE') {
      scopedBundle = await collectTerminalDiagnostics({
        query: diagnosticsQuery,
        identifiers: scopedIdentifiers(room, scoped, roomId),
        knownSecrets,
        redactText: redact,
        readJobState: reader.readJobState,
        ...(input.maxJobStateReads !== undefined ? { maxJobStateReads: input.maxJobStateReads } : {}),
      });
    }
    const authoritative = scopedBundle ?? initial;

    let durableComplete = false;
    try {
      durableComplete = isTerminalDiagnosticComplete(authoritative);
    } catch {
      durableComplete = false;
    }
    if (initial.collection.status !== 'COMPLETE') notes.push('initial-diagnostics-failed');
    if (scopedBundle !== null && scopedBundle.collection.status !== 'COMPLETE') {
      notes.push('scoped-diagnostics-failed');
    }
    if (!durableComplete) notes.push('durable-packet-incomplete');

    const metrics = await readMetricsSection(input);
    if (metrics === null && input.platformMetrics) notes.push('platform-metrics-unavailable');
    const apiWarnings = await readApiWarningsSection(
      input,
      typeof room?.tableId === 'string' ? room.tableId : null
    );

    const requestIds = canonicalHumanActionRequestIds(effectiveAction);
    const humanVerdict = classifyHumanActionCommit({
      requestIds,
      capture: authoritative.collection.status === 'COMPLETE' ? 'COMPLETE' : 'FAILED',
      events: authoritative.events,
      receipt:
        authoritative.foldReceipt !== null
          ? {
              requestId: authoritative.foldReceipt.requestId,
              eventSeq: authoritative.foldReceipt.eventSeq,
            }
          : null,
    });
    if (scoped.identityMismatch) {
      // A provided hand contradicted the exact request's event hand: the
      // identity check fails closed (no silent fallback, topology retained).
      notes.push('human-action-identity-mismatch');
    }
    const acceptedFoldRequestIds = plainIdentifiers(
      authoritative.events.filter((event) => event.action === 'FOLD').map((event) => event.requestId)
    ).slice(0, 16);
    // Explicit rejected/uncommitted evidence: the exact request row (status +
    // attempt states) or its absence, and the absent durable receipt. The
    // operator SQL foldReceipt JOIN only matches a committed FOLD event, so an
    // uncommitted fold never fabricates a receipt.
    const requestEvidence = humanActionDecisionEvidence(
      metadata.decisions,
      metadata.attempts,
      requestIds
    );
    const foldReceiptAbsent =
      authoritative.foldReceipt === null &&
      (requestIds.length > 0 || acceptedFoldRequestIds.length > 0);
    const inferredFoldRequestId =
      identitySource === 'latest-accepted-fold' ? scoped.requestId : null;

    const collectionFailed =
      room === null ||
      initial.collection.status !== 'COMPLETE' ||
      (scopedBundle !== null && scopedBundle.collection.status !== 'COMPLETE');
    const complete =
      !collectionFailed && durableComplete && !scoped.identityMismatch && !callbackFailed;

    const packet = {
      kind: LIVE_FAILURE_PACKET_KIND,
      version: LIVE_FAILURE_PACKET_VERSION,
      generatedAt: now().toISOString(),
      reason: sanitizedReason,
      collection: {
        status: complete ? 'COMPLETE' : 'FAILED',
        reason: sanitizedReason ?? notes[0] ?? null,
      },
      product: {
        discovery: metadata.discovery,
        room,
        decisions: metadata.decisions,
        attempts: metadata.attempts,
        truncated: metadata.truncated,
      },
      terminal: {
        authoritative: scopedBundle !== null ? 'scoped' : 'initial',
        scopedIdentifiers: scoped,
        initial,
        scoped: scopedBundle,
        durableComplete,
      },
      bullmq: {
        redisContainer: input.redisContainer,
        queuePrefix: input.queuePrefix ?? DEFAULT_QUEUE_PREFIX,
        // A scoped recapture probes the same rows again; keep the last probe
        // per outbox id so the packet carries one record per job.
        jobs: [...new Map(reader.probes.map((probe) => [probe.outboxId, probe])).values()],
      },
      metrics: metrics === null ? null : { source: 'platform-/metrics', reconcileFamilies: metrics.families },
      apiWarnings,
      humanAction: {
        requestIds,
        identitySource,
        acceptedFoldRequestIds,
        inferredFoldRequestId,
        committed: humanVerdict.committed,
        basis: humanVerdict.basis,
        receiptRequestId: authoritative.foldReceipt?.requestId ?? null,
        receiptEventSeq: authoritative.foldReceipt?.eventSeq ?? null,
        foldReceiptAbsent,
        identityMismatch: scoped.identityMismatch,
        providedHandId: plainIdentifiers([effectiveAction?.handId ?? null])[0] ?? null,
        decision: requestEvidence.decision,
        decisionRowAbsent: requestEvidence.rowAbsent,
        exchange: {
          httpStatus:
            typeof effectiveAction?.httpStatus === 'number' &&
            Number.isInteger(effectiveAction.httpStatus)
              ? effectiveAction.httpStatus
              : null,
          captureFailed: effectiveAction?.captureFailed === true,
        },
        capture: authoritative.collection.status,
      },
      warnings: notes.slice(0, 32),
    };

    const destination = packetDest(input);
    try {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      // Final defense-in-depth pass over the entire serialized packet with the
      // registry redactor before anything is written.
      writeFileSync(destination, `${redact(JSON.stringify(packet, null, 2))}\n`, { mode: 0o600 });
      packetPath = destination;
    } catch {
      notes.push('packet-not-persisted');
    }

    const completeFinal = complete && packetPath !== null;
    const reason = sanitizedReason ?? notes[0] ?? null;
    try {
      input.context.log(
        `live failure packet: complete=${String(completeFinal)} retainTopology=${String(!completeFinal)} path=${packetPath ?? 'none'}`
      );
    } catch {
      // Logging must never mask the original failure.
    }
    return {
      complete: completeFinal,
      packetPath,
      reason,
      retainTopology: !completeFinal,
    };
  } catch (error) {
    // Catastrophic capture failure: persist nothing raw, retain the topology,
    // report only the sanitized category of the failure.
    const reason = sanitizeNote(errorText(error), redact) ?? 'live-failure-packet-capture-failed';
    try {
      input.context.log('live failure packet: capture failed; retainTopology=true');
    } catch {
      // ignore
    }
    return { complete: false, packetPath, reason, retainTopology: true };
  }
}

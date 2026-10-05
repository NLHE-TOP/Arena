/**
 * Read-only evidence reader for the product's durable decision/attempt records.
 *
 * The operator audit API deliberately exposes metadata only, so acceptance
 * inspects the ACTUAL persisted bytes from the product's own SQLite store with
 * a read-only connection (never writes, never migrates). Every check re-derives
 * from the saved `source_json` (public chat) and `observation_json`, so a
 * prompt-builder bug cannot satisfy its own oracle.
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SeatObservation } from '@pokertools/types';
import { inspectPersistedDecision } from '../inspector.js';

export interface EvidenceRoom {
  id: string;
  name: string;
  status: string;
  policy_kind: string;
  policy_json: string;
  table_id: string | null;
  platform_competition_id: string | null;
  failure_reason: string | null;
}

export interface EvidenceDecision {
  id: string;
  table_id: string;
  turn_id: string;
  principal_id: string;
  room_id: string | null;
  status: string;
  observation_json: string;
  observation_hash: string;
  source_json: string | null;
  prompt_policy_id: string;
  event_cursor: number;
  request_json: string | null;
  receipt_json: string | null;
  error_reason: string | null;
  attempt_count: number;
}

export interface EvidenceAttempt {
  id: string;
  decision_id: string;
  attempt_no: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  request_json: string;
  response_json: string | null;
  error: string | null;
  model: string | null;
  provider: string | null;
  prompt_policy_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micro_usd: number;
  latency_ms: number;
  created_at: number;
  recorded_at: number | null;
}

export interface RoomEvidence {
  room: EvidenceRoom;
  decisions: EvidenceDecision[];
  attempts: EvidenceAttempt[];
  result: Record<string, unknown> | null;
}

export function readRoomEvidence(databasePath: string, roomId: string): RoomEvidence {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const room = db.prepare('SELECT * FROM product_rooms WHERE id = ?').get(roomId) as EvidenceRoom | undefined;
    if (!room) throw new Error(`room ${roomId} is not persisted`);
    const decisions = db
      .prepare('SELECT * FROM product_decisions WHERE room_id = ? ORDER BY created_at, id')
      .all(roomId) as EvidenceDecision[];
    const attempts = decisions.length
      ? (db
          .prepare(
            `SELECT * FROM product_model_attempts WHERE decision_id IN (${decisions
              .map(() => '?')
              .join(',')}) ORDER BY decision_id, attempt_no`
          )
          .all(...decisions.map((decision) => decision.id)) as EvidenceAttempt[])
      : [];
    const result = db.prepare('SELECT * FROM product_room_results WHERE room_id = ?').get(roomId) as
      | Record<string, unknown>
      | undefined;
    return { room, decisions, attempts, result: result ?? null };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Independent primitives (duplicated from the documented contract on purpose)
// ---------------------------------------------------------------------------

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortJsonValue(source[key]);
    return sorted;
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

interface ParsedResponseChoice {
  actionId: string;
  amount?: number;
}

function parseChosenAction(responseJson: string): ParsedResponseChoice {
  const payload = JSON.parse(responseJson) as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } }>;
  };
  const call = payload.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.function?.name !== 'choose_action' || typeof call.function.arguments !== 'string') {
    throw new Error('recorded response carries no choose_action tool call');
  }
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  if (typeof args.actionId !== 'string' || args.actionId.length === 0) {
    throw new Error('recorded response actionId is missing');
  }
  return {
    actionId: args.actionId,
    ...(typeof args.amount === 'number' ? { amount: args.amount } : {}),
  };
}

export interface ChosenActionSummary {
  decisionId: string;
  attemptNo: number;
  actionId: string;
  family: string | null;
  amount: number | null;
  minAmount: number | null;
  maxAmount: number | null;
  /** True when the chosen action requires a model-supplied amount. */
  requiresAmount: boolean | null;
  /** True when the raw response carried an amount the policy ignores. */
  amountIgnored: boolean;
}

/** Summarize chosen actions from persisted successful attempts (independent). */
export function summarizeChosenActions(evidence: RoomEvidence): ChosenActionSummary[] {
  const byId = new Map(evidence.decisions.map((decision) => [decision.id, decision]));
  const summaries: ChosenActionSummary[] = [];
  for (const attempt of evidence.attempts) {
    if (attempt.status !== 'SUCCEEDED' || attempt.response_json === null) continue;
    const decision = byId.get(attempt.decision_id);
    if (!decision) continue;
    try {
      const chosen = parseChosenAction(attempt.response_json);
      const observation = JSON.parse(decision.observation_json) as {
        legalActions?: Array<{ actionId: string; family: string; amount?: number; minAmount?: number; maxAmount?: number }>;
      };
      const legal = observation.legalActions?.find((action) => action.actionId === chosen.actionId) ?? null;
      const requiresAmount =
        legal === null
          ? null
          : (legal.family === 'BET' || legal.family === 'RAISE') && legal.amount === undefined;
      summaries.push({
        decisionId: decision.id,
        attemptNo: attempt.attempt_no,
        actionId: chosen.actionId,
        family: legal?.family ?? null,
        amount: chosen.amount ?? null,
        minAmount: legal?.minAmount ?? null,
        maxAmount: legal?.maxAmount ?? null,
        requiresAmount,
        amountIgnored: chosen.amount !== undefined && requiresAmount === false,
      });
    } catch {
      // Response validity is asserted by inspectRoomEvidence.
    }
  }
  return summaries;
}

export interface EvidenceViolation {
  roomId: string;
  decisionId: string;
  attemptNo: number | null;
  detail: string;
}

export interface EvidenceInspection {
  decidedTurns: number;
  inspectedAttempts: number;
  violations: EvidenceViolation[];
}

export interface InspectRoomEvidenceOptions {
  /** Durable agent principals; human principals must never own decisions. */
  agentPrincipalIds: ReadonlySet<string>;
}

/**
 * Inspect one room's persisted decisions and attempts:
 * - only AGENT principals own decisions and provider attempts;
 * - at most two attempts per decision and immutable attempt numbering;
 * - every SUCCEEDED attempt's exact request passes the independent inspector
 *   against the saved observation and saved `source_json.publicChat`;
 * - observation hash integrity and independent response/menu validation.
 */
export async function inspectRoomEvidence(
  evidence: RoomEvidence,
  options: InspectRoomEvidenceOptions
): Promise<EvidenceInspection> {
  const violations: EvidenceViolation[] = [];
  const attemptsByDecision = new Map<string, EvidenceAttempt[]>();
  for (const attempt of evidence.attempts) {
    const list = attemptsByDecision.get(attempt.decision_id) ?? [];
    list.push(attempt);
    attemptsByDecision.set(attempt.decision_id, list);
  }

  let inspectedAttempts = 0;
  for (const decision of evidence.decisions) {
    const attempts = attemptsByDecision.get(decision.id) ?? [];
    const violation = (attemptNo: number | null, detail: string) =>
      violations.push({ roomId: evidence.room.id, decisionId: decision.id, attemptNo, detail });

    if (!options.agentPrincipalIds.has(decision.principal_id)) {
      violation(null, `decision owned by a non-agent principal ${decision.principal_id}`);
    }
    if (attempts.length > 2) {
      violation(null, `decision has ${attempts.length} attempts (max 2)`);
    }
    const numbers = attempts.map((attempt) => attempt.attempt_no).sort((a, b) => a - b);
    if (numbers.some((value, index) => value !== index + 1)) {
      violation(null, `attempt numbering is not contiguous: ${numbers.join(',')}`);
    }

    let observation: SeatObservation;
    try {
      observation = JSON.parse(decision.observation_json) as SeatObservation;
    } catch {
      violation(null, 'saved observation is not valid JSON');
      continue;
    }
    const observationHash = sha256Hex(stableJson(observation));
    if (observationHash !== decision.observation_hash) {
      violation(null, 'saved observation hash does not match its bytes');
    }

    const source = decision.source_json === null ? null : (JSON.parse(decision.source_json) as { publicChat?: unknown[] });
    const publicChat = Array.isArray(source?.publicChat) ? source.publicChat : [];
    if (!Array.isArray(source?.publicChat) && decision.source_json !== null) {
      violation(null, 'saved decision source has no publicChat array');
    }

    for (const attempt of attempts) {
      inspectedAttempts += 1;
      if (attempt.status === 'PENDING') {
        violation(attempt.attempt_no, 'pending attempt persisted on a completed room');
      }
      if (attempt.status === 'FAILED' && (attempt.error === null || attempt.error.length === 0)) {
        violation(attempt.attempt_no, 'failed attempt has no recorded error');
      }
      // The exact provider request is inspected for EVERY attempt, including
      // failed and aborted exchanges: request evidence must exist and match the
      // saved observation/source even when the response was unusable.
      try {
        const parsedRequest = JSON.parse(attempt.request_json) as {
          temperature?: number;
          max_tokens?: number;
          messages?: Array<{ role: string; content: string }>;
          tools?: Array<{ function?: { parameters?: { properties?: { actionId?: { enum?: string[] } } } } }>;
        };
        const messages = parsedRequest.messages ?? [];
        // Independent action-option derivation (same canonical order/shape the
        // inspector re-derives from the saved observation).
        const actions = (observation.legalActions ?? []).map((action) => ({
          actionId: action.actionId,
          family: action.family,
          minAmount: action.minAmount ?? null,
          maxAmount: action.maxAmount ?? null,
          amount: action.amount ?? null,
          requiresAmount:
            (action.family === 'BET' || action.family === 'RAISE') && action.amount === undefined,
        }));
        const promptHash = sha256Hex(
          stableJson({
            promptVersion: decision.prompt_policy_id,
            messages: messages.map((message) => ({ role: message.role, content: message.content })),
            actions,
          })
        );
        const inspection = await inspectPersistedDecision({
          record: {
            requestJson: attempt.request_json,
            model: attempt.model ?? '',
            promptVersion: decision.prompt_policy_id,
            promptHash,
            observationHash: decision.observation_hash,
            ...(typeof parsedRequest.temperature === 'number' ? { temperature: parsedRequest.temperature } : {}),
            ...(typeof parsedRequest.max_tokens === 'number' ? { maxOutputTokens: parsedRequest.max_tokens } : {}),
          },
          observation,
          publicChat,
        });
        if (inspection.error !== undefined) {
          violation(attempt.attempt_no, `inspector unavailable: ${inspection.error}`);
        } else if (!inspection.ok) {
          violation(attempt.attempt_no, 'independent inspector rejected the persisted request');
        }
      } catch (error) {
        violation(attempt.attempt_no, `inspection failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Independent response validation only for a successful recorded
      // response; failed/HTTP-error payloads must not be treated as actions.
      if (attempt.status !== 'SUCCEEDED' || attempt.response_json === null) continue;
      try {
        const chosen = parseChosenAction(attempt.response_json);
        const legal = observation.legalActions.find((action) => action.actionId === chosen.actionId);
        if (!legal) {
          violation(attempt.attempt_no, `response actionId ${chosen.actionId} is outside the saved legal menu`);
        } else {
          const requiresAmount =
            (legal.family === 'BET' || legal.family === 'RAISE') && legal.amount === undefined;
          if (requiresAmount) {
            if (chosen.amount !== undefined && legal.minAmount !== undefined && chosen.amount < legal.minAmount) {
              violation(attempt.attempt_no, `response amount ${chosen.amount} below legal minimum`);
            } else if (chosen.amount !== undefined && legal.maxAmount !== undefined && chosen.amount > legal.maxAmount) {
              violation(attempt.attempt_no, `response amount ${chosen.amount} above legal maximum`);
            }
          } else {
            // Normalization policy: a model-supplied amount for a fixed-amount
            // action is deterministically ignored; the resolved canonical
            // request must carry the server amount (or omit a zero amount).
            const expected = legal.amount !== undefined && legal.amount > 0 ? legal.amount : undefined;
            const resolved = decision.request_json === null ? null : (JSON.parse(decision.request_json) as { amount?: number }).amount;
            if (resolved !== expected) {
              violation(
                attempt.attempt_no,
                `normalized request amount ${String(resolved)} != server amount ${String(expected)} for ${chosen.actionId}`
              );
            }
          }
        }
      } catch (error) {
        violation(attempt.attempt_no, `independent response validation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { decidedTurns: evidence.decisions.length, inspectedAttempts, violations };
}

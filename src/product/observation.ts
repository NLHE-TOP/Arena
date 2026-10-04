/**
 * Shared observation boundary utility.
 *
 * The observation and chat contracts are imported directly from
 * `@pokertools/types` — no local copies. `computeObservationHash` is the single
 * source of truth for the observation hash used by the store and the provider
 * runtime: plain `sha256(canonicalJson(observation))` over the strictly
 * validated canonical `SeatObservation`. The inspector can independently parse
 * `observation` with the same schema and recompute this hash.
 *
 * `canonicalJson` is a deterministic stable JSON serialization: object keys are
 * sorted recursively, `undefined` members are dropped, no whitespace is
 * emitted. Arrays keep their order.
 */
import { createHash } from 'node:crypto';
import {
  ChatMessageSchema,
  SeatObservationSchema,
  type ChatMessage,
  type SeatObservation,
} from '@pokertools/types';
import { z } from 'zod';

export type { ChatMessage, SeatObservation };

/**
 * Optional pre-transport source snapshot associated with a decision. The
 * `publicChat` record is the exact allowed input visible to the acting
 * principal, captured before transport; the inspector compares the actual
 * provider request against this saved input (the request alone cannot be used
 * to reconstruct it).
 */
export const DecisionSourceSchema = z.strictObject({
  publicChat: z.array(ChatMessageSchema),
});
export type DecisionSource = { readonly publicChat: readonly ChatMessage[] };

export class ObservationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationValidationError';
  }
}

/** Strictly validate a canonical `SeatObservation`. */
export function parseSeatObservation(value: unknown): SeatObservation {
  const result = SeatObservationSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.map(String).join('.')}` : '';
    throw new ObservationValidationError(`${issue?.message ?? 'invalid observation'}${path}`);
  }
  return result.data;
}

/** Strictly validate an optional decision source snapshot. */
export function parseDecisionSource(value: unknown): DecisionSource {
  const result = DecisionSourceSchema.safeParse(value);
  if (!result.success) {
    throw new ObservationValidationError(result.error.issues[0]?.message ?? 'invalid decision source');
  }
  return result.data as DecisionSource;
}

/** Deterministic stable JSON used for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ObservationValidationError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new ObservationValidationError(`canonicalJson: unsupported value type ${typeof value}`);
}

/**
 * Canonical observation hash: plain SHA-256 over the stable JSON of a strictly
 * validated canonical observation. Identical input always hashes identically.
 */
export function computeObservationHash(observation: unknown): string {
  return createHash('sha256').update(canonicalJson(parseSeatObservation(observation))).digest('hex');
}

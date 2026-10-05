/**
 * Canonical accepted-action capture for the human seat.
 *
 * The public canonical action response is `{ receipt, observation }`: the
 * maskable wire observation generated from the EXACT resulting snapshot plus
 * the durable receipt of the submitted turn/action. Drivers currently discard
 * it; the human-fold regressions need it as evidence, so this module defines a
 * small, sanitized, serializable capture and the card-secret hygiene around it.
 *
 * Card hygiene (both directions of trust):
 * - `sanitizeSeatObservationCards` empties every card-bearing field (`deck`,
 *   `board`, each player's `hand`/`shownCards`, each winner's `hand`) so a
 *   capture never carries hole cards or deck order, whichever path produced it
 *   (SDK result or browser response body);
 * - `assertNoCardSecrets` re-scans any captured/persisted value and throws on a
 *   non-empty card container or a card-shaped token, so a sanitization
 *   regression fails the run instead of leaking into an artifact.
 */
import type {
  CanonicalActionReceipt,
  CanonicalActionResult,
  LegalAction,
  SeatObservation,
} from '@pokertools/types';

/** Exact canonical action request body submitted to the public action route. */
export interface CapturedCanonicalRequest {
  requestId: string;
  turnId: string;
  expectedVersion: number;
  actionId: string;
  amount?: number;
}

/** Sanitized canonical accepted-action capture (never hole cards or deck). */
export interface CanonicalActionCapture {
  /** Canonical engine family of the submitted server-issued action. */
  family: string;
  request: CapturedCanonicalRequest;
  receipt: CanonicalActionReceipt;
  /** Exact result observation with every card-bearing field sanitized. */
  observation: SeatObservation;
  /** Client-side acceptance timestamp (ms epoch). */
  acceptedAt: number;
}

const CARD_TOKEN = /^(?:10|[2-9TJQKA])[shdc]$/i;

/** True for a single standard card token (`As`, `10h`, ...). */
export function isCardToken(value: string): boolean {
  return CARD_TOKEN.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Empty every card-bearing field of a face-in observation while keeping the
 * public shape intact: `deck`/`board` become empty arrays, each player's
 * `hand`/`shownCards` become null and each winner's `hand` becomes null.
 * `handRank`, stacks, bets, pots, action history and winners (seat/amount) are
 * preserved, so the capture still proves the fold boundary (winners, handId,
 * version) without any card value.
 */
export function sanitizeSeatObservationCards(observation: SeatObservation): SeatObservation {
  const sanitized = structuredClone(observation);
  sanitized.state.deck = [];
  sanitized.state.board = [];
  for (const player of sanitized.state.players) {
    if (player === null) continue;
    player.hand = null;
    player.shownCards = null;
  }
  if (sanitized.state.winners !== null) {
    sanitized.state.winners = sanitized.state.winners.map((winner) => ({ ...winner, hand: null }));
  }
  return sanitized;
}

/**
 * Validate the structural canonical result contract before it is trusted.
 * Malformed shape (for example a non-canonical error body that still returned
 * 2xx) fails loudly instead of producing an empty capture.
 */
export function parseCanonicalActionResult(payload: unknown): CanonicalActionResult {
  if (!isRecord(payload)) throw new Error('canonical action response is not an object');
  const receipt = payload.receipt;
  const observation = payload.observation;
  if (!isRecord(receipt)) throw new Error('canonical action response carries no receipt');
  if (!isRecord(observation)) throw new Error('canonical action response carries no observation');
  for (const key of ['requestId', 'tableId', 'handId', 'turnId', 'actionId'] as const) {
    if (typeof receipt[key] !== 'string' || (receipt[key] as string).length === 0) {
      throw new Error(`canonical action receipt is missing ${key}`);
    }
  }
  for (const key of ['version', 'eventSeq', 'acceptedAt'] as const) {
    if (!Number.isSafeInteger(receipt[key])) {
      throw new Error(`canonical action receipt is missing integer ${key}`);
    }
  }
  for (const key of ['tableId', 'handId', 'turnId'] as const) {
    if (typeof observation[key] !== 'string' || (observation[key] as string).length === 0) {
      throw new Error(`canonical action observation is missing ${key}`);
    }
  }
  const state = observation.state;
  if (!isRecord(state) || !isRecord(state.config) || !Array.isArray(state.players)) {
    throw new Error('canonical action observation state is malformed');
  }
  if (receipt.tableId !== observation.tableId) {
    throw new Error('canonical receipt tableId does not match its result observation');
  }
  if (receipt.handId !== observation.handId) {
    throw new Error('canonical receipt handId does not match its result observation');
  }
  return payload as unknown as CanonicalActionResult;
}

export interface BuildCanonicalActionCaptureInput {
  /** Canonical family of the submitted legal action (`FOLD`, `CALL`, ...). */
  family: LegalAction['family'] | string;
  /** Exact request body submitted (stable across retries). */
  request: CapturedCanonicalRequest;
  /** Exact accepted result returned by the action route. */
  result: CanonicalActionResult;
  /** Client-side acceptance timestamp (ms epoch). */
  acceptedAt: number;
}

/**
 * Build the sanitized capture and prove request/receipt coherence: the durable
 * receipt must identify exactly the submitted request (requestId, turnId,
 * actionId, tableId). A mismatch means the response belongs to another
 * exchange and must never be recorded as this action's acceptance.
 */
export function buildCanonicalActionCapture(
  input: BuildCanonicalActionCaptureInput
): CanonicalActionCapture {
  const { receipt, observation } = input.result;
  if (receipt.requestId !== input.request.requestId) {
    throw new Error('canonical receipt requestId does not match the submitted request');
  }
  if (receipt.turnId !== input.request.turnId) {
    throw new Error('canonical receipt turnId does not match the submitted request');
  }
  if (receipt.actionId !== input.request.actionId) {
    throw new Error('canonical receipt actionId does not match the submitted request');
  }
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt <= 0) {
    throw new Error('canonical capture acceptedAt must be a positive epoch millisecond timestamp');
  }
  return {
    family: input.family,
    request: { ...input.request },
    receipt: { ...receipt },
    observation: sanitizeSeatObservationCards(observation),
    acceptedAt: input.acceptedAt,
  };
}

const CARD_CONTAINER_KEY = /^(?:deck|board|hand|hands|cards|holeCards|shownCards)$/i;

/**
 * Fail-closed card-secret scan over any captured value. Throws when a
 * card-bearing container is non-empty, or when a card-shaped token appears
 * anywhere (including free text). Empty/null card fields and `handRank` are
 * intentionally allowed: they carry no card identity.
 */
export function assertNoCardSecrets(label: string, value: unknown): void {
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (isCardToken(node)) throw new Error(`${label}: card token at ${path}: ${node}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, entry] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (CARD_CONTAINER_KEY.test(key)) {
        if (Array.isArray(entry) && entry.length > 0) {
          throw new Error(`${label}: ${childPath} carries ${entry.length} card value(s)`);
        }
        if (typeof entry === 'string' && entry.trim() !== '' && isCardToken(entry)) {
          throw new Error(`${label}: card token at ${childPath}: ${entry}`);
        }
      }
      visit(entry, childPath);
    }
  };
  visit(value, '$');
}

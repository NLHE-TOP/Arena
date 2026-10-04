/**
 * Provider-owned canonical fixtures for the product tests.
 *
 * These build schema-valid `SeatObservation`/`ChatMessage` values through the
 * real canonical `@pokertools/types` schemas, so tests fail if the local
 * contract drifts. The values are the original provider fixtures: eventSeq 10,
 * a legal menu containing CHECK/CALL/RAISE/BET, no null player, and chat
 * message ids that never embed the message body.
 *
 * Additional canonical helpers (`seatObservationFixture`, `chatMessageFixture`,
 * action request/receipt fixtures, principal constants) are additive so the
 * store/runtime suites can share the same schema-validated sources.
 */
import {
  CanonicalActionReceiptSchema,
  CanonicalActionRequestSchema,
  ChatMessageSchema,
  SeatObservationSchema,
  type CanonicalActionReceipt,
  type CanonicalActionRequest,
  type ChatMessage,
  type LegalAction,
  type SeatObservation,
} from '@pokertools/types';

export const TEST_TABLE_ID = 'table-1';
export const TEST_HAND_ID = 'hand-1';
export const TEST_TURN_ID = 'turn-1';
export const TEST_EVENT_SEQ = 10;
export const TEST_VERSION = 4;

/** Compatibility aliases for suites that use the shorter names. */
export const TABLE_ID = TEST_TABLE_ID;
export const HAND_ID = TEST_HAND_ID;
/** The viewing seat in the default observation (seat 0). */
export const HUMAN_PRINCIPAL_ID = 'p0';
/** The opponent seat in the default observation (seat 1). */
export const AGENT_PRINCIPAL_ID = 'p1';

export function legalActionsFixture(): LegalAction[] {
  return [
    { actionId: 'act-fold', family: 'FOLD' },
    { actionId: 'act-check', family: 'CHECK' },
    { actionId: 'act-call', family: 'CALL', amount: 1 },
    { actionId: 'act-raise-half', family: 'RAISE', minAmount: 4, maxAmount: 40 },
    { actionId: 'act-raise-all-in', family: 'RAISE', minAmount: 4, maxAmount: 100, amount: 100 },
    { actionId: 'act-bet', family: 'BET', minAmount: 2, maxAmount: 100 },
  ];
}

export const DEFAULT_LEGAL_ACTIONS: readonly LegalAction[] = legalActionsFixture();

export function observationInput(): SeatObservation {
  return {
    tableId: TEST_TABLE_ID,
    handId: TEST_HAND_ID,
    turnId: TEST_TURN_ID,
    version: TEST_VERSION,
    eventSeq: TEST_EVENT_SEQ,
    state: {
      config: { smallBlind: 1, bigBlind: 2 },
      players: [
        {
          id: HUMAN_PRINCIPAL_ID,
          name: 'Seat Zero',
          seat: 0,
          stack: 99,
          hand: ['As', 'Kd'],
          shownCards: null,
          status: 'ACTIVE',
          betThisStreet: 1,
          totalInvestedThisHand: 1,
          isSittingOut: false,
          timeBank: 30,
          pendingAddOn: 0,
          sitInOption: 'IMMEDIATE',
          reservationExpiry: null,
          pendingStand: false,
        },
        {
          id: AGENT_PRINCIPAL_ID,
          name: 'Seat One',
          seat: 1,
          stack: 98,
          hand: null,
          shownCards: null,
          status: 'ACTIVE',
          betThisStreet: 2,
          totalInvestedThisHand: 2,
          isSittingOut: false,
          timeBank: 30,
          pendingAddOn: 0,
          sitInOption: 'IMMEDIATE',
          reservationExpiry: null,
          pendingStand: false,
        },
      ],
      maxPlayers: 2,
      handNumber: 1,
      buttonSeat: 0,
      bigBlindSeat: 1,
      deck: [],
      board: [],
      street: 'PREFLOP',
      pots: [{ amount: 3, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
      currentBets: { '0': 1, '1': 2 },
      minRaise: 2,
      lastRaiseAmount: 2,
      actionTo: 0,
      lastAggressorSeat: 1,
      activePlayers: [0, 1],
      winners: null,
      rakeThisHand: 0,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      blindLevel: 0,
      timeBanks: {},
      timeBankActiveSeat: null,
      actionHistory: [
        { type: 'CALL', seat: 1, resultingPot: 2, resultingStack: 98, street: 'PREFLOP' },
      ],
      timestamp: 1,
      handId: TEST_HAND_ID,
      viewingPlayerId: HUMAN_PRINCIPAL_ID,
      version: TEST_VERSION,
    },
    legalActions: legalActionsFixture(),
  };
}

export function observationFixture(overrides: Partial<SeatObservation> = {}): SeatObservation {
  return SeatObservationSchema.parse({ ...observationInput(), ...overrides });
}

export function withState(
  observation: SeatObservation,
  stateOverrides: Partial<SeatObservation['state']>,
): SeatObservation {
  return observationFixture({
    ...observation,
    state: { ...observation.state, ...stateOverrides },
  });
}

export interface SeatObservationFixtureOptions {
  tableId?: string;
  turnId?: string;
  version?: number;
  eventSeq?: number;
  legalActions?: readonly LegalAction[];
}

/**
 * Canonical observation with selected fields overridden. `version` is kept in
 * sync with `state.version` so the result stays schema-valid; tests that want
 * a corrupt identity/version spread the fixture and change one side only.
 */
export function seatObservationFixture(
  options: SeatObservationFixtureOptions = {},
): SeatObservation {
  const input = observationInput();
  if (options.tableId !== undefined) input.tableId = options.tableId;
  if (options.turnId !== undefined) input.turnId = options.turnId;
  if (options.version !== undefined) {
    input.version = options.version;
    input.state = { ...input.state, version: options.version };
  }
  if (options.eventSeq !== undefined) input.eventSeq = options.eventSeq;
  if (options.legalActions !== undefined) {
    input.legalActions = options.legalActions.map((action) => ({ ...action }));
  }
  return SeatObservationSchema.parse(input);
}

export interface ChatFixtureOverrides {
  messageId?: string;
  tableId?: string;
  handId?: string;
  principalId?: string;
  sentAt?: number;
}

/**
 * A schema-valid canonical public chat entry. The message id is opaque and
 * never derives from the body, so a secret in the body cannot leak into ids.
 */
export function chatFixture(
  eventSeq: number,
  body: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return ChatMessageSchema.parse({
    messageId: `msg-${eventSeq}`,
    tableId: TEST_TABLE_ID,
    handId: TEST_HAND_ID,
    eventSeq,
    principalId: AGENT_PRINCIPAL_ID,
    body,
    sentAt: eventSeq,
    ...overrides,
  });
}

/** Default chat message shared by store/runtime suites. */
export function chatMessageFixture(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return chatFixture(5, 'hello table', overrides);
}

/** A schema-valid canonical action request bound to the observation turn. */
export function actionRequestFixture(
  observation: SeatObservation = observationFixture(),
  actionId = 'act-check',
): CanonicalActionRequest {
  return CanonicalActionRequestSchema.parse({
    requestId: 'req-1',
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId,
  });
}

/** A schema-valid canonical action receipt bound to the observation turn. */
export function actionReceiptFixture(
  observation: SeatObservation = observationFixture(),
  actionId = 'act-check',
): CanonicalActionReceipt {
  return CanonicalActionReceiptSchema.parse({
    requestId: 'req-1',
    tableId: observation.tableId,
    handId: observation.handId,
    turnId: observation.turnId,
    actionId,
    version: observation.version + 1,
    eventSeq: observation.eventSeq + 1,
    acceptedAt: 1_700_000_000_001,
  });
}

/** The tool-call arguments a fake provider should echo for a happy path. */
export function validActionArguments(): Record<string, unknown> {
  return { actionId: 'act-raise-half', amount: 12, speech: 'raising it up' };
}

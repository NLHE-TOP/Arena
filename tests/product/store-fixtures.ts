/**
 * Store-owned fixtures for product persistence tests.
 *
 * Built and validated with the actual `@pokertools/types` schemas. Kept
 * independent from the provider-owned `fixtures.ts` so store tests do not
 * depend on prompt/provider fixture tuning.
 */
import {
  ActionType,
  CanonicalActionReceiptSchema,
  CanonicalActionRequestSchema,
  ChatMessageSchema,
  PlayerStatus,
  SeatObservationSchema,
  SitInOption,
  Street,
  toPublicWireState,
  type CanonicalActionReceipt,
  type CanonicalActionRequest,
  type ChatMessage,
  type LegalAction,
  type PublicPlayer,
  type PublicState,
  type SeatObservation,
} from '@pokertools/types';

export const HUMAN_PRINCIPAL_ID = 'u:human';
export const AGENT_PRINCIPAL_ID = 'svc:agent-1';
export const TABLE_ID = 'table-1';
export const HAND_ID = 'hand-1';

function makePlayer(overrides: Partial<PublicPlayer> & { id: string; seat: number }): PublicPlayer {
  return {
    name: overrides.id,
    stack: 1000,
    hand: null,
    shownCards: null,
    status: PlayerStatus.ACTIVE,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: null,
    pendingStand: false,
    ...overrides,
  };
}

function makePublicState(): PublicState {
  return {
    config: { smallBlind: 1, bigBlind: 2, maxPlayers: 2, randomProvider: () => 0.5 },
    players: [
      makePlayer({ id: 'p0', seat: 0, hand: ['As', 'Kd'], betThisStreet: 2, totalInvestedThisHand: 2 }),
      makePlayer({ id: 'p1', seat: 1, betThisStreet: 2, totalInvestedThisHand: 2 }),
    ],
    maxPlayers: 2,
    handNumber: 1,
    buttonSeat: 0,
    bigBlindSeat: 1,
    deck: [],
    board: [],
    street: Street.PREFLOP,
    pots: [{ amount: 4, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 2 }],
    currentBets: new Map([
      [0, 2],
      [1, 2],
    ]),
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
    timeBanks: new Map([
      [0, 30],
      [1, 30],
    ]),
    timeBankActiveSeat: null,
    actionHistory: [
      {
        action: { type: ActionType.CHECK, playerId: 'p0' },
        seat: 0,
        resultingPot: 4,
        resultingStack: 998,
        street: Street.PREFLOP,
      },
    ],
    previousStates: [],
    timestamp: 1_700_000_000_000,
    handId: HAND_ID,
    viewingPlayerId: 'p0',
    version: 1,
  };
}

const WIRE_STATE = toPublicWireState(makePublicState());

export const DEFAULT_LEGAL_ACTIONS: readonly LegalAction[] = [
  { actionId: 'act-fold', family: 'FOLD' },
  { actionId: 'act-check', family: 'CHECK' },
  { actionId: 'act-call', family: 'CALL' },
  { actionId: 'act-raise-half', family: 'RAISE', minAmount: 4, maxAmount: 100 },
  { actionId: 'act-raise-all-in', family: 'RAISE', minAmount: 100, maxAmount: 100, amount: 100 },
];

export interface SeatObservationFixtureOptions {
  tableId?: string;
  turnId?: string;
  version?: number;
  eventSeq?: number;
  legalActions?: readonly LegalAction[];
}

/** Fresh mutable observation input (canonical shape, not yet parsed). */
export function observationInput(): Record<string, unknown> {
  return {
    tableId: TABLE_ID,
    handId: HAND_ID,
    turnId: 'turn-1',
    version: WIRE_STATE.version,
    eventSeq: 10,
    state: { ...WIRE_STATE },
    legalActions: DEFAULT_LEGAL_ACTIONS.map((action) => ({ ...action })),
  };
}

/** A schema-valid canonical `SeatObservation`. */
export function observationFixture(): SeatObservation {
  return SeatObservationSchema.parse(observationInput());
}

/** A schema-valid canonical `SeatObservation` with selected fields overridden. */
export function seatObservationFixture(
  options: SeatObservationFixtureOptions = {},
): SeatObservation {
  const input = observationInput();
  input.tableId = options.tableId ?? TABLE_ID;
  input.turnId = options.turnId ?? 'turn-1';
  input.eventSeq = options.eventSeq ?? input.eventSeq;
  if (options.version !== undefined) {
    input.version = options.version;
    (input.state as Record<string, unknown>).version = options.version;
  }
  if (options.legalActions !== undefined) {
    input.legalActions = options.legalActions.map((action) => ({ ...action }));
  }
  return SeatObservationSchema.parse(input);
}

/** A schema-valid canonical `ChatMessage` for the fixture table/hand. */
export function chatFixture(
  eventSeq: number,
  body: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return ChatMessageSchema.parse({
    messageId: `msg-${eventSeq}`,
    tableId: TABLE_ID,
    handId: HAND_ID,
    eventSeq,
    principalId: HUMAN_PRINCIPAL_ID,
    body,
    sentAt: 1_700_000_000_000 + eventSeq,
    ...overrides,
  });
}

/** Default chat message used by store tests. */
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

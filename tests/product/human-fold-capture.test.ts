/**
 * Focused regressions for the human-seat canonical action hooks.
 *
 * The external human-fold regression depends on three contracts:
 * - the exact accepted canonical result is captured (request, receipt and the
 *   EXACT result observation) instead of being discarded;
 * - hole cards, board and deck are sanitized out of every capture and a
 *   card-secret scan fails closed on any regression;
 * - the optional action selection forces exactly the requested legal action
 *   once, and its accepted hook is awaited before the driver continues, while
 *   the default aggressive behavior and pacing remain untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalActionReceiptSchema,
  SeatObservationSchema,
  type CanonicalActionReceipt,
  type CanonicalActionResult,
  type SeatObservation,
} from '@pokertools/types';
import {
  assertNoCardSecrets,
  buildCanonicalActionCapture,
  isCardToken,
  parseCanonicalActionResult,
  sanitizeSeatObservationCards,
  type CapturedCanonicalRequest,
} from '../integration/acceptance/canonical-capture.js';
import {
  driveHumanSeats,
  type HumanActionSelection,
} from '../integration/acceptance/product-room.js';
import type { WalletSession } from '../integration/infra/wallet.js';
import {
  observationInput,
  seatObservationFixture,
  TEST_HAND_ID,
  TEST_TABLE_ID,
  TEST_TURN_ID,
} from './fixtures.js';

function foldResultObservation(): SeatObservation {
  const base = observationInput();
  return SeatObservationSchema.parse({
    ...base,
    version: base.version + 1,
    state: {
      ...base.state,
      version: base.version + 1,
      actionTo: null,
      winners: [{ seat: 1, amount: 3, hand: null, handRank: null }],
    },
  });
}

function receiptFor(request: CapturedCanonicalRequest, observation: SeatObservation): CanonicalActionReceipt {
  return CanonicalActionReceiptSchema.parse({
    requestId: request.requestId,
    tableId: observation.tableId,
    handId: observation.handId,
    turnId: request.turnId,
    actionId: request.actionId,
    version: observation.version,
    eventSeq: observation.eventSeq,
    acceptedAt: 1_700_000_000_002,
  });
}

function canonicalResult(
  request: CapturedCanonicalRequest,
  observation: SeatObservation = foldResultObservation()
): CanonicalActionResult {
  return { receipt: receiptFor(request, observation), observation };
}

interface FakeHuman {
  session: WalletSession;
  requests: CapturedCanonicalRequest[];
}

function fakeHuman(input: {
  observations: () => SeatObservation;
  action: (request: CapturedCanonicalRequest) => Promise<CanonicalActionResult>;
}): FakeHuman {
  const requests: CapturedCanonicalRequest[] = [];
  const session = {
    client: {
      getObservation: async (_tableId: string) => input.observations(),
      action: async (_tableId: string, request: CapturedCanonicalRequest) => {
        requests.push(request);
        return input.action(request);
      },
    },
  } as unknown as WalletSession;
  return { session, requests };
}

const FOLD_ACTION = { actionId: 'act-fold', family: 'FOLD' as const };

function chooseFold(observation: SeatObservation) {
  const fold = observation.legalActions.find((action) => action.family === 'FOLD');
  return fold ? { action: fold } : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canonical capture card hygiene', () => {
  it('sanitizes every card-bearing field while preserving the public fold boundary', () => {
    const observation = foldResultObservation();
    // The fixture carries a real hole-card pair for the viewing seat.
    expect(observation.state.players[0]!.hand).toEqual(['As', 'Kd']);
    const sanitized = sanitizeSeatObservationCards(observation);
    expect(sanitized.state.deck).toEqual([]);
    expect(sanitized.state.board).toEqual([]);
    for (const player of sanitized.state.players) {
      expect(player?.hand ?? null).toBeNull();
      expect(player?.shownCards ?? null).toBeNull();
    }
    expect(sanitized.state.winners).toEqual([{ seat: 1, amount: 3, hand: null, handRank: null }]);
    expect(sanitized.handId).toBe(TEST_HAND_ID);
    expect(sanitized.version).toBe(observation.version);
    expect(sanitized.legalActions).toEqual(observation.legalActions);
    // The original observation is never mutated.
    expect(observation.state.players[0]!.hand).toEqual(['As', 'Kd']);
    expect(() => assertNoCardSecrets('sanitized capture', sanitized)).not.toThrow();
  });

  it('fails closed on a non-empty deck, board, hand or shownCards, or a card token', () => {
    const observation = foldResultObservation();
    const base = sanitizeSeatObservationCards(observation);
    const withDeck = structuredClone(base);
    withDeck.state.deck = [3, 17];
    expect(() => assertNoCardSecrets('deck', withDeck)).toThrow(/deck carries 2 card value/);
    const withBoard = structuredClone(base);
    withBoard.state.board = ['Ah'];
    expect(() => assertNoCardSecrets('board', withBoard)).toThrow(/board carries 1 card value/);
    const withHand = structuredClone(base);
    withHand.state.players[1]!.hand = ['2c'];
    expect(() => assertNoCardSecrets('hand', withHand)).toThrow(/hand carries 1 card value/);
    const withShown = structuredClone(base);
    withShown.state.players[0]!.shownCards = [7];
    expect(() => assertNoCardSecrets('shown', withShown)).toThrow(/shownCards carries 1 card value/);
    const withWinnerHand = structuredClone(base);
    withWinnerHand.state.winners![0]!.hand = ['Ks'];
    expect(() => assertNoCardSecrets('winner', withWinnerHand)).toThrow(/hand carries 1 card value/);
    expect(() => assertNoCardSecrets('token', { value: 'Ah' })).toThrow(/card token/);
    expect(isCardToken('10h')).toBe(true);
    expect(isCardToken('hand-1')).toBe(false);
  });
});

describe('canonical capture construction', () => {
  const request: CapturedCanonicalRequest = {
    requestId: 'req-fold-1',
    turnId: TEST_TURN_ID,
    expectedVersion: 4,
    actionId: 'act-fold',
  };

  it('builds a coherent capture from the exact accepted result and sanitizes it', () => {
    const capture = buildCanonicalActionCapture({
      family: 'FOLD',
      request,
      result: canonicalResult(request),
      acceptedAt: Date.now(),
    });
    expect(capture.family).toBe('FOLD');
    expect(capture.request).toEqual(request);
    expect(capture.receipt.requestId).toBe('req-fold-1');
    expect(capture.receipt.tableId).toBe(TEST_TABLE_ID);
    expect(capture.observation.state.winners).toHaveLength(1);
    expect(capture.observation.state.players[0]!.hand).toBeNull();
    expect(() => assertNoCardSecrets('capture', capture)).not.toThrow();
  });

  it('refuses a receipt that does not identify the submitted request', () => {
    const mismatch = { ...request, requestId: 'other' };
    expect(() =>
      buildCanonicalActionCapture({
        family: 'FOLD',
        request,
        result: canonicalResult(mismatch),
        acceptedAt: Date.now(),
      })
    ).toThrow(/requestId/);
    expect(() =>
      buildCanonicalActionCapture({
        family: 'FOLD',
        request,
        result: canonicalResult({ ...request, actionId: 'act-check' }),
        acceptedAt: Date.now(),
      })
    ).toThrow(/actionId/);
  });

  it('validates the canonical response contract before trusting a 2xx body', () => {
    const result = canonicalResult(request);
    expect(parseCanonicalActionResult(result)).toBe(result);
    expect(() => parseCanonicalActionResult(null)).toThrow(/not an object/);
    expect(() => parseCanonicalActionResult({ receipt: { requestId: 'x' } })).toThrow(/observation/);
    expect(() =>
      parseCanonicalActionResult({ ...result, receipt: { ...result.receipt, requestId: '' } })
    ).toThrow(/requestId/);
    const mismatched = { ...result, observation: { ...result.observation, tableId: 'other-table' } };
    expect(() => parseCanonicalActionResult(mismatched)).toThrow(/tableId/);
  });
});

describe('human seat forced action selection', () => {
  it('forces the first legal FOLD once and awaits the accepted capture hook before continuing', async () => {
    const foldObservation = seatObservationFixture();
    const aggressiveObservation = seatObservationFixture({ version: 9, turnId: 'turn-2' });
    let observations = 0;
    let terminal = false;
    let hookStarted = false;
    let observationsAfterHookStart = 0;
    const captures: Array<Awaited<ReturnType<typeof buildCanonicalActionCapture>>> = [];
    const choices: string[] = [];
    let resolveHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      resolveHook = resolve;
    });
    const human = fakeHuman({
      observations: () => {
        observations += 1;
        if (hookStarted) observationsAfterHookStart += 1;
        return observations === 1 ? foldObservation : aggressiveObservation;
      },
      action: async (request) => canonicalResult(request, foldResultObservation()),
    });
    const run = driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      actionSelection: {
        choose: (observation) => {
          const fold = observation.legalActions.find((action) => action.family === 'FOLD');
          if (!fold) return null;
          choices.push(fold.family);
          return { action: fold };
        },
        onAccepted: async (capture) => {
          hookStarted = true;
          captures.push(capture);
          await hookGate;
        },
      },
    });
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    // The driver is blocked inside the accepted hook: no further observation
    // sweep may happen (and therefore no further action) before it resolves.
    expect(observationsAfterHookStart).toBe(0);
    resolveHook();
    terminal = true;
    const stats = await run;
    expect(stats.actions).toBe(1);
    expect(observations).toBe(1);
    expect(human.requests[0]!.actionId).toBe('act-fold');
    expect(captures[0]!.request.requestId).toBe(human.requests[0]!.requestId);
    expect(captures[0]!.receipt.actionId).toBe('act-fold');
    expect(captures[0]!.observation.state.winners).toHaveLength(1);
    expect(captures[0]!.observation.state.players[0]!.hand).toBeNull();
    // The selection is consumed after its first accepted action (default once):
    // choose would have been consulted again on the second sweep otherwise.
    expect(choices).toEqual(['FOLD']);
  });

  it('keeps the default aggressive policy for a turn the selection declines', async () => {
    let terminal = false;
    const chosen: string[] = [];
    const human = fakeHuman({
      observations: () => seatObservationFixture(),
      action: async (request) => {
        terminal = true;
        return canonicalResult(request, seatObservationFixture({ version: 7 }));
      },
    });
    const selection: HumanActionSelection = {
      choose: (observation) => {
        const fold = observation.legalActions.find((action) => action.family === 'FOLD');
        if (!fold) return null;
        chosen.push('fold');
        return { action: fold };
      },
    };
    // Patch the fixture menu to remove FOLD: the selection declines, and the
    // default aggressive policy (maximum RAISE) must be used instead.
    const noFold = seatObservationFixture({
      legalActions: seatObservationFixture().legalActions.filter((action) => action.family !== 'FOLD'),
    });
    human.session.client.getObservation = async () => noFold;
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      actionSelection: selection,
    });
    expect(stats.actions).toBe(1);
    expect(chosen).toEqual([]);
    expect(human.requests[0]!.actionId).toBe('act-raise-half');
    expect(human.requests[0]!.amount).toBe(40);
  });

  it('captures the accepted result of a selected action that needed a 429 retry', async () => {
    const capture = { current: null as CanonicalActionResult | null };
    let attempts = 0;
    let terminal = false;
    const human = fakeHuman({
      observations: () => seatObservationFixture(),
      action: async (request) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Rate limit exceeded, retry in 0 seconds'), {
            statusCode: 429,
            details: { retryAfterMs: 5 },
          });
        }
        terminal = true;
        return canonicalResult(request);
      },
    });
    const captures: unknown[] = [];
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxDelayMs: 1_000 },
      actionSelection: { choose: chooseFold, onAccepted: (result) => void captures.push(result) },
    });
    expect(attempts).toBe(2);
    expect(human.requests[1]!.requestId).toBe(human.requests[0]!.requestId);
    expect(stats.rateLimitRetries).toBe(1);
    expect(captures).toHaveLength(1);
    expect(capture.current).toBeNull();
  });

  it('rejects a selection outside the server-issued legal menu', async () => {
    const human = fakeHuman({
      observations: () => seatObservationFixture({ legalActions: [{ actionId: 'act-check', family: 'CHECK' }] }),
      action: async (request) => canonicalResult(request),
    });
    await expect(
      driveHumanSeats({
        humans: [human.session],
        tableId: TEST_TABLE_ID,
        isTerminal: () => false,
        pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
        actionSelection: { choose: () => ({ action: FOLD_ACTION }) },
      })
    ).rejects.toThrow(/outside the server-issued legal menu/);
  });

  it('never consults the selection when no selection callback is configured', async () => {
    let terminal = false;
    const human = fakeHuman({
      observations: () => seatObservationFixture(),
      action: async (request) => {
        terminal = true;
        return canonicalResult(request);
      },
    });
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
    });
    // Unchanged default: maximum RAISE.
    expect(stats.actions).toBe(1);
    expect(human.requests[0]!.actionId).toBe('act-raise-half');
    expect(human.requests[0]!.amount).toBe(40);
  });
});

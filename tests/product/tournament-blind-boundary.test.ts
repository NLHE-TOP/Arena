/**
 * Focused offline regressions for the deterministic competition-backed
 * tournament blind-boundary acceptance helpers
 * (`tests/integration/acceptance/tournament-blind-boundary.ts`).
 *
 * No platform, Docker or network is used: the replay projection, the strict
 * acceptance checks and the canonical action policy are pure and are exercised
 * with synthetic replay frames and observations.
 */
import { describe, expect, it } from 'vitest';
import type { BlindLevel, ReplayFrame, ReplayFrameEvent, SeatObservation } from '@pokertools/types';
import {
  analyzeTournamentReplay,
  assertTournamentBlindBoundaryEvidence,
  chooseBlindBoundaryAction,
  type BlindBoundaryEvidenceInput,
} from '../integration/acceptance/tournament-blind-boundary.js';

/** Synthetic public structure; the real one comes from the table state. */
const PUBLIC_STRUCTURE: readonly BlindLevel[] = [
  { smallBlind: 10, bigBlind: 20, ante: 0 },
  { smallBlind: 15, bigBlind: 30, ante: 0 },
  { smallBlind: 23, bigBlind: 46, ante: 5 },
  { smallBlind: 35, bigBlind: 70, ante: 8 },
];

function replayEvent(input: {
  eventSeq: number;
  type: ReplayFrameEvent['type'];
  occurredAt: number;
  payload?: Record<string, unknown>;
  requestId?: string | null;
}): ReplayFrameEvent {
  return {
    eventId: `event-${input.eventSeq}`,
    tableId: 'table-1',
    eventSeq: input.eventSeq,
    version: input.eventSeq,
    type: input.type,
    occurredAt: input.occurredAt,
    payload: input.payload ?? {},
    previousHash: null,
    hash: `hash-${input.eventSeq}`,
    requestId: input.requestId ?? null,
  };
}

function frame(events: ReplayFrameEvent[], chainValid = true): ReplayFrame {
  const lastSeq = events.at(-1)?.eventSeq ?? 1;
  return {
    tableId: 'table-1',
    fromEventSeq: 1,
    toEventSeq: lastSeq,
    anchorHash: null,
    headEventSeq: lastSeq,
    events,
    chainValid,
  };
}

function handStarted(eventSeq: number, handNumber: number, occurredAt: number): ReplayFrameEvent {
  return replayEvent({
    eventSeq,
    type: 'HAND_STARTED',
    occurredAt,
    payload: { handId: `hand-${handNumber}`, handNumber, buttonSeat: 0 },
  });
}

function handCompleted(eventSeq: number, handNumber: number, occurredAt: number): ReplayFrameEvent {
  return replayEvent({
    eventSeq,
    type: 'HAND_COMPLETED',
    occurredAt,
    payload: { handId: `hand-${handNumber}`, handNumber },
  });
}

function action(
  eventSeq: number,
  occurredAt: number,
  actionName: string,
  handNumber: number,
  requestId: string | null
): ReplayFrameEvent {
  return replayEvent({
    eventSeq,
    type: 'ACTION_APPLIED',
    occurredAt,
    payload: { action: actionName, handId: `hand-${handNumber}`, handNumber },
    requestId,
  });
}

/**
 * Four hands: two complete before the 16s blind advance, two after, one
 * accepted action per hand (fold-first pre-boundary, shove/call post).
 */
function boundaryScenarioEvents(): ReplayFrameEvent[] {
  return [
    handStarted(1, 1, 1_000),
    action(2, 1_100, 'FOLD', 1, 'request-1'),
    handCompleted(3, 1, 1_200),
    handStarted(4, 2, 7_000),
    action(5, 7_100, 'FOLD', 2, 'request-2'),
    handCompleted(6, 2, 7_200),
    action(7, 16_000, 'NEXT_BLIND_LEVEL', 2, null),
    handStarted(8, 3, 17_000),
    action(9, 17_500, 'RAISE', 3, 'request-3'),
    handCompleted(10, 3, 18_000),
    handStarted(11, 4, 18_100),
    action(12, 18_500, 'CALL', 4, 'request-4'),
    handCompleted(13, 4, 19_000),
  ];
}

function evidence(overrides: Partial<BlindBoundaryEvidenceInput> = {}): BlindBoundaryEvidenceInput {
  const replay = frame(boundaryScenarioEvents());
  return {
    replay,
    analysis: analyzeTournamentReplay(replay.events),
    structure: PUBLIC_STRUCTURE,
    initial: { blindLevel: 0, smallBlind: 10, bigBlind: 20 },
    observed: { blindLevel: 1, smallBlind: 15, bigBlind: 30 },
    startedAtMs: 0,
    minimumHands: 2,
    minimumAdvanceDelayMs: 10_000,
    ...overrides,
  };
}

function observation(families: Array<{ family: string; actionId?: string; maxAmount?: number }>): SeatObservation {
  return {
    legalActions: families.map((entry, index) => ({
      actionId: entry.actionId ?? `action-${entry.family}-${index}`,
      family: entry.family,
      ...(entry.maxAmount !== undefined ? { maxAmount: entry.maxAmount } : {}),
    })),
  } as unknown as SeatObservation;
}

describe('analyzeTournamentReplay', () => {
  it('projects sequential hands, the blind advance and accepted request ids', () => {
    const analysis = analyzeTournamentReplay(boundaryScenarioEvents());
    expect(analysis.handStarts.map((hand) => hand.handNumber)).toEqual([1, 2, 3, 4]);
    expect(analysis.handStarts.map((hand) => hand.handId)).toEqual(['hand-1', 'hand-2', 'hand-3', 'hand-4']);
    expect(analysis.handCompletions.map((hand) => hand.handId)).toEqual(['hand-1', 'hand-2', 'hand-3', 'hand-4']);
    expect(analysis.blindAdvances).toHaveLength(1);
    expect(analysis.blindAdvances[0]!.occurredAt).toBe(16_000);
    expect(analysis.requestIds).toEqual(['request-1', 'request-2', 'request-3', 'request-4']);
    expect(analysis.manualDealActions).toEqual([]);
    expect(analysis.duplicateHandStarts).toEqual([]);
    expect(analysis.duplicateHandCompletions).toEqual([]);
    expect(analysis.duplicateRequestIds).toEqual([]);
  });

  it('flags duplicate hand starts, duplicate completions, duplicate request ids and manual DEAL', () => {
    const events = [
      handStarted(1, 1, 1_000),
      handStarted(2, 1, 1_100),
      action(3, 1_200, 'DEAL', 1, null),
      action(4, 1_300, 'FOLD', 1, 'request-dup'),
      action(5, 1_400, 'CALL', 1, 'request-dup'),
      handCompleted(6, 1, 1_500),
      handCompleted(7, 1, 1_600),
    ];
    const analysis = analyzeTournamentReplay(events);
    expect(analysis.duplicateHandStarts).toEqual(['hand-1']);
    expect(analysis.duplicateHandCompletions).toEqual(['hand-1']);
    expect(analysis.duplicateRequestIds).toEqual(['request-dup']);
    expect(analysis.manualDealActions).toHaveLength(1);
  });

  it('rejects a HAND_STARTED event without hand identity', () => {
    expect(() => analyzeTournamentReplay([replayEvent({ eventSeq: 1, type: 'HAND_STARTED', occurredAt: 1 })])).toThrow(
      /missing handId\/handNumber/
    );
  });
});

describe('assertTournamentBlindBoundaryEvidence', () => {
  it('accepts a real worker boundary crossed while hands finish', () => {
    expect(() => assertTournamentBlindBoundaryEvidence(evidence())).not.toThrow();
  });

  it('rejects an invalid replay chain', () => {
    const input = evidence();
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: { ...input.replay, chainValid: false } })
    ).toThrow(/hash chain/);
  });

  it('rejects non-sequential hand numbers and missing completions', () => {
    const input = evidence();
    const broken = frame([
      handStarted(1, 1, 1_000),
      handCompleted(2, 1, 1_100),
      handStarted(3, 3, 7_000),
      handCompleted(4, 3, 7_100),
      action(5, 16_000, 'NEXT_BLIND_LEVEL', 3, null),
    ]);
    const brokenAnalysis = analyzeTournamentReplay(broken.events);
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: broken, analysis: brokenAnalysis })
    ).toThrow(/not sequential/);
  });

  it('rejects a boundary that did not cross during hands', () => {
    const input = evidence();
    const broken = frame([
      action(1, 16_000, 'NEXT_BLIND_LEVEL', 0, null),
      handStarted(2, 1, 17_000),
      handCompleted(3, 1, 17_100),
      handStarted(4, 2, 23_000),
      handCompleted(5, 2, 23_100),
    ]);
    const brokenAnalysis = analyzeTournamentReplay(broken.events);
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: broken, analysis: brokenAnalysis })
    ).toThrow(/did not cross during hands/);
  });

  it('rejects a manual (too early) blind advance', () => {
    const input = evidence();
    const broken = frame([
      handStarted(1, 1, 100),
      handCompleted(2, 1, 150),
      action(3, 200, 'NEXT_BLIND_LEVEL', 1, null),
      handStarted(4, 2, 300),
      handCompleted(5, 2, 350),
    ]);
    const brokenAnalysis = analyzeTournamentReplay(broken.events);
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: broken, analysis: brokenAnalysis })
    ).toThrow(/manual advance/);
  });

  it('rejects observed blinds that do not match the public structure level', () => {
    expect(() =>
      assertTournamentBlindBoundaryEvidence(evidence({ observed: { blindLevel: 1, smallBlind: 99, bigBlind: 30 } }))
    ).toThrow(/do not match structure level/);
  });

  it('rejects a public structure that is not strictly increasing', () => {
    expect(() =>
      assertTournamentBlindBoundaryEvidence(
        evidence({
          structure: [
            { smallBlind: 10, bigBlind: 20, ante: 0 },
            { smallBlind: 10, bigBlind: 20, ante: 0 },
          ],
        })
      )
    ).toThrow(/not strictly increasing/);
  });

  it('rejects initial blinds that do not match public structure level 0', () => {
    expect(() =>
      assertTournamentBlindBoundaryEvidence(evidence({ initial: { blindLevel: 0, smallBlind: 5, bigBlind: 10 } }))
    ).toThrow(/do not match structure level 0/);
  });

  it('rejects duplicate accepted-action request ids', () => {
    const input = evidence();
    const broken = frame([
      handStarted(1, 1, 1_000),
      action(2, 1_100, 'FOLD', 1, 'request-1'),
      action(3, 1_150, 'FOLD', 1, 'request-1'),
      handCompleted(4, 1, 1_200),
      handStarted(5, 2, 7_000),
      action(6, 7_100, 'FOLD', 2, 'request-2'),
      handCompleted(7, 2, 7_200),
      action(8, 16_000, 'NEXT_BLIND_LEVEL', 2, null),
      handStarted(9, 3, 17_000),
      action(10, 17_500, 'RAISE', 3, 'request-3'),
      handCompleted(11, 3, 18_000),
      handStarted(12, 4, 18_100),
      action(13, 18_500, 'CALL', 4, 'request-4'),
      handCompleted(14, 4, 19_000),
    ]);
    const brokenAnalysis = analyzeTournamentReplay(broken.events);
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: broken, analysis: brokenAnalysis })
    ).toThrow(/duplicate accepted-action requestId/);
  });

  it('rejects a manual DEAL action event', () => {
    const input = evidence();
    const broken = frame([
      handStarted(1, 1, 1_000),
      action(2, 1_050, 'DEAL', 1, null),
      handCompleted(3, 1, 1_200),
      handStarted(4, 2, 7_000),
      action(5, 7_100, 'FOLD', 2, 'request-2'),
      handCompleted(6, 2, 7_200),
      action(7, 16_000, 'NEXT_BLIND_LEVEL', 2, null),
      handStarted(8, 3, 17_000),
      action(9, 17_500, 'RAISE', 3, 'request-3'),
      handCompleted(10, 3, 18_000),
    ]);
    const brokenAnalysis = analyzeTournamentReplay(broken.events);
    expect(() =>
      assertTournamentBlindBoundaryEvidence({ ...input, replay: broken, analysis: brokenAnalysis })
    ).toThrow(/manual DEAL/);
  });
});

describe('chooseBlindBoundaryAction', () => {
  it('folds first before the boundary and checks when folding is not legal', () => {
    const fold = chooseBlindBoundaryAction(
      observation([{ family: 'FOLD' }, { family: 'CALL' }, { family: 'RAISE', maxAmount: 500 }]),
      'pre-boundary'
    );
    expect(fold.action.family).toBe('FOLD');
    expect(fold.amount).toBeUndefined();

    const check = chooseBlindBoundaryAction(
      observation([{ family: 'CHECK' }, { family: 'BET', maxAmount: 20 }]),
      'pre-boundary'
    );
    expect(check.action.family).toBe('CHECK');
  });

  it('shoves the maximum after the boundary and falls back to call/check/fold', () => {
    const shove = chooseBlindBoundaryAction(
      observation([{ family: 'FOLD' }, { family: 'CALL' }, { family: 'RAISE', maxAmount: 500 }]),
      'post-boundary'
    );
    expect(shove.action.family).toBe('RAISE');
    expect(shove.amount).toBe(500);

    const bet = chooseBlindBoundaryAction(observation([{ family: 'BET', maxAmount: 80 }]), 'post-boundary');
    expect(bet.action.family).toBe('BET');
    expect(bet.amount).toBe(80);

    const call = chooseBlindBoundaryAction(observation([{ family: 'FOLD' }, { family: 'CALL' }]), 'post-boundary');
    expect(call.action.family).toBe('CALL');

    const check = chooseBlindBoundaryAction(observation([{ family: 'CHECK' }, { family: 'FOLD' }]), 'post-boundary');
    expect(check.action.family).toBe('CHECK');

    const fold = chooseBlindBoundaryAction(observation([{ family: 'FOLD' }]), 'post-boundary');
    expect(fold.action.family).toBe('FOLD');
  });

  it('throws when the legal menu carries no usable action', () => {
    expect(() => chooseBlindBoundaryAction(observation([]), 'post-boundary')).toThrow(/no RAISE\/BET\/CALL\/CHECK\/FOLD/);
  });
});

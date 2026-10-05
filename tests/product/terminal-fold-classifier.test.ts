/**
 * Focused regressions for the terminal-fold evidence classifier.
 *
 * The external human-fold regression must never PASS on partial evidence: an
 * unresolved fold hand (no HAND_COMPLETED / archive obligation / director
 * progression), a missing winner set, an incomplete operator diagnostic packet,
 * duplicated exchanges, a manual DEAL, a platform 429 or an un-scanned action
 * payload each fail with a named check.
 */
import { describe, expect, it } from 'vitest';
import {
  PlayerStatus,
  SeatObservationSchema,
  type CanonicalActionReceipt,
  type CanonicalActionResult,
  type SeatObservation,
} from '@pokertools/types';
import {
  buildCanonicalActionCapture,
  type CanonicalActionCapture,
  type CapturedCanonicalRequest,
} from '../integration/acceptance/canonical-capture.js';
import {
  BULLMQ_JOB_STATE_SCRIPT,
  classifyTerminalFold,
  validateTerminalFoldCandidate,
  type TerminalFoldInputs,
} from '../integration/container-terminal-fold.js';
import { DEFAULT_RELEASE_PLATFORM_VERSION } from '../integration/infra/provenance.js';
import type { TerminalDiagnosticsBundle } from '../integration/acceptance/terminal-diagnostics.js';
import {
  observationInput,
  TEST_HAND_ID,
  TEST_TABLE_ID,
  TEST_TURN_ID,
} from './fixtures.js';

const REQUEST: CapturedCanonicalRequest = {
  requestId: 'req-fold-1',
  turnId: TEST_TURN_ID,
  expectedVersion: 4,
  actionId: 'act-fold',
};

function foldObservation(
  winners = true,
  stateOverrides: Partial<SeatObservation['state']> = {}
): SeatObservation {
  const base = observationInput();
  // Exact settled fold state: the human folded in the sole-contender shape, no
  // money remains in pots/currentBets, and the two stacks still sum to the
  // initial 2 x 1000 chips (the transferred pot stays inside the table).
  const settledPlayers = base.state.players.map((player, index) =>
    player === null
      ? null
      : index === 0
        ? {
            ...player,
            status: 'FOLDED',
            stack: 999,
            betThisStreet: 1,
            totalInvestedThisHand: 1,
            isSittingOut: true,
          }
        : {
            ...player,
            status: 'ACTIVE',
            stack: 1001,
            betThisStreet: 1,
            totalInvestedThisHand: 1,
            isSittingOut: false,
          }
  );
  return SeatObservationSchema.parse({
    ...base,
    version: base.version + 1,
    state: {
      ...base.state,
      street: 'SHOWDOWN',
      actionTo: null,
      pots: [],
      currentBets: {},
      winners: winners ? [{ seat: 1, amount: 2, hand: null, handRank: null }] : null,
      players: settledPlayers,
      ...stateOverrides,
      version: base.version + 1,
    },
  });
}

function capture(
  winners = true,
  stateOverrides: Partial<SeatObservation['state']> = {}
): CanonicalActionCapture {
  const observation = foldObservation(winners, stateOverrides);
  const receipt: CanonicalActionReceipt = {
    requestId: REQUEST.requestId,
    tableId: TEST_TABLE_ID,
    handId: observation.handId,
    turnId: REQUEST.turnId,
    actionId: REQUEST.actionId,
    version: observation.version,
    eventSeq: observation.eventSeq,
    acceptedAt: 1_700_000_000_001,
  };
  const result: CanonicalActionResult = { receipt, observation };
  return buildCanonicalActionCapture({
    family: 'FOLD',
    request: REQUEST,
    result,
    acceptedAt: 1_700_000_000_002,
  });
}

/** Mutable copy of the settled fold state's players for chip invariant tests. */
function settledPlayers(): SeatObservation['state']['players'] {
  return foldObservation().state.players.map((player) => (player === null ? null : { ...player }));
}

function bundle(overrides: Record<string, unknown> = {}): TerminalDiagnosticsBundle {
  return {
    version: 1,
    collectedAt: '2026-10-05T00:00:00.000Z',
    identifiers: {
      roomId: 'room-1',
      tableId: TEST_TABLE_ID,
      competitionId: 'comp-1',
      handId: TEST_HAND_ID,
      requestId: REQUEST.requestId,
      turnId: REQUEST.turnId,
    },
    collection: { status: 'COMPLETE', error: null },
    table: {
      id: TEST_TABLE_ID,
      status: 'OPEN',
      stateVersion: 12,
      eventSeq: 20,
      state: {
        handId: TEST_HAND_ID,
        handNumber: 1,
        street: 'SHOWDOWN',
        actionTo: null,
        winners: [],
        players: [],
        currentBets: {},
        pots: [],
        present: true,
        missing: [],
      },
    },
    events: [
      {
        id: 'evt-completed',
        eventSeq: 12,
        type: 'HAND_COMPLETED',
        version: 9,
        turnId: null,
        requestId: null,
        actionId: null,
        handId: TEST_HAND_ID,
        action: null,
      },
    ],
    subsequentHandStarts: [
      {
        id: 'evt-next',
        eventSeq: 15,
        type: 'HAND_STARTED',
        version: 10,
        turnId: null,
        requestId: null,
        actionId: null,
        handId: 'hand-2',
        action: null,
      },
    ],
    foldReceipt: {
      id: 'receipt-row',
      requestId: REQUEST.requestId,
      principalId: 'human-1',
      turnId: REQUEST.turnId,
      actionId: REQUEST.actionId,
      expectedVersion: REQUEST.expectedVersion,
      status: 'APPLIED',
      resultVersion: 5,
      eventSeq: 11,
      errorCode: null,
      // Durable exact observation snapshot used when the HTTP capture never
      // resolved: same settled sole-contender state (stacks sum to initial).
      observation: {
        tableId: TEST_TABLE_ID,
        handId: TEST_HAND_ID,
        turnId: REQUEST.turnId,
        version: 6,
        eventSeq: 12,
        state: {
          handId: TEST_HAND_ID,
          handNumber: 1,
          street: 'SHOWDOWN',
          actionTo: null,
          winners: [{ seat: 1, amount: 2, handRank: null }],
          players: [
            {
              id: 'entrant-1',
              seat: 0,
              status: 'FOLDED',
              stack: 999,
              betThisStreet: 1,
              totalInvestedThisHand: 1,
              isSittingOut: true,
            },
            {
              id: 'entrant-2',
              seat: 1,
              status: 'ACTIVE',
              stack: 1001,
              betThisStreet: 1,
              totalInvestedThisHand: 1,
              isSittingOut: false,
            },
          ],
          currentBets: {},
          pots: [],
          present: true,
          missing: [],
        },
      },
    },
    outbox: [
      {
        id: 'outbox-archive',
        kind: 'archive-hand',
        status: 'COMPLETED',
        attempts: 1,
        dedupeKey: 'dedupe-archive',
        availableAt: '2026-10-05T00:00:01.000Z',
        createdAt: '2026-10-05T00:00:00.500Z',
        updatedAt: '2026-10-05T00:00:02.000Z',
        lastError: null,
        payload: { handId: TEST_HAND_ID },
        jobState: null,
      },
      {
        id: 'outbox-next',
        kind: 'next-hand',
        status: 'COMPLETED',
        attempts: 1,
        dedupeKey: 'dedupe-next',
        availableAt: '2026-10-05T00:00:01.000Z',
        createdAt: '2026-10-05T00:00:00.500Z',
        updatedAt: '2026-10-05T00:00:02.000Z',
        lastError: null,
        payload: { handId: TEST_HAND_ID },
        jobState: null,
      },
    ],
    handHistory: { exists: true, id: TEST_HAND_ID, timestamp: '2026-10-05T00:00:02.000Z' },
    competition: {
      id: 'comp-1',
      mode: 'NONFINANCIAL',
      status: 'FINISHED',
      startingStack: 1000,
      smallBlind: 1,
      bigBlind: 2,
      entryAssetId: null,
      entryAmountAtomic: null,
      prizeAssetId: null,
      prizeAmountAtomic: null,
      prizeStatus: 'NOT_APPLICABLE',
      tournamentId: 'tour-1',
      startedAt: '2026-10-05T00:00:00.000Z',
      finishedAt: '2026-10-05T00:01:00.000Z',
      cancelledAt: null,
    },
    tournament: {
      id: 'tour-1',
      status: 'FINISHED',
      startingStack: 1000,
      buyIn: 0,
      fee: 0,
      maxPlayers: 2,
      tableId: TEST_TABLE_ID,
      startedAt: '2026-10-05T00:00:00.000Z',
      finishedAt: '2026-10-05T00:01:00.000Z',
    },
    entrants: [
      {
        id: 'entrant-1',
        principalId: 'human-1',
        kind: 'WALLET',
        seat: 0,
        entryState: 'NOT_REQUIRED',
        tournamentEntryId: null,
        tournamentStatus: 'ACTIVE',
        placement: 2,
        currentSeat: null,
        currentTableId: null,
        prizeAtomic: '0',
        authoritativeStack: 0,
      },
      {
        id: 'entrant-2',
        principalId: 'agent-1',
        kind: 'SERVICE',
        seat: 1,
        entryState: 'NOT_REQUIRED',
        tournamentEntryId: null,
        tournamentStatus: 'ACTIVE',
        placement: 1,
        currentSeat: null,
        currentTableId: null,
        prizeAtomic: '0',
        authoritativeStack: 2000,
      },
    ],
    reconciliation: {
      id: 'reconcile-1',
      eventSeq: 30,
      type: 'TOURNAMENT_RECONCILED',
      requestRef: null,
      stateFingerprint: 'fingerprint',
      occurredAt: '2026-10-05T00:01:00.000Z',
      payload: {},
    },
    contract: {
      capture: 'complete',
      table: 'present',
      hand: 'present',
      competition: 'present',
      tournament: 'present',
      receipt: 'present',
      handCompleted: 'present',
      handHistory: 'present',
      outbox: 'present',
    },
    metrics: null,
    apiLogWarning: null,
    warnings: [],
    ...overrides,
  } as unknown as TerminalDiagnosticsBundle;
}

function inputs(overrides: Partial<TerminalFoldInputs> = {}): TerminalFoldInputs {
  return {
    roomStatus: 'COMPLETE',
    capture: capture(),
    replay: {
      handStarts: [
        { handId: TEST_HAND_ID, handNumber: 1, occurredAt: 1 },
        { handId: 'hand-2', handNumber: 2, occurredAt: 2 },
      ],
      handCompletions: [{ handId: TEST_HAND_ID, occurredAt: 2 }],
      manualDealActions: [],
      duplicateRequestIds: [],
    },
    diagnostics: bundle(),
    competition: { settlementReady: true, status: 'FINISHED' },
    platform429: 0,
    secretScan: 'pass',
    noCardSecrets: true,
    noDuplicateAttempts: true,
    noDuplicateProviderTurns: true,
    ...overrides,
  };
}

function check(verdict: ReturnType<typeof classifyTerminalFold>, name: string): boolean {
  const found = verdict.checks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing check ${name}`);
  return found.pass;
}

describe('bullmq job-state read script', () => {
  it('dispatches membership by Redis type instead of a list-only LPOS', () => {
    // Regression: an unconditional LPOS against the present `completed` zset
    // raised WRONGTYPE, so every executed job read `unavailable` and failed the
    // mandatory diagnostics completeness with `job-state-unreadable`.
    expect(BULLMQ_JOB_STATE_SCRIPT).toMatch(/redis\.call\('TYPE',key\)\['ok'\]/);
    expect(BULLMQ_JOB_STATE_SCRIPT).toMatch(
      /if t=='list' then[\s\S]*?LPOS[\s\S]*?elseif t=='zset' then[\s\S]*?ZSCORE[\s\S]*?elseif t=='set' then[\s\S]*?SISMEMBER/
    );
    expect(BULLMQ_JOB_STATE_SCRIPT).not.toMatch(/LPOS', p\.\.k/);
  });

  it('reports an absent job as captured missing evidence, never as a state', () => {
    expect(BULLMQ_JOB_STATE_SCRIPT).toMatch(/EXISTS', p\.\.id\)==0 then return \{'missing'/);
    expect(BULLMQ_JOB_STATE_SCRIPT).toMatch(/local st='unknown'/);
  });
});

describe('terminal fold candidate validator', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;
  // A clearly synthetic, never-published version: the local candidate pointer
  // must never equal the currently released default (2.0.4), and must stay
  // below any next real release.
  const SYNTHETIC_CANDIDATE_VERSION = '9.9.9';

  it('accepts the exact local candidate identity for a synthetic unreleased version', () => {
    expect(validateTerminalFoldCandidate({ version: SYNTHETIC_CANDIDATE_VERSION, imageId })).toEqual({
      version: SYNTHETIC_CANDIDATE_VERSION,
      imageId,
    });
  });

  it('rejects the currently released official version and malformed versions', () => {
    expect(() =>
      validateTerminalFoldCandidate({ version: DEFAULT_RELEASE_PLATFORM_VERSION, imageId })
    ).toThrow(/released official/);
    for (const version of ['latest', '9.9', 'v9.9.9', '9.9.9-rc1', '', 4]) {
      expect(() => validateTerminalFoldCandidate({ version, imageId })).toThrow(/exact x\.y\.z/);
    }
  });

  it('rejects mutable tags, registry digests, malformed IDs and extra fields', () => {
    for (const bad of [
      'nlhe-product:container-gate',
      `ghcr.io/x@sha256:${'a'.repeat(64)}`,
      'sha256:abc',
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      42,
      null,
    ]) {
      expect(() =>
        validateTerminalFoldCandidate({ version: SYNTHETIC_CANDIDATE_VERSION, imageId: bad })
      ).toThrow(/exact local Docker image ID/);
    }
    expect(() =>
      validateTerminalFoldCandidate({ version: SYNTHETIC_CANDIDATE_VERSION, imageId, extra: true })
    ).toThrow(/unsupported field/);
    expect(() => validateTerminalFoldCandidate(null)).toThrow(/must be an object/);
    expect(() => validateTerminalFoldCandidate({ version: SYNTHETIC_CANDIDATE_VERSION })).toThrow(
      /exact local Docker image ID/
    );
  });
});

describe('terminal fold classifier', () => {
  it('PASSes a fully progressed fold packet', () => {
    const verdict = classifyTerminalFold(inputs());
    expect(
      verdict.checks.filter((entry) => !entry.pass).map((entry) => `${entry.name}:${entry.detail}`)
    ).toEqual([]);
    expect(verdict.evidence).toMatchObject({
      status: 'PASS',
      requestId: REQUEST.requestId,
      tableId: TEST_TABLE_ID,
      handId: TEST_HAND_ID,
      family: 'FOLD',
      handCompleted: true,
      archiveCompleted: true,
      directorProgressed: true,
      continuation: 'NEXT_HAND',
      roomTerminal: true,
      platform429: 0,
      secretScan: 'pass',
    });
    expect(verdict.checks.every((entry) => entry.pass)).toBe(true);
    expect(check(verdict, 'no-stranded-chips')).toBe(true);
    expect(verdict.winnersNonEmpty).toBe(true);
  });

  it('accepts settlement-ready progression when the fold hand is the last hand', () => {
    const full = bundle();
    const diagnostics = bundle({
      subsequentHandStarts: [],
      outbox: [
        full.outbox[0],
        {
          ...full.outbox[1]!,
          id: 'outbox-settle',
          kind: 'settle-hand',
          dedupeKey: 'dedupe-settle',
        },
      ],
    });
    const verdict = classifyTerminalFold(
      inputs({
        diagnostics,
        competition: { settlementReady: true, status: 'RUNNING' },
        replay: {
          handStarts: [{ handId: TEST_HAND_ID, handNumber: 1, occurredAt: 1 }],
          handCompletions: [{ handId: TEST_HAND_ID, occurredAt: 2 }],
          manualDealActions: [],
          duplicateRequestIds: [],
        },
      })
    );
    expect(verdict.evidence.status).toBe('PASS');
    expect(verdict.evidence.continuation).toBe('SETTLEMENT_READY');
  });

  it('accepts a durable operator fold boundary when the HTTP response never resolved', () => {
    const durable = {
      requestId: REQUEST.requestId,
      tableId: TEST_TABLE_ID,
      handId: TEST_HAND_ID,
      turnId: REQUEST.turnId,
      actionId: REQUEST.actionId,
      receiptStatus: 'COMPLETED',
      responseReceiptRequestId: REQUEST.requestId,
      acceptedAt: 1_700_000_000_003,
      winnersNonEmpty: true,
      observationHandMatches: true,
    };
    const verdict = classifyTerminalFold(inputs({ capture: null, durableFold: durable }));
    expect(verdict.evidence.status).toBe('PASS');
    expect(verdict.evidence).toMatchObject({
      requestId: REQUEST.requestId,
      tableId: TEST_TABLE_ID,
      handId: TEST_HAND_ID,
      family: 'FOLD',
      handCompleted: true,
      archiveCompleted: true,
      directorProgressed: true,
      continuation: 'NEXT_HAND',
      roomTerminal: true,
    });
    expect(check(verdict, 'accepted-fold')).toBe(true);
    expect(verdict.winnersNonEmpty).toBe(true);
  });

  it('rejects an incomplete durable fold receipt and a zero-live winner result', () => {
    const base = {
      requestId: REQUEST.requestId,
      tableId: TEST_TABLE_ID,
      handId: TEST_HAND_ID,
      turnId: REQUEST.turnId,
      actionId: REQUEST.actionId,
      receiptStatus: 'COMPLETED',
      responseReceiptRequestId: REQUEST.requestId,
      acceptedAt: 1_700_000_000_003,
      winnersNonEmpty: true,
      observationHandMatches: true,
    };
    const unresolved = classifyTerminalFold(
      inputs({ capture: null, durableFold: { ...base, receiptStatus: 'PENDING' } })
    );
    expect(check(unresolved, 'accepted-fold')).toBe(false);
    const mismatched = classifyTerminalFold(
      inputs({ capture: null, durableFold: { ...base, responseReceiptRequestId: 'other' } })
    );
    expect(check(mismatched, 'accepted-fold')).toBe(false);
    const zeroLive = classifyTerminalFold(
      inputs({ capture: null, durableFold: { ...base, winnersNonEmpty: false } })
    );
    expect(zeroLive.evidence.status).toBe('FAIL');
    expect(check(zeroLive, 'winners-nonempty')).toBe(false);
  });

  it('never infers director reconciliation from the next hand alone', () => {
    const full = bundle();
    const noReconcile = classifyTerminalFold(inputs({ diagnostics: bundle({ reconciliation: null }) }));
    expect(noReconcile.evidence.continuation).toBe('NEXT_HAND');
    expect(noReconcile.evidence.directorProgressed).toBe(false);
    expect(check(noReconcile, 'director-progressed')).toBe(false);
    const stale = classifyTerminalFold(
      inputs({
        diagnostics: bundle({
          reconciliation: { ...full.reconciliation!, occurredAt: '2023-01-01T00:00:00.000Z' },
          tournament: { ...full.tournament!, status: 'RUNNING' },
        }),
        competition: { settlementReady: false, status: 'RUNNING' },
      })
    );
    expect(check(stale, 'director-progressed')).toBe(false);
  });

  it('requires authoritative entrant status consistency for the director proof', () => {
    const full = bundle();
    const inconsistent = full.entrants.map((entrant, index) =>
      index === 0 ? { ...entrant, authoritativeStack: 0, tournamentStatus: 'ACTIVE' } : entrant
    );
    const running = classifyTerminalFold(
      inputs({
        diagnostics: bundle({
          tournament: { ...full.tournament!, status: 'RUNNING' },
          entrants: inconsistent,
        }),
        competition: { settlementReady: false, status: 'RUNNING' },
      })
    );
    expect(check(running, 'director-progressed')).toBe(false);
    // A well-defined terminal tournament is itself the authoritative proof.
    const terminal = classifyTerminalFold(
      inputs({
        diagnostics: bundle({
          tournament: { ...full.tournament!, status: 'FINISHED' },
          entrants: inconsistent,
        }),
      })
    );
    expect(check(terminal, 'director-progressed')).toBe(true);
  });

  it('FAILs when the exact result observation carries no winner', () => {
    const verdict = classifyTerminalFold(inputs({ capture: capture(false) }));
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'winners-nonempty')).toBe(false);
  });

  it('FAILs when the completed fold state still holds pot money', () => {
    // Stacks still sum to the initial chips, but a nonzero pot is stranded
    // money that was never paid back into the table.
    const verdict = classifyTerminalFold(
      inputs({
        capture: capture(true, {
          pots: [{ amount: 3, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
        }),
      })
    );
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'no-stranded-chips')).toBe(false);
  });

  it('FAILs when the completed stacks lost chips against the initial stacks', () => {
    const players = settledPlayers();
    if (players[0] !== null) players[0] = { ...players[0], stack: 998 };
    if (players[1] !== null) players[1] = { ...players[1], stack: 1000 };
    const verdict = classifyTerminalFold(inputs({ capture: capture(true, { players }) }));
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'no-stranded-chips')).toBe(false);
  });

  it('FAILs when the completed fold state still holds street bets', () => {
    const verdict = classifyTerminalFold(
      inputs({ capture: capture(true, { currentBets: { '0': 1, '1': 0 } }) })
    );
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'no-stranded-chips')).toBe(false);
  });

  it('FAILs a completed fold state that still has two live contenders', () => {
    const players = settledPlayers().map((player) =>
      player === null ? null : { ...player, status: PlayerStatus.ACTIVE }
    );
    const verdict = classifyTerminalFold(inputs({ capture: capture(true, { players }) }));
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'no-stranded-chips')).toBe(false);
  });

  it('accounts for the fold hand settle-hand rake and FAILs when it is unaccounted', () => {
    const full = bundle();
    const withRake = bundle({
      outbox: [
        ...full.outbox,
        {
          ...full.outbox[0]!,
          id: 'outbox-settle',
          kind: 'settle-hand',
          dedupeKey: 'dedupe-settle',
          payload: { handId: TEST_HAND_ID, rakeTotal: '1' },
        },
      ],
    });
    // 999 + 1000 covers the initial 2000 chips minus the 1-chip rake exactly.
    const players = settledPlayers();
    if (players[0] !== null) players[0] = { ...players[0], stack: 999 };
    if (players[1] !== null) players[1] = { ...players[1], stack: 1000 };
    const accounted = classifyTerminalFold(
      inputs({ diagnostics: withRake, capture: capture(true, { players }) })
    );
    expect(check(accounted, 'no-stranded-chips')).toBe(true);
    // The same completed stacks without the rake obligation must fail closed.
    const unaccounted = classifyTerminalFold(inputs({ capture: capture(true, { players }) }));
    expect(check(unaccounted, 'no-stranded-chips')).toBe(false);
    expect(unaccounted.evidence.status).toBe('FAIL');
  });

  it('FAILs a stalled fold hand with no completion, archive or progression', () => {
    const diagnostics = bundle({
      events: [],
      subsequentHandStarts: [],
      outbox: [],
      handHistory: { exists: false, id: null, timestamp: null },
      reconciliation: null,
    });
    const verdict = classifyTerminalFold(
      inputs({
        diagnostics,
        competition: { settlementReady: false, status: 'RUNNING' },
        replay: {
          handStarts: [{ handId: TEST_HAND_ID, handNumber: 1, occurredAt: 1 }],
          handCompletions: [],
          manualDealActions: [],
          duplicateRequestIds: [],
        },
      })
    );
    expect(verdict.evidence.status).toBe('FAIL');
    expect(check(verdict, 'mandatory-phase6-sections')).toBe(false);
    expect(check(verdict, 'hand-completed')).toBe(false);
    expect(check(verdict, 'archive-completed')).toBe(false);
    expect(check(verdict, 'director-progressed')).toBe(false);
    expect(check(verdict, 'continuation')).toBe(false);
  });

  it('FAILs an incomplete diagnostic collection or a mismatched fold receipt', () => {
    const failed = classifyTerminalFold(
      inputs({
        diagnostics: bundle({
          collection: { status: 'FAILED', error: 'capture-failed' },
          foldReceipt: null,
        }),
      })
    );
    expect(failed.evidence.status).toBe('FAIL');
    expect(check(failed, 'diagnostics-complete')).toBe(false);

    const mismatched = classifyTerminalFold(
      inputs({
        diagnostics: bundle({
          foldReceipt: { ...bundle().foldReceipt!, requestId: 'other-request' },
        }),
      })
    );
    expect(check(mismatched, 'diagnostics-complete')).toBe(false);
  });

  it('FAILs duplicated exchanges, a manual DEAL, platform 429s and card payloads', () => {
    expect(classifyTerminalFold(inputs({ noDuplicateAttempts: false })).evidence.status).toBe('FAIL');
    expect(classifyTerminalFold(inputs({ noDuplicateProviderTurns: false })).evidence.status).toBe('FAIL');
    expect(classifyTerminalFold(inputs({ noCardSecrets: false })).evidence.status).toBe('FAIL');
    expect(classifyTerminalFold(inputs({ platform429: 1 })).evidence.status).toBe('FAIL');
    expect(
      check(
        classifyTerminalFold(
          inputs({
            replay: {
              handStarts: [{ handId: TEST_HAND_ID, handNumber: 1, occurredAt: 1 }],
              handCompletions: [{ handId: TEST_HAND_ID, occurredAt: 2 }],
              manualDealActions: ['evt-deal'],
              duplicateRequestIds: [],
            },
          })
        ),
        'no-manual-deal'
      )
    ).toBe(false);
    expect(
      classifyTerminalFold(
        inputs({
          replay: {
            handStarts: [{ handId: TEST_HAND_ID, handNumber: 1, occurredAt: 1 }],
            handCompletions: [{ handId: TEST_HAND_ID, occurredAt: 2 }],
            manualDealActions: [],
            duplicateRequestIds: ['req-dup'],
          },
        })
      ).evidence.status
    ).toBe('FAIL');
  });
});

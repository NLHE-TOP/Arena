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
  classifyTerminalFold,
  validateTerminalFoldCandidate,
  type TerminalFoldInputs,
} from '../integration/container-terminal-fold.js';
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

function foldObservation(winners = true): SeatObservation {
  const base = observationInput();
  return SeatObservationSchema.parse({
    ...base,
    version: base.version + 1,
    state: {
      ...base.state,
      version: base.version + 1,
      actionTo: null,
      winners: winners ? [{ seat: 1, amount: 3, hand: null, handRank: null }] : null,
    },
  });
}

function capture(winners = true): CanonicalActionCapture {
  const observation = foldObservation(winners);
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

describe('terminal fold candidate validator', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;

  it('accepts the exact local candidate identity for an unreleased version', () => {
    expect(validateTerminalFoldCandidate({ version: '2.0.4', imageId })).toEqual({
      version: '2.0.4',
      imageId,
    });
  });

  it('rejects the released official version and malformed versions', () => {
    expect(() => validateTerminalFoldCandidate({ version: '2.0.3', imageId })).toThrow(
      /released official/
    );
    for (const version of ['latest', '2.0', 'v2.0.4', '2.0.4-rc1', '', 4]) {
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
      expect(() => validateTerminalFoldCandidate({ version: '2.0.4', imageId: bad })).toThrow(
        /exact local Docker image ID/
      );
    }
    expect(() =>
      validateTerminalFoldCandidate({ version: '2.0.4', imageId, extra: true })
    ).toThrow(/unsupported field/);
    expect(() => validateTerminalFoldCandidate(null)).toThrow(/must be an object/);
    expect(() => validateTerminalFoldCandidate({ version: '2.0.4' })).toThrow(
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

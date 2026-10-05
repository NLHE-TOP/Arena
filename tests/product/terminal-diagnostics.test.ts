/**
 * Focused pure coverage for the acceptance-only sanitized durable diagnostic
 * bundle helper (`tests/integration/acceptance/terminal-diagnostics.ts`).
 *
 * Every case injects a synthetic operator projection and/or a synthetic
 * Redis/BullMQ projection; no database, no Redis, no platform, no provider and
 * no product code is involved. Fixtures intentionally smuggle private engine
 * state (deck, hole cards, snapshots), raw response bodies and credentials to
 * prove the allowlists drop them; assertions compare booleans/markers and never
 * print a credential.
 */
import { describe, expect, it } from 'vitest';
import {
  OMITTED_DIAGNOSTIC_ERROR,
  TERMINAL_DIAGNOSTICS_ERROR_REGISTRY,
  collectTerminalDiagnostics,
  deriveTerminalDiagnosticsContract,
  deriveTerminalDiagnosticsWarnings,
  isTerminalDiagnosticComplete,
  sanitizeDiagnosticError,
  sanitizeDiagnosticInput,
  sanitizeOutboxJobState,
  sanitizeOutboxPayload,
  sanitizeReconciliationPayload,
  sanitizeTerminalDiagnosticsSections,
  terminalDiagnosticCompleteness,
  terminalDiagnosticsSql,
  type TerminalDiagnosticsSqlQuery,
} from '../integration/acceptance/terminal-diagnostics.js';

const TABLE = 'table-1';
const COMPETITION = 'comp-1';
const TOURNAMENT = 'tour-1';
const HAND = 'hand-1';
const PLAYER = 'player-1';
const AUDIT_REQUEST = 'req-fold';
const SECRET = 'nlheit-terminal-diagnostics-0123456789abcdef';
const CARD_MARKERS = ['Ah', 'Kd', '7c'];
const T0 = '2026-01-01T00:00:00.000Z';

/** Injected query returning one fixed payload; records the last SQL issued. */
function staticQuery(payload: unknown): { query: TerminalDiagnosticsSqlQuery; lastSql: () => string } {
  let lastSql = '';
  return {
    query: async (sql) => {
      lastSql = sql;
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
    lastSql: () => lastSql,
  };
}

/** Raw operator projection stuffed with private state and a generated secret. */
function rawOperatorProjection(): Record<string, unknown> {
  return {
    table: {
      id: TABLE,
      status: 'ACTIVE',
      stateVersion: 42,
      eventSeq: 17,
      // Authoritative engine snapshot: only the explicit public keys may
      // survive; deck/hole cards/board in this raw fixture must be dropped.
      state: {
        present: {
          state: true,
          handId: true,
          handNumber: true,
          street: true,
          actionTo: true,
          players: true,
          winners: true,
          pots: true,
          currentBets: true,
        },
        handId: HAND,
        handNumber: 1,
        street: 'SHOWDOWN',
        actionTo: null,
        winners: [{ seat: 1, amount: 15, handRank: 'High Card', hand: ['Ah', 'Kd'] }],
        players: [
          {
            id: PLAYER,
            seat: 0,
            status: 'FOLDED',
            stack: 985,
            betThisStreet: 0,
            totalInvestedThisHand: 5,
            isSittingOut: false,
            hand: ['2c', '3d'],
          },
          {
            id: 'player-2',
            seat: 1,
            status: 'ACTIVE',
            stack: 1015,
            betThisStreet: 0,
            totalInvestedThisHand: 10,
            isSittingOut: false,
            hand: ['Ah', 'Kd'],
          },
          null,
        ],
        currentBets: { 0: 0, 1: 0 },
        pots: [{ amount: 15, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
        deck: [1, 2, 3],
        board: ['Ah', 'Kd', 'Qc', 'Js', 'Th'],
      },
    },
    events: [
      {
        id: 'ev-2',
        eventSeq: 12,
        version: 11,
        type: 'ACTION_APPLIED',
        turnId: `turn-${SECRET}`,
        requestId: AUDIT_REQUEST,
        actionId: 'act-opaque',
        handId: HAND,
        action: 'FOLD',
        payload: { snapshot: { deck: ['Ah'] }, holeCards: ['Kd'] },
      },
      {
        id: 'ev-1',
        eventSeq: 10,
        version: 10,
        type: 'HAND_STARTED',
        turnId: null,
        requestId: null,
        actionId: null,
        handId: HAND,
        action: null,
        payload: { seats: [{ seat: 0, principalId: PLAYER, stack: 990 }] },
      },
      {
        id: 'ev-3',
        eventSeq: 13,
        version: 11,
        type: 'HAND_COMPLETED',
        turnId: null,
        requestId: null,
        actionId: null,
        handId: HAND,
        action: null,
      },
    ],
    subsequentHandStarts: [
      {
        id: 'ev-next-hand',
        eventSeq: 14,
        version: 12,
        type: 'HAND_STARTED',
        turnId: null,
        requestId: null,
        actionId: null,
        handId: 'hand-2',
        action: null,
        payload: { seats: [{ seat: 0, principalId: PLAYER, stack: 985 }] },
      },
    ],
    foldReceipt: {
      id: 'request-row-1',
      requestId: AUDIT_REQUEST,
      principalId: PLAYER,
      turnId: 'turn-1',
      actionId: 'act-opaque',
      expectedVersion: 10,
      status: 'COMPLETED',
      resultVersion: 11,
      eventSeq: 12,
      errorCode: null,
      action: 'FOLD',
      // Raw observation/response bodies are only ever read through explicit
      // semantic keys; deck/hole cards/board below must never survive.
      response: {
        receipt: {
          requestId: AUDIT_REQUEST,
          tableId: TABLE,
          handId: HAND,
          turnId: 'turn-1',
          actionId: 'act-opaque',
          version: 11,
          eventSeq: 12,
          acceptedAt: 1_700_000_000_000,
        },
        observation: {
          tableId: TABLE,
          handId: HAND,
          turnId: 'turn-1',
          version: 11,
          eventSeq: 12,
          state: {
            present: {
              state: true,
              handId: true,
              handNumber: true,
              street: true,
              actionTo: true,
              players: true,
              winners: true,
              pots: true,
              currentBets: true,
            },
            handId: HAND,
            handNumber: 1,
            street: 'PREFLOP',
            actionTo: null,
            winners: null,
            players: [
              {
                id: PLAYER,
                seat: 0,
                status: 'FOLDED',
                stack: 985,
                betThisStreet: 0,
                totalInvestedThisHand: 5,
                isSittingOut: false,
                hand: ['2c', '3d'],
              },
              {
                id: 'player-2',
                seat: 1,
                status: 'ACTIVE',
                stack: 1015,
                betThisStreet: 5,
                totalInvestedThisHand: 10,
                isSittingOut: false,
                hand: ['Ah', 'Kd'],
              },
            ],
            currentBets: { 0: 0, 1: 5 },
            pots: [{ amount: 15, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
            deck: [4, 5, 6],
            board: [],
          },
        },
      },
      audit: {
        id: 'audit-1',
        action: 'GAME_act-opaque',
        createdAt: T0,
        replayed: true,
        version: 11,
        eventSeq: 12,
        ip: '10.0.0.1',
        userAgent: 'raw-agent',
      },
    },
    outbox: [
      {
        id: 'ob-1',
        kind: 'archive-hand',
        status: 'DISPATCHED',
        attempts: 1,
        dedupeKey: `archive:${TABLE}_${HAND}`,
        availableAt: T0,
        createdAt: T0,
        updatedAt: T0,
        lastError: null,
        payload: {
          tableId: TABLE,
          handId: `${TABLE}_${HAND}`,
          snapshot: { deck: ['Ah'], holeCards: { [PLAYER]: ['Kd'] } },
        },
      },
      {
        id: 'ob-2',
        kind: 'settle-hand',
        status: 'FAILED',
        attempts: 4,
        dedupeKey: `settle:${TABLE}_${HAND}`,
        availableAt: T0,
        createdAt: T0,
        updatedAt: T0,
        lastError: `provider echoed ${SECRET}`,
        payload: {
          tableId: TABLE,
          handId: HAND,
          playerNetChanges: { [PLAYER]: '5', 'bad key': 'not-atomic' },
          rakeTotal: '1',
          expectedVersion: 11,
        },
      },
      {
        id: 'ob-3',
        kind: 'mystery',
        status: 'PENDING',
        attempts: 0,
        dedupeKey: `mystery:${TABLE}:1`,
        availableAt: T0,
        createdAt: T0,
        updatedAt: T0,
        lastError: 'JOB_EXECUTION_FAILED',
        payload: { secret: SECRET, deck: ['Ah'] },
      },
      {
        id: 'ob-4',
        kind: 'pubsub',
        status: 'COMPLETED',
        attempts: 1,
        dedupeKey: `pubsub:${TABLE}:17`,
        availableAt: T0,
        createdAt: T0,
        updatedAt: T0,
        lastError: null,
        payload: { channel: `pubsub:table:${TABLE}`, type: 'STATE_UPDATE', version: 11, eventSeq: 17, timestamp: 1 },
      },
    ],
    handHistory: {
      exists: true,
      id: `${TABLE}_${HAND}`,
      timestamp: T0,
      data: { holeCards: { [PLAYER]: ['Ah', 'Kd'] }, deck: ['7c'] },
    },
    competition: {
      id: COMPETITION,
      mode: 'NONFINANCIAL',
      status: 'RUNNING',
      startingStack: 1000,
      smallBlind: 5,
      bigBlind: 10,
      entryAssetId: null,
      entryAmountAtomic: null,
      prizeAssetId: null,
      prizeAmountAtomic: null,
      prizeStatus: 'NOT_APPLICABLE',
      tournamentId: TOURNAMENT,
      // Canonical released settlementReady predicate is verified against real
      // PostgreSQL semantics; the sanitizer only type-checks the boolean.
      settlementReady: true,
      startedAt: T0,
      finishedAt: null,
      cancelledAt: null,
      name: `room ${SECRET}`,
    },
    tournament: {
      id: TOURNAMENT,
      status: 'RUNNING',
      startingStack: 1000,
      buyIn: 0,
      fee: 0,
      maxPlayers: 2,
      tableId: TABLE,
      startedAt: T0,
      finishedAt: null,
      blindStructure: { deck: ['Ah'] },
    },
    entrants: [
      {
        id: 'entrant-1',
        principalId: PLAYER,
        kind: 'WALLET',
        seat: 0,
        entryState: 'NOT_REQUIRED',
        tournamentEntryId: 'entry-1',
        tournamentStatus: 'ACTIVE',
        placement: null,
        currentTableId: TABLE,
        currentSeat: 0,
        prizeAtomic: '0',
        // SQL derives this from the CURRENT Table.state player stack (985),
        // never from the prior HAND_STARTED seats snapshot (990).
        authoritativeStack: 985,
        holeCards: ['Ah'],
      },
    ],
    reconciliation: {
      id: 'reconcile-1',
      eventSeq: 3,
      type: 'TOURNAMENT_RECONCILED',
      requestRef: 'user-1',
      stateFingerprint: 'fingerprint-1',
      occurredAt: T0,
      payload: {
        status: 'RUNNING',
        tables: [{ id: TABLE, status: 'ACTIVE' }],
        entries: [
          { id: 'entry-1', status: 'ACTIVE', placement: null, currentTableId: TABLE, currentSeat: 0 },
        ],
        deck: ['Ah'],
        privateNote: SECRET,
      },
    },
  };
}

function assertNoPrivateMaterial(text: string): void {
  expect(text.includes(SECRET), 'output carries the generated secret').toBe(false);
  for (const marker of CARD_MARKERS) {
    expect(text.includes(marker), `output carries card marker ${marker}`).toBe(false);
  }
  // `contract.snapshot` is a legitimate contract field, so the raw snapshot
  // object is proven absent structurally (payload/state assertions) rather
  // than by the word.
  for (const key of ['deck', 'holeCards', '"data"', '"response"']) {
    expect(text.includes(key), `output carries private key ${key}`).toBe(false);
  }
}

function sectionFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const raw = rawOperatorProjection();
  return { ...raw, ...overrides };
}

/** Minimal raw outbox row for prioritization fixtures. */
function outboxRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ob-x',
    kind: 'settle-hand',
    status: 'FAILED',
    attempts: 1,
    dedupeKey: 'settle:x',
    availableAt: T0,
    createdAt: T0,
    updatedAt: T0,
    lastError: null,
    payload: {},
    ...overrides,
  };
}

describe('terminal diagnostics SQL projection', () => {
  it('builds one read-only sanitized SELECT from validated identifiers', () => {
    const sql = terminalDiagnosticsSql({ tableId: TABLE, competitionId: COMPETITION, handId: HAND, requestId: AUDIT_REQUEST });
    expect(sql).toMatch(/^\s*WITH\b/i);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    for (const table of ['"Table"', '"GameEvent"', '"GameActionRequest"', '"GameOutbox"', '"HandHistory"', '"Tournament"', '"Competition"', '"CompetitionEntrant"', '"TournamentEntry"', '"TournamentEvent"', '"AuditLog"']) {
      expect(sql).toContain(table);
    }
    expect(sql).toContain(`t.id = '${TABLE}'`);
    expect(sql).toContain(`AND c.id = '${COMPETITION}'`);
    expect(sql).toContain(`e.payload->>'handId' = '${HAND}'`);
    expect(sql).toContain(`r."requestId" = '${AUDIT_REQUEST}'`);
    expect(sql).toContain(`a.metadata->>'requestId'`);
    // Explicit requestId: exact durable row, LEFT JOINed so a rejected
    // request without an event is still captured; never scoped to FOLD.
    expect(sql).toContain(
      'LEFT JOIN "GameEvent" e ON e."tableId" = r."tableId" AND e."requestId" = r."requestId"'
    );
    expect(sql).not.toContain("e.payload->>'action' = 'FOLD'");
    // Default (no explicit requestId): legacy latest accepted FOLD inference.
    const defaultSql = terminalDiagnosticsSql({ tableId: TABLE, handId: HAND });
    expect(defaultSql).toContain(
      'JOIN "GameEvent" e ON e."tableId" = r."tableId" AND e."requestId" = r."requestId"'
    );
    expect(defaultSql).toContain("e.payload->>'action' = 'FOLD'");
    // Authoritative state and accepted response are read ONLY through explicit
    // public semantic keys.
    // Released 2.0.3 stores Table.state as a Prisma JSON string: every state
    // read must normalize the string form before projecting.
    expect(sql).toContain("jsonb_typeof(tt.state) = 'string'");
    expect(sql).toContain("jsonb_typeof(stack_table.state) = 'string'");
    expect(sql).toContain("#>> '{}'");
    expect(sql).toContain("(table_state.state)->'players'");
    expect(sql).toContain("(table_state.state)->'winners'");
    expect(sql).toContain("(table_state.state)->'pots'");
    expect(sql).toContain("(table_state.state)->'currentBets'");
    for (const publicKey of [
      "'betThisStreet'",
      "'totalInvestedThisHand'",
      "'isSittingOut'",
      "'capPerPlayer'",
    ]) {
      expect(sql, `missing public state key ${publicKey}`).toContain(publicKey);
    }
    // Exact released canonical settlementReady predicate across all backing
    // tables, using the JSON-string state normalization.
    expect(sql).toContain('"settlementReady"');
    expect(sql).toContain("'FINISHED'");
    expect(sql).toContain("'REGISTERED'");
    expect(sql).toContain('bool_or');
    expect(sql).toContain('jsonb_array_length');
    expect(sql).toContain('te."currentTableId"');
    expect(sql).toContain("jsonb_typeof(backing_table.state) = 'string'");
    expect(sql).toContain("r.response->'receipt'");
    expect(sql).toContain("r.response->'observation'->'state'");
    expect(sql).toContain('stack_table.state');
    expect(sql).toContain("'subsequentHandStarts'");
    expect(sql).toContain("e.type = 'HAND_STARTED'");
    // Raw state/response objects and private keys are never selected.
    expect(sql).not.toContain('snapshot');
    expect(sql).not.toMatch(/'state'\s*,\s*tt\.state\b/);
    expect(sql).not.toMatch(/'response'\s*,\s*r\.response\b/);
    for (const privateKey of ['deck', 'board', 'shownCards', 'actionHistory', 'holeCards']) {
      expect(sql.includes(`'${privateKey}'`), `private key ${privateKey} must never be projected`).toBe(false);
    }
    expect(sql.includes("->'hand'"), 'player.hand must never be projected').toBe(false);
    expect(sql.includes('"data"'), 'HandHistory.data must never be selected').toBe(false);
    expect(sql).toContain('"stateVersion"');
  });

  it('resolves a table from the competition when only the competition identifier is given', () => {
    const sql = terminalDiagnosticsSql({ competitionId: COMPETITION });
    expect(sql).toContain(`cc.id = '${COMPETITION}'`);
    expect(sql).toContain('ctr."tableId"');
  });

  it('refuses missing or unsafe identifiers and clamps row bounds', () => {
    expect(() => terminalDiagnosticsSql({})).toThrow(/requires a table or competition identifier/);
    expect(() => terminalDiagnosticsSql({ tableId: "x'; DROP TABLE y;--" })).toThrow(
      /not a plain durable identifier/
    );
    expect(() => terminalDiagnosticsSql({ tableId: 'ok-1', handId: 'bad hand' })).toThrow(
      /not a plain durable identifier/
    );
    const clamped = terminalDiagnosticsSql({ tableId: TABLE }, { maxEvents: 999_999, maxOutboxRows: -4 });
    expect(clamped).toContain('LIMIT 5000');
    expect(clamped).toContain('LIMIT 500');
  });
});

describe('terminal diagnostics bundle collection', () => {
  it('collects a complete bundle while dropping every private and secret field', async () => {
    const { query, lastSql } = staticQuery(rawOperatorProjection());
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: {
        roomId: 'room-1',
        tableId: TABLE,
        competitionId: COMPETITION,
        handId: HAND,
        requestId: AUDIT_REQUEST,
      },
      knownSecrets: [SECRET],
      metrics: { reconcile: { tournamentReconcileFailuresTotal: 2 }, secret: SECRET, deck: ['Ah'] },
      apiLogWarning: { message: `warn ${SECRET}`, token: 't', holeCards: ['Kd'] },
      now: () => new Date(T0),
    });

    expect(lastSql()).toMatch(/^\s*WITH\b/i);
    expect(bundle.version).toBe(1);
    expect(bundle.collectedAt).toBe(T0);
    expect(bundle.collection).toEqual({ status: 'COMPLETE', error: null });
    expect(bundle.identifiers).toEqual({
      roomId: 'room-1',
      tableId: TABLE,
      competitionId: COMPETITION,
      handId: HAND,
      requestId: AUDIT_REQUEST,
      turnId: null,
    });

    expect(bundle.table).toMatchObject({ id: TABLE, status: 'ACTIVE', stateVersion: 42, eventSeq: 17 });
    expect(bundle.table?.state).toEqual({
      handId: HAND,
      handNumber: 1,
      street: 'SHOWDOWN',
      actionTo: null,
      winners: [{ seat: 1, amount: 15, handRank: 'High Card' }],
      players: [
        {
          id: PLAYER,
          seat: 0,
          status: 'FOLDED',
          stack: 985,
          betThisStreet: 0,
          totalInvestedThisHand: 5,
          isSittingOut: false,
        },
        {
          id: 'player-2',
          seat: 1,
          status: 'ACTIVE',
          stack: 1015,
          betThisStreet: 0,
          totalInvestedThisHand: 10,
          isSittingOut: false,
        },
      ],
      currentBets: { 0: 0, 1: 0 },
      pots: [{ amount: 15, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
      present: true,
      missing: [],
    });

    expect(bundle.subsequentHandStarts).toHaveLength(1);
    expect(bundle.subsequentHandStarts[0]).toMatchObject({
      eventSeq: 14,
      type: 'HAND_STARTED',
      handId: 'hand-2',
    });

    expect(bundle.events.map((event) => event.eventSeq)).toEqual([10, 12, 13]);
    const fold = bundle.events.find((event) => event.action === 'FOLD');
    expect(fold?.requestId).toBe(AUDIT_REQUEST);
    expect(fold?.turnId).toBe('turn-<redacted>');
    expect(fold).not.toHaveProperty('payload');

    expect(bundle.foldReceipt).not.toBeNull();
    expect(bundle.foldReceipt?.status).toBe('COMPLETED');
    expect(bundle.foldReceipt?.errorCode).toBeNull();
    expect(bundle.foldReceipt?.action).toBe('FOLD');
    expect(bundle.foldReceipt?.replayed).toBe(true);
    expect(bundle.foldReceipt?.audit).toEqual({
      id: 'audit-1',
      action: 'GAME_act-opaque',
      createdAt: T0,
      replayed: true,
      version: 11,
      eventSeq: 12,
    });
    expect(bundle.foldReceipt?.responseReceipt).toEqual({
      requestId: AUDIT_REQUEST,
      turnId: 'turn-1',
      actionId: 'act-opaque',
      handId: HAND,
      version: 11,
      eventSeq: 12,
      acceptedAt: 1_700_000_000_000,
    });
    expect(bundle.foldReceipt?.observation).toEqual({
      tableId: TABLE,
      handId: HAND,
      turnId: 'turn-1',
      version: 11,
      eventSeq: 12,
      state: {
        handId: HAND,
        handNumber: 1,
        street: 'PREFLOP',
        actionTo: null,
        // Literal authoritative null is preserved (not normalized to []).
        winners: null,
        players: [
          {
            id: PLAYER,
            seat: 0,
            status: 'FOLDED',
            stack: 985,
            betThisStreet: 0,
            totalInvestedThisHand: 5,
            isSittingOut: false,
          },
          {
            id: 'player-2',
            seat: 1,
            status: 'ACTIVE',
            stack: 1015,
            betThisStreet: 5,
            totalInvestedThisHand: 10,
            isSittingOut: false,
          },
        ],
        currentBets: { 0: 0, 1: 5 },
        pots: [{ amount: 15, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: 0 }],
        present: true,
        missing: [],
      },
    });
    expect(bundle.foldReceipt).not.toHaveProperty('response');
    expect(bundle.foldReceipt?.observation?.state?.players[0]).not.toHaveProperty('hand');

    const byId = new Map(bundle.outbox.map((row) => [row.id, row]));
    expect(byId.get('ob-1')?.payload).toEqual({ handId: `${TABLE}_${HAND}` });
    expect(byId.get('ob-2')?.payload).toEqual({
      handId: HAND,
      rakeTotal: '1',
      playerNetChanges: { [PLAYER]: '5' },
    });
    expect(byId.get('ob-2')?.lastError).toBe(OMITTED_DIAGNOSTIC_ERROR);
    expect(byId.get('ob-3')?.payload).toEqual({});
    expect(byId.get('ob-3')?.lastError).toBe('JOB_EXECUTION_FAILED');
    expect(byId.get('ob-4')?.payload).toEqual({ type: 'STATE_UPDATE', version: 11, eventSeq: 17, timestamp: 1 });
    expect(bundle.outbox.every((row) => row.jobState === null)).toBe(true);

    expect(bundle.handHistory).toEqual({ exists: true, id: `${TABLE}_${HAND}`, timestamp: T0 });
    expect(bundle.handHistory).not.toHaveProperty('data');

    expect(bundle.entrants).toHaveLength(1);
    // Current authoritative stack from Table.state.players (985), not the
    // prior HAND_STARTED seats snapshot (990).
    expect(bundle.entrants[0]?.authoritativeStack).toBe(985);
    expect(bundle.entrants[0]?.currentTableId).toBe(TABLE);
    expect(bundle.entrants[0]).not.toHaveProperty('holeCards');
    expect(bundle.competition?.settlementReady).toBe(true);
    expect(bundle.competition).not.toHaveProperty('name');
    expect(bundle.tournament).not.toHaveProperty('blindStructure');

    expect(bundle.reconciliation?.type).toBe('TOURNAMENT_RECONCILED');
    expect(bundle.reconciliation?.payload).toEqual({
      status: 'RUNNING',
      tables: [{ id: TABLE, status: 'ACTIVE' }],
      entries: [
        { id: 'entry-1', status: 'ACTIVE', placement: null, currentTableId: TABLE, currentSeat: 0 },
      ],
    });

    expect(bundle.metrics).toEqual({ reconcile: { tournamentReconcileFailuresTotal: 2 } });
    expect(bundle.apiLogWarning).toEqual({ message: 'warn <redacted>' });

    expect(bundle.contract).toEqual({
      capture: 'complete',
      table: 'present',
      snapshot: 'present',
      hand: 'present',
      competition: 'present',
      tournament: 'present',
      receipt: 'present',
      handCompleted: 'present',
      handHistory: 'present',
      outbox: 'present',
      nextHandStarted: 'present',
      affectedHandJobs: 'not-requested',
      settlementReady: 'present',
    });
    expect(isTerminalDiagnosticComplete(bundle)).toBe(true);
    expect(terminalDiagnosticCompleteness(bundle)).toEqual({
      complete: true,
      errors: [],
      collectionErrors: 0,
    });

    expect(bundle.warnings).toContain('reconciliation-latest:TOURNAMENT_RECONCILED#3');
    expect(bundle.warnings).toContain('outbox-failed:settle-hand#ob-2:attempts=4');
    expect(bundle.warnings).toContain(
      'reconcile-metrics:reconcile.tournamentReconcileFailuresTotal=2'
    );
    expect(bundle.warnings).toContain('api-log-warning-present');

    assertNoPrivateMaterial(JSON.stringify(bundle));
  });

  it('marks replayed unknown (never false) when audit evidence is absent', async () => {
    const projection = rawOperatorProjection();
    const receipt = projection.foldReceipt as Record<string, unknown>;
    delete receipt.audit;
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND, requestId: AUDIT_REQUEST },
      now: () => new Date(T0),
    });
    expect(bundle.foldReceipt?.audit).toBeNull();
    expect(bundle.foldReceipt?.replayed).toBeNull();
  });

  it('warns on a missing hand history for the requested hand', async () => {
    const projection = sectionFixture({ handHistory: { exists: false, id: null, timestamp: null } });
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(bundle.warnings).toContain(`hand-history-missing:${HAND}`);
  });

  it('sanitizes caller-supplied job state and never trusts raw job data', async () => {
    const calls: string[] = [];
    const { query } = staticQuery(rawOperatorProjection());
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      knownSecrets: [SECRET],
      readJobState: (job) => {
        calls.push(job.outboxId);
        if (job.outboxId === 'ob-1') {
          return {
            state: 'failed',
            attemptsMade: 3,
            failedReason: `worker echoed ${SECRET}`,
            processedOn: 1,
            finishedOn: 2,
            data: { snapshot: { deck: ['Ah'] }, holeCards: ['Kd'] },
          };
        }
        if (job.outboxId === 'ob-2') throw new Error(`redis unreachable ${SECRET}`);
        return null;
      },
      now: () => new Date(T0),
    });

    // COMPLETED rows are never queried.
    // Affected-hand rows first (newest first), then other unresolved rows;
    // COMPLETED rows and pubsub are never probed.
    expect(calls).toEqual(['ob-2', 'ob-1', 'ob-3']);
    const byId = new Map(bundle.outbox.map((row) => [row.id, row]));
    const failed = byId.get('ob-1')?.jobState;
    expect(failed?.state).toBe('failed');
    expect(failed?.exists).toBe(true);
    expect(failed?.attemptsMade).toBe(3);
    expect(failed?.failedReason).toBe(OMITTED_DIAGNOSTIC_ERROR);
    expect(failed).not.toHaveProperty('data');

    const unavailable = byId.get('ob-2')?.jobState;
    expect(unavailable?.state).toBe('unavailable');
    expect(unavailable?.exists).toBeNull();

    const missing = byId.get('ob-3')?.jobState;
    expect(missing?.state).toBe('missing');
    expect(missing?.exists).toBe(false);

    expect(byId.get('ob-4')?.jobState).toBeNull();
    expect(bundle.contract.affectedHandJobs).toBe('present');
    expect(bundle.warnings).toContain('outbox-job:archive-hand#ob-1:state=failed');
    expect(bundle.warnings).toContain('outbox-job:mystery#ob-3:state=missing');
    expect(bundle.warnings).toContain('outbox-job:settle-hand#ob-2:state=unavailable');
    assertNoPrivateMaterial(JSON.stringify(bundle));
  });

  it('probes affected-hand jobs first within budget and never probes pubsub or completed rows', async () => {
    const projection = rawOperatorProjection();
    projection.outbox = [
      outboxRow({ id: 'ob-old-1', createdAt: '2025-12-31T00:00:00.000Z' }),
      outboxRow({ id: 'ob-old-2', createdAt: '2025-12-30T00:00:00.000Z' }),
      ...(projection.outbox as unknown[]),
      // A pending pubsub row must not consume any read budget.
      outboxRow({
        id: 'ob-pubsub-pending',
        kind: 'pubsub',
        status: 'PENDING',
        payload: { type: 'STATE_UPDATE' },
      }),
    ];
    const calls: string[] = [];
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      readJobState: (job) => {
        calls.push(job.outboxId);
        return { state: 'waiting' };
      },
      maxJobStateReads: 3,
      now: () => new Date(T0),
    });

    // Affected-hand rows first (newest first: settle ob-2 then archive ob-1),
    // then the newest other unresolved row (mystery ob-3).
    expect(calls).toEqual(['ob-2', 'ob-1', 'ob-3']);
    expect(calls).not.toContain('ob-pubsub-pending');
    expect(calls).not.toContain('ob-4');
    expect(calls.some((id) => id.startsWith('ob-old'))).toBe(false);

    // Every outbox row is retained unchanged (ascending createdAt order).
    expect(bundle.outbox.map((row) => row.id)).toEqual([
      'ob-old-2',
      'ob-old-1',
      'ob-1',
      'ob-2',
      'ob-3',
      'ob-4',
      'ob-pubsub-pending',
    ]);
    expect(bundle.contract.affectedHandJobs).toBe('present');
    expect(bundle.warnings).not.toContain('outbox-job:pubsub#ob-pubsub-pending:state=missing');
  });

  it('fails closed when a required affected-hand archive/next job state is unreadable', async () => {
    const { query } = staticQuery(rawOperatorProjection());

    const unreadable = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      readJobState: (job) => {
        if (job.outboxId === 'ob-1') throw new Error('redis unreachable');
        return null;
      },
      now: () => new Date(T0),
    });
    expect(unreadable.contract.affectedHandJobs).toBe('missing');
    expect(terminalDiagnosticCompleteness(unreadable).errors).toContain('job-state-unreadable');

    // A legitimately absent BullMQ job is captured evidence, not an error.
    const legitimatelyMissing = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      readJobState: () => null,
      now: () => new Date(T0),
    });
    expect(legitimatelyMissing.contract.affectedHandJobs).toBe('present');
    expect(terminalDiagnosticCompleteness(legitimatelyMissing).errors).toEqual([]);

    // A required affected-hand job beyond the bounded read budget is unreadable.
    const boundedOut = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      readJobState: () => ({ state: 'waiting' }),
      maxJobStateReads: 1,
      now: () => new Date(T0),
    });
    expect(boundedOut.outbox.find((row) => row.id === 'ob-1')?.jobState).toBeNull();
    expect(boundedOut.contract.affectedHandJobs).toBe('missing');
    expect(terminalDiagnosticCompleteness(boundedOut).errors).toContain('job-state-unreadable');

    // Without a callback the probe is not requested and never an error.
    const noProbe = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(noProbe.contract.affectedHandJobs).toBe('not-requested');
    expect(terminalDiagnosticCompleteness(noProbe).errors).toEqual([]);
  });
});

describe('terminal diagnostics error sanitization', () => {
  it('retains registry-known durable error codes verbatim', () => {
    for (const code of TERMINAL_DIAGNOSTICS_ERROR_REGISTRY) {
      expect(sanitizeDiagnosticError(code)).toBe(code);
    }
    expect(sanitizeDiagnosticError('CUSTOM_CODE', { registry: ['CUSTOM_CODE'] })).toBe('CUSTOM_CODE');
  });

  it('redacts secret-shaped error strings and omits unknown errors instead of raw text', () => {
    expect(sanitizeDiagnosticError(`unknown failure ${SECRET}`)).toBe(OMITTED_DIAGNOSTIC_ERROR);
    expect(sanitizeDiagnosticError(`unknown failure ${SECRET}`)?.includes(SECRET)).toBe(false);
    expect(sanitizeDiagnosticError('provider payload {"choices":[]}')).toBe(OMITTED_DIAGNOSTIC_ERROR);
    expect(sanitizeDiagnosticError(null)).toBeNull();
    expect(sanitizeDiagnosticError('   ')).toBeNull();
    expect(sanitizeDiagnosticError(42)).toBeNull();

    // Redaction can salvage a registry-known code from a larger string.
    const salvaged = sanitizeDiagnosticError(`CUSTOM_CODE ${SECRET}`, {
      registry: ['CUSTOM_CODE'],
      redactText: (text) => text.split(SECRET).join('').trim(),
    });
    expect(salvaged).toBe('CUSTOM_CODE');
  });
});

describe('terminal diagnostics payload allowlists', () => {
  it('projects GameOutbox payloads through the per-kind semantic whitelist', () => {
    expect(
      sanitizeOutboxPayload('archive-hand', {
        tableId: TABLE,
        handId: `${TABLE}_${HAND}`,
        snapshot: { deck: ['Ah'], holeCards: { [PLAYER]: ['Kd'] } },
      })
    ).toEqual({ handId: `${TABLE}_${HAND}` });

    expect(sanitizeOutboxPayload('mystery', { secret: SECRET })).toEqual({});

    expect(
      sanitizeOutboxPayload('settle-hand', {
        tableId: TABLE,
        handId: HAND,
        rakeTotal: '1',
        expectedVersion: 11,
        playerNetChanges: { [PLAYER]: '5', 'bad key': 'not-atomic', other: 7 },
      })
    ).toEqual({ handId: HAND, rakeTotal: '1', playerNetChanges: { [PLAYER]: '5' } });

    expect(
      sanitizeOutboxPayload('pubsub', {
        channel: `pubsub:table:${TABLE}`,
        type: 'STATE_UPDATE',
        version: 11,
        eventSeq: 17,
        timestamp: 1,
        payload: { deck: ['Ah'] },
      })
    ).toEqual({ type: 'STATE_UPDATE', version: 11, eventSeq: 17, timestamp: 1 });
  });

  it('projects the reconciliation payload through its whitelist', () => {
    expect(
      sanitizeReconciliationPayload('TOURNAMENT_RECONCILED', {
        status: 'RUNNING',
        tables: [{ id: TABLE, status: 'ACTIVE', secret: SECRET }],
        entries: [
          { id: 'entry-1', status: 'ACTIVE', placement: null, currentTableId: TABLE, currentSeat: 0 },
        ],
        deck: ['Ah'],
        privateNote: SECRET,
      })
    ).toEqual({
      status: 'RUNNING',
      tables: [{ id: TABLE, status: 'ACTIVE' }],
      entries: [
        { id: 'entry-1', status: 'ACTIVE', placement: null, currentTableId: TABLE, currentSeat: 0 },
      ],
    });
    expect(sanitizeReconciliationPayload('TOURNAMENT_SETTLED', { status: 'FINISHED' })).toEqual({});
  });

  it('whitelists a caller job-state projection with unknown never fabricated', () => {
    expect(sanitizeOutboxJobState(null)).toEqual({
      state: 'missing',
      exists: false,
      attemptsMade: null,
      failedReason: null,
      processedOn: null,
      finishedOn: null,
    });
    expect(sanitizeOutboxJobState('FAILED').state).toBe('failed');
    expect(sanitizeOutboxJobState({ state: 'a-state-that-does-not-exist' })).toEqual({
      state: 'unknown',
      exists: null,
      attemptsMade: null,
      failedReason: null,
      processedOn: null,
      finishedOn: null,
    });
    expect(
      sanitizeOutboxJobState({ state: 'waiting', exists: false, attemptsMade: 0 }).exists
    ).toBe(false);
  });
});

describe('terminal diagnostics optional input sanitization', () => {
  it('drops credential and private game keys and redacts every string', () => {
    const sanitized = sanitizeDiagnosticInput(
      {
        token: 't',
        authorization: 'a',
        apiKey: 'k',
        deck: ['Ah'],
        holeCards: ['Kd'],
        state: { deck: ['Ah'] },
        snapshot: { deck: ['7c'] },
        response: { deck: ['Ah'] },
        data: { deck: ['Ah'] },
        nested: { secret: SECRET, safe: `ok ${SECRET}` },
        values: [1, 'two'],
      },
      { knownSecrets: [SECRET] }
    ) as Record<string, unknown>;
    expect(Object.keys(sanitized).sort()).toEqual(['nested', 'values']);
    expect(sanitized.nested).toEqual({ safe: 'ok <redacted>' });
    expect(sanitized.values).toEqual([1, 'two']);
    assertNoPrivateMaterial(JSON.stringify(sanitized));
  });

  it('bounds depth, item count and non-finite numbers', () => {
    const sanitized = sanitizeDiagnosticInput({
      items: Array.from({ length: 300 }, (_, index) => index),
      bad: Number.POSITIVE_INFINITY,
    }) as Record<string, unknown>;
    expect((sanitized.items as unknown[]).length).toBe(128);
    expect(sanitized.bad).toBeNull();
  });
});

describe('terminal diagnostics failure capture', () => {
  const identifiers = { tableId: TABLE, handId: HAND };

  it('captures query, empty, parse and shape failures without throwing', async () => {
    const thrown = await collectTerminalDiagnostics({
      query: async () => {
        throw new Error(`psql exploded ${SECRET}`);
      },
      identifiers,
      knownSecrets: [SECRET],
      now: () => new Date(T0),
    });
    expect(thrown.collection.status).toBe('FAILED');
    expect(thrown.collection.error).toContain(OMITTED_DIAGNOSTIC_ERROR);
    expect(thrown.collection.error?.includes(SECRET)).toBe(false);
    expect(thrown.table).toBeNull();
    expect(thrown.warnings).toEqual([]);

    const empty = await collectTerminalDiagnostics({ query: staticQuery('').query, identifiers });
    expect(empty.collection.status).toBe('FAILED');
    expect(empty.collection.error).toMatch(/returned no row/);

    const unparseable = await collectTerminalDiagnostics({ query: staticQuery('not json').query, identifiers });
    expect(unparseable.collection.status).toBe('FAILED');
    expect(unparseable.collection.error).toMatch(/not parseable JSON/);

    const wrongShape = await collectTerminalDiagnostics({ query: staticQuery([1, 2]).query, identifiers });
    expect(wrongShape.collection.status).toBe('FAILED');
    expect(wrongShape.collection.error).toMatch(/unexpected shape/);
  });

  it('records invalid identifiers as a failure without touching the query', async () => {
    let queried = false;
    const bundle = await collectTerminalDiagnostics({
      query: async () => {
        queried = true;
        return '{}';
      },
      identifiers: { tableId: "x'; DROP TABLE y;--" },
    });
    expect(queried).toBe(false);
    expect(bundle.collection.status).toBe('FAILED');
    expect(bundle.collection.error).toBe('invalid terminal diagnostic identifiers');
  });

  it('never masks an original failure and still surfaces reconcile-failure metrics', async () => {
    const original = new Error('original acceptance failure');
    let observed: unknown = null;
    try {
      throw original;
    } catch (failure) {
      observed = failure;
      const bundle = await collectTerminalDiagnostics({
        query: async () => {
          throw new Error(`diagnostic exploded ${SECRET}`);
        },
        identifiers,
        knownSecrets: [SECRET],
        metrics: { pokertools_tournament_reconcile_failures_total: 3 },
        now: () => new Date(T0),
      });
      expect(bundle.collection.status).toBe('FAILED');
      expect(bundle.warnings).toContain(
        'reconcile-metrics:pokertools_tournament_reconcile_failures_total=3'
      );
      assertNoPrivateMaterial(JSON.stringify(bundle));
    }
    expect(observed).toBe(original);
    expect(original.message).toBe('original acceptance failure');
  });

  it('derives warnings only from sanitized evidence', () => {
    const sections = sanitizeTerminalDiagnosticsSections(
      sectionFixture({ handHistory: { exists: false, id: null, timestamp: null } }),
      { knownSecrets: [SECRET] }
    );
    const warnings = deriveTerminalDiagnosticsWarnings({
      identifiers: {
        roomId: null,
        tableId: TABLE,
        competitionId: null,
        handId: HAND,
        requestId: null,
        turnId: null,
      },
      sections,
      metrics: { reconcile: { failures: 0, mismatches: 1 } },
      apiLogWarning: { message: 'present' },
    });
    expect(warnings).toContain('reconciliation-latest:TOURNAMENT_RECONCILED#3');
    expect(warnings).toContain(`hand-history-missing:${HAND}`);
    expect(warnings).toContain('reconcile-metrics:reconcile.mismatches=1');
    expect(warnings).toContain('api-log-warning-present');
    assertNoPrivateMaterial(JSON.stringify(warnings));
  });
});

describe('terminal diagnostics completeness contract', () => {
  it('is complete when requested identities exist even though outcome evidence is absent', async () => {
    // A hand that started but has not completed, with no archive yet and an
    // empty outbox: every absence is a valid outcome, not a capture error.
    const projection = {
      table: {
        id: TABLE,
        status: 'ACTIVE',
        stateVersion: 9,
        eventSeq: 10,
        state: {
          present: {
            state: true,
            handId: true,
            handNumber: true,
            street: true,
            actionTo: true,
            players: true,
            winners: true,
            pots: true,
            currentBets: true,
          },
          handId: HAND,
          handNumber: 1,
          street: 'PREFLOP',
          actionTo: 0,
          winners: null,
          players: [{ id: PLAYER, seat: 0, status: 'ACTIVE', stack: 1000 }],
          currentBets: { 0: 0 },
          pots: [{ amount: 15, eligibleSeats: [0, 1], type: 'MAIN' }],
          deck: [1, 2, 3],
          board: [],
        },
      },
      events: [
        {
          id: 'ev-start',
          eventSeq: 10,
          version: 9,
          type: 'HAND_STARTED',
          turnId: null,
          requestId: null,
          actionId: null,
          handId: HAND,
          action: null,
        },
      ],
      foldReceipt: null,
      outbox: [],
      handHistory: { exists: false, id: null, timestamp: null },
      competition: rawOperatorProjection().competition,
      tournament: rawOperatorProjection().tournament,
      entrants: [],
      reconciliation: null,
    };
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, competitionId: COMPETITION, handId: HAND },
      now: () => new Date(T0),
    });

    expect(bundle.contract).toEqual({
      capture: 'complete',
      table: 'present',
      snapshot: 'present',
      hand: 'present',
      competition: 'present',
      tournament: 'present',
      receipt: 'not-requested',
      handCompleted: 'absent',
      handHistory: 'absent',
      outbox: 'empty',
      nextHandStarted: 'absent',
      affectedHandJobs: 'not-requested',
      settlementReady: 'present',
    });
    expect(isTerminalDiagnosticComplete(bundle)).toBe(true);
    expect(terminalDiagnosticCompleteness(bundle).collectionErrors).toBe(0);
    // The absence is still surfaced as a diagnostic warning.
    expect(bundle.warnings).toContain(`hand-history-missing:${HAND}`);
  });

  it('reports every missing requested identity separately as a completeness error', async () => {
    const { query } = staticQuery({});
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, competitionId: COMPETITION, handId: HAND, requestId: AUDIT_REQUEST },
      now: () => new Date(T0),
    });
    const completeness = terminalDiagnosticCompleteness(bundle);
    expect(completeness.complete).toBe(false);
    expect(completeness.errors).toEqual([
      'table-missing',
      'competition-missing',
      'tournament-missing',
      'hand-missing',
      'receipt-missing',
    ]);
    expect(completeness.collectionErrors).toBe(completeness.errors.length);
    expect(isTerminalDiagnosticComplete(bundle)).toBe(false);
    expect(bundle.contract).toMatchObject({
      capture: 'complete',
      table: 'missing',
      hand: 'missing',
      competition: 'missing',
      tournament: 'missing',
      receipt: 'missing',
    });
  });

  it('expects the durable receipt of the latest accepted fold even without an explicit request id', async () => {
    const projection = rawOperatorProjection();
    // The fold event exists with an accepted request id, but the durable
    // GameActionRequest row was never projected.
    projection.foldReceipt = null;
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(bundle.contract.receipt).toBe('missing');
    expect(terminalDiagnosticCompleteness(bundle).errors).toContain('receipt-missing');
  });

  it('captures an explicit committed CALL/RAISE receipt regardless of action family', async () => {
    const projection = rawOperatorProjection();
    const receipt = projection.foldReceipt as Record<string, unknown>;
    receipt.action = 'CALL';
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND, requestId: AUDIT_REQUEST },
      now: () => new Date(T0),
    });
    expect(bundle.foldReceipt?.action).toBe('CALL');
    expect(bundle.contract.receipt).toBe('present');
    expect(terminalDiagnosticCompleteness(bundle).errors).toEqual([]);
  });

  it('captures a rejected explicit request without a committed event instead of reporting it absent', async () => {
    const projection = rawOperatorProjection();
    const receipt = projection.foldReceipt as Record<string, unknown>;
    receipt.action = null;
    receipt.status = 'REJECTED';
    receipt.errorCode = 'GAME_ACTION_REJECTED';
    receipt.audit = null;
    delete receipt.response;
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND, requestId: AUDIT_REQUEST },
      now: () => new Date(T0),
    });
    expect(bundle.foldReceipt?.action).toBeNull();
    expect(bundle.foldReceipt?.status).toBe('REJECTED');
    expect(bundle.foldReceipt?.errorCode).toBe('GAME_ACTION_REJECTED');
    expect(bundle.contract.receipt).toBe('present');
    expect(terminalDiagnosticCompleteness(bundle).errors).toEqual([]);
  });

  it('fails closed when required Table.state snapshot fields are absent', async () => {
    const projection = rawOperatorProjection();
    const state = (projection.table as Record<string, unknown>).state as Record<string, unknown>;
    (state.present as Record<string, unknown>).winners = false;
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(bundle.contract.snapshot).toBe('missing');
    expect(bundle.table?.state?.missing).toEqual(['winners']);
    const completeness = terminalDiagnosticCompleteness(bundle);
    expect(completeness.errors).toContain('snapshot-missing');
    expect(completeness.complete).toBe(false);
    expect(isTerminalDiagnosticComplete(bundle)).toBe(false);
  });

  it('preserves the authoritative winners null vs empty vs non-empty distinction', async () => {
    const variants: Array<{ winners: unknown; expected: unknown }> = [
      { winners: null, expected: null },
      { winners: [], expected: [] },
      {
        winners: [{ seat: 1, amount: 15, handRank: 'High Card' }],
        expected: [{ seat: 1, amount: 15, handRank: 'High Card' }],
      },
    ];
    for (const variant of variants) {
      const projection = rawOperatorProjection();
      const state = (projection.table as Record<string, unknown>).state as Record<string, unknown>;
      state.winners = variant.winners;
      const { query } = staticQuery(projection);
      const bundle = await collectTerminalDiagnostics({
        query,
        identifiers: { tableId: TABLE, handId: HAND },
        now: () => new Date(T0),
      });
      expect(bundle.contract.snapshot).toBe('present');
      expect(bundle.table?.state?.winners).toEqual(variant.expected);
    }
  });

  it('fails closed when the canonical settlementReady projection is missing', async () => {
    const projection = rawOperatorProjection();
    delete (projection.competition as Record<string, unknown>).settlementReady;
    const { query } = staticQuery(projection);
    const missing = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(missing.competition?.settlementReady).toBeNull();
    expect(missing.contract.settlementReady).toBe('missing');
    expect(terminalDiagnosticCompleteness(missing).errors).toContain('settlement-ready-missing');

    // A non-boolean raw value is never coerced to false.
    const typed = rawOperatorProjection();
    (typed.competition as Record<string, unknown>).settlementReady = 'true';
    const { query: typedQuery } = staticQuery(typed);
    const wrongType = await collectTerminalDiagnostics({
      query: typedQuery,
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    expect(wrongType.competition?.settlementReady).toBeNull();
    expect(wrongType.contract.settlementReady).toBe('missing');
    expect(terminalDiagnosticCompleteness(wrongType).errors).toContain('settlement-ready-missing');
  });

  it('scopes HAND_COMPLETED to the exact hand and exposes canonical subsequent starts', async () => {
    const projection = rawOperatorProjection();
    // Only the requested hand's HAND_STARTED remains; no HAND_COMPLETED for it.
    projection.events = [(projection.events as unknown[])[1]];
    const { query } = staticQuery(projection);
    const bundle = await collectTerminalDiagnostics({
      query,
      identifiers: { tableId: TABLE, handId: HAND },
      knownSecrets: [SECRET],
      now: () => new Date(T0),
    });
    expect(bundle.contract.hand).toBe('present');
    // A later hand's start (and never its completion) cannot satisfy this.
    expect(bundle.contract.handCompleted).toBe('absent');
    expect(bundle.contract.nextHandStarted).toBe('present');
    expect(bundle.subsequentHandStarts.map((event) => event.handId)).toEqual(['hand-2']);
    expect(terminalDiagnosticCompleteness(bundle).errors).toEqual([]);
    assertNoPrivateMaterial(JSON.stringify(bundle));
  });

  it('marks a failed capture incomplete so wrappers retain the live topology', async () => {
    const bundle = await collectTerminalDiagnostics({
      query: async () => {
        throw new Error('operator database unreachable');
      },
      identifiers: { tableId: TABLE, handId: HAND },
      now: () => new Date(T0),
    });
    const completeness = terminalDiagnosticCompleteness(bundle);
    expect(bundle.contract.capture).toBe('failed');
    expect(completeness.complete).toBe(false);
    expect(completeness.errors).toContain('capture-failed');
    expect(completeness.errors).toContain('table-missing');
    expect(completeness.collectionErrors).toBeGreaterThan(0);
    expect(isTerminalDiagnosticComplete(bundle)).toBe(false);
  });

  it('re-derives the contract from saved evidence (never trusts the stored field)', () => {
    const saved = {
      identifiers: {
        roomId: null,
        tableId: TABLE,
        competitionId: null,
        handId: HAND,
        requestId: null,
        turnId: null,
      },
      collection: { status: 'COMPLETE' as const, error: null },
      jobStateRequested: false,
      ...sanitizeTerminalDiagnosticsSections(rawOperatorProjection()),
    };
    const contract = deriveTerminalDiagnosticsContract(saved);
    expect(contract.table).toBe('present');
    expect(contract.snapshot).toBe('present');
    expect(contract.receipt).toBe('present');
    expect(contract.handCompleted).toBe('present');
    expect(contract.nextHandStarted).toBe('present');
    expect(contract.affectedHandJobs).toBe('not-requested');
    expect(contract.settlementReady).toBe('present');
    expect(isTerminalDiagnosticComplete({ ...saved, contract, warnings: [], version: 1, collectedAt: T0, metrics: null, apiLogWarning: null })).toBe(true);
  });
});

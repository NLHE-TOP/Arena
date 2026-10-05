/**
 * Focused pure/unit coverage for the acceptance-only live-failure packet
 * (`tests/integration/acceptance/live-failure-packet.ts`).
 *
 * No database topology, no Docker, no Redis, no platform and no provider are
 * involved: operator SQL, redis-cli, `/metrics` and `docker logs` are all
 * injected. Fixtures deliberately smuggle nested private engine state (hole
 * cards, decks, snapshots), raw payloads and generated secrets to prove the
 * allowlists and enum classification omit them. Assertions compare booleans,
 * markers and exact projected shapes and never print a credential.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  classifyFailureErrorCategory,
  classifyHumanActionCommit,
  cleanupDisposableSqliteArtifacts,
  collectLiveFailurePacket,
  createBullMqJobStateReader,
  humanActionDecisionEvidence,
  lastCanonicalHumanActionFromBrowserResult,
  lastHumanActionFromDecisions,
  parseApiWarnings,
  parseBullMqJobProbe,
  parseReconcileMetrics,
  privateProductDatabasePath,
  privateProductDataDirectory,
  productDecisionSelectSql,
  projectFailureMetadata,
  proveContainerStopped,
  readProductFailureMetadata,
  relocateDisposableSqliteArtifacts,
  resolveScopedFoldIdentifiers,
  type RedisCliExecutor,
} from '../integration/acceptance/live-failure-packet.js';

const SECRET = 'nlheit-live-failure-packet-0123456789abcdef';
const CARDS = ['Ah', 'Kd', '7c'];
const TABLE = 'table-1';
const COMPETITION = 'comp-1';
const REQUEST = 'req-fold-1';

const redact = (text: string): string => text.split(SECRET).join('<redacted>');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nlhe-live-failure-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimal product schema with the raw private columns present but never read. */
function createProductDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE product_rooms (
        id TEXT PRIMARY KEY, name TEXT, status TEXT, policy_kind TEXT, policy_json TEXT,
        table_id TEXT, platform_competition_id TEXT, failure_reason TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE product_decisions (
        id TEXT PRIMARY KEY, table_id TEXT, turn_id TEXT, principal_id TEXT, room_id TEXT,
        status TEXT, observation_json TEXT, observation_hash TEXT, source_json TEXT,
        prompt_policy_id TEXT, event_cursor INTEGER, request_json TEXT, receipt_json TEXT,
        error_reason TEXT, attempt_count INTEGER, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE product_model_attempts (
        id TEXT PRIMARY KEY, decision_id TEXT, attempt_no INTEGER, status TEXT,
        request_json TEXT, request_hash TEXT, request_metadata_json TEXT, response_json TEXT,
        error TEXT, model TEXT, provider TEXT, prompt_policy_id TEXT,
        prompt_tokens INTEGER, completion_tokens INTEGER, cost_micro_usd INTEGER,
        latency_ms INTEGER, created_at INTEGER, recorded_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO product_rooms (id, name, status, policy_kind, policy_json, table_id, platform_competition_id, failure_reason, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 'SPONSORED', ?, ?, ?, ?, 1, 2)`
    ).run('room-1', 'accept-room', `{"secret":"${SECRET}"}`, TABLE, COMPETITION, `worker echoed ${SECRET}`);
    db.prepare(
      `INSERT INTO product_decisions (id, table_id, turn_id, principal_id, room_id, status, observation_json, observation_hash, source_json, prompt_policy_id, event_cursor, request_json, receipt_json, error_reason, attempt_count, created_at, updated_at)
       VALUES ('dec-1', ?, ?, 'player-1', 'room-1', 'ACTION_SUBMITTED', ?, 'hash', ?, 'policy-1', 12, ?, ?, ?, 1, 3, 4)`
    ).run(
      TABLE,
      `turn-${SECRET}`,
      JSON.stringify({ state: { players: [{ hand: CARDS }] }, deck: CARDS }),
      JSON.stringify({ publicChat: [`chat ${SECRET}`] }),
      JSON.stringify({ requestId: REQUEST, actionId: 'act-fold-1', expectedVersion: 7, holeCards: CARDS }),
      JSON.stringify({ requestId: REQUEST, actionId: 'act-fold-1', version: 8, eventSeq: 21 }),
      `unknown free text ${SECRET}`
    );
    db.prepare(
      `INSERT INTO product_model_attempts (id, decision_id, attempt_no, status, request_json, request_hash, request_metadata_json, response_json, error, model, provider, prompt_policy_id, prompt_tokens, completion_tokens, cost_micro_usd, latency_ms, created_at, recorded_at)
       VALUES ('att-1', 'dec-1', 1, 'FAILED', ?, 'hash', ?, ?, ?, 'model-x', 'provider-y', 'policy-1', 10, 0, 0, 55, 5, 6)`
    ).run(
      JSON.stringify({ messages: [{ content: `prompt ${SECRET}` }] }),
      JSON.stringify({ headers: { authorization: `Bearer ${SECRET}` } }),
      JSON.stringify({ choices: [{ message: { content: `raw ${SECRET}` } }] }),
      'HTTP 429 rate limit exceeded'
    );
  } finally {
    db.close();
  }
}

/**
 * Minimal product schema with ONE rejected/uncommitted human decision: the
 * exact request id exists, but there is no receipt (foldReceipt SQL JOIN needs
 * a committed FOLD event, so the packet must record the absence explicitly).
 */
function createRejectedHumanActionDatabase(path: string): void {
  createProductDatabase(path);
  const db = new Database(path);
  try {
    db.prepare('DELETE FROM product_model_attempts').run();
    db.prepare('DELETE FROM product_decisions').run();
    db.prepare(
      `INSERT INTO product_decisions (id, table_id, turn_id, principal_id, room_id, status, observation_json, observation_hash, source_json, prompt_policy_id, event_cursor, request_json, receipt_json, error_reason, attempt_count, created_at, updated_at)
       VALUES ('dec-rejected', ?, 'turn-rejected', 'human-player', 'room-1', 'STALE', ?, 'hash', NULL, 'policy-1', 12, ?, NULL, 'stale turn superseded', 1, 3, 4)`
    ).run(
      TABLE,
      JSON.stringify({ state: { players: [{ hand: CARDS }] }, deck: CARDS }),
      JSON.stringify({ requestId: 'req-rejected-fold', actionId: 'act-rejected-fold', expectedVersion: 7 })
    );
    db.prepare(
      `INSERT INTO product_model_attempts (id, decision_id, attempt_no, status, request_json, request_hash, request_metadata_json, response_json, error, model, provider, prompt_policy_id, prompt_tokens, completion_tokens, cost_micro_usd, latency_ms, created_at, recorded_at)
       VALUES ('att-rejected', 'dec-rejected', 1, 'FAILED', '{}', 'hash', NULL, NULL, 'stale turn superseded', 'model-x', 'provider-y', 'policy-1', 0, 0, 0, 55, 5, 6)`
    ).run();
  } finally {
    db.close();
  }
}

describe('failure metadata projection', () => {
  it('projects only allowlisted scalars and drops nested private cards/secrets', () => {
    const room = projectFailureMetadata(
      'room',
      {
        id: 'room-1',
        status: 'ACTIVE',
        policy_kind: 'SPONSORED',
        policy_json: `{"secret":"${SECRET}"}`,
        table_id: TABLE,
        platform_competition_id: COMPETITION,
        failure_reason: `worker echoed ${SECRET}`,
        created_at: 1,
        updated_at: 2,
        deck: CARDS,
        nested: { holeCards: CARDS, snapshot: { cards: CARDS } },
      },
      { redactText: redact }
    );
    expect(Object.keys(room!).sort()).toEqual([
      'competitionId',
      'createdAt',
      'failureCategory',
      'id',
      'policyKind',
      'status',
      'tableId',
      'updatedAt',
    ]);
    // Unknown free-text failure reason is omitted, never echoed.
    expect(room!.failureCategory).toBeNull();
    const serialized = JSON.stringify(room);
    expect(serialized).not.toContain(SECRET);
    for (const card of CARDS) expect(serialized).not.toContain(card);

    const decision = projectFailureMetadata(
      'decision',
      {
        id: 'dec-1',
        table_id: TABLE,
        turn_id: `turn-${SECRET}`,
        principal_id: 'player-1',
        status: 'ACTION_SUBMITTED',
        prompt_policy_id: 'policy-1',
        event_cursor: 12,
        attempt_count: 1,
        request_id: REQUEST,
        action_id: 'act-fold-1',
        expected_version: 7,
        receipt_request_id: REQUEST,
        receipt_action_id: 'act-fold-1',
        receipt_version: 8,
        receipt_event_seq: 21,
        error_reason: `unknown free text ${SECRET}`,
        created_at: 3,
        updated_at: 4,
        observation_json: JSON.stringify({ deck: CARDS }),
        request_json: JSON.stringify({ holeCards: CARDS }),
      } satisfies Record<string, unknown>,
      { redactText: redact }
    );
    expect(decision).not.toBeNull();
    expect(decision!.turnId).not.toContain(SECRET);
    expect(decision!.requestId).toBe(REQUEST);
    expect(decision!.actionId).toBe('act-fold-1');
    expect(decision!.receiptVersion).toBe(8);
    expect(decision!.receiptEventSeq).toBe(21);
    expect(decision!.errorCategory).toBeNull();
    expect(JSON.stringify(decision)).not.toContain(SECRET);

    const attempt = projectFailureMetadata(
      'attempt',
      {
        id: 'att-1',
        decision_id: 'dec-1',
        attempt_no: '1',
        status: 'FAILED',
        model: 'model-x',
        provider: 'provider-y',
        prompt_policy_id: 'policy-1',
        prompt_tokens: 10,
        completion_tokens: 0,
        cost_micro_usd: 0,
        latency_ms: 55,
        error: 'HTTP 429 rate limit exceeded',
        created_at: 5,
        recorded_at: 6,
        response_json: JSON.stringify({ choices: [`raw ${SECRET}`] }),
      },
      { redactText: redact }
    );
    expect(attempt).toEqual({
      id: 'att-1',
      decisionId: 'dec-1',
      attemptNo: 1,
      status: 'FAILED',
      model: 'model-x',
      provider: 'provider-y',
      promptPolicyId: 'policy-1',
      promptTokens: 10,
      completionTokens: 0,
      costMicroUsd: 0,
      latencyMs: 55,
      errorCategory: 'RATE_LIMITED',
      createdAt: 5,
      recordedAt: 6,
    });
  });

  it('classifies errors into a bounded enum and omits unknown free text', () => {
    expect(classifyFailureErrorCategory('OUTBOX_ATTEMPTS_EXHAUSTED')).toBe('OUTBOX_ATTEMPTS_EXHAUSTED');
    expect(classifyFailureErrorCategory('HTTP 401 unauthorized')).toBe('AUTH');
    expect(classifyFailureErrorCategory('request timed out')).toBe('TIMEOUT');
    expect(classifyFailureErrorCategory('stale turn superseded')).toBe('STALE');
    expect(classifyFailureErrorCategory(`worker echoed ${SECRET}`)).toBeNull();
    expect(classifyFailureErrorCategory(CARDS.join(' '))).toBeNull();
  });

  it('never selects whole payload/observation/source columns in the decision SQL', () => {
    const sql = productDecisionSelectSql(50);
    expect(sql).not.toMatch(/\bSELECT\s+\*/i);
    for (const forbidden of [
      'observation_json',
      'source_json',
      'response_json',
      'request_metadata_json',
      'policy_json',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain("json_extract(request_json, '$.requestId')");
    expect(sql).toContain("json_extract(receipt_json, '$.eventSeq')");
  });

  it('reads an ACTIVE room and its decisions/attempts read-only from SQLite', () => {
    const dir = tempDir();
    const path = join(dir, 'nlhe.sqlite');
    createProductDatabase(path);
    const metadata = readProductFailureMetadata(path, { redactText: redact });
    expect(metadata.discovery).toBe('active');
    expect(metadata.room).not.toBeNull();
    expect(metadata.room!.id).toBe('room-1');
    expect(metadata.room!.tableId).toBe(TABLE);
    expect(metadata.room!.competitionId).toBe(COMPETITION);
    expect(metadata.decisions).toHaveLength(1);
    expect(metadata.decisions[0]!.requestId).toBe(REQUEST);
    expect(metadata.decisions[0]!.turnId).not.toContain(SECRET);
    expect(metadata.decisions[0]!.errorCategory).toBeNull();
    expect(metadata.attempts).toEqual([
      expect.objectContaining({ id: 'att-1', errorCategory: 'RATE_LIMITED', model: 'model-x' }),
    ]);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(SECRET);
    for (const card of CARDS) expect(serialized).not.toContain(card);
  });
});

describe('reconcile metrics and API warning projection', () => {
  it('keeps numeric reconcile families only and drops labels and unrelated families', () => {
    const families = parseReconcileMetrics(
      [
        '# HELP pokertools_tournament_reconcile_failures_total deferred reconciles',
        'pokertools_tournament_reconcile_failures_total 2',
        `pokertools_tournament_reconcile_failures_total{reason="${SECRET}"} 3`,
        'pokertools_http_requests_total{status="429"} 10',
        'pokertools_tournament_reconcile_deferred_total NaN',
      ].join('\n')
    );
    expect(families).toEqual([
      { family: 'pokertools_tournament_reconcile_failures_total', value: 5, samples: 2 },
    ]);
    expect(JSON.stringify(families)).not.toContain(SECRET);
    expect(JSON.stringify(families)).not.toContain('reason');
  });

  it('keeps only exact known warning message + table id records, never raw lines', () => {
    const known = 'Tournament reconciliation deferred after accepted action';
    const records = parseApiWarnings(
      [
        JSON.stringify({ level: 40, tableId: TABLE, msg: known }),
        JSON.stringify({ level: 40, tableId: 'other-table', msg: known }),
        JSON.stringify({ level: 40, tableId: TABLE, msg: `custom ${SECRET}` }),
        `raw text ${known} ${TABLE} ${SECRET}`,
        JSON.stringify({ level: 40, tableId: TABLE, msg: known }),
      ].join('\n'),
      { tableId: TABLE }
    );
    expect(records).toEqual([{ message: known, tableId: TABLE, count: 2 }]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('raw text');
  });
});

describe('human action commit classification', () => {
  const events = [{ requestId: REQUEST }, { requestId: 'req-other' }];

  it('classifies an absent receipt as committed=false when the capture completed', () => {
    expect(
      classifyHumanActionCommit({ requestIds: [REQUEST], capture: 'COMPLETE', events: [], receipt: null })
    ).toEqual({ committed: false, basis: 'receipt-absent' });
  });

  it('never invents a verdict from an incomplete capture', () => {
    expect(
      classifyHumanActionCommit({ requestIds: [REQUEST], capture: 'FAILED', events: [], receipt: null })
    ).toEqual({ committed: null, basis: 'capture-incomplete' });
  });

  it('uses durable receipt/event evidence when present', () => {
    expect(
      classifyHumanActionCommit({
        requestIds: [REQUEST],
        capture: 'COMPLETE',
        events,
        receipt: { requestId: REQUEST, eventSeq: 21 },
      })
    ).toEqual({ committed: true, basis: 'durable-event' });
    expect(
      classifyHumanActionCommit({ requestIds: [REQUEST], capture: 'COMPLETE', events, receipt: null })
    ).toEqual({ committed: true, basis: 'durable-event' });
    expect(
      classifyHumanActionCommit({
        requestIds: [REQUEST],
        capture: 'COMPLETE',
        events: [],
        receipt: { requestId: REQUEST, eventSeq: 21 },
      })
    ).toEqual({ committed: true, basis: 'durable-receipt' });
  });

  it('treats a request row with no event as not committed, never a fabricated receipt', () => {
    expect(
      classifyHumanActionCommit({
        requestIds: [REQUEST],
        capture: 'COMPLETE',
        events: [],
        receipt: { requestId: REQUEST, eventSeq: null },
      })
    ).toEqual({ committed: false, basis: 'request-not-committed' });
    expect(
      classifyHumanActionCommit({ requestIds: [REQUEST], capture: 'COMPLETE', events: [], receipt: null })
    ).toEqual({ committed: false, basis: 'receipt-absent' });
  });

  it('prefers exact canonical ids over the latest accepted FOLD inference', () => {
    const scoped = resolveScopedFoldIdentifiers(
      [{ action: 'FOLD', requestId: 'req-inferred', handId: 'hand-1', turnId: 'turn-1' }],
      { requestIds: [REQUEST], handId: 'hand-exact' }
    );
    expect(scoped).toEqual({
      requestId: REQUEST,
      handId: 'hand-exact',
      turnId: null,
      source: 'canonical-human-action',
      eventMatched: false,
      identityMismatch: false,
    });
    expect(
      resolveScopedFoldIdentifiers(
        [{ action: 'FOLD', requestId: 'req-inferred', handId: 'hand-1', turnId: 'turn-1' }],
        null
      )
    ).toEqual({
      requestId: 'req-inferred',
      handId: 'hand-1',
      turnId: 'turn-1',
      source: 'latest-accepted-fold',
      eventMatched: true,
      identityMismatch: false,
    });
  });

  it('derives the exact hand/turn from the matching request event and flags a hand mismatch', () => {
    const events = [
      { action: 'FOLD', requestId: 'req-old', handId: 'hand-old', turnId: 'turn-old' },
      { action: 'CALL', requestId: 'req-call', handId: 'hand-1', turnId: 'turn-9' },
    ];
    expect(
      resolveScopedFoldIdentifiers(events, { requestIds: ['req-call'], handId: null })
    ).toEqual({
      requestId: 'req-call',
      handId: 'hand-1',
      turnId: 'turn-9',
      source: 'canonical-human-action',
      eventMatched: true,
      identityMismatch: false,
    });
    // A provided hand contradicting the exact event hand fails the identity
    // check instead of silently falling back to either hand.
    const mismatch = resolveScopedFoldIdentifiers(events, {
      requestIds: ['req-call'],
      handId: 'hand-other',
    });
    expect(mismatch).toEqual({
      requestId: 'req-call',
      handId: 'hand-1',
      turnId: 'turn-9',
      source: 'canonical-human-action',
      eventMatched: true,
      identityMismatch: true,
    });
    // An uncommitted request with no event keeps a provided hand and is
    // otherwise unknown: never an older accepted FOLD hand.
    expect(
      resolveScopedFoldIdentifiers(events, { requestIds: ['req-uncommitted'], handId: 'hand-known' })
    ).toEqual({
      requestId: 'req-uncommitted',
      handId: 'hand-known',
      turnId: null,
      source: 'canonical-human-action',
      eventMatched: false,
      identityMismatch: false,
    });
    expect(resolveScopedFoldIdentifiers(events, { requestIds: ['req-uncommitted'] })).toEqual({
      requestId: 'req-uncommitted',
      handId: null,
      turnId: null,
      source: 'canonical-human-action',
      eventMatched: false,
      identityMismatch: false,
    });
  });
});

describe('rejected human action evidence', () => {
  it('derives the most recent non-agent request id, never an older agent fold', () => {
    const decisions = [
      { principalId: 'agent-1', requestId: 'req-agent-fold', status: 'COMMITTED' },
      { principalId: 'human-player', requestId: 'req-rejected-fold', status: 'STALE' },
    ];
    expect(lastHumanActionFromDecisions(decisions, ['agent-1'])).toEqual({
      requestIds: ['req-rejected-fold'],
      actionId: null,
      turnId: null,
      tableId: null,
    });
    expect(lastHumanActionFromDecisions([decisions[0]!], ['agent-1'])).toBeNull();
    expect(lastHumanActionFromDecisions([], [])).toBeNull();
  });

  it('stores the exact decision row plus attempts, and row absence explicitly', () => {
    const decisions = [
      {
        id: 'dec-rejected',
        status: 'STALE',
        turnId: 'turn-rejected',
        principalId: 'human-player',
        requestId: 'req-rejected-fold',
        actionId: 'act-rejected-fold',
        receiptRequestId: null,
        receiptVersion: null,
        receiptEventSeq: null,
        attemptCount: 1,
      },
    ];
    const attempts = [
      { decisionId: 'dec-rejected', attemptNo: 1, status: 'FAILED', errorCategory: 'STALE', recordedAt: 6 },
    ];
    const matched = humanActionDecisionEvidence(decisions, attempts, ['req-rejected-fold']);
    expect(matched.rowAbsent).toBe(false);
    expect(matched.decision).toMatchObject({
      decisionId: 'dec-rejected',
      status: 'STALE',
      requestId: 'req-rejected-fold',
      receiptRequestId: null,
      attempts: [{ attemptNo: 1, status: 'FAILED', errorCategory: 'STALE', recordedAt: 6 }],
    });
    const absent = humanActionDecisionEvidence(decisions, attempts, ['req-never-persisted']);
    expect(absent).toEqual({ decision: null, rowAbsent: true });
    expect(humanActionDecisionEvidence(decisions, attempts, [])).toEqual({
      decision: null,
      rowAbsent: false,
    });
  });

  it('relays an exact browser canonical action or accepted fold capture', () => {
    expect(
      lastCanonicalHumanActionFromBrowserResult({
        canonicalHumanAction: { requestIds: ['req-relayed'], actionId: 'act-relayed', turnId: 'turn-9' },
      })
    ).toEqual({
      requestIds: ['req-relayed'],
      requestId: null,
      actionId: 'act-relayed',
      turnId: 'turn-9',
      tableId: null,
      handId: null,
    });
    expect(
      lastCanonicalHumanActionFromBrowserResult({
        humanFold: {
          request: { requestId: 'req-fold', actionId: 'act-fold', turnId: 'turn-1' },
          receipt: { requestId: 'req-fold', actionId: 'act-fold', turnId: 'turn-1', tableId: TABLE },
          observation: { state: { handId: 'hand-1' } },
        },
      })
    ).toEqual({
      requestIds: ['req-fold'],
      requestId: 'req-fold',
      actionId: 'act-fold',
      turnId: 'turn-1',
      tableId: TABLE,
      handId: 'hand-1',
    });
    expect(lastCanonicalHumanActionFromBrowserResult({})).toBeNull();
    expect(lastCanonicalHumanActionFromBrowserResult({ canonicalHumanAction: { requestIds: [] } })).toBeNull();
  });
});

describe('BullMQ job probe', () => {
  const empty = Array.from({ length: 8 }, () => '');

  it('derives the state from queue membership and parses the allowed fields', () => {
    const probe = parseBullMqJobProbe(['1', '3', '1700000000000', '', ...empty.map((_, i) => (i === 1 ? '1234.5' : ''))]);
    expect(probe).toEqual({
      state: 'failed',
      exists: true,
      membership: ['failed'],
      attemptsMade: 3,
      processedOn: 1_700_000_000_000,
      finishedOn: null,
    });
    expect(parseBullMqJobProbe(['0', '', '', '', ...empty])).toEqual({
      state: 'missing',
      exists: false,
      membership: [],
      attemptsMade: null,
      processedOn: null,
      finishedOn: null,
    });
    expect(parseBullMqJobProbe(['1', '', '', '', ...empty]).state).toBe('unknown');
  });

  it('with an injected executor issues only targeted HGET/membership commands', async () => {
    const calls: string[][] = [];
    const executor: RedisCliExecutor = {
      pipeline: async (commands) => {
        calls.push([...commands]);
        return ['1', '1', '', '', '', '1', '', '', '', '', '', ''];
      },
      command: async (command) => {
        calls.push([command]);
        return 'OUTBOX_ATTEMPTS_EXHAUSTED';
      },
    };
    const reader = createBullMqJobStateReader({ redisContainer: 'unused', executor });
    const jobState = await reader.readJobState({
      tableId: TABLE,
      outboxId: 'ob-1',
      kind: 'settle-hand',
      dedupeKey: 'settle:table-1:hand-1',
    });
    expect(jobState).toEqual({
      state: 'failed',
      exists: true,
      attemptsMade: 1,
      failedReason: 'OUTBOX_ATTEMPTS_EXHAUSTED',
      processedOn: null,
      finishedOn: null,
    });
    // Exactly one pipeline + one failedReason read; never any raw job data.
    expect(calls).toHaveLength(2);
    for (const command of calls.flat()) {
      expect(command).not.toMatch(/\bHGETALL\b/);
      expect(command).not.toMatch(/\bGET\b/);
      expect(command).not.toMatch(/\bHMGET\b/);
      expect(command).toMatch(/^(?:EXISTS|HGET|ZSCORE|LPOS) /);
    }
    expect(calls[1]![0]).toBe('HGET bull:settle-hand:ob-1 failedReason');
    expect(reader.probes).toEqual([
      expect.objectContaining({ outboxId: 'ob-1', kind: 'settle-hand', queue: 'settle-hand', state: 'failed' }),
    ]);
  });
});

describe('live failure packet orchestration', () => {
  function rawProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      table: {
        id: TABLE,
        status: 'ACTIVE',
        stateVersion: 9,
        eventSeq: 12,
        // Corrected `currentTable.state` projection (presence object + public
        // semantic keys only; deck/hole cards are never projected).
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
          handId: 'hand-1',
          handNumber: 1,
          street: 'PREFLOP',
          actionTo: 0,
          winners: null,
          players: [
            {
              id: 'player-1',
              seat: 0,
              status: 'ACTIVE',
              stack: 100,
              betThisStreet: 0,
              totalInvestedThisHand: 0,
              isSittingOut: false,
            },
          ],
          currentBets: {},
          pots: [{ amount: 3, eligibleSeats: [0, 1], type: 'MAIN', capPerPlayer: null }],
        },
      },
      events: [],
      foldReceipt: null,
      outbox: [],
      handHistory: { exists: false, id: null, timestamp: null },
      competition: {
      settlementReady: false,
        id: COMPETITION,
        mode: 'SPONSORED',
        status: 'ACTIVE',
        startingStack: 100,
        smallBlind: 1,
        bigBlind: 2,
        entryAssetId: null,
        entryAmountAtomic: null,
        prizeAssetId: null,
        prizeAmountAtomic: null,
        prizeStatus: 'NONE',
        tournamentId: 'tour-1',
        startedAt: null,
        finishedAt: null,
        cancelledAt: null,
      },
      tournament: {
        id: 'tour-1',
        status: 'ACTIVE',
        startingStack: 100,
        buyIn: 0,
        fee: 0,
        maxPlayers: 2,
        tableId: TABLE,
        startedAt: null,
        finishedAt: null,
      },
      entrants: [],
      reconciliation: null,
      ...overrides,
    };
  }

  function productDatabaseFixture(): { root: string; databasePath: string } {
    const root = tempDir();
    const databasePath = join(root, 'nlhe-live.sqlite');
    createProductDatabase(databasePath);
    return { root, databasePath };
  }

  it('classifies an uncommitted fold with an absent receipt as committed=false (case-1 evidence)', async () => {
    const { root, databasePath } = productDatabaseFixture();
    let calls = 0;
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: [REQUEST], handId: 'hand-1', turnId: 'turn-1' },
      query: async () => {
        calls += 1;
        return JSON.stringify(rawProjection());
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(calls).toBe(2); // initial identifiers, then the scoped exact re-read
    expect(result.complete).toBe(false);
    expect(result.retainTopology).toBe(true);
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { authoritative: string; durableComplete: boolean; scoped: unknown };
      humanAction: { committed: boolean | null; basis: string; receiptRequestId: string | null };
    };
    expect(packet.terminal.authoritative).toBe('scoped');
    expect(packet.terminal.scoped).not.toBeNull();
    expect(packet.terminal.durableComplete).toBe(false);
    expect(packet.humanAction).toMatchObject({
      committed: false,
      basis: 'receipt-absent',
      receiptRequestId: null,
    });
    expect(readFileSync(result.packetPath!, 'utf8')).not.toContain(SECRET);
  });

  it('completes the packet when the exact fold receipt is durable', async () => {
    const { root, databasePath } = productDatabaseFixture();
    const acceptedEvent = {
      id: 'ev-1',
      eventSeq: 11,
      type: 'ACTION_APPLIED',
      version: 11,
      turnId: 'turn-1',
      requestId: REQUEST,
      actionId: 'act-fold-1',
      handId: 'hand-1',
      action: 'FOLD',
    };
    const receipt = {
      id: 'fr-1',
      requestId: REQUEST,
      principalId: 'player-1',
      turnId: 'turn-1',
      actionId: 'act-fold-1',
      expectedVersion: 7,
      status: 'ACCEPTED',
      resultVersion: 8,
      eventSeq: 12,
      errorCode: null,
      audit: null,
      responseReceipt: null,
      observation: null,
    };
    let calls = 0;
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: [REQUEST], handId: 'hand-1', turnId: 'turn-1' },
      query: async () => {
        calls += 1;
        return calls === 1
          ? JSON.stringify(rawProjection({ events: [acceptedEvent] }))
          : JSON.stringify(rawProjection({ events: [acceptedEvent], foldReceipt: receipt }));
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(calls).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.retainTopology).toBe(false);
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { authoritative: string; durableComplete: boolean };
      humanAction: { committed: boolean | null; basis: string; receiptRequestId: string | null };
    };
    expect(packet.terminal).toMatchObject({ authoritative: 'scoped', durableComplete: true });
    expect(packet.humanAction).toMatchObject({
      committed: true,
      basis: 'durable-event',
      receiptRequestId: REQUEST,
      receiptEventSeq: 12,
      foldReceiptAbsent: false,
    });
  });

  it('scopes an explicit successful CALL to the exact matching hand, not an older fold hand', async () => {
    const { root, databasePath } = productDatabaseFixture();
    const olderFold = {
      id: 'ev-old',
      eventSeq: 4,
      type: 'ACTION_APPLIED',
      version: 4,
      turnId: 'turn-old',
      requestId: 'req-older-accepted-fold',
      actionId: 'act-old',
      handId: 'hand-old',
      action: 'FOLD',
    };
    const callEvent = {
      id: 'ev-call',
      eventSeq: 9,
      type: 'ACTION_APPLIED',
      version: 9,
      turnId: 'turn-9',
      requestId: 'req-call',
      actionId: 'act-call',
      handId: 'hand-1',
      action: 'CALL',
    };
    const callReceipt = {
      id: 'fr-call',
      requestId: 'req-call',
      principalId: 'human-player',
      turnId: 'turn-9',
      actionId: 'act-call',
      expectedVersion: 8,
      status: 'ACCEPTED',
      resultVersion: 9,
      eventSeq: 10,
      errorCode: null,
      audit: null,
      responseReceipt: null,
      observation: null,
    };
    let calls = 0;
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: ['req-call'] },
      query: async () => {
        calls += 1;
        return JSON.stringify(
          rawProjection({
            events: [olderFold, callEvent],
            ...(calls > 1 ? { foldReceipt: callReceipt } : {}),
          })
        );
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { scopedIdentifiers: Record<string, unknown> };
      humanAction: Record<string, unknown>;
    };
    expect(packet.terminal.scopedIdentifiers).toMatchObject({
      requestId: 'req-call',
      handId: 'hand-1',
      turnId: 'turn-9',
      source: 'canonical-human-action',
      eventMatched: true,
      identityMismatch: false,
    });
    expect(packet.humanAction).toMatchObject({
      committed: true,
      basis: 'durable-event',
      receiptRequestId: 'req-call',
      receiptEventSeq: 10,
      foldReceiptAbsent: false,
      identityMismatch: false,
      providedHandId: null,
    });
    expect(result.complete).toBe(true);
    expect(result.retainTopology).toBe(false);
  });

  it('fails the identity check and retains when a provided hand contradicts the exact request event', async () => {
    const { root, databasePath } = productDatabaseFixture();
    const callEvent = {
      id: 'ev-call',
      eventSeq: 9,
      type: 'ACTION_APPLIED',
      version: 9,
      turnId: 'turn-9',
      requestId: 'req-call',
      actionId: 'act-call',
      handId: 'hand-1',
      action: 'CALL',
    };
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: ['req-call'], handId: 'hand-other' },
      query: async () => JSON.stringify(rawProjection({ events: [callEvent] })),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { scopedIdentifiers: Record<string, unknown> };
      humanAction: Record<string, unknown>;
      warnings: string[];
    };
    // The event hand is authoritative for the scoped query; the contradiction
    // is recorded and fails closed (retain), never silently resolved.
    expect(packet.terminal.scopedIdentifiers).toMatchObject({
      requestId: 'req-call',
      handId: 'hand-1',
      identityMismatch: true,
    });
    expect(packet.humanAction).toMatchObject({
      identityMismatch: true,
      providedHandId: 'hand-other',
    });
    expect(packet.warnings).toContain('human-action-identity-mismatch');
    expect(result.complete).toBe(false);
    expect(result.retainTopology).toBe(true);
  });

  it('preserves a provided hand for an uncommitted request with no event and never uses an older fold hand', async () => {
    const { root, databasePath } = productDatabaseFixture();
    const olderFold = {
      id: 'ev-old',
      eventSeq: 4,
      type: 'ACTION_APPLIED',
      version: 4,
      turnId: 'turn-old',
      requestId: 'req-older-accepted-fold',
      actionId: 'act-old',
      handId: 'hand-old',
      action: 'FOLD',
    };
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: ['req-uncommitted'], handId: 'hand-known' },
      query: async () => JSON.stringify(rawProjection({ events: [olderFold] })),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { scopedIdentifiers: Record<string, unknown> };
      humanAction: Record<string, unknown>;
    };
    expect(packet.terminal.scopedIdentifiers).toMatchObject({
      requestId: 'req-uncommitted',
      handId: 'hand-known',
      eventMatched: false,
      identityMismatch: false,
      source: 'canonical-human-action',
    });
    expect(packet.humanAction).toMatchObject({
      requestIds: ['req-uncommitted'],
      inferredFoldRequestId: null,
      committed: false,
      basis: 'receipt-absent',
      foldReceiptAbsent: true,
      identityMismatch: false,
    });
  });

  it('forces an incomplete retained packet when the latest exchange capture failed, with no older fold fallback', async () => {
    const { root, databasePath } = productDatabaseFixture();
    const olderFold = {
      id: 'ev-old',
      eventSeq: 4,
      type: 'ACTION_APPLIED',
      version: 4,
      turnId: 'turn-old',
      requestId: 'req-older-accepted-fold',
      actionId: 'act-old',
      handId: 'hand-old',
      action: 'FOLD',
    };
    let calls = 0;
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      // The latest exchange carried captureError: no request identity exists.
      lastCanonicalHumanAction: { requestIds: [], captureFailed: true },
      query: async () => {
        calls += 1;
        return JSON.stringify(rawProjection({ events: [olderFold] }));
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    // No scoped capture is attempted and the older accepted FOLD is not used.
    expect(calls).toBe(1);
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      terminal: { scopedIdentifiers: Record<string, unknown>; scoped: unknown };
      humanAction: Record<string, unknown>;
      warnings: string[];
    };
    expect(packet.terminal.scopedIdentifiers).toMatchObject({
      requestId: null,
      handId: null,
      source: 'none',
      eventMatched: false,
      identityMismatch: false,
    });
    expect(packet.terminal.scoped).toBeNull();
    expect(packet.humanAction).toMatchObject({
      requestIds: [],
      identitySource: 'none',
      inferredFoldRequestId: null,
      committed: null,
      basis: 'no-canonical-action',
      foldReceiptAbsent: true,
      exchange: { captureFailed: true },
    });
    expect(packet.warnings).toContain('human-action-capture-failed');
    expect(result.complete).toBe(false);
    expect(result.retainTopology).toBe(true);
  });

  it('derives the exact rejected human request and records its row/attempt evidence without an older fold', async () => {
    const root = tempDir();
    const databasePath = join(root, 'nlhe-live.sqlite');
    createRejectedHumanActionDatabase(databasePath);
    const olderAcceptedFold = {
      id: 'ev-old',
      eventSeq: 5,
      type: 'ACTION_APPLIED',
      version: 5,
      turnId: 'turn-old',
      requestId: 'req-older-accepted-fold',
      actionId: 'act-old',
      handId: 'hand-old',
      action: 'FOLD',
    };
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      agentPrincipalIds: ['agent-1'],
      query: async () => JSON.stringify(rawProjection({ events: [olderAcceptedFold] })),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      humanAction: {
        requestIds: string[];
        identitySource: string;
        inferredFoldRequestId: string | null;
        committed: boolean | null;
        basis: string;
        foldReceiptAbsent: boolean;
        receiptRequestId: string | null;
        decisionRowAbsent: boolean;
        decision: { status: string; requestId: string | null; attempts: Array<{ status: string }> } | null;
      };
      terminal: { scopedIdentifiers: { requestId: string | null; source: string } };
    };
    expect(packet.terminal.scopedIdentifiers).toMatchObject({
      requestId: 'req-rejected-fold',
      source: 'canonical-human-action',
    });
    expect(packet.humanAction).toMatchObject({
      requestIds: ['req-rejected-fold'],
      identitySource: 'product-decisions',
      inferredFoldRequestId: null,
      committed: false,
      basis: 'receipt-absent',
      receiptRequestId: null,
      foldReceiptAbsent: true,
      decisionRowAbsent: false,
      decision: { status: 'STALE', requestId: 'req-rejected-fold', attempts: [{ status: 'FAILED' }] },
    });
    // Conservative retention: the durable receipt is missing.
    expect(result.retainTopology).toBe(true);
    expect(readFileSync(result.packetPath!, 'utf8')).not.toContain(SECRET);
  });

  it('records an absent decision row for a callback request as explicit case-1 evidence', async () => {
    const root = tempDir();
    const databasePath = join(root, 'nlhe-live.sqlite');
    createRejectedHumanActionDatabase(databasePath);
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      lastCanonicalHumanAction: { requestIds: ['req-never-persisted'] },
      query: async () => JSON.stringify(rawProjection()),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const packet = JSON.parse(readFileSync(result.packetPath!, 'utf8')) as {
      humanAction: {
        requestIds: string[];
        identitySource: string;
        committed: boolean | null;
        basis: string;
        foldReceiptAbsent: boolean;
        decisionRowAbsent: boolean;
        decision: unknown;
      };
    };
    expect(packet.humanAction).toMatchObject({
      requestIds: ['req-never-persisted'],
      identitySource: 'callback',
      committed: false,
      basis: 'receipt-absent',
      foldReceiptAbsent: true,
      decisionRowAbsent: true,
      decision: null,
    });
  });

  it('persists a redacted packet and retains the topology when the query fails', async () => {
    const root = tempDir();
    const databasePath = join(root, 'nlhe-live.sqlite');
    createProductDatabase(databasePath);
    const failingQuery = async (): Promise<string> => {
      throw new Error(`psql failed ${SECRET}`);
    };
    const result = await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      reason: `live run failed ${SECRET}`,
      lastCanonicalHumanAction: { requestIds: [REQUEST], handId: 'hand-1' },
      platformMetrics: { url: 'http://127.0.0.1:1' },
      apiContainerName: 'api-unused',
      query: failingQuery,
      readMetricsText: async () => '',
      readApiLog: async () => '',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.complete).toBe(false);
    expect(result.retainTopology).toBe(true);
    expect(result.packetPath).not.toBeNull();
    expect(result.reason).not.toContain(SECRET);
    const packetPath = result.packetPath!;
    expect(existsSync(packetPath)).toBe(true);
    expect(statSync(packetPath).mode & 0o777).toBe(0o600);
    const text = readFileSync(packetPath, 'utf8');
    expect(text).not.toContain(SECRET);
    for (const card of CARDS) expect(text).not.toContain(card);

    const packet = JSON.parse(text) as {
      collection: { status: string };
      product: { room: { id: string; tableId: string } | null; decisions: Array<Record<string, unknown>> };
      humanAction: { committed: boolean | null; basis: string };
      terminal: { initial: { collection: { status: string } } };
      metrics: { reconcileFamilies: unknown[] } | null;
    };
    expect(packet.collection.status).toBe('FAILED');
    expect(packet.terminal.initial.collection.status).toBe('FAILED');
    // The failure did not prevent the read-only SQLite projection.
    expect(packet.product.room?.id).toBe('room-1');
    expect(packet.product.room?.tableId).toBe(TABLE);
    expect(packet.product.decisions[0]!.requestId).toBe(REQUEST);
    // A failed capture never invents a commit verdict.
    expect(packet.humanAction).toMatchObject({ committed: null, basis: 'capture-incomplete' });
  });

  it('does not delete the raw SQLite files by itself', async () => {
    const root = tempDir();
    const databasePath = join(root, 'nlhe-live.sqlite');
    createProductDatabase(databasePath);
    await collectLiveFailurePacket({
      context: { artifactDir: root, log: () => undefined },
      adminTarget: { kind: 'url', databaseUrl: 'postgresql://unused' },
      redisContainer: 'unused',
      secretRegistry: { redact, values: () => [SECRET] },
      productDatabasePath: databasePath,
      query: async () => {
        throw new Error('operator query unavailable');
      },
    });
    expect(existsSync(databasePath)).toBe(true);
  });

  it('cleans up only explicitly supplied disposable artifact SQLite files', () => {
    const root = tempDir();
    const db = join(root, 'run.sqlite');
    const live = join(root, 'live.sqlite');
    const notes = join(root, 'notes.txt');
    const outsideDir = tempDir();
    const outside = join(outsideDir, 'outside.sqlite');
    writeFileSync(db, '');
    writeFileSync(`${db}-wal`, '');
    writeFileSync(`${db}-shm`, '');
    writeFileSync(live, '');
    writeFileSync(notes, '');
    writeFileSync(outside, '');
    mkdirSync(join(root, 'directory.sqlite'));

    const result = cleanupDisposableSqliteArtifacts({
      paths: [db, live, notes, outside, join(root, 'directory.sqlite')],
      root,
      protectedPaths: [live],
    });
    expect(result.removed.sort()).toEqual([db, `${db}-shm`, `${db}-wal`].sort());
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: live, reason: 'protected-path' },
        { path: notes, reason: 'outside-root-or-not-sqlite' },
        { path: outside, reason: 'outside-root-or-not-sqlite' },
        { path: join(root, 'directory.sqlite'), reason: 'missing-directory-or-symlink' },
      ])
    );
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it('moves an explicitly supplied disposable SQLite set into the protected runtime dir', () => {
    const root = tempDir();
    const destination = tempDir();
    const db = join(root, 'run.sqlite');
    writeFileSync(db, 'raw-observation');
    writeFileSync(`${db}-wal`, 'raw-wal');
    writeFileSync(`${db}-shm`, 'raw-shm');
    const outsideDir = tempDir();
    const outside = join(outsideDir, 'outside.sqlite');
    writeFileSync(outside, '');

    const result = relocateDisposableSqliteArtifacts({
      paths: [db, outside],
      root,
      destinationDir: destination,
    });
    expect(result.moved.sort()).toEqual(
      [join(destination, 'run.sqlite'), join(destination, 'run.sqlite-shm'), join(destination, 'run.sqlite-wal')].sort()
    );
    expect(result.skipped).toEqual([{ path: outside, reason: 'outside-root-or-not-sqlite' }]);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(join(destination, 'run.sqlite'))).toBe(true);
    expect(readFileSync(join(destination, 'run.sqlite'), 'utf8')).toBe('raw-observation');
    expect(existsSync(outside)).toBe(true);
  });

  it('never overwrites an existing destination during relocation', () => {
    const root = tempDir();
    const destination = tempDir();
    const db = join(root, 'run.sqlite');
    writeFileSync(db, 'raw');
    writeFileSync(join(destination, 'run.sqlite'), 'operator-data');
    const result = relocateDisposableSqliteArtifacts({ paths: [db], root, destinationDir: destination });
    expect(result.moved).toEqual([]);
    expect(result.skipped).toEqual([{ path: db, reason: 'destination-exists' }]);
    expect(readFileSync(join(destination, 'run.sqlite'), 'utf8')).toBe('operator-data');
  });
});

describe('private product data boundary and stop assurance', () => {
  it('places the private SQLite in the dedicated runtimeDir child, never the runtimeDir root', () => {
    const runtimeDir = '/protected/runtime-run-1';
    const path = privateProductDatabasePath(runtimeDir, 'nlhe.sqlite');
    expect(path).toBe(join(runtimeDir, 'private-product-data', 'nlhe.sqlite'));
    expect(privateProductDataDirectory(runtimeDir)).toBe(join(runtimeDir, 'private-product-data'));
    // The standalone container mounts dirname(databasePath): it must be the
    // dedicated child, never the runtimeDir root that holds secret env files.
    expect(join(path, '..')).not.toBe(runtimeDir);
    expect(privateProductDataDirectory(runtimeDir)).not.toBe(runtimeDir);
    expect(() => privateProductDatabasePath(runtimeDir, '../escape.sqlite')).toThrow(/plain file name/);
    expect(() => privateProductDatabasePath(runtimeDir, 'nested/db.sqlite')).toThrow(/plain file name/);
    expect(() => privateProductDatabasePath(runtimeDir, 'bad name.sqlite')).toThrow(/plain file name/);
  });

  it('proves a stopped/removed container and treats unknown probes as not proven', async () => {
    const run = (result: { code: number | null; stdout?: string; stderr?: string }) => async () =>
      ({ code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
    expect(await proveContainerStopped('c1', run({ code: 0, stdout: 'false\n' }))).toEqual({
      stopped: true,
      reason: 'not-running',
    });
    expect(await proveContainerStopped('c1', run({ code: 1, stderr: 'Error: No such object: c1' }))).toEqual({
      stopped: true,
      reason: 'removed',
    });
    expect(await proveContainerStopped('c1', run({ code: 0, stdout: 'true' }))).toEqual({
      stopped: false,
      reason: 'still-running',
    });
    expect(
      await proveContainerStopped('c1', run({ code: 1, stderr: 'Cannot connect to the Docker daemon' }))
    ).toEqual({ stopped: false, reason: 'probe-failed' });
    expect(
      await proveContainerStopped('c1', async () => {
        throw new Error('docker missing');
      })
    ).toEqual({ stopped: false, reason: 'probe-failed' });
    let called = false;
    expect(
      await proveContainerStopped('', async () => {
        called = true;
        return { code: 0, stdout: 'false', stderr: '' };
      })
    ).toEqual({ stopped: false, reason: 'no-container-name' });
    expect(called).toBe(false);
  });
});

describe('live wrapper finalization order', () => {
  const wrappers = ['container-live-sponsored.ts', 'container-live-challenge.ts'];

  it('stops the paid runtime, captures the packet while PostgreSQL lives, then conditionally tears down', () => {
    for (const name of wrappers) {
      const source = readFileSync(
        fileURLToPath(new URL(`../integration/${name}`, import.meta.url)),
        'utf8'
      );
      const runtimeStop = source.indexOf('await runtime.stop()');
      const stopProof = source.indexOf('proveContainerStopped(');
      const packetCapture = source.indexOf('await collectLiveFailurePacket(');
      const topologyStop = source.indexOf('await topology.stop()');
      const retentionGuard = source.indexOf('!retainedTopology');
      expect(runtimeStop, `${name}: runtime stop`).toBeGreaterThan(-1);
      expect(stopProof, `${name}: stop proof`).toBeGreaterThan(runtimeStop);
      expect(packetCapture, `${name}: packet capture`).toBeGreaterThan(stopProof);
      expect(topologyStop, `${name}: topology stop`).toBeGreaterThan(packetCapture);
      expect(retentionGuard, `${name}: retention guard`).toBeGreaterThan(packetCapture);
      // The private SQLite lives in the dedicated runtimeDir child from the
      // start: the wrappers never relocate or artifact-root-delete it, and the
      // legacy helpers stay fallback-only.
      expect(source).toContain('privateProductDatabasePath(');
      expect(source).toContain('privateProductDataDirectory(');
      expect(source).not.toContain('cleanupDisposableSqliteArtifacts(');
      expect(source).not.toContain('relocateDisposableSqliteArtifacts(');
      expect(source).toContain('runtimeStopProven');
      expect(source).toContain("'private-runtime'");
      expect(source).toContain("'private-runtime-removed'");
      expect(source).toContain('retainedState');
      expect(source).toContain('failurePacket');
      expect(source).toContain('agentPrincipalIds');
    }
  });

  it('relays the metadata-only browser human action exchange in the sponsored wrapper', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../integration/container-live-sponsored.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('onHumanActionExchange');
    expect(source).toContain('latestHumanActionExchange');
    // The request-send-order reducer is used, never a blind latest assignment.
    expect(source).toContain('selectLatestHumanActionExchange(');
    // The relay stores only canonical ids/status metadata: no raw request or
    // response bodies are referenced by the handler.
    expect(source).not.toContain('request_json');
    expect(source).not.toContain('response_json');
    expect(source).not.toContain('observation_json');
  });
});

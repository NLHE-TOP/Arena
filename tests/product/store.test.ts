import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentConfigInput } from '../../src/product/catalog.js';
import { canonicalJson, computeObservationHash } from '../../src/product/observation.js';
import { ProductStore, computeDecisionId, type ProductRoom } from '../../src/product/store.js';
import {
  AGENT_PRINCIPAL_ID,
  HUMAN_PRINCIPAL_ID,
  actionReceiptFixture,
  actionRequestFixture,
  chatMessageFixture,
  seatObservationFixture,
} from './store-fixtures.js';

const REPO_MIGRATIONS = resolve(process.cwd(), 'migrations');
const PRODUCT_MIGRATION = join(REPO_MIGRATIONS, '001_product.sql');
const UNRELATED_MIGRATION = '001_schema.sql';
const PROMPT_HASH = 'ab'.repeat(32);

const HUMAN = HUMAN_PRINCIPAL_ID;
const AGENT = 'agent-1';
const AGENT_PRINCIPAL = AGENT_PRINCIPAL_ID;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function agentConfig(overrides: Partial<AgentConfigInput> = {}): AgentConfigInput {
  return {
    id: AGENT,
    name: 'Agent One',
    model: 'model-x',
    provider: 'provider-x',
    baseUrl: 'https://provider.example/v1',
    keyEnv: 'AGENT_KEY',
    principalId: AGENT_PRINCIPAL,
    promptPolicyId: 'prompt-policy-v1',
    promptPolicyHash: PROMPT_HASH,
    pricing: {
      inputMicroUsdPerMillionTokens: 1_000_000,
      outputMicroUsdPerMillionTokens: 2_000_000,
    },
    limits: {
      maxCallsPerRoom: 4,
      maxCostMicroUsdPerRoom: 10_000,
      maxCostMicroUsdPerCall: 2_000,
    },
    ...overrides,
  };
}

function createRoom(store: ProductStore, id = 'room-1'): ProductRoom {
  return store.createRoom({
    id,
    name: 'Friday Night Table',
    policy: {
      kind: 'SPONSORED',
      participants: [
        { kind: 'HUMAN', principalId: HUMAN },
        { kind: 'AGENT', agentId: AGENT, principalId: AGENT_PRINCIPAL },
      ],
    },
  });
}

function observe(
  store: ProductStore,
  observation: unknown = seatObservationFixture(),
  overrides: Record<string, unknown> = {},
) {
  return store.observeDecision({
    tableId: 'table-1',
    turnId: 'turn-1',
    principalId: HUMAN,
    observation,
    promptPolicyId: 'prompt-policy-v1',
    eventCursor: 7,
    ...overrides,
  } as never);
}

interface SuccessfulAttemptInput {
  responseJson?: string;
  costMicroUsd?: number;
}

function recordSuccessfulAttempt(
  store: ProductStore,
  decisionId: string,
  attemptId: string,
  input: SuccessfulAttemptInput = {},
) {
  return store.recordAttemptResponse(decisionId, attemptId, {
    status: 'SUCCEEDED',
    responseJson: input.responseJson ?? '{"action":"CHECK"}',
    model: 'model-x',
    provider: 'provider-x',
    promptPolicyId: 'prompt-policy-v1',
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      costMicroUsd: input.costMicroUsd ?? 40,
      latencyMs: 120,
    },
  });
}

describe('product database', () => {
  let dir: string;
  let dbPath: string;
  let store: ProductStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nlhe-product-'));
    dbPath = join(dir, 'product.db');
    store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // A restart test may already have closed the handle.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function withRaw<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(dbPath, { readonly: false });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function rawError(sql: string, ...params: Array<string | number>): string | undefined {
    try {
      withRaw((db) => db.prepare(sql).run(...params));
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  describe('migration baseline', () => {
    it('applies the baseline once and reopens idempotently', () => {
      const applied = store.listAppliedMigrations();
      expect(applied.map((migration) => migration.version)).toContain('001_product.sql');
      expect(store.baselineMigrationHash).toMatch(/^[0-9a-f]{64}$/);
      expect(store.baselineMigrationHash).toBe(applied[0]?.sha256);

      store.close();
      store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
      expect(store.listAppliedMigrations()).toEqual(applied);
      expect(store.baselineMigrationHash).toBe(applied[0]?.sha256);
      if (process.platform !== 'win32') {
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      }
    });

    it('renames legacy tournament columns in place for existing databases', () => {
      const legacyDir = join(dir, 'legacy-migrations');
      mkdirSync(legacyDir);
      copyFileSync(PRODUCT_MIGRATION, join(legacyDir, '001_product.sql'));
      const legacyPath = join(dir, 'legacy.db');
      ProductStore.open({ path: legacyPath, migrationsDir: legacyDir }).close();

      // Simulate rows written by the previous schema (`tournament_id`).
      const now = Date.now();
      const raw = new Database(legacyPath);
      raw
        .prepare(
          `INSERT INTO product_rooms
             (id, name, status, policy_kind, policy_json, table_id, tournament_id, failure_reason, created_at, updated_at)
           VALUES (?, ?, 'ACTIVE', 'SPONSORED', ?, ?, ?, NULL, ?, ?)`,
        )
        .run('legacy-room', 'Legacy', '{"kind":"SPONSORED"}', 'table-legacy', 'competition-legacy', now, now);
      raw
        .prepare(
          `INSERT INTO product_room_results
             (room_id, table_id, tournament_id, projection_version, placements_json, derived_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run('legacy-room', 'table-legacy', 'competition-legacy', '[]', now);
      raw.close();

      copyFileSync(join(REPO_MIGRATIONS, '002_product.sql'), join(legacyDir, '002_product.sql'));
      const migrated = ProductStore.open({ path: legacyPath, migrationsDir: legacyDir });
      try {
        expect(migrated.getRoom('legacy-room')).toMatchObject({
          tableId: 'table-legacy',
          platformCompetitionId: 'competition-legacy',
        });
        expect(migrated.getRoomResult('legacy-room')).toMatchObject({
          tableId: 'table-legacy',
          platformCompetitionId: 'competition-legacy',
        });
      } finally {
        migrated.close();
      }
    });

    it('uses its own WAL database and ignores unrelated migrations', () => {
      // A migrations directory may legitimately contain unrelated baselines;
      // only `NNN_product.sql` files are product migrations.
      const mixedDir = mkdtempSync(join(tmpdir(), 'nlhe-product-mixed-'));
      copyFileSync(PRODUCT_MIGRATION, join(mixedDir, '001_product.sql'));
      writeFileSync(join(mixedDir, UNRELATED_MIGRATION), 'CREATE TABLE games (id TEXT);');
      const mixedPath = join(mixedDir, 'mixed.sqlite');
      const mixed = ProductStore.open({ path: mixedPath, migrationsDir: mixedDir });
      expect(mixed.listAppliedMigrations().map((m) => m.version)).toEqual(['001_product.sql']);
      mixed.close();
      const mixedDb = new Database(mixedPath);
      const mixedTables = (
        mixedDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>
      ).map((row) => row.name);
      mixedDb.close();
      expect(mixedTables).not.toContain('games');
      expect(store.listAppliedMigrations().every((m) => m.version.endsWith('_product.sql'))).toBe(true);

      store.close();
      expect(withRaw((db) => db.pragma('journal_mode', { simple: true }))).toBe('wal');
      const tables = withRaw(
        (db) =>
          (
            db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
              name: string;
            }>
          ).map((row) => row.name),
      );
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every((name) => name.startsWith('product_'))).toBe(true);
      expect(tables).not.toContain('games');
      store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
    });

    it('fails closed when an applied product migration changes', () => {
      const migrationsDir = join(dir, 'isolated-migrations');
      mkdirSync(migrationsDir);
      copyFileSync(PRODUCT_MIGRATION, join(migrationsDir, '001_product.sql'));
      ProductStore.open({ path: join(dir, 'hash.db'), migrationsDir }).close();

      const file = join(migrationsDir, '001_product.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- tampered\n`);
      expect(codeOf(() => ProductStore.open({ path: join(dir, 'hash.db'), migrationsDir }))).toBe(
        'MIGRATION_HASH_MISMATCH',
      );
    });

    it('fails when no product baseline exists', () => {
      const migrationsDir = join(dir, 'empty-migrations');
      mkdirSync(migrationsDir);
      writeFileSync(join(migrationsDir, '001_schema.sql'), 'SELECT 1;');
      expect(codeOf(() => ProductStore.open({ path: join(dir, 'none.db'), migrationsDir }))).toBe(
        'MIGRATION_MISSING',
      );
    });

    it('rejects a foreign non-empty database without mutating it', () => {
      const foreignPath = join(dir, 'foreign.db');
      const foreign = new Database(foreignPath);
      foreign.exec('CREATE TABLE games (id TEXT PRIMARY KEY)');
      foreign.prepare('INSERT INTO games (id) VALUES (?)').run('old-v02-game');
      foreign.close();
      if (process.platform !== 'win32') chmodSync(foreignPath, 0o644);
      const before = readFileSync(foreignPath);
      const beforeMode = process.platform !== 'win32' ? statSync(foreignPath).mode & 0o777 : null;

      expect(codeOf(() => ProductStore.open({ path: foreignPath, migrationsDir: REPO_MIGRATIONS }))).toBe(
        'FOREIGN_DATABASE',
      );
      expect(() => ProductStore.open({ path: foreignPath, migrationsDir: REPO_MIGRATIONS })).toThrow(
        /Expected a fresh NLHE product database/,
      );

      // The foreign file is neither rewritten nor chmodded, and no product
      // tables were created in it.
      expect(readFileSync(foreignPath).equals(before)).toBe(true);
      if (beforeMode !== null) expect(statSync(foreignPath).mode & 0o777).toBe(beforeMode);
      const inspect = new Database(foreignPath);
      const tables = (
        inspect.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
      ).map((row) => row.name);
      inspect.close();
      expect(tables).toContain('games');
      expect(tables.some((name) => name.startsWith('product_'))).toBe(false);
    });

    it('creates a fresh product database with owner-only file and directory permissions', () => {
      const nestedDir = join(dir, 'nested', 'deeper');
      const nestedPath = join(nestedDir, 'product.db');
      const fresh = ProductStore.open({ path: nestedPath, migrationsDir: REPO_MIGRATIONS });
      try {
        expect(fresh.listAppliedMigrations().map((migration) => migration.version)).toContain(
          '001_product.sql',
        );
      } finally {
        fresh.close();
      }
      if (process.platform !== 'win32') {
        expect(statSync(nestedPath).mode & 0o777).toBe(0o600);
        expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
      }

      // :memory: is exempt from file/directory permissions.
      const memory = ProductStore.open({ path: ':memory:', migrationsDir: REPO_MIGRATIONS });
      expect(memory.listAppliedMigrations()).toHaveLength(3);
      memory.close();
    });
  });

  describe('rooms', () => {
    it('runs the lifecycle with CAS transitions and platform references', () => {
      const room = createRoom(store);
      expect(room).toMatchObject({
        id: 'room-1',
        name: 'Friday Night Table',
        status: 'DRAFT',
        tableId: null,
        platformCompetitionId: null,
      });
      const participants = store.listParticipants('room-1');
      expect(participants.map((p) => p.kind).sort()).toEqual(['AGENT', 'HUMAN']);
      for (const participant of participants) {
        expect(Object.keys(participant)).not.toContain('seat');
      }

      store.openRoomForRoster('room-1');
      store.beginProvisioning('room-1');
      expect(store.getRoom('room-1')?.status).toBe('PROVISIONING');
      expect(codeOf(() => store.activateRoom('room-1'))).toBe('INVALID_INPUT');

      store.setPlatformReferences('room-1', { tableId: 'table-9', platformCompetitionId: 'tournament-3' });
      expect(store.getRoom('room-1')).toMatchObject({
        tableId: 'table-9',
        platformCompetitionId: 'tournament-3',
      });
      store.activateRoom('room-1');
      expect(store.getRoom('room-1')?.status).toBe('ACTIVE');
      store.completeRoom('room-1');
      expect(store.getRoom('room-1')?.status).toBe('COMPLETE');

      expect(codeOf(() => store.openRoomForRoster('room-1'))).toBe('ROOM_STATE');
      expect(codeOf(() => store.transitionRoom('room-1', 'DRAFT', 'WAITING_FOR_ROSTER'))).toBe('ROOM_STATE');
      expect(codeOf(() => store.setPlatformReferences('room-1', { tableId: 'other' }))).toBe('ROOM_STATE');
      expect(store.listRooms('COMPLETE')).toHaveLength(1);
      expect(store.listRooms('ACTIVE')).toHaveLength(0);
    });

    it('requires a policy-satisfying roster before provisioning', () => {
      store.createRoom({
        id: 'room-2',
        name: 'Partial',
        policy: { kind: 'SPONSORED', participants: [{ kind: 'HUMAN', principalId: HUMAN }] },
      });
      store.openRoomForRoster('room-2');
      expect(codeOf(() => store.beginProvisioning('room-2'))).toBe('SEAT_COUNT');

      store.addParticipant('room-2', { principalId: AGENT_PRINCIPAL, kind: 'AGENT', agentId: AGENT });
      expect(
        codeOf(() =>
          store.addParticipant('room-2', { principalId: AGENT_PRINCIPAL, kind: 'AGENT', agentId: AGENT }),
        ),
      ).toBe('PARTICIPANT_EXISTS');
      expect(store.removeParticipant('room-2', HUMAN)).toBe(true);
      expect(store.removeParticipant('room-2', HUMAN)).toBe(false);
      store.addParticipant('room-2', { principalId: HUMAN, kind: 'HUMAN' });

      store.beginProvisioning('room-2');
      expect(store.getParticipant('room-2', HUMAN)).toMatchObject({ kind: 'HUMAN', agentId: null });
      expect(codeOf(() => store.addParticipant('room-2', { principalId: 'u:late', kind: 'HUMAN' }))).toBe(
        'ROOM_STATE',
      );
      expect(codeOf(() => store.removeParticipant('room-2', HUMAN))).toBe('ROOM_STATE');
    });

    it('enforces CHALLENGE mix caps on joins', () => {
      store.createRoom({
        id: 'room-3',
        name: 'Challenge',
        policy: {
          kind: 'CHALLENGE',
          participants: [
            { kind: 'HUMAN', principalId: HUMAN },
            { kind: 'AGENT', agentId: AGENT, principalId: AGENT_PRINCIPAL },
          ],
        },
      });
      store.openRoomForRoster('room-3');
      expect(codeOf(() => store.addParticipant('room-3', { principalId: 'u:second', kind: 'HUMAN' }))).toBe(
        'HUMAN_COUNT',
      );
      for (let index = 0; index < 8; index++) {
        store.addParticipant('room-3', {
          principalId: `svc:a-${index}`,
          kind: 'AGENT',
          agentId: `a-${index}`,
        });
      }
      expect(
        codeOf(() => store.addParticipant('room-3', { principalId: 'svc:a-9', kind: 'AGENT', agentId: 'a-9' })),
      ).toBe('AGENT_COUNT');
      store.beginProvisioning('room-3');
      expect(store.getRoom('room-3')?.policy.kind).toBe('CHALLENGE');
      expect(store.getRoom('room-3')?.policy.finance).toBeNull();
    });

    it('fails a room with a required reason and survives restart', () => {
      createRoom(store, 'room-4');
      expect(codeOf(() => store.failRoom('room-4', ''))).toBe('INVALID_INPUT');
      const failed = store.failRoom('room-4', 'operator cancelled');
      expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'operator cancelled' });
      expect(codeOf(() => store.failRoom('room-4', 'again'))).toBe('ROOM_STATE');

      store.close();
      store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
      expect(store.getRoom('room-4')).toMatchObject({
        status: 'FAILED',
        failureReason: 'operator cancelled',
      });
      expect(store.listParticipants('room-4')).toHaveLength(2);
    });

    it('generates ids and rejects duplicate principals at creation', () => {
      const room = store.createRoom({
        name: 'Auto id',
        policy: {
          kind: 'CHALLENGE',
          participants: [
            { kind: 'HUMAN', principalId: HUMAN },
            { kind: 'AGENT', agentId: AGENT, principalId: AGENT_PRINCIPAL },
          ],
        },
      });
      expect(room.id.length).toBeGreaterThan(0);
      expect(
        codeOf(() =>
          store.createRoom({
            name: 'dup',
            policy: {
              kind: 'SPONSORED',
              participants: [
                { kind: 'HUMAN', principalId: HUMAN },
                { kind: 'HUMAN', principalId: HUMAN },
              ],
            },
          }),
        ),
      ).toBe('PARTICIPANT_EXISTS');
    });
  });

  describe('durable decisions', () => {
    it('observes a turn once with the canonical plain-sha256 hash and version', () => {
      const fixture = seatObservationFixture();
      const decision = observe(store, fixture);
      expect(decision.status).toBe('OBSERVED');
      expect(decision.id).toBe(computeDecisionId('table-1', 'turn-1', HUMAN));
      expect(decision.id).toMatch(/^[0-9a-f]{64}$/);
      expect(decision.observationHash).toBe(computeObservationHash(fixture));
      expect(decision.observationHash).toBe(
        createHash('sha256').update(canonicalJson(fixture)).digest('hex'),
      );
      expect(decision.version).toBe(fixture.version);
      expect(decision.observation.tableId).toBe('table-1');
      expect(decision.source).toBeNull();

      const reordered = {
        legalActions: fixture.legalActions,
        eventSeq: fixture.eventSeq,
        version: fixture.version,
        turnId: fixture.turnId,
        handId: fixture.handId,
        state: fixture.state,
        tableId: fixture.tableId,
      };
      expect(computeObservationHash(reordered)).toBe(decision.observationHash);

      expect(observe(store, fixture).id).toBe(decision.id);
      expect(store.listDecisions({ tableId: 'table-1' })).toHaveLength(1);
      expect(store.getDecisionForTurn('table-1', 'turn-1', HUMAN)?.id).toBe(decision.id);
    });

    it('hashes observations exactly like the provider stable-JSON hash', async () => {
      const { sha256Hex, stableJson } = await import('../../src/llm/decision-prompt.js');
      const fixture = seatObservationFixture();
      expect(computeObservationHash(fixture)).toBe(sha256Hex(stableJson(fixture)));
      const decision = observe(store, fixture);
      expect(decision.observationHash).toBe(sha256Hex(stableJson(fixture)));
      expect(decision.observationHash).toBe(sha256Hex(stableJson(decision.observation)));
    });

    it('rejects invalid observations and conflicting re-observations', () => {
      expect(codeOf(() => observe(store, { tableId: 'table-1' }))).toBe('INVALID_INPUT');
      expect(
        codeOf(() => observe(store, { ...seatObservationFixture(), handId: 'other-hand' })),
      ).toBe('INVALID_INPUT');

      const fixture = seatObservationFixture();
      expect(codeOf(() => observe(store, fixture, { observationHash: 'f'.repeat(64) }))).toBe(
        'OBSERVATION_CONFLICT',
      );
      const decision = observe(store, fixture);
      expect(
        codeOf(() => observe(store, seatObservationFixture({ version: fixture.version + 1 }))),
      ).toBe('OBSERVATION_CONFLICT');
      expect(codeOf(() => observe(store, fixture, { eventCursor: 8 }))).toBe('OBSERVATION_CONFLICT');
      expect(codeOf(() => observe(store, fixture, { tableId: 'other-table' }))).toBe(
        'OBSERVATION_CONFLICT',
      );
      expect(decision.id).toBeDefined();
    });

    it('attaches an immutable pre-transport source snapshot', () => {
      const fixture = seatObservationFixture();
      const chat = chatMessageFixture();
      const decision = observe(store, fixture, { source: { publicChat: [chat] } });
      expect(decision.source).toEqual({ publicChat: [chat] });

      expect(observe(store, fixture, { source: { publicChat: [chat] } }).id).toBe(decision.id);
      expect(
        codeOf(() =>
          observe(store, fixture, {
            source: { publicChat: [chatMessageFixture({ body: 'changed' })] },
          }),
        ),
      ).toBe('OBSERVATION_CONFLICT');
      expect(
        rawError(
          'UPDATE product_decisions SET source_json = ? WHERE id = ?',
          JSON.stringify({ publicChat: [] }),
          decision.id,
        ),
      ).toMatch(/immutable/);
    });

    it('drives the lifecycle with CAS and reuses recorded success', () => {
      const fixture = seatObservationFixture();
      const decision = observe(store, fixture);
      const started = store.startAttempt(decision.id, '{"messages":[]}');
      expect(started.kind).toBe('started');
      if (started.kind !== 'started') throw new Error('unreachable');
      expect(started.attempt).toMatchObject({ attemptNo: 1, status: 'PENDING', model: null });
      expect(store.getDecision(decision.id)?.status).toBe('CALLING_PROVIDER');
      expect(codeOf(() => store.startAttempt(decision.id, '{"messages":[]}'))).toBe('ATTEMPT_IN_FLIGHT');

      const recorded = recordSuccessfulAttempt(store, decision.id, started.attempt.id);
      expect(recorded).toMatchObject({ status: 'SUCCEEDED', model: 'model-x', costMicroUsd: 40 });
      expect(store.getDecision(decision.id)?.status).toBe('PROVIDER_RECORDED');

      const reused = store.startAttempt(decision.id, '{"messages":[]}');
      expect(reused.kind).toBe('reuse');
      if (reused.kind !== 'reuse') throw new Error('unreachable');
      expect(reused.attempt.id).toBe(started.attempt.id);

      const request = actionRequestFixture(fixture);
      const submitted = store.submitResolvedAction(decision.id, JSON.stringify(request));
      expect(submitted).toMatchObject({
        status: 'ACTION_SUBMITTED',
        requestJson: JSON.stringify(request),
      });
      const receipt = actionReceiptFixture(fixture);
      const committed = store.commitDecision(decision.id, JSON.stringify(receipt));
      expect(committed).toMatchObject({
        status: 'COMMITTED',
        receiptJson: JSON.stringify(receipt),
        requestJson: JSON.stringify(request),
      });
      expect(
        codeOf(() =>
          store.transitionDecision(decision.id, 'PROVIDER_RECORDED', 'ACTION_SUBMITTED', {
            requestJson: '{}',
          }),
        ),
      ).toBe('DECISION_STATE');
      expect(store.listAttempts(decision.id)).toHaveLength(1);
      expect(store.startAttempt(decision.id, '{"messages":[]}').kind).toBe('reuse');
    });

    it('records failed attempts without reusing them and retries the next attempt', () => {
      const decision = observe(store);
      const first = store.startAttempt(decision.id, '{"messages":[]}');
      if (first.kind !== 'started') throw new Error('unreachable');
      const failed = store.recordAttemptResponse(decision.id, first.attempt.id, {
        status: 'FAILED',
        error: 'HTTP 503',
        responseJson: '{"error":"overloaded"}',
        model: 'model-x',
        provider: 'provider-x',
        promptPolicyId: 'prompt-policy-v1',
        usage: { promptTokens: 0, completionTokens: 0, costMicroUsd: 0, latencyMs: 30 },
      });
      expect(failed.status).toBe('FAILED');
      expect(store.getDecision(decision.id)?.status).toBe('OBSERVED');

      const second = store.startAttempt(decision.id, '{"messages":[]}');
      expect(second.kind).toBe('started');
      if (second.kind !== 'started') throw new Error('unreachable');
      expect(second.attempt.attemptNo).toBe(2);
      expect(second.attempt.id).not.toBe(first.attempt.id);

      recordSuccessfulAttempt(store, decision.id, second.attempt.id, { responseJson: '{"action":"CALL"}' });
      const reused = store.startAttempt(decision.id, '{"messages":[]}');
      expect(reused.kind).toBe('reuse');
      if (reused.kind !== 'reuse') throw new Error('unreachable');
      expect(reused.attempt.id).toBe(second.attempt.id);
    });

    it('seals attempt request and response records once written', () => {
      const decision = observe(store);
      const started = store.startAttempt(decision.id, '{"messages":[]}');
      if (started.kind !== 'started') throw new Error('unreachable');
      expect(
        rawError(
          'UPDATE product_model_attempts SET request_json = ? WHERE id = ?',
          '{"messages":[1]}',
          started.attempt.id,
        ),
      ).toMatch(/immutable/);
      expect(rawError('DELETE FROM product_model_attempts WHERE id = ?', started.attempt.id)).toMatch(
        /immutable/,
      );

      recordSuccessfulAttempt(store, decision.id, started.attempt.id);
      expect(
        rawError(
          'UPDATE product_model_attempts SET response_json = ?, recorded_at = ? WHERE id = ?',
          '{"again":1}',
          Date.now(),
          started.attempt.id,
        ),
      ).toMatch(/already recorded/);
      expect(
        codeOf(() =>
          store.recordAttemptResponse(decision.id, started.attempt.id, {
            status: 'SUCCEEDED',
            responseJson: '{"again":1}',
            model: 'model-x',
            provider: 'provider-x',
            promptPolicyId: 'prompt-policy-v1',
            usage: { promptTokens: 0, completionTokens: 0, costMicroUsd: 0, latencyMs: 0 },
          }),
        ),
      ).toBe('DECISION_STATE');
      expect(store.getAttempt(started.attempt.id)?.responseJson).toBe('{"action":"CHECK"}');
    });

    it('prevents rewriting the resolved request, receipt or room reference', () => {
      const fixture = seatObservationFixture();
      createRoom(store, 'room-ref');
      const decision = observe(store, fixture, { roomId: 'room-ref' });
      const started = store.startAttempt(decision.id, '{"messages":[]}');
      if (started.kind !== 'started') throw new Error('unreachable');
      recordSuccessfulAttempt(store, decision.id, started.attempt.id);
      const request = actionRequestFixture(fixture);
      store.submitResolvedAction(decision.id, JSON.stringify(request));
      const receipt = actionReceiptFixture(fixture);
      store.commitDecision(decision.id, JSON.stringify(receipt));

      expect(store.getDecision(decision.id)?.requestJson).toBe(JSON.stringify(request));
      expect(
        rawError(
          'UPDATE product_decisions SET request_json = ? WHERE id = ?',
          JSON.stringify({ ...request, actionId: 'la-fold' }),
          decision.id,
        ),
      ).toMatch(/write-once/);
      expect(
        rawError('UPDATE product_decisions SET receipt_json = NULL WHERE id = ?', decision.id),
      ).toMatch(/write-once/);
      expect(
        rawError('UPDATE product_decisions SET room_id = ? WHERE id = ?', 'room-other', decision.id),
      ).toMatch(/immutable/);
      // Lifecycle-column updates remain allowed alongside the write-once guard.
      expect(rawError('UPDATE product_decisions SET updated_at = ? WHERE id = ?', Date.now(), decision.id)).toBeUndefined();

      store.close();
      store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
      const restored = store.getDecision(decision.id);
      expect(restored?.requestJson).toBe(JSON.stringify(request));
      expect(restored?.receiptJson).toBe(JSON.stringify(receipt));
      expect(restored?.roomId).toBe('room-ref');
    });

    it('persists the exact request hash and immutable sanitized transport metadata', () => {
      const fixture = seatObservationFixture();
      const decision = observe(store, fixture);
      const request = JSON.stringify(actionRequestFixture(fixture));
      const metadata = {
        baseUrlHost: 'localhost:8080',
        model: 'model-x',
        provider: 'provider-x',
        temperature: 0.2,
      };
      const started = store.startAttempt(decision.id, request, metadata);
      if (started.kind !== 'started') throw new Error('unreachable');
      expect(started.attempt.requestHash).toBe(
        createHash('sha256').update(request, 'utf8').digest('hex'),
      );
      expect(JSON.parse(started.attempt.requestMetadataJson ?? 'null')).toEqual(metadata);
      expect(started.attempt.requestMetadataJson).not.toContain('authorization');

      expect(
        rawError(
          'UPDATE product_model_attempts SET request_hash = ? WHERE id = ?',
          'f'.repeat(64),
          started.attempt.id,
        ),
      ).toMatch(/immutable/);
      expect(
        rawError(
          'UPDATE product_model_attempts SET request_metadata_json = ? WHERE id = ?',
          '{"tampered":true}',
          started.attempt.id,
        ),
      ).toMatch(/immutable/);

      for (const forbidden of [
        { headers: { authorization: 'Bearer sk-live' } },
        { nested: { authorization: 'Bearer sk-live' } },
        { apiKey: 'sk-live' },
        { password: 'hunter2' },
      ]) {
        expect(codeOf(() => store.startAttempt(decision.id, request, forbidden))).toBe('INVALID_INPUT');
      }
    });

    it('accepts transport metadata as JSON text and rejects non-object metadata', () => {
      const decision = observe(
        store,
        seatObservationFixture({ tableId: 'table-meta', turnId: 'turn-meta' }),
        { tableId: 'table-meta', turnId: 'turn-meta' },
      );
      const started = store.startAttempt(decision.id, '{"messages":[]}', '{"model":"model-x"}');
      if (started.kind !== 'started') throw new Error('unreachable');
      expect(JSON.parse(started.attempt.requestMetadataJson ?? 'null')).toEqual({ model: 'model-x' });
      expect(codeOf(() => store.startAttempt(decision.id, '{"messages":[]}', [1, 2]))).toBe(
        'INVALID_INPUT',
      );
      expect(codeOf(() => store.startAttempt(decision.id, '{"messages":[]}', 'not-json'))).toBe(
        'INVALID_INPUT',
      );
    });

    it('marks the speech intention at most once after commit', () => {
      const fixture = seatObservationFixture();
      const decision = observe(store, fixture);
      expect(codeOf(() => store.markSpeechIntended(decision.id))).toBe('DECISION_STATE');

      const started = store.startAttempt(decision.id, '{"messages":[]}');
      if (started.kind !== 'started') throw new Error('unreachable');
      recordSuccessfulAttempt(store, decision.id, started.attempt.id);
      store.submitResolvedAction(decision.id, JSON.stringify(actionRequestFixture(fixture)));
      expect(codeOf(() => store.markSpeechIntended(decision.id))).toBe('DECISION_STATE');
      store.commitDecision(decision.id, JSON.stringify(actionReceiptFixture(fixture)));

      expect(store.markSpeechIntended(decision.id)).toBe(true);
      expect(store.markSpeechIntended(decision.id)).toBe(false);
      const committed = store.getDecision(decision.id);
      expect(committed?.speechIntendedAt).toEqual(expect.any(Number));
      expect(Object.keys(committed ?? {})).not.toContain('chatText');

      expect(
        rawError(
          'UPDATE product_decisions SET speech_intended_at = ? WHERE id = ?',
          (committed?.speechIntendedAt ?? 0) + 1,
          decision.id,
        ),
      ).toMatch(/write-once/);

      store.close();
      store = ProductStore.open({ path: dbPath, migrationsDir: REPO_MIGRATIONS });
      expect(store.getDecision(decision.id)?.speechIntendedAt).toBe(committed?.speechIntendedAt);
      expect(store.markSpeechIntended(decision.id)).toBe(false);
    });

    it('marks decisions stale or failed with reasons and keeps them terminal', () => {
      const stale = observe(store);
      expect(store.markDecisionStale(stale.id, 'cursor advanced')).toMatchObject({
        status: 'STALE',
        errorReason: 'cursor advanced',
      });
      expect(codeOf(() => store.startAttempt(stale.id, '{}'))).toBe('DECISION_STATE');

      const other = observe(
        store,
        seatObservationFixture({ tableId: 'table-2', turnId: 'turn-2' }),
        { tableId: 'table-2', turnId: 'turn-2', eventCursor: 2 },
      );
      expect(store.failDecision(other.id, 'provider unavailable')).toMatchObject({
        status: 'FAILED',
        errorReason: 'provider unavailable',
      });
      expect(codeOf(() => store.markDecisionStale(other.id, 'late'))).toBe('DECISION_STATE');
      expect(codeOf(() => store.commitDecision(other.id, '{}'))).toBe('DECISION_STATE');
    });
  });

  describe('compute reservations', () => {
    it('reserves the per-call maximum and enforces call and cost budgets', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 2, maxCostMicroUsdPerRoom: 100, maxCostMicroUsdPerCall: 40 },
        }),
      );
      createRoom(store, 'room-budget');

      const first = store.reserveCall('room-budget', AGENT);
      expect(first).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 40,
        callsSettled: 0,
        costMicroUsdSettled: 0,
      });
      expect(store.reserveCall('room-budget', AGENT)).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 80,
      });
      expect(codeOf(() => store.reserveCall('room-budget', AGENT))).toBe('RESERVATION_EXCEEDED');

      expect(store.settleCall('room-budget', AGENT, 25)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 40,
        callsSettled: 1,
        costMicroUsdSettled: 25,
      });
      expect(codeOf(() => store.reserveCall('room-budget', AGENT))).toBe('RESERVATION_EXCEEDED');
      expect(store.releaseCall('room-budget', AGENT)).toMatchObject({
        callsReserved: 0,
        costMicroUsdReserved: 0,
        callsSettled: 1,
        costMicroUsdSettled: 25,
      });
      expect(store.reserveCall('room-budget', AGENT).callsReserved).toBe(1);
      expect(store.settleCall('room-budget', AGENT, 40)).toMatchObject({
        callsSettled: 2,
        costMicroUsdSettled: 65,
      });
      expect(codeOf(() => store.reserveCall('room-budget', AGENT))).toBe('RESERVATION_EXCEEDED');
    });

    it('persists real overrun cost before raising the budget error', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 100, maxCostMicroUsdPerCall: 40 },
        }),
      );
      createRoom(store, 'room-budget-2');
      store.reserveCall('room-budget-2', AGENT);
      expect(codeOf(() => store.settleCall('room-budget-2', AGENT, 12.5))).toBe('INVALID_INPUT');
      expect(codeOf(() => store.settleCall('room-budget-2', AGENT, -1))).toBe('INVALID_INPUT');
      expect(store.getReservation('room-budget-2', AGENT)).toMatchObject({
        callsReserved: 1,
        costMicroUsdSettled: 0,
      });

      expect(codeOf(() => store.settleCall('room-budget-2', AGENT, 55))).toBe('RESERVATION_EXCEEDED');
      expect(store.getReservation('room-budget-2', AGENT)).toMatchObject({
        callsReserved: 0,
        costMicroUsdReserved: 0,
        callsSettled: 1,
        costMicroUsdSettled: 55,
      });
      expect(codeOf(() => store.settleCall('room-budget-2', AGENT, 10))).toBe('RESERVATION_NOT_FOUND');
      expect(codeOf(() => store.releaseCall('room-budget-2', AGENT))).toBe('RESERVATION_NOT_FOUND');

      // 55 settled + 40 reserve still fits the room budget.
      store.reserveCall('room-budget-2', AGENT);
      expect(codeOf(() => store.settleCall('room-budget-2', AGENT, 55))).toBe('RESERVATION_EXCEEDED');
      expect(store.getReservation('room-budget-2', AGENT)).toMatchObject({
        callsSettled: 2,
        costMicroUsdSettled: 110,
      });
      expect(codeOf(() => store.reserveCall('room-budget-2', AGENT))).toBe('RESERVATION_EXCEEDED');
    });

    it('settles the actual recorded provider cost after a successful response', () => {
      store.upsertAgentConfig(agentConfig());
      createRoom(store, 'room-settle');
      const decision = observe(store);
      const started = store.startAttempt(decision.id, '{"messages":[]}');
      if (started.kind !== 'started') throw new Error('unreachable');
      const attempt = recordSuccessfulAttempt(store, decision.id, started.attempt.id, { costMicroUsd: 33 });
      store.reserveCall('room-settle', AGENT);
      expect(store.settleCall('room-settle', AGENT, attempt.costMicroUsd)).toMatchObject({
        callsSettled: 1,
        costMicroUsdSettled: 33,
      });
    });

    it('freezes limits below outstanding reservations and refuses disabled agents', () => {
      const limits = { maxCallsPerRoom: 2, maxCostMicroUsdPerRoom: 100, maxCostMicroUsdPerCall: 40 };
      store.upsertAgentConfig(agentConfig({ limits }));
      createRoom(store, 'room-budget-3');
      store.reserveCall('room-budget-3', AGENT);
      store.reserveCall('room-budget-3', AGENT);

      expect(
        codeOf(() =>
          store.upsertAgentConfig(
            agentConfig({ limits: { ...limits, maxCostMicroUsdPerCall: 30, maxCostMicroUsdPerRoom: 100 } }),
          ),
        ),
      ).toBe('INVALID_INPUT');
      expect(
        codeOf(() => store.upsertAgentConfig(agentConfig({ limits: { ...limits, maxCallsPerRoom: 1 } }))),
      ).toBe('INVALID_INPUT');
      expect(
        codeOf(() =>
          store.upsertAgentConfig(
            agentConfig({ limits: { maxCallsPerRoom: 1, maxCostMicroUsdPerRoom: 30, maxCostMicroUsdPerCall: 40 } }),
          ),
        ),
      ).toBe('INVALID_LIMIT');
      store.releaseCall('room-budget-3', AGENT);
      store.releaseCall('room-budget-3', AGENT);
      expect(() =>
        store.upsertAgentConfig(agentConfig({ limits: { ...limits, maxCallsPerRoom: 1 } })),
      ).not.toThrow();

      store.upsertAgentConfig(agentConfig({ enabled: false }));
      expect(codeOf(() => store.reserveCall('room-budget-3', AGENT))).toBe('AGENT_DISABLED');
    });

    it('settles unknown call cost at the reserved maximum without false billing', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 100, maxCostMicroUsdPerCall: 40 },
        }),
      );
      createRoom(store, 'room-unknown');
      const decision = observe(
        store,
        seatObservationFixture({ tableId: 'table-unknown', turnId: 'turn-unknown' }),
        { tableId: 'table-unknown', turnId: 'turn-unknown' },
      );
      const started = store.startAttempt(decision.id, '{"messages":[]}');
      if (started.kind !== 'started') throw new Error('unreachable');
      const failed = store.recordAttemptResponse(decision.id, started.attempt.id, {
        status: 'FAILED',
        error: 'provider timeout',
        model: 'model-x',
        provider: 'provider-x',
        promptPolicyId: 'prompt-policy-v1',
        usage: { promptTokens: 0, completionTokens: 0, costMicroUsd: 0, latencyMs: 5000 },
      });

      store.reserveCall('room-unknown', AGENT);
      expect(store.settleUnknownCall('room-unknown', AGENT)).toMatchObject({
        callsReserved: 0,
        costMicroUsdReserved: 0,
        callsSettled: 1,
        costMicroUsdSettled: 40,
      });
      expect(failed.costMicroUsd).toBe(0); // analytics never falsely billed
      expect(codeOf(() => store.settleUnknownCall('room-unknown', AGENT))).toBe('RESERVATION_NOT_FOUND');

      // Two unknown settlements consume the room budget conservatively.
      store.reserveCall('room-unknown', AGENT);
      store.settleUnknownCall('room-unknown', AGENT);
      expect(store.getReservation('room-unknown', AGENT)).toMatchObject({
        callsSettled: 2,
        costMicroUsdSettled: 80,
      });
      expect(codeOf(() => store.reserveCall('room-unknown', AGENT))).toBe('RESERVATION_EXCEEDED');
    });

    it('lists every agent reservation for a room', () => {
      store.upsertAgentConfig(agentConfig());
      store.upsertAgentConfig(
        agentConfig({ id: 'agent-2', keyEnv: 'AGENT_KEY_2', principalId: 'svc:agent-2' }),
      );
      createRoom(store, 'room-list');
      createRoom(store, 'room-other');
      store.reserveCall('room-list', AGENT);
      store.reserveCall('room-list', 'agent-2');
      store.reserveCall('room-other', AGENT);

      const reservations = store.listRoomReservations('room-list');
      expect(reservations.map((reservation) => reservation.agentId)).toEqual([AGENT, 'agent-2']);
      expect(reservations.every((reservation) => reservation.roomId === 'room-list')).toBe(true);
      expect(store.listRoomReservations('room-other')).toHaveLength(1);
      expect(store.listRoomReservations('room-empty')).toEqual([]);
    });

    it('admits two agents against the shared remaining room cost and rejects room overruns before modifying', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 40 },
        }),
      );
      store.upsertAgentConfig(
        agentConfig({
          id: 'agent-2',
          keyEnv: 'AGENT_KEY_2',
          principalId: 'svc:agent-2',
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 30 },
        }),
      );
      createRoom(store, 'room-shared');
      const roomLimits = { maxCalls: 4, maxCostMicroUsd: 100 };

      expect(store.reserveCall('room-shared', AGENT, roomLimits)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 40,
      });
      expect(store.reserveCall('room-shared', 'agent-2', roomLimits)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 30,
      });
      // Shared remaining cost is exact: 70 + 30 == 100 is admitted (strict >).
      expect(store.reserveCall('room-shared', 'agent-2', roomLimits)).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 60,
      });
      // 100 + 40 > 100: rejected across agents before any modification.
      expect(codeOf(() => store.reserveCall('room-shared', AGENT, roomLimits))).toBe(
        'ROOM_RESERVATION_EXCEEDED',
      );
      expect(store.getReservation('room-shared', AGENT)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 40,
      });
      expect(store.getReservation('room-shared', 'agent-2')).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 60,
      });

      // Bigint room limits compare exactly (140 == 140 admitted).
      expect(store.reserveCall('room-shared', AGENT, { maxCostMicroUsd: 140n })).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 80,
      });
    });

    it('rejects room call admissions across agents and honours zero caps', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 40 },
        }),
      );
      store.upsertAgentConfig(
        agentConfig({ id: 'agent-2', keyEnv: 'AGENT_KEY_2', principalId: 'svc:agent-2',
          limits: { maxCallsPerRoom: 4, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 40 } }),
      );
      createRoom(store, 'room-shared-calls');
      const roomLimits = { maxCalls: 2, maxCostMicroUsd: 1000 };
      store.reserveCall('room-shared-calls', AGENT, roomLimits);
      store.reserveCall('room-shared-calls', 'agent-2', roomLimits);
      // Per-agent caps would allow this, but the room aggregate is exhausted.
      expect(codeOf(() => store.reserveCall('room-shared-calls', AGENT, roomLimits))).toBe(
        'ROOM_RESERVATION_EXCEEDED',
      );

      store.upsertAgentConfig(
        agentConfig({
          id: 'agent-free',
          keyEnv: 'AGENT_FREE_KEY',
          principalId: 'svc:agent-free',
          limits: { maxCallsPerRoom: 2, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 },
        }),
      );
      createRoom(store, 'room-free');
      // A 0 cost cap still admits a 0 reserved cost; a 0 call cap admits none.
      expect(store.reserveCall('room-free', 'agent-free', { maxCalls: 1, maxCostMicroUsd: 0 })).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 0,
      });
      expect(codeOf(() => store.reserveCall('room-free', 'agent-free', { maxCalls: 0, maxCostMicroUsd: 0 }))).toBe(
        'ROOM_RESERVATION_EXCEEDED',
      );
      expect(codeOf(() => store.reserveCall('room-free', 'agent-free', { maxCostMicroUsd: 1.5 }))).toBe(
        'INVALID_INPUT',
      );
      expect(codeOf(() => store.reserveCall('room-free', 'agent-free', { maxCalls: -1n }))).toBe(
        'INVALID_INPUT',
      );
    });

    it('admits calls reserved at a caller ceiling where the declared max would exhaust the room cap', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 8, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 100 },
        }),
      );
      const roomLimits = { maxCalls: 8, maxCostMicroUsd: 100 };
      createRoom(store, 'room-declared-cap');
      // Declared-max reservation consumes the whole room cap; the second call is denied.
      store.reserveCall('room-declared-cap', AGENT, roomLimits);
      expect(codeOf(() => store.reserveCall('room-declared-cap', AGENT, roomLimits))).toBe(
        'ROOM_RESERVATION_EXCEEDED',
      );

      createRoom(store, 'room-ceiling');
      expect(store.reserveCall('room-ceiling', AGENT, roomLimits, 30)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 30,
      });
      expect(store.reserveCall('room-ceiling', AGENT, roomLimits, 30)).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 60,
      });
      expect(store.reserveCall('room-ceiling', AGENT, roomLimits, 30n)).toMatchObject({
        callsReserved: 3,
        costMicroUsdReserved: 90,
      });
      // Overrun still denied before modification (90 + 30 > 100).
      expect(codeOf(() => store.reserveCall('room-ceiling', AGENT, roomLimits, 30))).toBe(
        'ROOM_RESERVATION_EXCEEDED',
      );
      expect(store.getReservation('room-ceiling', AGENT)).toMatchObject({
        callsReserved: 3,
        costMicroUsdReserved: 90,
      });
    });

    it('releases the exact per-call ceiling on settlement and unknown settlement', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 8, maxCostMicroUsdPerRoom: 1000, maxCostMicroUsdPerCall: 100 },
        }),
      );
      createRoom(store, 'room-ceiling-settle');
      store.reserveCall('room-ceiling-settle', AGENT, {}, 30);
      store.reserveCall('room-ceiling-settle', AGENT, {}, 20);
      expect(store.getReservation('room-ceiling-settle', AGENT)).toMatchObject({
        callsReserved: 2,
        costMicroUsdReserved: 50,
      });

      // FIFO: settling releases the first ceiling (30), not the declared max (100).
      expect(store.settleCall('room-ceiling-settle', AGENT, 10)).toMatchObject({
        callsReserved: 1,
        costMicroUsdReserved: 20,
        callsSettled: 1,
        costMicroUsdSettled: 10,
      });
      expect(store.settleUnknownCall('room-ceiling-settle', AGENT)).toMatchObject({
        callsReserved: 0,
        costMicroUsdReserved: 0,
        callsSettled: 2,
        costMicroUsdSettled: 30,
      });
    });

    it('admits zero-ceiling calls under a zero cap and enforces per-agent room caps and invalid amounts', () => {
      store.upsertAgentConfig(
        agentConfig({
          limits: { maxCallsPerRoom: 2, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 },
        }),
      );
      createRoom(store, 'room-zero-ceiling');
      expect(store.reserveCall('room-zero-ceiling', AGENT, { maxCalls: 2, maxCostMicroUsd: 0 }, 0)).toMatchObject(
        { callsReserved: 1, costMicroUsdReserved: 0 },
      );
      expect(store.reserveCall('room-zero-ceiling', AGENT, { maxCalls: 2, maxCostMicroUsd: 0 }, 0n)).toMatchObject(
        { callsReserved: 2, costMicroUsdReserved: 0 },
      );
      expect(
        codeOf(() => store.reserveCall('room-zero-ceiling', AGENT, { maxCalls: 2, maxCostMicroUsd: 0 }, 0)),
      ).toBe('ROOM_RESERVATION_EXCEEDED');

      store.upsertAgentConfig(
        agentConfig({
          id: 'agent-capped',
          keyEnv: 'CAPPED_KEY',
          principalId: 'svc:capped',
          limits: { maxCallsPerRoom: 8, maxCostMicroUsdPerRoom: 50, maxCostMicroUsdPerCall: 50 },
        }),
      );
      createRoom(store, 'room-agent-cap');
      store.reserveCall('room-agent-cap', 'agent-capped', { maxCostMicroUsd: 1000 }, 30);
      // Per-agent per-room cost cap uses reserved+settled+incoming: 30 + 30 > 50.
      expect(
        codeOf(() => store.reserveCall('room-agent-cap', 'agent-capped', { maxCostMicroUsd: 1000 }, 30)),
      ).toBe('RESERVATION_EXCEEDED');

      expect(codeOf(() => store.reserveCall('room-agent-cap', 'agent-capped', {}, 1.5))).toBe(
        'INVALID_INPUT',
      );
      expect(codeOf(() => store.reserveCall('room-agent-cap', 'agent-capped', {}, -1n))).toBe(
        'INVALID_INPUT',
      );
      expect(
        codeOf(() =>
          store.reserveCall('room-agent-cap', 'agent-capped', {}, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        ),
      ).toBe('INVALID_INPUT');
    });

    it('does not reserve compute on terminal rooms', () => {
      store.upsertAgentConfig(agentConfig());
      createRoom(store, 'room-budget-4');
      store.openRoomForRoster('room-budget-4');
      store.beginProvisioning('room-budget-4');
      store.setPlatformReferences('room-budget-4', { tableId: 'table-budget' });
      store.activateRoom('room-budget-4');
      store.completeRoom('room-budget-4');
      expect(codeOf(() => store.reserveCall('room-budget-4', AGENT))).toBe('ROOM_STATE');
    });
  });

  describe('derived platform results', () => {
    function completedRoom(id: string): void {
      createRoom(store, id);
      store.openRoomForRoster(id);
      store.beginProvisioning(id);
      store.setPlatformReferences(id, { tableId: `table-${id}`, platformCompetitionId: 'tournament-9' });
      store.activateRoom(id);
      store.completeRoom(id);
    }

    it('records an immutable projection with no financial settlement fields', () => {
      completedRoom('room-results');
      const result = store.recordRoomResult({
        roomId: 'room-results',
        placements: [
          { principalId: HUMAN, kind: 'HUMAN', placement: 1 },
          { principalId: AGENT_PRINCIPAL, kind: 'AGENT', placement: 2 },
        ],
      });
      expect(result).toMatchObject({
        roomId: 'room-results',
        tableId: 'table-room-results',
        platformCompetitionId: 'tournament-9',
        projectionVersion: 1,
      });
      const serialized = JSON.stringify(result);
      for (const forbidden of ['entryAtomic', 'prizeAtomic', 'assetId', 'payout', 'settlement']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(store.getRoomResult('room-results')).toEqual(result);
      expect(
        codeOf(() =>
          store.recordRoomResult({
            roomId: 'room-results',
            placements: [{ principalId: HUMAN, kind: 'HUMAN', placement: 1 }],
          }),
        ),
      ).toBe('RESULT_EXISTS');
      expect(
        rawError('UPDATE product_room_results SET placements_json = ? WHERE room_id = ?', '[]', 'room-results'),
      ).toMatch(/immutable/);
      expect(rawError('DELETE FROM product_room_results WHERE room_id = ?', 'room-results')).toMatch(
        /immutable/,
      );
    });

    it('requires a complete room and participant-consistent placements', () => {
      createRoom(store, 'room-open');
      expect(
        codeOf(() =>
          store.recordRoomResult({
            roomId: 'room-open',
            placements: [{ principalId: HUMAN, kind: 'HUMAN', placement: 1 }],
          }),
        ),
      ).toBe('ROOM_STATE');

      completedRoom('room-results-2');
      expect(
        codeOf(() =>
          store.recordRoomResult({
            roomId: 'room-results-2',
            placements: [{ principalId: 'u:stranger', kind: 'HUMAN', placement: 1 }],
          }),
        ),
      ).toBe('INVALID_INPUT');
      expect(
        codeOf(() =>
          store.recordRoomResult({
            roomId: 'room-results-2',
            placements: [{ principalId: HUMAN, kind: 'AGENT', placement: 1 }],
          }),
        ),
      ).toBe('INVALID_INPUT');
      expect(
        codeOf(() =>
          store.recordRoomResult({
            roomId: 'room-results-2',
            placements: [
              { principalId: HUMAN, kind: 'HUMAN', placement: 1 },
              { principalId: AGENT_PRINCIPAL, kind: 'AGENT', placement: 1 },
            ],
          }),
        ),
      ).toBe('INVALID_INPUT');
      expect(codeOf(() => store.recordRoomResult({ roomId: 'room-results-2', placements: [] }))).toBe(
        'INVALID_INPUT',
      );
      expect(
        store.recordRoomResult({
          roomId: 'room-results-2',
          placements: [
            { principalId: HUMAN, kind: 'HUMAN', placement: 2 },
            { principalId: AGENT_PRINCIPAL, kind: 'AGENT', placement: 1 },
          ],
        }),
      ).toBeDefined();
    });
  });
});

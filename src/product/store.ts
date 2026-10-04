/**
 * Product persistence store.
 *
 * Owns a dedicated SQLite database (WAL, single process) for product-level
 * state: rooms, participant metadata, agent configuration references, durable
 * per-turn decisions, immutable model attempts, per-room compute reservations
 * and the immutable results projection.
 *
 * Boundaries:
 * - No poker state and no seat authority: rooms reference external
 *   table/platform competition ids; participants are principal metadata only.
 * - No financial settlement: `product_room_results` is a derived platform
 *   projection and is never an accounting source.
 * - No secrets: agent configuration stores environment-variable names.
 *
 * Startup is idempotent. Product migrations (`NNN_product.sql`) are applied
 * once and their SHA-256 is re-verified on every open. All money/budget
 * quantities are integer micro-USD; floats are rejected.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { normalizeAgentConfig, type AgentConfig, type AgentConfigInput } from './catalog.js';
import {
  canonicalJson,
  computeObservationHash,
  parseDecisionSource,
  parseSeatObservation,
  type DecisionSource,
  type SeatObservation,
} from './observation.js';
import {
  assertParticipantAllowed,
  assertRosterSatisfiesPolicy,
  normalizePolicyParticipant,
  resolveProductPolicy,
  type ParticipantKind,
  type PolicyParticipant,
  type ProductPolicy,
  type ProductPolicyInput,
  type ProductPolicyKind,
} from './policy.js';

/** File-name shape of product migrations (for example `001_product.sql`). */
export const PRODUCT_MIGRATION_FILE_PATTERN = /^\d+_product\.sql$/;

/** Default product database path relative to the process working directory. */
export const DEFAULT_PRODUCT_DB_PATH = 'data/product.db';

/** Product room lifecycle states. */
export type RoomStatus =
  | 'DRAFT'
  | 'WAITING_FOR_ROSTER'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'COMPLETE'
  | 'FAILED';

/** Durable decision lifecycle states. */
export type DecisionStatus =
  | 'OBSERVED'
  | 'CALLING_PROVIDER'
  | 'PROVIDER_RECORDED'
  | 'ACTION_SUBMITTED'
  | 'COMMITTED'
  | 'STALE'
  | 'FAILED';

/** Model attempt states; only `SUCCEEDED` attempts are reusable. */
export type AttemptStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

/** Stable failure codes for product store operations. */
export type ProductStoreErrorCode =
  | 'INVALID_INPUT'
  | 'FOREIGN_DATABASE'
  | 'MIGRATION_MISSING'
  | 'MIGRATION_HASH_MISMATCH'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_STATE'
  | 'PARTICIPANT_EXISTS'
  | 'PARTICIPANT_NOT_FOUND'
  | 'DECISION_NOT_FOUND'
  | 'DECISION_STATE'
  | 'OBSERVATION_CONFLICT'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_STATE'
  | 'ATTEMPT_IN_FLIGHT'
  | 'AGENT_CONFIG_NOT_FOUND'
  | 'AGENT_DISABLED'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_EXCEEDED'
  | 'ROOM_RESERVATION_EXCEEDED'
  | 'RESULT_EXISTS'
  | 'RESULT_NOT_FOUND';

export class ProductStoreError extends Error {
  readonly code: ProductStoreErrorCode;

  constructor(code: ProductStoreErrorCode, message: string) {
    super(message);
    this.name = 'ProductStoreError';
    this.code = code;
  }
}

/** One applied product migration row. */
export interface ProductMigration {
  readonly version: string;
  readonly sha256: string;
  readonly appliedAt: number;
}

/** A product room; no poker state and no seat authority is stored here. */
export interface ProductRoom {
  readonly id: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly policyKind: ProductPolicyKind;
  readonly policy: ProductPolicy;
  readonly tableId: string | null;
  readonly platformCompetitionId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Principal metadata for one room participant. Never carries a seat. */
export interface ProductParticipant {
  readonly roomId: string;
  readonly principalId: string;
  readonly kind: ParticipantKind;
  readonly agentId: string | null;
  readonly joinedAt: number;
}

/** Room creation input. `policy.participants` may hold a partial roster. */
export interface CreateRoomInput {
  /** Optional room display name; defaults to the room id. */
  name?: string;
  /** Optional id; a random UUID is assigned when omitted. */
  id?: string;
  policy: ProductPolicyInput;
}

/** Participant addition input. */
export interface AddParticipantInput {
  principalId: string;
  kind: ParticipantKind;
  agentId?: string | null;
}

/** External platform references for a room (table and/or competition). */
export interface PlatformReferencesInput {
  tableId?: string | null;
  platformCompetitionId?: string | null;
}

/**
 * Optional room-aggregate admission limits applied across every agent of the
 * room inside the same reservation transaction. `null`/absent means no room
 * cap on that dimension. Values may be safe integers or bigint for exact
 * totals. A cap of `0` rejects calls unless the reserved per-call cost is
 * exactly `0` (comparison is strict `>`).
 */
export interface RoomReservationLimits {
  maxCalls?: number | bigint | null;
  maxCostMicroUsd?: number | bigint | null;
}

/** Optional patch for a room CAS transition. */
export interface RoomTransitionPatch {
  tableId?: string | null;
  platformCompetitionId?: string | null;
  failureReason?: string | null;
}

/** Observation boundary for one durable decision. */
export interface ObserveDecisionInput {
  tableId: string;
  turnId: string;
  principalId: string;
  /** Optional owning room reference. */
  roomId?: string | null;
  /** Canonical `SeatObservation`; validated strictly before persistence. */
  observation: unknown;
  /** Optional expected observation hash; must match the canonical hash. */
  observationHash?: string;
  /** Optional exact pre-transport source snapshot (public chat). */
  source?: DecisionSource | null;
  promptPolicyId: string;
  eventCursor: number;
}

/** A durable per-turn decision with a structured, hash-verified observation. */
export interface ProductDecision {
  readonly id: string;
  readonly tableId: string;
  readonly turnId: string;
  readonly principalId: string;
  readonly roomId: string | null;
  readonly status: DecisionStatus;
  readonly observation: SeatObservation;
  readonly observationHash: string;
  /** Observation version, exposed without ad-hoc raw JSON parsing. */
  readonly version: number;
  readonly promptPolicyId: string;
  readonly eventCursor: number;
  readonly source: DecisionSource | null;
  readonly requestJson: string | null;
  readonly receiptJson: string | null;
  /** Durable at-most-once speech intention timestamp; never a chat store. */
  readonly speechIntendedAt: number | null;
  readonly errorReason: string | null;
  readonly attemptCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Optional decision listing filter. */
export interface DecisionFilter {
  tableId?: string;
  roomId?: string;
  principalId?: string;
  status?: DecisionStatus;
}

/** Optional patch for a decision CAS transition. */
export interface DecisionTransitionPatch {
  requestJson?: string;
  receiptJson?: string;
  errorReason?: string;
}

/** Integer usage/cost metrics recorded for one provider attempt. */
export interface AttemptUsage {
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  latencyMs: number;
}

/**
 * Response record for one attempt. `responseJson` is the exact provider
 * transport response; `FAILED` records carry an error and are never reused.
 */
export interface AttemptRecordInput {
  status: 'SUCCEEDED' | 'FAILED';
  responseJson?: string | null;
  error?: string | null;
  model: string;
  provider: string;
  promptPolicyId: string;
  usage: AttemptUsage;
}

/** An immutable model attempt row (pending until a response is recorded). */
export interface ModelAttempt {
  readonly id: string;
  readonly decisionId: string;
  readonly attemptNo: number;
  readonly status: AttemptStatus;
  readonly requestJson: string;
  /** Plain sha256 of the exact request_json bytes. */
  readonly requestHash: string;
  /** Immutable sanitized pre-HTTP transport metadata, or null. */
  readonly requestMetadataJson: string | null;
  readonly responseJson: string | null;
  readonly error: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly promptPolicyId: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly createdAt: number;
  readonly recordedAt: number | null;
}

/**
 * Result of starting a provider call. `reuse` means a recorded successful
 * attempt already exists and must be reused instead of calling again.
 */
export type StartAttemptResult =
  | { readonly kind: 'started'; readonly attempt: ModelAttempt }
  | { readonly kind: 'reuse'; readonly attempt: ModelAttempt };

/** Conservative per-room reservation counters for one agent. */
export interface AgentReservation {
  readonly roomId: string;
  readonly agentId: string;
  /** In-flight calls, each holding one `maxCostMicroUsdPerCall` reserve. */
  readonly callsReserved: number;
  readonly costMicroUsdReserved: number;
  readonly callsSettled: number;
  readonly costMicroUsdSettled: number;
  readonly updatedAt: number;
}

/** One derived platform placement. Carries no money fields. */
export interface RoomResultPlacement {
  readonly principalId: string;
  readonly kind: ParticipantKind;
  readonly placement: number;
}

/** Input for the immutable results projection. */
export interface RecordRoomResultInput {
  roomId: string;
  placements: readonly RoomResultPlacement[];
  projectionVersion?: number;
}

/** Immutable derived platform result projection (not financial settlement). */
export interface RoomResult {
  readonly roomId: string;
  readonly tableId: string;
  readonly platformCompetitionId: string | null;
  readonly projectionVersion: number;
  readonly placements: readonly RoomResultPlacement[];
  readonly derivedAt: number;
}

/** Options for `ProductStore.open`. */
export interface OpenProductStoreOptions {
  /** Database file path. Defaults to `<cwd>/data/product.db`. */
  path?: string;
  /** Directory containing `NNN_product.sql` migrations. Defaults to `<cwd>/migrations`. */
  migrationsDir?: string;
}

const ROOM_TRANSITIONS: Readonly<Record<RoomStatus, readonly RoomStatus[]>> = {
  DRAFT: ['WAITING_FOR_ROSTER', 'FAILED'],
  WAITING_FOR_ROSTER: ['PROVISIONING', 'FAILED'],
  PROVISIONING: ['ACTIVE', 'FAILED'],
  ACTIVE: ['COMPLETE', 'FAILED'],
  COMPLETE: [],
  FAILED: [],
};

const DECISION_TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  OBSERVED: ['CALLING_PROVIDER', 'STALE', 'FAILED'],
  // CALLING_PROVIDER -> OBSERVED is the retry edge after a recorded failure.
  CALLING_PROVIDER: ['PROVIDER_RECORDED', 'OBSERVED', 'STALE', 'FAILED'],
  PROVIDER_RECORDED: ['ACTION_SUBMITTED', 'STALE', 'FAILED'],
  ACTION_SUBMITTED: ['COMMITTED', 'STALE', 'FAILED'],
  COMMITTED: [],
  STALE: [],
  FAILED: [],
};

const NON_TERMINAL_DECISION_STATUSES: readonly DecisionStatus[] = [
  'OBSERVED',
  'CALLING_PROVIDER',
  'PROVIDER_RECORDED',
  'ACTION_SUBMITTED',
];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable sha256 identity for one durable decision. */
export function computeDecisionId(tableId: string, turnId: string, principalId: string): string {
  return sha256Hex(`nlhe-product:decision:v1\0${tableId}\0${turnId}\0${principalId}`);
}

/** Stable sha256 identity for one attempt of a decision. */
export function computeAttemptId(decisionId: string, attemptNo: number): string {
  return sha256Hex(`nlhe-product:attempt:v1\0${decisionId}\0${attemptNo}`);
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ProductStoreError('INVALID_INPUT', `${field} must be a non-empty trimmed string`);
  }
  return value;
}

function assertInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ProductStoreError('INVALID_INPUT', `${field} must be a safe integer >= ${minimum}`);
  }
  return value;
}

/** Normalize an optional non-negative safe-integer/bigint limit to bigint. */
function normalizeOptionalBigInt(value: unknown, field: string): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new ProductStoreError('INVALID_INPUT', `${field} must be non-negative`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProductStoreError('INVALID_INPUT', `${field} must be a non-negative safe integer or bigint`);
    }
    return BigInt(value);
  }
  throw new ProductStoreError('INVALID_INPUT', `${field} must be a non-negative safe integer or bigint`);
}

/** Convert an exact bigint total to a storable/public safe integer. */
function toSafeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProductStoreError('INVALID_INPUT', `${field} exceeds the safe integer range`);
  }
  return Number(value);
}

/** Outstanding per-call reserve ceilings (FIFO) for one reservation row. */
function parseReserveAmounts(json: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  );
}

function assertJsonText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProductStoreError('INVALID_INPUT', `${field} must be non-empty JSON text`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new ProductStoreError('INVALID_INPUT', `${field} must be valid JSON`);
  }
  return value;
}

function assertJsonObjectText(value: unknown, field: string): string {
  const text = assertJsonText(value, field);
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProductStoreError('INVALID_INPUT', `${field} must be a JSON object`);
  }
  return text;
}

/** Metadata keys that would persist transport credentials; never allowed. */
const FORBIDDEN_TRANSPORT_METADATA_KEYS = new Set([
  'headers',
  'authorization',
  'proxyauthorization',
  'apikey',
  'api_key',
  'x-api-key',
  'secret',
  'password',
]);

function assertSanitizedMetadataKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertSanitizedMetadataKeys(item, path);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_TRANSPORT_METADATA_KEYS.has(key.toLowerCase())) {
      throw new ProductStoreError(
        'INVALID_INPUT',
        `${path}.${key} is not allowed: transport metadata must be sanitized (no headers or credentials)`,
      );
    }
    assertSanitizedMetadataKeys(nested, `${path}.${key}`);
  }
}

/** Validate and canonicalize optional sanitized transport metadata. */
function normalizeTransportMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let record: Record<string, unknown>;
  if (typeof value === 'string') {
    assertJsonObjectText(value, 'requestMetadata');
    record = JSON.parse(value) as Record<string, unknown>;
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    record = value as Record<string, unknown>;
  } else {
    throw new ProductStoreError('INVALID_INPUT', 'requestMetadata must be a JSON object');
  }
  assertSanitizedMetadataKeys(record, 'requestMetadata');
  try {
    return canonicalJson(record);
  } catch (error) {
    throw new ProductStoreError(
      'INVALID_INPUT',
      error instanceof Error ? `requestMetadata must be JSON-serializable: ${error.message}` : 'invalid requestMetadata',
    );
  }
}

interface ProductMigrationRow {
  version: string;
  sha256: string;
  applied_at: number;
}

interface RoomRow {
  id: string;
  name: string;
  status: string;
  policy_kind: string;
  policy_json: string;
  table_id: string | null;
  platform_competition_id: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface ParticipantRow {
  room_id: string;
  principal_id: string;
  kind: string;
  agent_id: string | null;
  joined_at: number;
}

interface AgentConfigRow {
  id: string;
  name: string;
  model: string;
  provider: string;
  base_url: string;
  key_env: string;
  principal_id: string;
  prompt_policy_id: string;
  prompt_policy_hash: string;
  input_micro_usd_per_million_tokens: number;
  output_micro_usd_per_million_tokens: number;
  max_calls_per_room: number;
  max_cost_micro_usd_per_room: number;
  max_cost_micro_usd_per_call: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface DecisionRow {
  id: string;
  table_id: string;
  turn_id: string;
  principal_id: string;
  room_id: string | null;
  status: string;
  observation_json: string;
  observation_hash: string;
  source_json: string | null;
  prompt_policy_id: string;
  event_cursor: number;
  request_json: string | null;
  receipt_json: string | null;
  speech_intended_at: number | null;
  error_reason: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

interface AttemptRow {
  id: string;
  decision_id: string;
  attempt_no: number;
  status: string;
  request_json: string;
  request_hash: string;
  request_metadata_json: string | null;
  response_json: string | null;
  error: string | null;
  model: string | null;
  provider: string | null;
  prompt_policy_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micro_usd: number;
  latency_ms: number;
  created_at: number;
  recorded_at: number | null;
}

interface ReservationRow {
  room_id: string;
  agent_id: string;
  calls_reserved: number;
  cost_micro_usd_reserved: number;
  reserve_amounts_json: string;
  calls_settled: number;
  cost_micro_usd_settled: number;
  updated_at: number;
}

interface ResultRow {
  room_id: string;
  table_id: string;
  platform_competition_id: string | null;
  projection_version: number;
  placements_json: string;
  derived_at: number;
}

/** True when this database already carries the product ownership marker. */
function hasProductMarker(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='product_migrations'`)
      .get() !== undefined
  );
}

/** Count user tables/views, excluding SQLite internal objects. */
function countForeignObjects(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Ownership boundary. A database without the product marker must be empty
 * (fresh); any foreign/old schema is rejected with the same message before
 * pragmas, migrations or permission changes, so product state never silently
 * cohabits another database. Ownership is generic (no known foreign table
 * names are hardcoded).
 */
function assertProductOwnership(db: Database.Database): void {
  try {
    if (hasProductMarker(db)) return;
    if (countForeignObjects(db) > 0) {
      throw new ProductStoreError('FOREIGN_DATABASE', 'Expected a fresh NLHE product database');
    }
  } catch (error) {
    if (error instanceof ProductStoreError) throw error;
    throw new ProductStoreError('FOREIGN_DATABASE', 'Expected a fresh NLHE product database');
  }
}

/** Create the database parent directory privately, only when it is missing. */
function ensurePrivateParent(path: string): void {
  if (path === ':memory:') return;
  const dir = dirname(path);
  if (dir === '' || dir === '.' || dir === path) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Restrict an owned database file to its owner (POSIX only). */
function secureOwnedDatabaseFile(path: string): void {
  if (path === ':memory:' || process.platform === 'win32') return;
  chmodSync(path, 0o600);
}

function listProductMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) {
    throw new ProductStoreError('MIGRATION_MISSING', `product migrations directory not found: ${migrationsDir}`);
  }
  const files = readdirSync(migrationsDir)
    .filter((name) => PRODUCT_MIGRATION_FILE_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (files.length === 0) {
    throw new ProductStoreError('MIGRATION_MISSING', `no NNN_product.sql migrations found in ${migrationsDir}`);
  }
  return files;
}

function readMigrationHash(migrationsDir: string, file: string): string {
  return sha256Hex(readFileSync(join(migrationsDir, file), 'utf8'));
}

function applyProductMigrations(db: Database.Database, migrationsDir: string): ProductMigrationRow[] {
  const files = listProductMigrationFiles(migrationsDir);
  const hasMigrationsTable =
    db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='product_migrations'`)
      .get() !== undefined;
  const applied = new Map<string, ProductMigrationRow>();
  if (hasMigrationsTable) {
    for (const row of db
      .prepare(`SELECT version, sha256, applied_at FROM product_migrations ORDER BY version`)
      .all() as ProductMigrationRow[]) {
      applied.set(row.version, row);
    }
  }

  for (const row of applied.values()) {
    if (!files.includes(row.version)) {
      throw new ProductStoreError('MIGRATION_HASH_MISMATCH', `applied product migration is missing from disk: ${row.version}`);
    }
    if (readMigrationHash(migrationsDir, row.version) !== row.sha256) {
      throw new ProductStoreError('MIGRATION_HASH_MISMATCH', `applied product migration has changed: ${row.version}`);
    }
  }

  const applyOne = db.transaction((file: string) => {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare(`INSERT INTO product_migrations (version, sha256, applied_at) VALUES (?, ?, ?)`).run(
      file,
      sha256Hex(sql),
      Date.now(),
    );
  });
  for (const file of files) {
    if (!applied.has(file)) applyOne(file);
  }
  return db
    .prepare(`SELECT version, sha256, applied_at FROM product_migrations ORDER BY version`)
    .all() as ProductMigrationRow[];
}

/**
 * SQLite-backed product store. Open with `ProductStore.open`; mutating public
 * methods are transactional where they touch more than one row.
 */
export class ProductStore {
  private readonly db: Database.Database;

  /** SHA-256 of the baseline product migration, verified on every open. */
  readonly baselineMigrationHash: string;

  private constructor(db: Database.Database, baselineMigrationHash: string) {
    this.db = db;
    this.baselineMigrationHash = baselineMigrationHash;
  }

  /** Open the product database (WAL), verify and apply product migrations. */
  static open(options: OpenProductStoreOptions = {}): ProductStore {
    const path = options.path ?? resolve(process.cwd(), DEFAULT_PRODUCT_DB_PATH);
    const migrationsDir = options.migrationsDir ?? resolve(process.cwd(), 'migrations');
    ensurePrivateParent(path);
    const db = new Database(path);
    try {
      // Ownership is validated before any pragma, migration or permission
      // change so a foreign database is never mutated or made private.
      assertProductOwnership(db);
      secureOwnedDatabaseFile(path);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      const migrations = applyProductMigrations(db, migrationsDir);
      const baseline = migrations[0];
      if (baseline === undefined) {
        throw new ProductStoreError('MIGRATION_MISSING', 'no product migrations were applied');
      }
      return new ProductStore(db, baseline.sha256);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Close the underlying SQLite handle. */
  close(): void {
    this.db.close();
  }

  /** Applied product migrations, oldest first. */
  listAppliedMigrations(): ProductMigration[] {
    const rows = this.db
      .prepare(`SELECT version, sha256, applied_at FROM product_migrations ORDER BY version`)
      .all() as ProductMigrationRow[];
    return rows.map((row) => ({
      version: row.version,
      sha256: row.sha256,
      appliedAt: row.applied_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Rooms and participants
  // -------------------------------------------------------------------------

  /**
   * Create a DRAFT room from a validated policy. Policy participants that
   * carry a `principalId` are inserted atomically; participants that only
   * declare the planned roster shape join later through `addParticipant`.
   */
  createRoom(input: CreateRoomInput): ProductRoom {
    const id = input.id === undefined ? randomUUID() : assertIdentifier(input.id, 'room id');
    const name = input.name === undefined ? id : assertIdentifier(input.name, 'room name');
    const policy = resolveProductPolicy(input.policy);
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO product_rooms
             (id, name, status, policy_kind, policy_json, table_id, platform_competition_id, failure_reason, created_at, updated_at)
           VALUES (?, ?, 'DRAFT', ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, name, policy.kind, JSON.stringify(policy), now, now);
      const principalIds = new Set<string>();
      for (const participant of input.policy.participants) {
        if (participant.principalId === undefined) continue;
        const principalId = assertIdentifier(participant.principalId, 'participant.principalId');
        if (principalIds.has(principalId)) {
          throw new ProductStoreError('PARTICIPANT_EXISTS', `duplicate principal in room ${id}`);
        }
        principalIds.add(principalId);
        this.insertParticipant(id, principalId, normalizePolicyParticipant(participant), now);
      }
    })();
    return this.requireRoom(id);
  }

  /** Get a room, or `null` when it does not exist. */
  getRoom(roomId: string): ProductRoom | null {
    const row = this.db
      .prepare(`SELECT * FROM product_rooms WHERE id = ?`)
      .get(assertIdentifier(roomId, 'roomId')) as RoomRow | undefined;
    return row === undefined ? null : this.roomFromRow(row);
  }

  /** List rooms, optionally filtered by status, oldest first. */
  listRooms(status?: RoomStatus): ProductRoom[] {
    const rows = (
      status === undefined
        ? this.db.prepare(`SELECT * FROM product_rooms ORDER BY created_at, id`).all()
        : this.db.prepare(`SELECT * FROM product_rooms WHERE status = ? ORDER BY created_at, id`).all(status)
    ) as RoomRow[];
    return rows.map((row) => this.roomFromRow(row));
  }

  /** Add one participant while the room is DRAFT or WAITING_FOR_ROSTER. */
  addParticipant(roomId: string, input: AddParticipantInput): ProductParticipant {
    const id = assertIdentifier(roomId, 'roomId');
    const principalId = assertIdentifier(input?.principalId, 'principalId');
    const candidate = normalizePolicyParticipant(input);
    return this.db.transaction(() => {
      const room = this.requireRoom(id);
      if (room.status !== 'DRAFT' && room.status !== 'WAITING_FOR_ROSTER') {
        throw new ProductStoreError(
          'ROOM_STATE',
          `participants can only change in DRAFT or WAITING_FOR_ROSTER, room ${id} is ${room.status}`,
        );
      }
      const roster = this.listParticipants(id).map((participant) => ({
        kind: participant.kind,
        agentId: participant.agentId,
      }));
      assertParticipantAllowed(room.policy, roster, candidate);
      if (this.getParticipant(id, principalId) !== null) {
        throw new ProductStoreError('PARTICIPANT_EXISTS', `principal ${principalId} is already in room ${id}`);
      }
      return this.insertParticipant(id, principalId, candidate, Date.now());
    })();
  }

  /** Remove a participant while the room is DRAFT or WAITING_FOR_ROSTER. */
  removeParticipant(roomId: string, principalId: string): boolean {
    const id = assertIdentifier(roomId, 'roomId');
    const principal = assertIdentifier(principalId, 'principalId');
    return this.db.transaction(() => {
      const room = this.requireRoom(id);
      if (room.status !== 'DRAFT' && room.status !== 'WAITING_FOR_ROSTER') {
        throw new ProductStoreError(
          'ROOM_STATE',
          `participants can only change in DRAFT or WAITING_FOR_ROSTER, room ${id} is ${room.status}`,
        );
      }
      return (
        this.db
          .prepare(`DELETE FROM product_room_participants WHERE room_id = ? AND principal_id = ?`)
          .run(id, principal).changes === 1
      );
    })();
  }

  /** One participant of a room, or `null`. */
  getParticipant(roomId: string, principalId: string): ProductParticipant | null {
    const row = this.db
      .prepare(`SELECT * FROM product_room_participants WHERE room_id = ? AND principal_id = ?`)
      .get(assertIdentifier(roomId, 'roomId'), assertIdentifier(principalId, 'principalId')) as
      | ParticipantRow
      | undefined;
    return row === undefined ? null : this.participantFromRow(row);
  }

  /** Participants of one room, oldest first; no seat authority is exposed. */
  listParticipants(roomId: string): ProductParticipant[] {
    const rows = this.db
      .prepare(`SELECT * FROM product_room_participants WHERE room_id = ? ORDER BY joined_at, principal_id`)
      .all(assertIdentifier(roomId, 'roomId')) as ParticipantRow[];
    return rows.map((row) => this.participantFromRow(row));
  }

  /** Compare-and-swap a room status; illegal/stale transitions fail closed. */
  transitionRoom(
    roomId: string,
    expectedStatus: RoomStatus,
    nextStatus: RoomStatus,
    patch: RoomTransitionPatch = {},
  ): ProductRoom {
    const id = assertIdentifier(roomId, 'roomId');
    if (!ROOM_TRANSITIONS[expectedStatus].includes(nextStatus)) {
      throw new ProductStoreError('ROOM_STATE', `illegal room transition ${expectedStatus} -> ${nextStatus}`);
    }
    if (nextStatus === 'ACTIVE' && patch.tableId == null) {
      throw new ProductStoreError('INVALID_INPUT', 'ACTIVE rooms require platform table references');
    }
    if (nextStatus === 'FAILED' && patch.failureReason == null) {
      throw new ProductStoreError('INVALID_INPUT', 'FAILED rooms require a failureReason');
    }
    return this.casRoom(id, expectedStatus, nextStatus, patch);
  }

  /** DRAFT -> WAITING_FOR_ROSTER. */
  openRoomForRoster(roomId: string): ProductRoom {
    return this.transitionRoom(roomId, 'DRAFT', 'WAITING_FOR_ROSTER');
  }

  /** WAITING_FOR_ROSTER -> PROVISIONING; the full roster must satisfy the policy. */
  beginProvisioning(roomId: string): ProductRoom {
    const id = assertIdentifier(roomId, 'roomId');
    const room = this.requireRoom(id);
    const roster = this.listParticipants(id).map((participant) => ({
      kind: participant.kind,
      agentId: participant.agentId,
    }));
    assertRosterSatisfiesPolicy(room.policy, roster);
    return this.transitionRoom(id, 'WAITING_FOR_ROSTER', 'PROVISIONING');
  }

  /** Set/replace external table/competition references on a non-terminal room. */
  setPlatformReferences(roomId: string, references: PlatformReferencesInput): ProductRoom {
    const id = assertIdentifier(roomId, 'roomId');
    const tableId = references?.tableId == null ? null : assertIdentifier(references.tableId, 'tableId');
    const platformCompetitionId =
      references?.platformCompetitionId == null
        ? null
        : assertIdentifier(references.platformCompetitionId, 'platformCompetitionId');
    if (tableId === null && platformCompetitionId === null) {
      throw new ProductStoreError('INVALID_INPUT', 'at least one platform reference is required');
    }
    return this.db.transaction(() => {
      const room = this.requireRoom(id);
      if (room.status === 'COMPLETE' || room.status === 'FAILED') {
        throw new ProductStoreError('ROOM_STATE', `room ${id} is terminal (${room.status})`);
      }
      this.db
        .prepare(
          `UPDATE product_rooms
             SET table_id = COALESCE(?, table_id), platform_competition_id = COALESCE(?, platform_competition_id), updated_at = ?
           WHERE id = ?`,
        )
        .run(tableId, platformCompetitionId, Date.now(), id);
      return this.requireRoom(id);
    })();
  }

  /**
   * PROVISIONING -> ACTIVE. Optionally sets platform references first; a table
   * reference is required, no poker state is written.
   */
  activateRoom(roomId: string, references?: PlatformReferencesInput): ProductRoom {
    const id = assertIdentifier(roomId, 'roomId');
    return this.db.transaction(() => {
      if (references !== undefined) this.setPlatformReferences(id, references);
      const room = this.requireRoom(id);
      if (room.tableId === null) {
        throw new ProductStoreError('INVALID_INPUT', 'ACTIVE rooms require platform table references');
      }
      return this.casRoom(id, 'PROVISIONING', 'ACTIVE', {});
    })();
  }

  /** ACTIVE -> COMPLETE. */
  completeRoom(roomId: string): ProductRoom {
    return this.transitionRoom(roomId, 'ACTIVE', 'COMPLETE');
  }

  /** Durable pre-start cancellation intent, retried by room recovery. */
  requestRoomCancellation(roomId: string): void {
    const id = assertIdentifier(roomId, 'roomId');
    const room = this.requireRoom(id);
    if (!['DRAFT', 'WAITING_FOR_ROSTER', 'PROVISIONING'].includes(room.status)) {
      throw new ProductStoreError('ROOM_STATE', `room ${id} is not pre-start`);
    }
    this.db.prepare('INSERT OR IGNORE INTO product_room_cancellations (room_id, requested_at) VALUES (?, ?)')
      .run(id, Date.now());
  }

  roomCancellationRequested(roomId: string): boolean {
    return this.db.prepare('SELECT 1 FROM product_room_cancellations WHERE room_id = ?')
      .get(assertIdentifier(roomId, 'roomId')) !== undefined;
  }

  /** Only cleared when PokerTools proves start won the lifecycle race. */
  clearRoomCancellation(roomId: string): void {
    this.db.prepare('DELETE FROM product_room_cancellations WHERE room_id = ?')
      .run(assertIdentifier(roomId, 'roomId'));
  }

  /** Any non-terminal state -> FAILED with a required reason. */
  failRoom(roomId: string, reason: string): ProductRoom {
    const failureReason = assertIdentifier(reason, 'failureReason');
    const id = assertIdentifier(roomId, 'roomId');
    const room = this.requireRoom(id);
    if (room.status === 'COMPLETE' || room.status === 'FAILED') {
      throw new ProductStoreError('ROOM_STATE', `room ${id} is already terminal (${room.status})`);
    }
    return this.casRoom(id, room.status, 'FAILED', { failureReason });
  }

  // -------------------------------------------------------------------------
  // Agent configuration references
  // -------------------------------------------------------------------------

  /**
   * Insert or replace one agent configuration. Only environment-variable
   * references and integer economics are persisted. Limits cannot be tightened
   * below outstanding reservations, and the per-call cost limit is frozen
   * while calls are in flight so settlement reserves stay exact.
   */
  upsertAgentConfig(input: AgentConfigInput): AgentConfig {
    const config = normalizeAgentConfig(input);
    const previous = this.getAgentConfig(config.id);
    if (previous !== null) this.assertLimitChangeFitsReservations(previous, config);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO product_agent_configs
           (id, name, model, provider, base_url, key_env, principal_id,
            prompt_policy_id, prompt_policy_hash,
            input_micro_usd_per_million_tokens, output_micro_usd_per_million_tokens,
            max_calls_per_room, max_cost_micro_usd_per_room, max_cost_micro_usd_per_call,
            enabled, created_at, updated_at)
         VALUES
           (@id, @name, @model, @provider, @baseUrl, @keyEnv, @principalId,
            @promptPolicyId, @promptPolicyHash,
            @inputRate, @outputRate,
            @maxCallsPerRoom, @maxCostPerRoom, @maxCostPerCall,
            @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           model = excluded.model,
           provider = excluded.provider,
           base_url = excluded.base_url,
           key_env = excluded.key_env,
           principal_id = excluded.principal_id,
           prompt_policy_id = excluded.prompt_policy_id,
           prompt_policy_hash = excluded.prompt_policy_hash,
           input_micro_usd_per_million_tokens = excluded.input_micro_usd_per_million_tokens,
           output_micro_usd_per_million_tokens = excluded.output_micro_usd_per_million_tokens,
           max_calls_per_room = excluded.max_calls_per_room,
           max_cost_micro_usd_per_room = excluded.max_cost_micro_usd_per_room,
           max_cost_micro_usd_per_call = excluded.max_cost_micro_usd_per_call,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: config.id,
        name: config.name,
        model: config.model,
        provider: config.provider,
        baseUrl: config.baseUrl,
        keyEnv: config.keyEnv,
        principalId: config.principalId,
        promptPolicyId: config.promptPolicyId,
        promptPolicyHash: config.promptPolicyHash,
        inputRate: config.pricing.inputMicroUsdPerMillionTokens,
        outputRate: config.pricing.outputMicroUsdPerMillionTokens,
        maxCallsPerRoom: config.limits.maxCallsPerRoom,
        maxCostPerRoom: config.limits.maxCostMicroUsdPerRoom,
        maxCostPerCall: config.limits.maxCostMicroUsdPerCall,
        enabled: config.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    return this.requireAgentConfig(config.id);
  }

  /** Get one normalized agent configuration, or `null`. */
  getAgentConfig(agentId: string): AgentConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM product_agent_configs WHERE id = ?`)
      .get(assertIdentifier(agentId, 'agentId')) as AgentConfigRow | undefined;
    return row === undefined ? null : this.agentConfigFromRow(row);
  }

  /** All agent configurations, ordered by id. */
  listAgentConfigs(): AgentConfig[] {
    const rows = this.db.prepare(`SELECT * FROM product_agent_configs ORDER BY id`).all() as AgentConfigRow[];
    return rows.map((row) => this.agentConfigFromRow(row));
  }

  // -------------------------------------------------------------------------
  // Durable decisions
  // -------------------------------------------------------------------------

  /**
   * Observe a turn exactly once. The decision id is the stable sha256 of
   * (tableId, turnId, principalId); the observation is validated and hashed
   * with the shared canonical hash before persistence. Re-observing the same
   * turn with the same snapshot/source returns the existing decision; any
   * difference fails with `OBSERVATION_CONFLICT`.
   */
  observeDecision(input: ObserveDecisionInput): ProductDecision {
    const tableId = assertIdentifier(input?.tableId, 'tableId');
    const turnId = assertIdentifier(input.turnId, 'turnId');
    const principalId = assertIdentifier(input.principalId, 'principalId');
    const roomId =
      input.roomId === undefined || input.roomId === null ? null : assertIdentifier(input.roomId, 'roomId');
    const observation = this.parseObservation(input.observation);
    if (observation.tableId !== tableId || observation.turnId !== turnId) {
      throw new ProductStoreError(
        'OBSERVATION_CONFLICT',
        `observation does not match table/turn (${tableId}/${turnId})`,
      );
    }
    const observationJson = canonicalJson(observation);
    const observationHash = computeObservationHash(observation);
    if (input.observationHash != null && input.observationHash !== observationHash) {
      throw new ProductStoreError('OBSERVATION_CONFLICT', `observation hash does not match turn ${turnId}`);
    }
    const promptPolicyId = assertIdentifier(input.promptPolicyId, 'promptPolicyId');
    const eventCursor = assertInteger(input.eventCursor, 'eventCursor', 0);
    const source =
      input.source === undefined || input.source === null ? null : parseDecisionSource(input.source);
    const sourceJson = source === null ? null : canonicalJson(source);
    if (roomId !== null && this.getRoom(roomId) === null) {
      throw new ProductStoreError('ROOM_NOT_FOUND', `room not found: ${roomId}`);
    }

    const id = computeDecisionId(tableId, turnId, principalId);
    const existing = this.getDecision(id);
    if (existing !== null) {
      const existingSource = existing.source === null ? null : canonicalJson(existing.source);
      if (
        existing.observationHash !== observationHash ||
        existing.promptPolicyId !== promptPolicyId ||
        existing.eventCursor !== eventCursor ||
        (input.source !== undefined && existingSource !== sourceJson)
      ) {
        throw new ProductStoreError('OBSERVATION_CONFLICT', `decision ${id} was already observed differently`);
      }
      return existing;
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO product_decisions
           (id, table_id, turn_id, principal_id, room_id, status, observation_json, observation_hash,
            source_json, prompt_policy_id, event_cursor, request_json, receipt_json, error_reason,
            attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'OBSERVED', ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        id,
        tableId,
        turnId,
        principalId,
        roomId,
        observationJson,
        observationHash,
        sourceJson,
        promptPolicyId,
        eventCursor,
        now,
        now,
      );
    return this.requireDecision(id);
  }

  /** Get a decision by id, or `null`. */
  getDecision(decisionId: string): ProductDecision | null {
    const row = this.db
      .prepare(`SELECT * FROM product_decisions WHERE id = ?`)
      .get(assertIdentifier(decisionId, 'decisionId')) as DecisionRow | undefined;
    return row === undefined ? null : this.decisionFromRow(row);
  }

  /** Get the decision for one turn, or `null`. */
  getDecisionForTurn(tableId: string, turnId: string, principalId: string): ProductDecision | null {
    return this.getDecision(
      computeDecisionId(
        assertIdentifier(tableId, 'tableId'),
        assertIdentifier(turnId, 'turnId'),
        assertIdentifier(principalId, 'principalId'),
      ),
    );
  }

  /** List decisions matching the optional filter, oldest first. */
  listDecisions(filter: DecisionFilter = {}): ProductDecision[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.tableId !== undefined) {
      clauses.push('table_id = ?');
      params.push(assertIdentifier(filter.tableId, 'tableId'));
    }
    if (filter.roomId !== undefined) {
      clauses.push('room_id = ?');
      params.push(assertIdentifier(filter.roomId, 'roomId'));
    }
    if (filter.principalId !== undefined) {
      clauses.push('principal_id = ?');
      params.push(assertIdentifier(filter.principalId, 'principalId'));
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM product_decisions${where} ORDER BY created_at, id`)
      .all(...params) as DecisionRow[];
    return rows.map((row) => this.decisionFromRow(row));
  }

  /**
   * Compare-and-swap a decision status following the documented lifecycle.
   * Required payloads are validated (`ACTION_SUBMITTED` request, `COMMITTED`
   * receipt, `STALE`/`FAILED` reason).
   */
  transitionDecision(
    decisionId: string,
    expectedStatus: DecisionStatus,
    nextStatus: DecisionStatus,
    patch: DecisionTransitionPatch = {},
  ): ProductDecision {
    const id = assertIdentifier(decisionId, 'decisionId');
    if (!DECISION_TRANSITIONS[expectedStatus].includes(nextStatus)) {
      throw new ProductStoreError('DECISION_STATE', `illegal decision transition ${expectedStatus} -> ${nextStatus}`);
    }
    if (nextStatus === 'ACTION_SUBMITTED') {
      if (patch.requestJson === undefined) {
        throw new ProductStoreError('INVALID_INPUT', 'ACTION_SUBMITTED requires the resolved request JSON');
      }
      assertJsonObjectText(patch.requestJson, 'requestJson');
    }
    if (nextStatus === 'COMMITTED') {
      if (patch.receiptJson === undefined) {
        throw new ProductStoreError('INVALID_INPUT', 'COMMITTED requires the action receipt JSON');
      }
      assertJsonObjectText(patch.receiptJson, 'receiptJson');
    }
    if (nextStatus === 'STALE' || nextStatus === 'FAILED') {
      if (patch.errorReason === undefined) {
        throw new ProductStoreError('INVALID_INPUT', `${nextStatus} requires a reason`);
      }
      assertIdentifier(patch.errorReason, 'errorReason');
    }
    return this.casDecision(id, expectedStatus, nextStatus, patch, Date.now());
  }

  /**
   * Start one provider attempt, persisting the exact request bytes with their
   * sha256 and optional sanitized pre-HTTP transport metadata (immutable). A
   * recorded successful attempt is returned with `kind: 'reuse'` instead of
   * calling again; failed attempts are never reused, and an in-flight call
   * fails with `ATTEMPT_IN_FLIGHT`.
   */
  startAttempt(decisionId: string, requestJson: string, requestMetadata?: unknown): StartAttemptResult {
    const id = assertIdentifier(decisionId, 'decisionId');
    const request = assertJsonObjectText(requestJson, 'requestJson');
    const requestHash = sha256Hex(request);
    const metadataJson = normalizeTransportMetadata(requestMetadata);
    return this.db.transaction((): StartAttemptResult => {
      const decision = this.requireDecision(id);
      if (
        decision.status === 'PROVIDER_RECORDED' ||
        decision.status === 'ACTION_SUBMITTED' ||
        decision.status === 'COMMITTED'
      ) {
        const attempt = this.latestSuccessfulAttempt(id);
        if (attempt === null) {
          throw new ProductStoreError('ATTEMPT_STATE', `decision ${id} is ${decision.status} without a successful attempt`);
        }
        return { kind: 'reuse', attempt };
      }
      if (decision.status === 'CALLING_PROVIDER') {
        throw new ProductStoreError('ATTEMPT_IN_FLIGHT', `decision ${id} already has a provider call in flight`);
      }
      if (decision.status !== 'OBSERVED') {
        throw new ProductStoreError('DECISION_STATE', `cannot start an attempt from status ${decision.status}`);
      }
      const attemptNo = decision.attemptCount + 1;
      const attemptId = computeAttemptId(id, attemptNo);
      const now = Date.now();
      const updated = this.db
        .prepare(
          `UPDATE product_decisions SET status = 'CALLING_PROVIDER', attempt_count = ?, updated_at = ?
           WHERE id = ? AND status = 'OBSERVED'`,
        )
        .run(attemptNo, now, id);
      if (updated.changes !== 1) {
        throw new ProductStoreError('DECISION_STATE', `decision ${id} changed concurrently`);
      }
      this.db
        .prepare(
          `INSERT INTO product_model_attempts
             (id, decision_id, attempt_no, request_json, request_hash, request_metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(attemptId, id, attemptNo, request, requestHash, metadataJson, now);
      return { kind: 'started', attempt: this.requireAttempt(attemptId) };
    })();
  }

  /**
   * Record the exact provider response once. `SUCCEEDED` moves the decision to
   * PROVIDER_RECORDED; `FAILED` records the error and returns the decision to
   * OBSERVED so a new attempt can be started (failed attempts are not reused).
   */
  recordAttemptResponse(decisionId: string, attemptId: string, record: AttemptRecordInput): ModelAttempt {
    const id = assertIdentifier(decisionId, 'decisionId');
    const attemptKey = assertIdentifier(attemptId, 'attemptId');
    if (record?.status !== 'SUCCEEDED' && record?.status !== 'FAILED') {
      throw new ProductStoreError('INVALID_INPUT', 'attempt status must be SUCCEEDED or FAILED');
    }
    const model = assertIdentifier(record.model, 'model');
    const provider = assertIdentifier(record.provider, 'provider');
    const promptPolicyId = assertIdentifier(record.promptPolicyId, 'promptPolicyId');
    const promptTokens = assertInteger(record.usage?.promptTokens, 'usage.promptTokens', 0);
    const completionTokens = assertInteger(record.usage?.completionTokens, 'usage.completionTokens', 0);
    const costMicroUsd = assertInteger(record.usage?.costMicroUsd, 'usage.costMicroUsd', 0);
    const latencyMs = assertInteger(record.usage?.latencyMs, 'usage.latencyMs', 0);
    let responseJson: string | null = null;
    if (record.responseJson !== undefined && record.responseJson !== null) {
      responseJson = assertJsonText(record.responseJson, 'responseJson');
    }
    if (record.status === 'SUCCEEDED' && responseJson === null) {
      throw new ProductStoreError('INVALID_INPUT', 'SUCCEEDED attempts require the provider response JSON');
    }
    const error = record.status === 'FAILED' ? assertIdentifier(record.error ?? '', 'error') : null;

    return this.db.transaction((): ModelAttempt => {
      const decision = this.requireDecision(id);
      if (decision.status !== 'CALLING_PROVIDER') {
        throw new ProductStoreError('DECISION_STATE', `decision ${id} is ${decision.status}; no provider call to record`);
      }
      const attempt = this.requireAttempt(attemptKey);
      if (attempt.decisionId !== id) {
        throw new ProductStoreError('ATTEMPT_STATE', `attempt ${attemptKey} does not belong to decision ${id}`);
      }
      const now = Date.now();
      const updated = this.db
        .prepare(
          `UPDATE product_model_attempts
             SET status = ?, response_json = ?, error = ?, model = ?, provider = ?, prompt_policy_id = ?,
                 prompt_tokens = ?, completion_tokens = ?, cost_micro_usd = ?, latency_ms = ?, recorded_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(
          record.status,
          responseJson,
          error,
          model,
          provider,
          promptPolicyId,
          promptTokens,
          completionTokens,
          costMicroUsd,
          latencyMs,
          now,
          attemptKey,
        );
      if (updated.changes !== 1) {
        throw new ProductStoreError('ATTEMPT_STATE', `attempt ${attemptKey} was already recorded`);
      }
      this.casDecision(
        id,
        'CALLING_PROVIDER',
        record.status === 'SUCCEEDED' ? 'PROVIDER_RECORDED' : 'OBSERVED',
        {},
        now,
      );
      return this.requireAttempt(attemptKey);
    })();
  }

  /** PROVIDER_RECORDED -> ACTION_SUBMITTED with the resolved request JSON. */
  submitResolvedAction(decisionId: string, requestJson: string): ProductDecision {
    return this.transitionDecision(decisionId, 'PROVIDER_RECORDED', 'ACTION_SUBMITTED', {
      requestJson: assertJsonObjectText(requestJson, 'requestJson'),
    });
  }

  /** ACTION_SUBMITTED -> COMMITTED with the platform receipt JSON. */
  commitDecision(decisionId: string, receiptJson: string): ProductDecision {
    return this.transitionDecision(decisionId, 'ACTION_SUBMITTED', 'COMMITTED', {
      receiptJson: assertJsonObjectText(receiptJson, 'receiptJson'),
    });
  }

  /** Mark a non-terminal decision STALE (for example an advanced cursor). */
  markDecisionStale(decisionId: string, reason: string): ProductDecision {
    return this.transitionFromAnyNonTerminal(decisionId, 'STALE', assertIdentifier(reason, 'reason'));
  }

  /** Mark a non-terminal decision FAILED. */
  failDecision(decisionId: string, reason: string): ProductDecision {
    return this.transitionFromAnyNonTerminal(decisionId, 'FAILED', assertIdentifier(reason, 'reason'));
  }

  /**
   * Durably claim the at-most-once speech intention for a COMMITTED decision.
   * Call before sending; returns `true` only for the claim that marked it and
   * `false` when it was already marked (never resend). A lost speech outcome is
   * acceptable and never rolls back the committed action. This is an intention
   * audit timestamp only: no chat text is persisted here.
   */
  markSpeechIntended(decisionId: string): boolean {
    const id = assertIdentifier(decisionId, 'decisionId');
    return this.db.transaction((): boolean => {
      const decision = this.requireDecision(id);
      if (decision.status !== 'COMMITTED') {
        throw new ProductStoreError(
          'DECISION_STATE',
          `speech can only be intended for a COMMITTED decision, ${id} is ${decision.status}`,
        );
      }
      const now = Date.now();
      const result = this.db
        .prepare(
          `UPDATE product_decisions
             SET speech_intended_at = ?, updated_at = ?
           WHERE id = ? AND speech_intended_at IS NULL`,
        )
        .run(now, now, id);
      return result.changes === 1;
    })();
  }

  /** Get one model attempt, or `null`. */
  getAttempt(attemptId: string): ModelAttempt | null {
    const row = this.db
      .prepare(`SELECT * FROM product_model_attempts WHERE id = ?`)
      .get(assertIdentifier(attemptId, 'attemptId')) as AttemptRow | undefined;
    return row === undefined ? null : this.attemptFromRow(row);
  }

  /** Attempts of one decision in attempt order. */
  listAttempts(decisionId: string): ModelAttempt[] {
    const rows = this.db
      .prepare(`SELECT * FROM product_model_attempts WHERE decision_id = ? ORDER BY attempt_no`)
      .all(assertIdentifier(decisionId, 'decisionId')) as AttemptRow[];
    return rows.map((row) => this.attemptFromRow(row));
  }

  // -------------------------------------------------------------------------
  // Compute reservations (integer micro-USD, per-call ceiling reserved)
  // -------------------------------------------------------------------------

  /**
   * Reserve one in-flight call.
   *
   * `reserveMicroUsd` is the caller-computed deterministic per-call ceiling
   * (number|bigint); when omitted the agent's declared
   * `maxCostMicroUsdPerCall` is reserved. Per-agent caps and the optional room
   * aggregate guard both use the incoming reserve amount with strict `>`
   * comparisons, so a `0` cap admits only a `0` reserve. The declared per-call
   * maximum remains the runtime's provider validation cap and is not enforced
   * here. Totals are exact bigint and the whole admission is one transaction.
   */
  reserveCall(
    roomId: string,
    agentId: string,
    roomLimits: RoomReservationLimits = {},
    reserveMicroUsd?: number | bigint,
  ): AgentReservation {
    const room = assertIdentifier(roomId, 'roomId');
    const agent = assertIdentifier(agentId, 'agentId');
    const roomMaxCalls = normalizeOptionalBigInt(roomLimits?.maxCalls, 'roomLimits.maxCalls');
    const roomMaxCost = normalizeOptionalBigInt(
      roomLimits?.maxCostMicroUsd,
      'roomLimits.maxCostMicroUsd',
    );
    const requestedReserve = normalizeOptionalBigInt(reserveMicroUsd, 'reserveMicroUsd');
    return this.db.transaction((): AgentReservation => {
      const roomRecord = this.requireRoom(room);
      if (roomRecord.status === 'COMPLETE' || roomRecord.status === 'FAILED') {
        throw new ProductStoreError('ROOM_STATE', `cannot reserve compute for terminal room ${room}`);
      }
      const config = this.requireAgentConfig(agent);
      if (!config.enabled) {
        throw new ProductStoreError('AGENT_DISABLED', `agent ${agent} is disabled`);
      }
      const reserveBig = requestedReserve ?? BigInt(config.limits.maxCostMicroUsdPerCall);
      const reserveAmount = toSafeNumber(reserveBig, 'reserveMicroUsd');

      // Room-aggregate admission guard, evaluated before any modification.
      if (roomMaxCalls !== null || roomMaxCost !== null) {
        let totalCalls = 0n;
        let totalCost = 0n;
        for (const reservation of this.listRoomReservations(room)) {
          totalCalls += BigInt(reservation.callsReserved + reservation.callsSettled);
          totalCost += BigInt(reservation.costMicroUsdReserved + reservation.costMicroUsdSettled);
        }
        if (roomMaxCalls !== null && totalCalls + 1n > roomMaxCalls) {
          throw new ProductStoreError(
            'ROOM_RESERVATION_EXCEEDED',
            `ROOM_RESERVATION_EXCEEDED: room ${room} exhausted maxCalls=${roomMaxCalls.toString()}`,
          );
        }
        if (roomMaxCost !== null && totalCost + reserveBig > roomMaxCost) {
          throw new ProductStoreError(
            'ROOM_RESERVATION_EXCEEDED',
            `ROOM_RESERVATION_EXCEEDED: room ${room} exhausted maxCostMicroUsd=${roomMaxCost.toString()}`,
          );
        }
      }

      const current = this.getReservation(room, agent);
      const reserveAmounts = this.getReserveAmounts(room, agent);
      const callsReserved = BigInt(current?.callsReserved ?? 0) + 1n;
      const costMicroUsdReserved = BigInt(current?.costMicroUsdReserved ?? 0) + reserveBig;
      const callsSettled = BigInt(current?.callsSettled ?? 0);
      const costMicroUsdSettled = BigInt(current?.costMicroUsdSettled ?? 0);

      if (callsSettled + callsReserved > BigInt(config.limits.maxCallsPerRoom)) {
        throw new ProductStoreError(
          'RESERVATION_EXCEEDED',
          `agent ${agent} exhausted maxCallsPerRoom=${config.limits.maxCallsPerRoom} for room ${room}`,
        );
      }
      if (costMicroUsdSettled + costMicroUsdReserved > BigInt(config.limits.maxCostMicroUsdPerRoom)) {
        throw new ProductStoreError(
          'RESERVATION_EXCEEDED',
          `agent ${agent} exhausted maxCostMicroUsdPerRoom=${config.limits.maxCostMicroUsdPerRoom} for room ${room}`,
        );
      }
      this.writeReservation(room, agent, {
        callsReserved: toSafeNumber(callsReserved, 'callsReserved'),
        costMicroUsdReserved: toSafeNumber(costMicroUsdReserved, 'costMicroUsdReserved'),
        callsSettled: toSafeNumber(callsSettled, 'callsSettled'),
        costMicroUsdSettled: toSafeNumber(costMicroUsdSettled, 'costMicroUsdSettled'),
        reserveAmounts: [...reserveAmounts, reserveAmount],
      });
      return this.requireReservation(room, agent);
    })();
  }

  /**
   * Settle one reserved call with its actual integer cost (normally at or
   * below the reserved per-call ceiling). The exact ceiling reserved for this
   * call is released; real overruns above the agent's declared per-call
   * maximum are persisted in full as settled cost before a
   * `RESERVATION_EXCEEDED` error is raised: actual provider spend is never
   * silently discarded.
   */
  settleCall(roomId: string, agentId: string, costMicroUsd: number): AgentReservation {
    const room = assertIdentifier(roomId, 'roomId');
    const agent = assertIdentifier(agentId, 'agentId');
    const cost = assertInteger(costMicroUsd, 'costMicroUsd', 0);
    const config = this.requireAgentConfig(agent);
    const settled = this.db.transaction((): AgentReservation => {
      const current = this.requireReservation(room, agent);
      if (current.callsReserved < 1) {
        throw new ProductStoreError('RESERVATION_NOT_FOUND', `no in-flight reservation for agent ${agent} in room ${room}`);
      }
      const released = this.takeOldestReserve(room, agent, config.limits.maxCostMicroUsdPerCall);
      this.writeReservation(room, agent, {
        callsReserved: current.callsReserved - 1,
        // The exact per-call ceiling is released; any overrun remains settled.
        costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released.amount),
        callsSettled: current.callsSettled + 1,
        costMicroUsdSettled: current.costMicroUsdSettled + cost,
        reserveAmounts: released.remaining,
      });
      return this.requireReservation(room, agent);
    })();
    if (cost > config.limits.maxCostMicroUsdPerCall) {
      throw new ProductStoreError(
        'RESERVATION_EXCEEDED',
        `actual cost ${cost} exceeds reserved per-call maximum ${config.limits.maxCostMicroUsdPerCall}; overrun persisted as settled cost`,
      );
    }
    return settled;
  }

  /**
   * Settle an in-flight call whose actual cost is unknown (for example a
   * timeout) at the exact ceiling reserved for that call. This is the
   * conservative budget account only: provider cost analytics stay at their
   * recorded value (0 for unknown) and no false charge is booked.
   */
  settleUnknownCall(roomId: string, agentId: string): AgentReservation {
    const room = assertIdentifier(roomId, 'roomId');
    const agent = assertIdentifier(agentId, 'agentId');
    return this.db.transaction((): AgentReservation => {
      const config = this.requireAgentConfig(agent);
      const current = this.requireReservation(room, agent);
      if (current.callsReserved < 1) {
        throw new ProductStoreError('RESERVATION_NOT_FOUND', `no in-flight reservation for agent ${agent} in room ${room}`);
      }
      const released = this.takeOldestReserve(room, agent, config.limits.maxCostMicroUsdPerCall);
      this.writeReservation(room, agent, {
        callsReserved: current.callsReserved - 1,
        costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released.amount),
        callsSettled: current.callsSettled + 1,
        costMicroUsdSettled: current.costMicroUsdSettled + released.amount,
        reserveAmounts: released.remaining,
      });
      return this.requireReservation(room, agent);
    })();
  }

  /** Release one reserved call without settling it (for example a failure). */
  releaseCall(roomId: string, agentId: string): AgentReservation {
    const room = assertIdentifier(roomId, 'roomId');
    const agent = assertIdentifier(agentId, 'agentId');
    return this.db.transaction((): AgentReservation => {
      const config = this.requireAgentConfig(agent);
      const current = this.requireReservation(room, agent);
      if (current.callsReserved < 1) {
        throw new ProductStoreError('RESERVATION_NOT_FOUND', `no in-flight reservation for agent ${agent} in room ${room}`);
      }
      const released = this.takeOldestReserve(room, agent, config.limits.maxCostMicroUsdPerCall);
      this.writeReservation(room, agent, {
        callsReserved: current.callsReserved - 1,
        costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released.amount),
        callsSettled: current.callsSettled,
        costMicroUsdSettled: current.costMicroUsdSettled,
        reserveAmounts: released.remaining,
      });
      return this.requireReservation(room, agent);
    })();
  }

  /** All agent reservations for one room, ordered by agent id. */
  listRoomReservations(roomId: string): AgentReservation[] {
    const rows = this.db
      .prepare(`SELECT * FROM product_agent_reservations WHERE room_id = ? ORDER BY agent_id`)
      .all(assertIdentifier(roomId, 'roomId')) as ReservationRow[];
    return rows.map((row) => this.reservationFromRow(row));
  }

  /** Current reservation counters, or `null` when never reserved. */
  getReservation(roomId: string, agentId: string): AgentReservation | null {
    const row = this.db
      .prepare(`SELECT * FROM product_agent_reservations WHERE room_id = ? AND agent_id = ?`)
      .get(assertIdentifier(roomId, 'roomId'), assertIdentifier(agentId, 'agentId')) as
      | ReservationRow
      | undefined;
    return row === undefined ? null : this.reservationFromRow(row);
  }

  // -------------------------------------------------------------------------
  // Derived platform results projection (never financial settlement)
  // -------------------------------------------------------------------------

  /** Record the immutable derived platform result for a COMPLETE room once. */
  recordRoomResult(input: RecordRoomResultInput): RoomResult {
    const roomId = assertIdentifier(input?.roomId, 'roomId');
    const placements = this.validatePlacements(input.placements);
    const projectionVersion =
      input.projectionVersion === undefined ? 1 : assertInteger(input.projectionVersion, 'projectionVersion', 1);

    return this.db.transaction((): RoomResult => {
      const room = this.requireRoom(roomId);
      if (room.status !== 'COMPLETE') {
        throw new ProductStoreError('ROOM_STATE', `results require a COMPLETE room, room ${roomId} is ${room.status}`);
      }
      if (this.getRoomResult(roomId) !== null) {
        throw new ProductStoreError('RESULT_EXISTS', `room ${roomId} already has a result`);
      }
      const participants = new Map(
        this.listParticipants(roomId).map((participant) => [participant.principalId, participant]),
      );
      const seenPrincipals = new Set<string>();
      const seenPlacements = new Set<number>();
      for (const placement of placements) {
        const participant = participants.get(placement.principalId);
        if (participant === undefined) {
          throw new ProductStoreError('INVALID_INPUT', `placement principal ${placement.principalId} is not in room ${roomId}`);
        }
        if (participant.kind !== placement.kind) {
          throw new ProductStoreError('INVALID_INPUT', `placement kind mismatch for ${placement.principalId}`);
        }
        if (seenPrincipals.has(placement.principalId)) {
          throw new ProductStoreError('INVALID_INPUT', `duplicate placement principal ${placement.principalId}`);
        }
        if (seenPlacements.has(placement.placement)) {
          throw new ProductStoreError('INVALID_INPUT', `duplicate placement position ${placement.placement}`);
        }
        seenPrincipals.add(placement.principalId);
        seenPlacements.add(placement.placement);
      }
      this.db
        .prepare(
          `INSERT INTO product_room_results (room_id, table_id, platform_competition_id, projection_version, placements_json, derived_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, room.tableId, room.platformCompetitionId, projectionVersion, JSON.stringify(placements), Date.now());
      return this.requireRoomResult(roomId);
    })();
  }

  /** The immutable result projection for one room, or `null`. */
  getRoomResult(roomId: string): RoomResult | null {
    const row = this.db
      .prepare(`SELECT * FROM product_room_results WHERE room_id = ?`)
      .get(assertIdentifier(roomId, 'roomId')) as ResultRow | undefined;
    return row === undefined ? null : this.resultFromRow(row);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private roomFromRow(row: RoomRow): ProductRoom {
    return {
      id: row.id,
      name: row.name,
      status: row.status as RoomStatus,
      policyKind: row.policy_kind as ProductPolicyKind,
      policy: JSON.parse(row.policy_json) as ProductPolicy,
      tableId: row.table_id,
      platformCompetitionId: row.platform_competition_id,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private participantFromRow(row: ParticipantRow): ProductParticipant {
    return {
      roomId: row.room_id,
      principalId: row.principal_id,
      kind: row.kind as ParticipantKind,
      agentId: row.agent_id,
      joinedAt: row.joined_at,
    };
  }

  private agentConfigFromRow(row: AgentConfigRow): AgentConfig {
    return {
      id: row.id,
      name: row.name,
      model: row.model,
      provider: row.provider,
      baseUrl: row.base_url,
      keyEnv: row.key_env,
      principalId: row.principal_id,
      promptPolicyId: row.prompt_policy_id,
      promptPolicyHash: row.prompt_policy_hash,
      pricing: {
        inputMicroUsdPerMillionTokens: row.input_micro_usd_per_million_tokens,
        outputMicroUsdPerMillionTokens: row.output_micro_usd_per_million_tokens,
      },
      limits: {
        maxCallsPerRoom: row.max_calls_per_room,
        maxCostMicroUsdPerRoom: row.max_cost_micro_usd_per_room,
        maxCostMicroUsdPerCall: row.max_cost_micro_usd_per_call,
      },
      enabled: row.enabled === 1,
    };
  }

  private decisionFromRow(row: DecisionRow): ProductDecision {
    const observation = parseSeatObservation(JSON.parse(row.observation_json) as unknown);
    return {
      id: row.id,
      tableId: row.table_id,
      turnId: row.turn_id,
      principalId: row.principal_id,
      roomId: row.room_id,
      status: row.status as DecisionStatus,
      observation,
      observationHash: row.observation_hash,
      version: observation.version,
      promptPolicyId: row.prompt_policy_id,
      eventCursor: row.event_cursor,
      source: row.source_json === null ? null : (JSON.parse(row.source_json) as DecisionSource),
      requestJson: row.request_json,
      receiptJson: row.receipt_json,
      speechIntendedAt: row.speech_intended_at,
      errorReason: row.error_reason,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private attemptFromRow(row: AttemptRow): ModelAttempt {
    return {
      id: row.id,
      decisionId: row.decision_id,
      attemptNo: row.attempt_no,
      status: row.status as AttemptStatus,
      requestJson: row.request_json,
      requestHash: row.request_hash,
      requestMetadataJson: row.request_metadata_json,
      responseJson: row.response_json,
      error: row.error,
      model: row.model,
      provider: row.provider,
      promptPolicyId: row.prompt_policy_id,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      costMicroUsd: row.cost_micro_usd,
      latencyMs: row.latency_ms,
      createdAt: row.created_at,
      recordedAt: row.recorded_at,
    };
  }

  private reservationFromRow(row: ReservationRow): AgentReservation {
    return {
      roomId: row.room_id,
      agentId: row.agent_id,
      callsReserved: row.calls_reserved,
      costMicroUsdReserved: row.cost_micro_usd_reserved,
      callsSettled: row.calls_settled,
      costMicroUsdSettled: row.cost_micro_usd_settled,
      updatedAt: row.updated_at,
    };
  }

  /** Outstanding per-call reserve ceilings (FIFO) for one reservation. */
  private getReserveAmounts(roomId: string, agentId: string): number[] {
    const row = this.db
      .prepare(
        `SELECT reserve_amounts_json FROM product_agent_reservations WHERE room_id = ? AND agent_id = ?`,
      )
      .get(roomId, agentId) as { reserve_amounts_json: string } | undefined;
    return row === undefined ? [] : parseReserveAmounts(row.reserve_amounts_json);
  }

  /** Take the oldest outstanding per-call ceiling (FIFO) for settlement. */
  private takeOldestReserve(
    roomId: string,
    agentId: string,
    fallback: number,
  ): { amount: number; remaining: number[] } {
    const amounts = this.getReserveAmounts(roomId, agentId);
    if (amounts.length === 0) return { amount: fallback, remaining: [] };
    return { amount: amounts[0]!, remaining: amounts.slice(1) };
  }

  private resultFromRow(row: ResultRow): RoomResult {
    return {
      roomId: row.room_id,
      tableId: row.table_id,
      platformCompetitionId: row.platform_competition_id,
      projectionVersion: row.projection_version,
      placements: JSON.parse(row.placements_json) as RoomResultPlacement[],
      derivedAt: row.derived_at,
    };
  }

  private parseObservation(value: unknown): SeatObservation {
    try {
      return parseSeatObservation(value);
    } catch (error) {
      throw new ProductStoreError(
        'INVALID_INPUT',
        error instanceof Error ? `invalid SeatObservation: ${error.message}` : 'invalid SeatObservation',
      );
    }
  }

  private requireRoom(roomId: string): ProductRoom {
    const room = this.getRoom(roomId);
    if (room === null) throw new ProductStoreError('ROOM_NOT_FOUND', `room not found: ${roomId}`);
    return room;
  }

  private requireDecision(decisionId: string): ProductDecision {
    const decision = this.getDecision(decisionId);
    if (decision === null) throw new ProductStoreError('DECISION_NOT_FOUND', `decision not found: ${decisionId}`);
    return decision;
  }

  private requireAttempt(attemptId: string): ModelAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === null) throw new ProductStoreError('ATTEMPT_NOT_FOUND', `attempt not found: ${attemptId}`);
    return attempt;
  }

  private requireAgentConfig(agentId: string): AgentConfig {
    const config = this.getAgentConfig(agentId);
    if (config === null) throw new ProductStoreError('AGENT_CONFIG_NOT_FOUND', `agent config not found: ${agentId}`);
    return config;
  }

  private requireReservation(roomId: string, agentId: string): AgentReservation {
    const reservation = this.getReservation(roomId, agentId);
    if (reservation === null) {
      throw new ProductStoreError('RESERVATION_NOT_FOUND', `no reservation for agent ${agentId} in room ${roomId}`);
    }
    return reservation;
  }

  private requireRoomResult(roomId: string): RoomResult {
    const result = this.getRoomResult(roomId);
    if (result === null) throw new ProductStoreError('RESULT_NOT_FOUND', `no result for room ${roomId}`);
    return result;
  }

  private insertParticipant(
    roomId: string,
    principalId: string,
    participant: PolicyParticipant,
    joinedAt: number,
  ): ProductParticipant {
    this.db
      .prepare(
        `INSERT INTO product_room_participants (room_id, principal_id, kind, agent_id, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(roomId, principalId, participant.kind, participant.agentId ?? null, joinedAt);
    const inserted = this.getParticipant(roomId, principalId);
    if (inserted === null) {
      throw new ProductStoreError('PARTICIPANT_NOT_FOUND', `participant ${principalId} was not persisted`);
    }
    return inserted;
  }

  private casRoom(
    roomId: string,
    expectedStatus: RoomStatus,
    nextStatus: RoomStatus,
    patch: RoomTransitionPatch,
  ): ProductRoom {
    const result = this.db
      .prepare(
        `UPDATE product_rooms
           SET status = @nextStatus,
               table_id = COALESCE(@tableId, table_id),
               platform_competition_id = COALESCE(@platformCompetitionId, platform_competition_id),
               failure_reason = COALESCE(@failureReason, failure_reason),
               updated_at = @updatedAt
         WHERE id = @id AND status = @expectedStatus`,
      )
      .run({
        id: roomId,
        expectedStatus,
        nextStatus,
        tableId: patch.tableId ?? null,
        platformCompetitionId: patch.platformCompetitionId ?? null,
        failureReason: patch.failureReason ?? null,
        updatedAt: Date.now(),
      });
    if (result.changes !== 1) {
      const existing = this.getRoom(roomId);
      if (existing === null) throw new ProductStoreError('ROOM_NOT_FOUND', `room not found: ${roomId}`);
      throw new ProductStoreError('ROOM_STATE', `room ${roomId} is ${existing.status}, expected ${expectedStatus}`);
    }
    return this.requireRoom(roomId);
  }

  private casDecision(
    decisionId: string,
    expectedStatus: DecisionStatus,
    nextStatus: DecisionStatus,
    patch: DecisionTransitionPatch,
    now: number,
  ): ProductDecision {
    const result = this.db
      .prepare(
        `UPDATE product_decisions
           SET status = @nextStatus,
               request_json = COALESCE(@requestJson, request_json),
               receipt_json = COALESCE(@receiptJson, receipt_json),
               error_reason = COALESCE(@errorReason, error_reason),
               updated_at = @updatedAt
         WHERE id = @id AND status = @expectedStatus`,
      )
      .run({
        id: decisionId,
        expectedStatus,
        nextStatus,
        requestJson: patch.requestJson ?? null,
        receiptJson: patch.receiptJson ?? null,
        errorReason: patch.errorReason ?? null,
        updatedAt: now,
      });
    if (result.changes !== 1) {
      const existing = this.getDecision(decisionId);
      if (existing === null) throw new ProductStoreError('DECISION_NOT_FOUND', `decision not found: ${decisionId}`);
      throw new ProductStoreError(
        'DECISION_STATE',
        `decision ${decisionId} is ${existing.status}, expected ${expectedStatus}`,
      );
    }
    return this.requireDecision(decisionId);
  }

  private transitionFromAnyNonTerminal(
    decisionId: string,
    nextStatus: 'STALE' | 'FAILED',
    reason: string,
  ): ProductDecision {
    const id = assertIdentifier(decisionId, 'decisionId');
    const decision = this.requireDecision(id);
    if (!NON_TERMINAL_DECISION_STATUSES.includes(decision.status)) {
      throw new ProductStoreError('DECISION_STATE', `decision ${id} is already terminal (${decision.status})`);
    }
    return this.casDecision(id, decision.status, nextStatus, { errorReason: reason }, Date.now());
  }

  private latestSuccessfulAttempt(decisionId: string): ModelAttempt | null {
    const row = this.db
      .prepare(
        `SELECT * FROM product_model_attempts
         WHERE decision_id = ? AND status = 'SUCCEEDED'
         ORDER BY attempt_no DESC LIMIT 1`,
      )
      .get(decisionId) as AttemptRow | undefined;
    return row === undefined ? null : this.attemptFromRow(row);
  }

  private writeReservation(
    roomId: string,
    agentId: string,
    totals: {
      callsReserved: number;
      costMicroUsdReserved: number;
      callsSettled: number;
      costMicroUsdSettled: number;
      reserveAmounts: readonly number[];
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO product_agent_reservations
           (room_id, agent_id, calls_reserved, cost_micro_usd_reserved, reserve_amounts_json,
            calls_settled, cost_micro_usd_settled, updated_at)
         VALUES (@roomId, @agentId, @callsReserved, @costReserved, @reserveAmounts,
                 @callsSettled, @costSettled, @updatedAt)
         ON CONFLICT(room_id, agent_id) DO UPDATE SET
           calls_reserved = excluded.calls_reserved,
           cost_micro_usd_reserved = excluded.cost_micro_usd_reserved,
           reserve_amounts_json = excluded.reserve_amounts_json,
           calls_settled = excluded.calls_settled,
           cost_micro_usd_settled = excluded.cost_micro_usd_settled,
           updated_at = excluded.updated_at`,
      )
      .run({
        roomId,
        agentId,
        callsReserved: totals.callsReserved,
        costReserved: totals.costMicroUsdReserved,
        reserveAmounts: JSON.stringify(totals.reserveAmounts),
        callsSettled: totals.callsSettled,
        costSettled: totals.costMicroUsdSettled,
        updatedAt: Date.now(),
      });
  }

  private assertLimitChangeFitsReservations(previous: AgentConfig, next: AgentConfig): void {
    const rows = this.db
      .prepare(`SELECT * FROM product_agent_reservations WHERE agent_id = ? AND calls_reserved > 0`)
      .all(next.id) as ReservationRow[];
    if (rows.length === 0) return;
    if (next.limits.maxCostMicroUsdPerCall !== previous.limits.maxCostMicroUsdPerCall) {
      throw new ProductStoreError(
        'INVALID_INPUT',
        `maxCostMicroUsdPerCall is frozen while agent ${next.id} has calls in flight`,
      );
    }
    for (const row of rows) {
      if (row.calls_settled + row.calls_reserved > next.limits.maxCallsPerRoom) {
        throw new ProductStoreError(
          'INVALID_INPUT',
          `maxCallsPerRoom would fall below outstanding reservations of agent ${next.id} in room ${row.room_id}`,
        );
      }
      if (row.cost_micro_usd_settled + row.cost_micro_usd_reserved > next.limits.maxCostMicroUsdPerRoom) {
        throw new ProductStoreError(
          'INVALID_INPUT',
          `maxCostMicroUsdPerRoom would fall below outstanding reservations of agent ${next.id} in room ${row.room_id}`,
        );
      }
    }
  }

  private validatePlacements(placements: unknown): RoomResultPlacement[] {
    if (!Array.isArray(placements) || placements.length === 0) {
      throw new ProductStoreError('INVALID_INPUT', 'placements must be a non-empty array');
    }
    return placements.map((placement) => {
      if (placement === null || typeof placement !== 'object') {
        throw new ProductStoreError('INVALID_INPUT', 'each placement must be an object');
      }
      const record = placement as Record<string, unknown>;
      const principalId = assertIdentifier(record.principalId, 'placement.principalId');
      if (record.kind !== 'HUMAN' && record.kind !== 'AGENT') {
        throw new ProductStoreError('INVALID_INPUT', 'placement.kind must be HUMAN or AGENT');
      }
      return { principalId, kind: record.kind, placement: assertInteger(record.placement, 'placement.placement', 1) };
    });
  }
}

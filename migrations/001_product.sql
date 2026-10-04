-- 001_product.sql — product database baseline (schema only).
--
-- Applied only by ProductStore (src/product/store.ts) against its own SQLite
-- database. Product migrations match `NNN_product.sql`; each applied file's
-- SHA-256 is recorded in product_migrations and re-verified on every startup.
--
-- This schema stores no poker state, no seat authority and no financial
-- settlement. Budget quantities are integer micro-USD; floats are never
-- persisted. Agent rows store environment variable names, never secrets.

CREATE TABLE product_migrations (
  version    TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64),
  applied_at INTEGER NOT NULL
);

CREATE TRIGGER product_migrations_no_update
BEFORE UPDATE ON product_migrations
BEGIN
  SELECT RAISE(ABORT, 'product migration hashes are immutable');
END;

CREATE TRIGGER product_migrations_no_delete
BEFORE DELETE ON product_migrations
BEGIN
  SELECT RAISE(ABORT, 'product migration hashes are immutable');
END;

CREATE TABLE product_rooms (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) > 0),
  status         TEXT NOT NULL CHECK (status IN (
                   'DRAFT', 'WAITING_FOR_ROSTER', 'PROVISIONING',
                   'ACTIVE', 'COMPLETE', 'FAILED'
                 )),
  policy_kind    TEXT NOT NULL CHECK (policy_kind IN ('SPONSORED', 'CHALLENGE')),
  policy_json    TEXT NOT NULL,
  table_id       TEXT,
  tournament_id  TEXT,
  failure_reason TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (status NOT IN ('ACTIVE', 'COMPLETE') OR table_id IS NOT NULL),
  CHECK (status <> 'FAILED' OR (failure_reason IS NOT NULL AND length(failure_reason) > 0))
);

-- Principal metadata only; no seat column exists.
CREATE TABLE product_room_participants (
  room_id      TEXT NOT NULL REFERENCES product_rooms(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('HUMAN', 'AGENT')),
  agent_id     TEXT,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (room_id, principal_id),
  CHECK ((kind = 'AGENT' AND agent_id IS NOT NULL AND length(agent_id) > 0)
      OR (kind = 'HUMAN' AND agent_id IS NULL))
);

CREATE INDEX product_room_participants_agent ON product_room_participants(agent_id);

CREATE TABLE product_agent_configs (
  id                                   TEXT PRIMARY KEY,
  name                                 TEXT NOT NULL CHECK (length(name) > 0),
  model                                TEXT NOT NULL CHECK (length(model) > 0),
  provider                             TEXT NOT NULL CHECK (length(provider) > 0),
  base_url                             TEXT NOT NULL CHECK (length(base_url) > 0),
  key_env                              TEXT NOT NULL CHECK (length(key_env) > 0),
  principal_id                         TEXT NOT NULL CHECK (length(principal_id) > 0),
  prompt_policy_id                     TEXT NOT NULL CHECK (length(prompt_policy_id) > 0),
  prompt_policy_hash                   TEXT NOT NULL CHECK (length(prompt_policy_hash) = 64),
  input_micro_usd_per_million_tokens   INTEGER NOT NULL CHECK (input_micro_usd_per_million_tokens >= 0),
  output_micro_usd_per_million_tokens  INTEGER NOT NULL CHECK (output_micro_usd_per_million_tokens >= 0),
  max_calls_per_room                   INTEGER NOT NULL CHECK (max_calls_per_room >= 1),
  max_cost_micro_usd_per_room          INTEGER NOT NULL CHECK (max_cost_micro_usd_per_room >= 0),
  max_cost_micro_usd_per_call          INTEGER NOT NULL CHECK (max_cost_micro_usd_per_call >= 0),
  enabled                              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at                           INTEGER NOT NULL,
  updated_at                           INTEGER NOT NULL,
  CHECK (max_cost_micro_usd_per_call <= max_cost_micro_usd_per_room)
);

CREATE TABLE product_decisions (
  id               TEXT PRIMARY KEY,
  table_id         TEXT NOT NULL CHECK (length(table_id) > 0),
  turn_id          TEXT NOT NULL CHECK (length(turn_id) > 0),
  principal_id     TEXT NOT NULL CHECK (length(principal_id) > 0),
  room_id          TEXT REFERENCES product_rooms(id),
  status           TEXT NOT NULL CHECK (status IN (
                     'OBSERVED', 'CALLING_PROVIDER', 'PROVIDER_RECORDED',
                     'ACTION_SUBMITTED', 'COMMITTED', 'STALE', 'FAILED'
                   )),
  observation_json TEXT NOT NULL,
  observation_hash TEXT NOT NULL CHECK (length(observation_hash) = 64),
  source_json      TEXT,
  prompt_policy_id TEXT NOT NULL CHECK (length(prompt_policy_id) > 0),
  event_cursor     INTEGER NOT NULL CHECK (event_cursor >= 0),
  request_json     TEXT,
  receipt_json     TEXT,
  speech_intended_at INTEGER,
  error_reason     TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (table_id, turn_id, principal_id),
  CHECK (status NOT IN ('ACTION_SUBMITTED', 'COMMITTED') OR request_json IS NOT NULL),
  CHECK (status <> 'COMMITTED' OR receipt_json IS NOT NULL),
  CHECK (status <> 'FAILED' OR (error_reason IS NOT NULL AND length(error_reason) > 0)),
  CHECK (status <> 'STALE' OR (error_reason IS NOT NULL AND length(error_reason) > 0))
);

CREATE INDEX product_decisions_room ON product_decisions(room_id);
CREATE INDEX product_decisions_table ON product_decisions(table_id);

-- The observation and pre-transport source are immutable for the lifetime of
-- the decision; only lifecycle/payload columns may change.
CREATE TRIGGER product_decisions_observation_immutable
BEFORE UPDATE ON product_decisions
WHEN NEW.id <> OLD.id
  OR NEW.table_id <> OLD.table_id
  OR NEW.turn_id <> OLD.turn_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.observation_json <> OLD.observation_json
  OR NEW.observation_hash <> OLD.observation_hash
  OR NEW.source_json IS NOT OLD.source_json
  OR NEW.prompt_policy_id <> OLD.prompt_policy_id
  OR NEW.event_cursor <> OLD.event_cursor
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'decision observation and source are immutable');
END;

-- The owning room cannot be silently reassigned after observation.
CREATE TRIGGER product_decisions_room_immutable
BEFORE UPDATE ON product_decisions
WHEN NEW.room_id IS NOT OLD.room_id
BEGIN
  SELECT RAISE(ABORT, 'decision room reference is immutable');
END;

-- Resolved action request and receipt are write-once: lifecycle updates may
-- read them but never alter or clear an already-recorded payload.
CREATE TRIGGER product_decisions_payload_write_once
BEFORE UPDATE ON product_decisions
WHEN (OLD.request_json IS NOT NULL AND NEW.request_json IS NOT OLD.request_json)
  OR (OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json)
BEGIN
  SELECT RAISE(ABORT, 'decision request and receipt are write-once');
END;

-- The speech intention is marked at most once, before sending; a lost speech
-- outcome is acceptable and never rolls back the committed action.
CREATE TRIGGER product_decisions_speech_write_once
BEFORE UPDATE ON product_decisions
WHEN OLD.speech_intended_at IS NOT NULL AND NEW.speech_intended_at IS NOT OLD.speech_intended_at
BEGIN
  SELECT RAISE(ABORT, 'decision speech intention is write-once');
END;

CREATE TABLE product_model_attempts (
  id                TEXT PRIMARY KEY,
  decision_id       TEXT NOT NULL REFERENCES product_decisions(id),
  attempt_no        INTEGER NOT NULL CHECK (attempt_no >= 1),
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  request_json      TEXT NOT NULL,
  -- Exact sha256 of the request_json bytes; write-immutable.
  request_hash      TEXT NOT NULL CHECK (length(request_hash) = 64),
  -- Sanitized pre-HTTP transport record metadata (never headers/credentials).
  request_metadata_json TEXT,
  response_json     TEXT,
  error             TEXT,
  model             TEXT,
  provider          TEXT,
  prompt_policy_id  TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_micro_usd    INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  latency_ms        INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at        INTEGER NOT NULL,
  recorded_at       INTEGER,
  UNIQUE (decision_id, attempt_no),
  CHECK (response_json IS NULL OR recorded_at IS NOT NULL),
  CHECK (status <> 'PENDING' OR recorded_at IS NULL),
  CHECK (status <> 'SUCCEEDED' OR response_json IS NOT NULL),
  CHECK (status <> 'FAILED' OR (error IS NOT NULL AND length(error) > 0)),
  CHECK (status = 'PENDING' OR (model IS NOT NULL AND provider IS NOT NULL AND prompt_policy_id IS NOT NULL))
);

CREATE TRIGGER product_model_attempts_identity_immutable
BEFORE UPDATE ON product_model_attempts
WHEN NEW.id <> OLD.id
  OR NEW.decision_id <> OLD.decision_id
  OR NEW.attempt_no <> OLD.attempt_no
  OR NEW.request_json <> OLD.request_json
  OR NEW.request_hash <> OLD.request_hash
  OR NEW.request_metadata_json IS NOT OLD.request_metadata_json
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'model attempt request and identity are immutable');
END;

-- The response record (success or failure) is written exactly once.
CREATE TRIGGER product_model_attempts_record_once
BEFORE UPDATE ON product_model_attempts
WHEN OLD.status <> 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'model attempt is already recorded');
END;

CREATE TRIGGER product_model_attempts_no_delete
BEFORE DELETE ON product_model_attempts
BEGIN
  SELECT RAISE(ABORT, 'model attempts are immutable');
END;

CREATE TABLE product_agent_reservations (
  room_id                TEXT NOT NULL REFERENCES product_rooms(id) ON DELETE CASCADE,
  agent_id               TEXT NOT NULL REFERENCES product_agent_configs(id),
  calls_reserved         INTEGER NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
  cost_micro_usd_reserved INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd_reserved >= 0),
  -- Outstanding per-call reserve ceilings (JSON integer array, FIFO), so a
  -- settlement releases exactly the amount that call reserved.
  reserve_amounts_json   TEXT NOT NULL DEFAULT '[]',
  calls_settled          INTEGER NOT NULL DEFAULT 0 CHECK (calls_settled >= 0),
  cost_micro_usd_settled INTEGER NOT NULL DEFAULT 0 CHECK (cost_micro_usd_settled >= 0),
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

-- Derived platform projection; never a financial settlement source.
CREATE TABLE product_room_results (
  room_id            TEXT PRIMARY KEY REFERENCES product_rooms(id),
  table_id           TEXT NOT NULL,
  tournament_id      TEXT,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1),
  kind               TEXT NOT NULL DEFAULT 'PLATFORM_PROJECTION'
                       CHECK (kind = 'PLATFORM_PROJECTION'),
  placements_json    TEXT NOT NULL,
  derived_at         INTEGER NOT NULL
);

CREATE TRIGGER product_room_results_no_update
BEFORE UPDATE ON product_room_results
BEGIN
  SELECT RAISE(ABORT, 'room results are immutable');
END;

CREATE TRIGGER product_room_results_no_delete
BEFORE DELETE ON product_room_results
BEGIN
  SELECT RAISE(ABORT, 'room results are immutable');
END;

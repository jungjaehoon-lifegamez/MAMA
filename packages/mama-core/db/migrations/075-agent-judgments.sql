-- Core-owned judgment and commitment command bindings.
-- Existing decisions, registry, observations, edges, and effect receipts remain authoritative.

ALTER TABLE decisions ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK (record_kind IN ('legacy', 'judgment', 'commitment'));
ALTER TABLE decisions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(payload_json));
ALTER TABLE decisions ADD COLUMN applies_from INTEGER;
ALTER TABLE decisions ADD COLUMN applies_until INTEGER;

CREATE TABLE IF NOT EXISTS command_bindings (
  command_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) > 0),
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  payload_hash TEXT NOT NULL CHECK (length(trim(payload_hash)) > 0),
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('judgment', 'observation', 'identity', 'effect')),
  receipt_key TEXT NOT NULL CHECK (length(trim(receipt_key)) > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS judgment_commands (
  command_id TEXT PRIMARY KEY REFERENCES command_bindings(command_id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  committed_watermark INTEGER NOT NULL CHECK (committed_watermark >= 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS commitments (
  task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  commitment_id TEXT NOT NULL UNIQUE,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  head_record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS commitment_assignments (
  commitment_id TEXT NOT NULL REFERENCES commitments(commitment_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'revise', 'withdraw')),
  set_json TEXT NOT NULL CHECK (json_valid(set_json)),
  clear_json TEXT NOT NULL CHECK (json_valid(clear_json)),
  applies_from INTEGER,
  applies_until INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (commitment_id, revision),
  UNIQUE (commitment_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_judgment_commands_record ON judgment_commands(record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commitments_head ON commitments(head_record_id);
CREATE INDEX IF NOT EXISTS idx_commitment_assignments_record ON commitment_assignments(record_id);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (75, 'Core-owned agent judgment and commitment commands');

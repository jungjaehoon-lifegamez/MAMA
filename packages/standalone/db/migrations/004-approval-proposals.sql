-- Writes the agent proposes and an owner decides in Telegram (docs/development/work/approvals.md).
-- The host runs the stored input once, after approval; a row left executing by a restart becomes
-- unknown and is never run again. principal_id is null for the common session.
CREATE TABLE IF NOT EXISTS approval_proposals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  input_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'approved', 'rejected', 'expired', 'executing', 'done', 'failed', 'unknown'
  )),
  principal_id TEXT,
  model_run_id TEXT,
  request_key TEXT NOT NULL,
  reason TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  -- The card exactly as the owner was shown it; outcomes are added under it.
  card_html TEXT,
  chat_id TEXT,
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  result_json TEXT,
  UNIQUE (model_run_id, request_key)
);
CREATE INDEX IF NOT EXISTS approval_proposals_status ON approval_proposals (status, expires_at);

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 4, 'Approval proposals');

CREATE TABLE IF NOT EXISTS mailbox_host_checkpoints (
  input_id INTEGER PRIMARY KEY REFERENCES mailbox_inputs(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (106, 'Consumer-owned durable host job checkpoints');

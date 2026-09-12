-- What a record is about, and who was involved, as references instead of prose.
--
-- The only statement of subject used to be the `topic` text. `item_id` points at a
-- registry node, so two spellings of one item join.
--
-- `record_actors` is a table rather than a column because one record routinely involves
-- several people in different roles - the person who did the work, the one who relayed it,
-- the client contact. The single `assignee` slot on a task was losing that distinction, and
-- putting it back as one column would lose it again. The role is free text: production work
-- and a booking do not share a role vocabulary, and the registry holds the person while the
-- role belongs to this record.
--
-- No foreign key to registry_nodes: the store validates the node and its kind before
-- writing, and a merge rewrites nothing (readers canonicalise through merged_into), so a
-- database-level constraint would only add a failure mode without adding a guarantee.

ALTER TABLE decisions ADD COLUMN item_id TEXT;

-- Only the item. A composite index over
-- COALESCE(event_datetime, created_at) was tried first and broke recovery of databases whose
-- schema_version is newer than their structure - event_datetime arrives in migration 030 and
-- is not guaranteed to exist when this one runs.
CREATE INDEX IF NOT EXISTS idx_decisions_item ON decisions(item_id);

CREATE TABLE IF NOT EXISTS record_actors (
  record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  -- Insertion order, so the actor list reads back the way the agent stated it.
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (record_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_record_actors_person ON record_actors(person_id, record_id);

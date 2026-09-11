-- Registry: the one place that says "these names are the same thing".
--
-- A work item or a person is a node; every spelling it is known by is an alias row. Records
-- and tasks point at the node, so a fact filed under one spelling and a task titled with
-- another still join. Before this, identity lived in title and topic strings, and one item
-- measured 2026-09-11 carried three spellings that never joined.
--
-- Merging is a decision, never a similarity guess: the UNIQUE(kind, alias) constraint makes
-- a contested alias an error the caller must resolve, rather than a silent reassignment.

CREATE TABLE IF NOT EXISTS registry_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
  name TEXT NOT NULL,
  -- Set when an owner correction splits one item into the files it really covers.
  parent_id TEXT REFERENCES registry_nodes(id) ON DELETE SET NULL,
  -- Set when this node was merged away; resolution follows the pointer to the survivor.
  merged_into TEXT REFERENCES registry_nodes(id) ON DELETE SET NULL,
  merge_reason TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registry_nodes_kind ON registry_nodes(kind, merged_into);
CREATE INDEX IF NOT EXISTS idx_registry_nodes_parent ON registry_nodes(parent_id);

CREATE TABLE IF NOT EXISTS registry_aliases (
  node_id TEXT NOT NULL REFERENCES registry_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
  -- Case- and space-normalised at write time; the display form stays in `alias_display`.
  alias TEXT NOT NULL,
  alias_display TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, alias)
);

CREATE INDEX IF NOT EXISTS idx_registry_aliases_node ON registry_aliases(node_id);

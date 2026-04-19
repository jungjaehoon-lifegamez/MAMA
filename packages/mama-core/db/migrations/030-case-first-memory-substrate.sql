-- Migration 030: Case-First Memory Substrate (Phase 1 + 2 + 3)
-- Consolidated from pre-ship migrations 030..049.
-- Covers: entity substrate (decision_entity_sources, entity_lineage,
-- entity_policy), event_datetime column + backfill + created_at fill,
-- entity observation source-locator refactor, case_truth +
-- case_memberships + case_corrections + case_proposal_queue,
-- wiki page search index, entity_timeline_events.role,
-- connector_event_index, learned ranker + search feedback,
-- case_links + tombstones, case promotion/freshness columns,
-- case membership explanation columns.
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md

-- ================================================================
-- Entity substrate — decision_entity_sources
-- ================================================================
CREATE TABLE IF NOT EXISTS decision_entity_sources (
  decision_id TEXT NOT NULL,
  entity_observation_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'support',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_observation_id) REFERENCES entity_observations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_entity_sources_unique
  ON decision_entity_sources(decision_id, entity_observation_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_decision_entity_sources_decision
  ON decision_entity_sources(decision_id);

CREATE INDEX IF NOT EXISTS idx_decision_entity_sources_observation
  ON decision_entity_sources(entity_observation_id);


-- ================================================================
-- Entity substrate — lineage tables
-- ================================================================
CREATE TABLE IF NOT EXISTS entity_ingest_runs (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('live', 'replay', 'backfill')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  scope_key TEXT NOT NULL,
  source_window_start INTEGER,
  source_window_end INTEGER,
  raw_count INTEGER NOT NULL DEFAULT 0,
  observation_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  reviewable_count INTEGER NOT NULL DEFAULT 0,
  audit_run_id TEXT,
  audit_classification TEXT CHECK (audit_classification IN ('improved', 'stable', 'regressed', 'inconclusive')),
  error_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER,
  FOREIGN KEY (audit_run_id) REFERENCES entity_audit_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_ingest_runs_connector_created_at
  ON entity_ingest_runs(connector, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_ingest_runs_status_created_at
  ON entity_ingest_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS entity_lineage_links (
  id TEXT PRIMARY KEY,
  canonical_entity_id TEXT NOT NULL,
  entity_observation_id TEXT NOT NULL,
  source_entity_id TEXT,
  contribution_kind TEXT NOT NULL CHECK (
    contribution_kind IN ('seed', 'merge_adopt', 'manual_attach', 'rollback_restore')
  ),
  run_id TEXT,
  candidate_id TEXT,
  review_action_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rolled_back')),
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('direct', 'backfilled')),
  confidence REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  superseded_at INTEGER,
  FOREIGN KEY (canonical_entity_id) REFERENCES entity_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_observation_id) REFERENCES entity_observations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_entity_id) REFERENCES entity_nodes(id) ON DELETE SET NULL,
  FOREIGN KEY (run_id) REFERENCES entity_ingest_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (candidate_id) REFERENCES entity_resolution_candidates(id) ON DELETE SET NULL,
  FOREIGN KEY (review_action_id) REFERENCES entity_merge_actions(id) ON DELETE SET NULL,
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_entity_lineage_links_entity_status_created_at
  ON entity_lineage_links(canonical_entity_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_lineage_links_observation
  ON entity_lineage_links(entity_observation_id);
CREATE INDEX IF NOT EXISTS idx_entity_lineage_links_run
  ON entity_lineage_links(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_lineage_active_pair
  ON entity_lineage_links(canonical_entity_id, entity_observation_id)
  WHERE status = 'active';


-- ================================================================
-- Entity substrate — policy tables
-- ================================================================
CREATE TABLE IF NOT EXISTS entity_policy (
  policy_key TEXT PRIMARY KEY,
  policy_kind TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_role_bindings (
  actor_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_policy_proposals (
  proposal_id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  policy_kind TEXT NOT NULL,
  proposed_value_json TEXT NOT NULL,
  proposer_actor TEXT NOT NULL,
  approver_actor TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entity_policy_kind
  ON entity_policy(policy_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_policy_proposals_status_created
  ON entity_policy_proposals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_policy_proposals_policy_key
  ON entity_policy_proposals(policy_key, created_at DESC);

-- ================================================================
-- Temporal — add event_datetime column
-- ================================================================
-- Migration 033: Add event_datetime column to decisions table
-- Stores source event timestamp in milliseconds when known.
ALTER TABLE decisions ADD COLUMN event_datetime INTEGER;

CREATE INDEX IF NOT EXISTS idx_decisions_event_datetime ON decisions(event_datetime);


-- ================================================================
-- Temporal — backfill from linked observations
-- ================================================================
-- Migration 034: Backfill event_datetime for existing decisions
-- Priority:
-- 1) Latest linked observation timestamp when provenance exists
-- 2) event_date at 00:00:00 UTC when only date is known

UPDATE decisions
SET event_datetime = (
  SELECT MAX(COALESCE(o.timestamp_observed, o.created_at))
  FROM decision_entity_sources des
  JOIN entity_observations o ON o.id = des.entity_observation_id
  WHERE des.decision_id = decisions.id
)
WHERE event_datetime IS NULL
  AND EXISTS (
    SELECT 1
    FROM decision_entity_sources des
    JOIN entity_observations o ON o.id = des.entity_observation_id
    WHERE des.decision_id = decisions.id
  );

UPDATE decisions
SET event_datetime = CAST(strftime('%s', event_date || 'T00:00:00Z') AS INTEGER) * 1000
WHERE event_datetime IS NULL
  AND event_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decisions_event_datetime_backfill ON decisions(event_datetime);


-- ================================================================
-- Temporal — final fill from created_at
-- ================================================================
-- Migration 035: Fill any remaining event_datetime gaps from created_at
-- This is the final fallback for decisions that have neither provenance-linked
-- observation timestamps nor an explicit event_date.

UPDATE decisions
SET event_datetime = created_at
WHERE event_datetime IS NULL;


-- ================================================================
-- Source locator — add column + seed from raw_db_ref
-- ================================================================
ALTER TABLE entity_observations ADD COLUMN source_locator TEXT;

UPDATE entity_observations
SET source_locator = source_raw_db_ref
WHERE source_locator IS NULL;


-- ================================================================
-- Source locator — switch identity + triggers
-- ================================================================
UPDATE entity_observations
SET source_locator = COALESCE(source_locator, source_raw_db_ref, '')
WHERE source_locator IS NULL OR source_locator = '';

DROP INDEX IF EXISTS idx_entity_observations_source_record;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_observations_source_record
  ON entity_observations(
    source_connector,
    source_locator,
    source_raw_record_id,
    observation_type
  );

CREATE INDEX IF NOT EXISTS idx_entity_observations_source_locator_record
  ON entity_observations(source_connector, source_locator, source_raw_record_id);

CREATE TRIGGER IF NOT EXISTS trg_entity_observations_backfill_source_locator_insert
AFTER INSERT ON entity_observations
WHEN (NEW.source_locator IS NULL OR NEW.source_locator = '')
  AND COALESCE(NEW.source_raw_db_ref, '') <> ''
BEGIN
  UPDATE entity_observations
  SET source_locator = NEW.source_raw_db_ref
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_entity_observations_backfill_source_locator_update
AFTER UPDATE ON entity_observations
WHEN (NEW.source_locator IS NULL OR NEW.source_locator = '')
  AND COALESCE(NEW.source_raw_db_ref, '') <> ''
BEGIN
  UPDATE entity_observations
  SET source_locator = NEW.source_raw_db_ref
  WHERE id = NEW.id;
END;


-- ================================================================
-- Source locator — drop legacy raw_db_ref
-- ================================================================
UPDATE entity_observations
SET source_locator = COALESCE(source_locator, source_raw_db_ref, '')
WHERE source_locator IS NULL OR source_locator = '';

DROP TRIGGER IF EXISTS trg_entity_observations_backfill_source_locator_insert;
DROP TRIGGER IF EXISTS trg_entity_observations_backfill_source_locator_update;

ALTER TABLE entity_observations DROP COLUMN source_raw_db_ref;


-- ================================================================
-- Phase 1 — case_truth
-- ================================================================
-- Migration 039: Create case_truth table
-- Phase 1 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md §5.2

CREATE TABLE IF NOT EXISTS case_truth (
  case_id TEXT PRIMARY KEY,                                                 -- UUID, also persisted in wiki frontmatter
  current_wiki_path TEXT,                                                   -- nullable (merged cases retain no current page)
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','resolved','stale','archived','merged','split')),
  status_reason TEXT,
  primary_actors TEXT,                                                      -- JSON: [{entity_id, role}]
  blockers TEXT,                                                            -- JSON: [{text, source_decision_id?, source_event_id?}]
  last_activity_at TEXT,                                                    -- ISO 8601 — fast-writer field
  canonical_case_id TEXT REFERENCES case_truth(case_id),                    -- merge survivor pointer
  split_from_case_id TEXT REFERENCES case_truth(case_id),                   -- split parent reference
  wiki_path_history TEXT,                                                   -- JSON: [{path, valid_from, valid_to}]
  scope_refs TEXT,                                                          -- JSON: [{kind, id}]
  confidence TEXT,                                                          -- high | medium | low
  compiled_at TEXT,                                                         -- wiki-compiler last write
  state_updated_at TEXT,                                                    -- memory-agent last write (status / last_activity)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_case_truth_current_path
  ON case_truth(current_wiki_path COLLATE NOCASE)
  WHERE current_wiki_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_case_truth_status ON case_truth(status);
CREATE INDEX IF NOT EXISTS idx_case_truth_canonical ON case_truth(canonical_case_id);
CREATE INDEX IF NOT EXISTS idx_case_truth_last_activity ON case_truth(last_activity_at DESC);


-- ================================================================
-- Phase 1 — case_memberships
-- ================================================================
-- Migration 040: Create case_memberships table
-- Phase 1 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md §5.3
--
-- Locked tombstone encoding (§0d Option B): (status='stale', user_locked=1).
-- CHECK enum stays at 5 values; no 'stale_locked'.

CREATE TABLE IF NOT EXISTS case_memberships (
  case_id TEXT NOT NULL REFERENCES case_truth(case_id),
  source_type TEXT NOT NULL CHECK(source_type IN ('decision','event','observation','artifact')),
  source_id TEXT NOT NULL,
  role TEXT,                                                                -- soft-typed: primary | supporting | contradicting | ...
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','candidate','removed','excluded','stale')),
  added_by TEXT NOT NULL CHECK(added_by IN ('wiki-compiler','memory-agent','user-correction')),
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_locked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (case_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_case_memberships_source
  ON case_memberships(source_type, source_id, status);
CREATE INDEX IF NOT EXISTS idx_case_memberships_case_status
  ON case_memberships(case_id, status);


-- ================================================================
-- Phase 1 — case_corrections
-- ================================================================
-- Migration 041: Create case_corrections table
-- Phase 1 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md §5.4
--
-- Option C (Phase 0 §0f): target_ref_json TEXT (readable canonical JSON) +
-- target_ref_hash BLOB (32-byte SHA-256 over canonical JSON).
-- Partial UNIQUE index on (case_id, target_ref_hash) WHERE active lock ensures
-- one active lock per (case, target).
--
-- Phase 1 SCAFFOLD ONLY: the table ships empty. Write flows
-- (apply/revert/supersede helpers, HITL UX, recompile lock-respect) are
-- Phase 2 per spec §14 L811 amendment.

CREATE TABLE IF NOT EXISTS case_corrections (
  correction_id TEXT PRIMARY KEY,                                           -- UUID
  case_id TEXT NOT NULL REFERENCES case_truth(case_id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('case_field','membership','wiki_section')),
  target_ref_json TEXT NOT NULL,                                            -- canonical JSON (human-readable)
  target_ref_hash BLOB NOT NULL CHECK(length(target_ref_hash) = 32),        -- SHA-256 32 bytes
  field_name TEXT,                                                          -- redundant convenience for target_kind='case_field'
  old_value_json TEXT,                                                      -- snapshot at correction time
  new_value_json TEXT NOT NULL,                                             -- user's intended value
  reason TEXT NOT NULL,
  is_lock_active INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES case_corrections(correction_id),
  reverted_at TEXT,
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_corrections_case_active
  ON case_corrections(case_id, is_lock_active, reverted_at);

-- Partial UNIQUE: at most one active lock per (case_id, target_ref_hash).
-- Reverted or superseded rows do not block new active locks on the same target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_corrections_active_target
  ON case_corrections(case_id, target_ref_hash)
  WHERE is_lock_active = 1 AND reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_corrections_target_kind
  ON case_corrections(case_id, target_kind);


-- ================================================================
-- Phase 1 — case_proposal_queue
-- ================================================================
-- Migration 042: Create case_proposal_queue table
-- Phase 1 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md §5.7
--
-- Acceptance-layer queue for LLM proposals rejected by the deterministic
-- acceptance layer (§4.2). Phase 1 SCAFFOLD + quarantine writes only; HITL
-- resolution UX is Phase 2.
--
-- payload_fingerprint is a SHA-256 (32 bytes) over a STABLE per-kind canonical
-- JSON subset — NOT over the full proposed_payload (full LLM output varies
-- across runs and would defeat dedup). Per-kind subsets live in the
-- acceptance-layer implementation; see spec §5.7 write rules.

CREATE TABLE IF NOT EXISTS case_proposal_queue (
  proposal_id TEXT PRIMARY KEY,                                             -- UUID
  project TEXT NOT NULL,
  proposal_kind TEXT NOT NULL CHECK(proposal_kind IN (
    'ambiguous_slug',
    'duplicate_frontmatter',
    'missing_frontmatter',
    'unknown_case_id',
    'stale_case_id',
    'merged_target',
    'archived_target',
    'lock_conflict',
    'corrupt_frontmatter',
    'quarantined_accepted_case'
  )),
  proposed_payload TEXT NOT NULL,                                           -- JSON: full LLM proposal
  payload_fingerprint BLOB NOT NULL CHECK(length(payload_fingerprint) = 32),
  conflicting_case_id TEXT,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK(resolution IS NULL OR resolution IN ('accepted','rejected','modified','merged')),
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_case_proposal_queue_unresolved
  ON case_proposal_queue(project, resolved_at);
CREATE INDEX IF NOT EXISTS idx_case_proposal_queue_kind
  ON case_proposal_queue(proposal_kind, resolved_at);

-- Composite UNIQUE for idempotent re-detection. COALESCE allows dedup even
-- when conflicting_case_id is NULL (e.g. corrupt_frontmatter).
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_proposal_queue_dedup
  ON case_proposal_queue(
    project,
    proposal_kind,
    COALESCE(conflicting_case_id, ''),
    payload_fingerprint
  )
  WHERE resolved_at IS NULL;


-- ================================================================
-- Phase 1 — wiki_page_search_index
-- ================================================================
-- Migration 043: Wiki page search index for mama_search integration
-- Phase 1 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md §7.1
--
-- Tables: wiki_page_index (metadata), wiki_page_embeddings (vectors),
-- wiki_pages_fts (FTS5 inverted index). FTS5 is REGULAR (not contentless,
-- not external-content) with `page_id UNINDEXED` for app-side hit mapping.
-- Sync triggers use standard INSERT / DELETE+INSERT / DELETE.
--
-- App-layer writes to wiki_page_index MUST NOT use INSERT OR REPLACE
-- (that toggles rowids and leaves FTS pointing at deleted rows). Use
-- INSERT ... ON CONFLICT(page_id) DO UPDATE SET ... so the UPDATE trigger
-- fires and the FTS stays consistent.

CREATE TABLE IF NOT EXISTS wiki_page_index (
  page_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'wiki_page' CHECK(source_type = 'wiki_page'),
  source_locator TEXT NOT NULL,
  case_id TEXT REFERENCES case_truth(case_id),
  title TEXT NOT NULL,
  -- Spec §5.6 enum (original 4 + 'case' added in Phase 1). DB-level CHECK
  -- prevents malformed page_type from entering the search index and later
  -- silently breaking the mama_search roll-up that keys on 'case'.
  page_type TEXT NOT NULL CHECK(page_type IN ('entity','lesson','synthesis','process','case')),
  content TEXT NOT NULL,
  confidence TEXT,
  compiled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_type, source_locator)
);

CREATE TABLE IF NOT EXISTS wiki_page_embeddings (
  page_id TEXT PRIMARY KEY REFERENCES wiki_page_index(page_id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  page_id UNINDEXED,
  title,
  content,
  source_locator
);

-- INSERT trigger: sync new row into FTS.
CREATE TRIGGER IF NOT EXISTS trg_wiki_page_index_ai
AFTER INSERT ON wiki_page_index
BEGIN
  INSERT INTO wiki_pages_fts(page_id, title, content, source_locator)
  VALUES (NEW.page_id, NEW.title, NEW.content, NEW.source_locator);
END;

-- UPDATE trigger: delete-then-insert keeps FTS tokens in sync on edits.
-- Only fires when indexed/stored FTS-adjacent columns change; page_id stays
-- unchanged via the UPSERT contract noted above.
CREATE TRIGGER IF NOT EXISTS trg_wiki_page_index_au
AFTER UPDATE OF title, content, source_locator ON wiki_page_index
BEGIN
  DELETE FROM wiki_pages_fts WHERE page_id = OLD.page_id;
  INSERT INTO wiki_pages_fts(page_id, title, content, source_locator)
  VALUES (NEW.page_id, NEW.title, NEW.content, NEW.source_locator);
END;

-- DELETE trigger: remove all FTS rows for the page.
CREATE TRIGGER IF NOT EXISTS trg_wiki_page_index_ad
AFTER DELETE ON wiki_page_index
BEGIN
  DELETE FROM wiki_pages_fts WHERE page_id = OLD.page_id;
END;


-- ================================================================
-- Phase 2 — entity_timeline_events.role
-- ================================================================
-- Migration 044: Add entity_timeline_events.role
--
-- Phase 2 Task 1 (spec §14 item 11, §4 L105-111): add a nullable `role`
-- column to `entity_timeline_events` so memory-agent role inference
-- (Phase 2 Task 3) can attach a role to each timeline event without
-- constraining downstream consumers. Role is soft-typed per spec §5.1
-- (requester | implementer | reviewer | observer | affected | NULL)
-- — the CHECK enum is intentionally NOT applied so future spec changes
-- don't require another migration.

ALTER TABLE entity_timeline_events ADD COLUMN role TEXT;


-- ================================================================
-- Phase 3 — connector_event_index
-- ================================================================
-- Migration 045: Create connector_event_index and replay-safe connector cursors
-- Phase 3 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md Amendment 9

CREATE TABLE IF NOT EXISTS connector_event_index (
  event_index_id TEXT PRIMARY KEY,
  source_connector TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_locator TEXT,
  channel TEXT,
  author TEXT,
  title TEXT,
  content TEXT NOT NULL,
  event_datetime INTEGER,
  event_date TEXT,
  source_timestamp_ms INTEGER NOT NULL,
  metadata_json TEXT,
  artifact_locator TEXT,
  artifact_title TEXT,
  content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
  indexed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_event_index_source_identity
  ON connector_event_index(source_connector, source_id);

CREATE INDEX IF NOT EXISTS idx_connector_event_index_cursor_order
  ON connector_event_index(source_connector, source_timestamp_ms, source_id);

CREATE INDEX IF NOT EXISTS idx_connector_event_index_event_datetime
  ON connector_event_index(event_datetime, event_index_id);

CREATE INDEX IF NOT EXISTS idx_connector_event_index_event_date
  ON connector_event_index(event_date, event_datetime, event_index_id);

CREATE INDEX IF NOT EXISTS idx_connector_event_index_artifact_locator
  ON connector_event_index(artifact_locator)
  WHERE artifact_locator IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connector_event_index_expires_at
  ON connector_event_index(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS connector_event_index_fts USING fts5(
  event_index_id UNINDEXED,
  title,
  content,
  author,
  channel,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_ai
AFTER INSERT ON connector_event_index
BEGIN
  INSERT INTO connector_event_index_fts(event_index_id, title, content, author, channel)
  VALUES (NEW.event_index_id, NEW.title, NEW.content, NEW.author, NEW.channel);
END;

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_au
AFTER UPDATE OF title, content, author, channel ON connector_event_index
BEGIN
  DELETE FROM connector_event_index_fts WHERE event_index_id = OLD.event_index_id;
  INSERT INTO connector_event_index_fts(event_index_id, title, content, author, channel)
  VALUES (NEW.event_index_id, NEW.title, NEW.content, NEW.author, NEW.channel);
END;

CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_ad
AFTER DELETE ON connector_event_index
BEGIN
  DELETE FROM connector_event_index_fts WHERE event_index_id = OLD.event_index_id;
END;

CREATE TABLE IF NOT EXISTS connector_event_index_cursors (
  connector_name TEXT PRIMARY KEY,
  last_seen_timestamp_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_source_id TEXT NOT NULL DEFAULT '',
  last_sweep_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  indexed_count INTEGER NOT NULL DEFAULT 0
);


-- ================================================================
-- Phase 3 — search_feedback + ranker
-- ================================================================
-- Migration 046: Create search_feedback and ranker_model_versions
-- Phase 3 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md Amendment 10

CREATE TABLE IF NOT EXISTS search_feedback (
  feedback_id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  query_hash BLOB NOT NULL CHECK(length(query_hash) = 32),
  question_type TEXT NOT NULL CHECK(question_type IN (
    'status',
    'timeline',
    'artifact',
    'correction',
    'decision_reason',
    'how_to',
    'unknown'
  )),
  result_source_type TEXT NOT NULL CHECK(result_source_type IN (
    'decision',
    'checkpoint',
    'wiki_page',
    'case',
    'connector_event'
  )),
  result_source_id TEXT NOT NULL,
  case_id TEXT REFERENCES case_truth(case_id),
  feedback_kind TEXT NOT NULL CHECK(feedback_kind IN ('shown','click','accept','reject','hide')),
  rank_position INTEGER NOT NULL CHECK(rank_position >= 0),
  score_before REAL,
  score_after REAL,
  session_id TEXT,
  actor TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_search_feedback_query_hash_created
  ON search_feedback(query_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_feedback_result_created
  ON search_feedback(result_source_type, result_source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_feedback_case_created
  ON search_feedback(case_id, created_at DESC)
  WHERE case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_search_feedback_kind_created
  ON search_feedback(feedback_kind, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_search_feedback_shown_dedupe
  ON search_feedback(session_id, query_hash, result_source_type, result_source_id)
  WHERE feedback_kind = 'shown' AND session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ranker_model_versions (
  model_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  feature_set_version TEXT NOT NULL,
  coefficients_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  training_window_json TEXT NOT NULL,
  baseline_metrics_json TEXT NOT NULL,
  quality_gate_status TEXT NOT NULL CHECK(quality_gate_status IN ('passed','failed','not_run')),
  trained_at TEXT NOT NULL,
  trained_by TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranker_model_versions_single_active
  ON ranker_model_versions(active)
  WHERE active = 1;

CREATE INDEX IF NOT EXISTS idx_ranker_model_versions_trained_at
  ON ranker_model_versions(trained_at DESC);

CREATE INDEX IF NOT EXISTS idx_ranker_model_versions_feature_set
  ON ranker_model_versions(feature_set_version);

CREATE TABLE IF NOT EXISTS search_ranker_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO search_ranker_settings (key, value_json, updated_at)
VALUES ('search_feedback_retention_days', '180', strftime('%Y-%m-%dT%H:%M:%fZ','now'));


-- ================================================================
-- Phase 3 — case_links + tombstones
-- ================================================================
-- Migration 047: Create case_links and revoked wiki tombstones
-- Phase 3 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md Amendment 11

CREATE TABLE IF NOT EXISTS case_links (
  link_id TEXT PRIMARY KEY,
  case_id_from TEXT NOT NULL REFERENCES case_truth(case_id),
  case_id_to TEXT NOT NULL REFERENCES case_truth(case_id),
  link_type TEXT NOT NULL CHECK(link_type IN (
    'related',
    'supersedes-case',
    'subcase-of',
    'blocked-by',
    'duplicate-of'
  )),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason_json TEXT,
  source_kind TEXT NOT NULL DEFAULT 'manual' CHECK(source_kind IN (
    'manual',
    'wiki_compiler',
    'hitl_correction',
    'system_backfill'
  )),
  source_ref TEXT,
  source_ref_fingerprint BLOB CHECK(
    source_ref_fingerprint IS NULL OR length(source_ref_fingerprint) = 32
  ),
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  CHECK(case_id_from <> case_id_to)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_case_links_active_unique
  ON case_links(case_id_from, case_id_to, link_type)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_links_from_active
  ON case_links(case_id_from, created_at DESC, link_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_links_to_active
  ON case_links(case_id_to, created_at DESC, link_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_links_type_active
  ON case_links(link_type, created_at DESC, link_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_links_source_ref_fingerprint
  ON case_links(source_ref_fingerprint)
  WHERE source_ref_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS case_links_revoked_wiki_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  case_id_from TEXT NOT NULL,
  case_id_to TEXT NOT NULL,
  link_type TEXT NOT NULL,
  source_ref_fingerprint BLOB NOT NULL CHECK(length(source_ref_fingerprint) = 32),
  source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoke_reason TEXT NOT NULL,
  unsuppressed_at TEXT,
  unsuppressed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_case_links_wiki_tombstone_active_unique
  ON case_links_revoked_wiki_tombstones(
    case_id_from,
    case_id_to,
    link_type,
    source_ref_fingerprint
  )
  WHERE unsuppressed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_links_wiki_tombstone_source
  ON case_links_revoked_wiki_tombstones(case_id_from, unsuppressed_at);

INSERT OR IGNORE INTO case_links (
  link_id,
  case_id_from,
  case_id_to,
  link_type,
  created_at,
  created_by,
  confidence,
  reason_json,
  source_kind,
  source_ref,
  source_ref_fingerprint,
  revoked_at,
  revoked_by,
  revoke_reason
)
SELECT
  'backfill:canonical:' || case_id,
  case_id,
  canonical_case_id,
  'duplicate-of',
  updated_at,
  'system',
  NULL,
  '{"authority":"case_truth.canonical_case_id"}',
  'system_backfill',
  'case_truth.canonical_case_id',
  NULL,
  NULL,
  NULL,
  NULL
FROM case_truth
WHERE canonical_case_id IS NOT NULL
  AND canonical_case_id <> case_id;

INSERT OR IGNORE INTO case_links (
  link_id,
  case_id_from,
  case_id_to,
  link_type,
  created_at,
  created_by,
  confidence,
  reason_json,
  source_kind,
  source_ref,
  source_ref_fingerprint,
  revoked_at,
  revoked_by,
  revoke_reason
)
SELECT
  'backfill:split:' || case_id,
  case_id,
  split_from_case_id,
  'subcase-of',
  updated_at,
  'system',
  NULL,
  '{"authority":"case_truth.split_from_case_id"}',
  'system_backfill',
  'case_truth.split_from_case_id',
  NULL,
  NULL,
  NULL,
  NULL
FROM case_truth
WHERE split_from_case_id IS NOT NULL
  AND split_from_case_id <> case_id;


-- ================================================================
-- Phase 3 — case_truth promotion + freshness
-- ================================================================
-- Migration 048: Add case promotion and freshness columns
-- Phase 3 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md Amendments 12 + 13

ALTER TABLE case_truth ADD COLUMN canonical_decision_id TEXT;
ALTER TABLE case_truth ADD COLUMN canonical_event_id TEXT;
ALTER TABLE case_truth ADD COLUMN promoted_at TEXT;
ALTER TABLE case_truth ADD COLUMN promoted_by TEXT;
ALTER TABLE case_truth ADD COLUMN promotion_reason TEXT;

ALTER TABLE case_truth ADD COLUMN freshness_score REAL CHECK(
  freshness_score IS NULL OR (freshness_score >= 0 AND freshness_score <= 1)
);
ALTER TABLE case_truth ADD COLUMN freshness_state TEXT CHECK(
  freshness_state IS NULL OR freshness_state IN ('fresh','stale','drifted','unknown')
);
ALTER TABLE case_truth ADD COLUMN freshness_score_is_drifted INTEGER NOT NULL DEFAULT 0 CHECK(
  freshness_score_is_drifted IN (0,1)
);
ALTER TABLE case_truth ADD COLUMN freshness_drift_threshold REAL CHECK(
  freshness_drift_threshold IS NULL OR (
    freshness_drift_threshold >= 0 AND freshness_drift_threshold <= 1
  )
);
ALTER TABLE case_truth ADD COLUMN freshness_checked_at TEXT;
ALTER TABLE case_truth ADD COLUMN freshness_reason_json TEXT;


-- ================================================================
-- Phase 3 — case_memberships explanation columns
-- ================================================================
-- Migration 049: Add case membership explanation columns
-- Phase 3 of MAMA Case-First Memory System
-- Spec: docs/superpowers/specs/2026-04-17-mama-work-case-first-memory-system-design.md Amendment 14

ALTER TABLE case_memberships ADD COLUMN assignment_strategy TEXT;
ALTER TABLE case_memberships ADD COLUMN score_breakdown_json TEXT;
ALTER TABLE case_memberships ADD COLUMN source_locator TEXT;
ALTER TABLE case_memberships ADD COLUMN explanation_updated_at TEXT;


-- ================================================================
-- Final schema_version marker
-- ================================================================
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (30, 'Case-First Memory Substrate consolidated (Phase 1+2+3)');

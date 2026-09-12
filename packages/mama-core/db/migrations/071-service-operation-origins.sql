-- Migration 071: a truthful service/CLI operation can trace itself.
--
-- tool_traces was model-only: model_run_id was NOT NULL with an FK to
-- model_runs, so a host operation could be recorded only by forging a fake
-- model run. This migration relaxes that: model_run_id becomes nullable, and
-- an operation-origin row is anchored instead by a nonempty operation_id and
-- actor_principal_id. A CHECK forbids a row with neither origin. Legacy rows
-- keep their model id and semantics; the model_runs FK is preserved.
--
-- WHY A TABLE REBUILD: dropping the NOT NULL on model_run_id and adding a CHECK
-- cannot be done with ALTER; SQLite requires create/copy/drop/rename. This SQL
-- file rebuilds the canonical (post-068) column set and is what the plain
-- applyAll test path runs. The migration runner special-cases version 71 with a
-- dynamic rebuild that additionally preserves any extra runtime columns/indexes/
-- triggers a live database may carry (see node-sqlite-adapter). Both produce the
-- same canonical shape. The rebuild copies every existing row and re-creates
-- every 033/061/068 index; nothing is dropped.
--
-- GUARD: this canonical-only direct-SQL path can express ONLY the exact pre-071
-- canonical tool_traces (the fresh 033/061/068 chain: 17 columns with fixed
-- types/NOT NULL/DEFAULT/PK, one FK to model_runs, the PK auto-index, and the
-- four 033/068 named indexes). It copies no origin values and carries no
-- triggers, embedded constraints, custom/unique indexes or referencing children
-- across the rebuild. Against anything else it would SILENTLY DROP it (a runtime
-- column, a changed column constraint/default, an embedded CHECK/UNIQUE, an
-- extra outgoing FK, a trigger, a custom/unique index, an already-present
-- operation_id / actor_principal_id value) or CASCADE-delete a referencing child
-- row on the DROP TABLE. Production extended-schema upgrades must instead go
-- through the dynamic adapter path, which preserves all of those verbatim. So
-- this guard fails LOUDLY, before altering any data, on any deviation from the
-- exact canonical pre-071 shape: the CHECK on _migration071_guard aborts the
-- whole script if the CASE evaluates to 0.
--
-- This is a strict canonical-shape precondition (a fingerprint of the known
-- fresh pre-071 chain), NOT a general SQL migration engine and NOT a policy on
-- the production adapter. It enumerates the full canonical column tuples, the
-- single canonical FK, exactly one auto-index (the PK), and rejects embedded
-- CHECK text, triggers, extra explicit indexes, and referencing children.
-- NOTE: the pre-071 canonical shape has NO operation_id/actor_principal_id
-- columns (071 adds them); their presence means a noncanonical source this path
-- cannot faithfully carry.

CREATE TEMP TABLE _migration071_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration071_guard (ok)
SELECT CASE
  -- (1) column count must be exactly the 17 canonical columns (catches an extra
  --     column - including an already-present origin column this path cannot
  --     copy - and a missing column).
  WHEN (SELECT count(*) FROM pragma_table_info('tool_traces')) <> 17 THEN 0
  -- (2) every column must match the canonical (name, type, NOT NULL, DEFAULT, PK)
  --     tuple. Catches a renamed/extra column, a changed column constraint, a
  --     changed default, and an already-present operation_id/actor_principal_id.
  WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('tool_traces') ti
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT 'trace_id' AS cname, 'TEXT' AS ctype, 0 AS cnn, NULL AS cdflt, 1 AS cpk
        UNION ALL SELECT 'model_run_id', 'TEXT', 1, NULL, 0
        UNION ALL SELECT 'gateway_call_id', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'tool_name', 'TEXT', 1, NULL, 0
        UNION ALL SELECT 'input_summary', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'output_summary', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'execution_status', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'duration_ms', 'INTEGER', 0, '0', 0
        UNION ALL SELECT 'envelope_hash', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'created_at', 'INTEGER', 1, NULL, 0
        UNION ALL SELECT 'failure_code', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'diagnostic_json', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'evidence_json', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'catalog_revision', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'owner_scope', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'project_id', 'TEXT', 0, NULL, 0
        UNION ALL SELECT 'channel_id', 'TEXT', 0, NULL, 0
      ) canon
      WHERE canon.cname = ti.name
        AND canon.ctype = ti.type
        AND canon.cnn = ti."notnull"
        AND canon.cpk = ti.pk
        AND ((canon.cdflt IS NULL AND ti.dflt_value IS NULL) OR canon.cdflt = ti.dflt_value)
    )
  ) THEN 0
  -- (3) the outgoing FK set must be exactly the single canonical model_runs FK
  --     (catches an extra or changed outgoing FK).
  WHEN (SELECT count(*) FROM pragma_foreign_key_list('tool_traces')) <> 1 THEN 0
  WHEN NOT EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('tool_traces')
    WHERE "from" = 'model_run_id' AND "table" = 'model_runs' AND "to" = 'model_run_id'
  ) THEN 0
  -- (4) no embedded CHECK constraint. pragma does not expose CHECK, so scan the
  --     stored CREATE TABLE text; the canonical shape carries no CHECK keyword.
  WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'tool_traces' AND instr(upper(sql), 'CHECK') > 0
  ) THEN 0
  -- (5) exactly one auto-index (the trace_id PK). An embedded UNIQUE constraint
  --     (table- or column-level) adds a second sql-IS-NULL auto-index; merely
  --     ignoring sql-IS-NULL auto-indexes would silently drop it on rebuild.
  WHEN (
    SELECT count(*) FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'tool_traces' AND sql IS NULL
  ) <> 1 THEN 0
  -- (6) any trigger on tool_traces (DROP/RENAME would not carry it).
  WHEN EXISTS (
    SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tool_traces'
  ) THEN 0
  -- (7) any non-canonical explicit index on tool_traces (a user/unique index
  --     with its own CREATE statement this path does not recreate).
  WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'tool_traces' AND sql IS NOT NULL
    AND name NOT IN (
      'idx_tool_traces_model_run_id', 'idx_tool_traces_gateway_call_id',
      'idx_tool_traces_scope_recency', 'idx_tool_traces_channel_recency'
    )
  ) THEN 0
  -- (8) any table that references tool_traces - the DROP TABLE below would
  --     CASCADE-delete its rows. Detected via the per-table FK list.
  WHEN EXISTS (
    SELECT 1 FROM sqlite_master m
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> 'tool_traces'
    AND EXISTS (
      SELECT 1 FROM pragma_foreign_key_list(m.name) fk WHERE fk."table" = 'tool_traces'
    )
  ) THEN 0
  ELSE 1
END;
DROP TABLE _migration071_guard;

CREATE TABLE tool_traces_071_new (
  trace_id TEXT PRIMARY KEY,
  model_run_id TEXT,
  gateway_call_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  execution_status TEXT,
  duration_ms INTEGER DEFAULT 0,
  envelope_hash TEXT,
  created_at INTEGER NOT NULL,
  failure_code TEXT,
  diagnostic_json TEXT,
  evidence_json TEXT,
  catalog_revision TEXT,
  owner_scope TEXT,
  project_id TEXT,
  channel_id TEXT,
  operation_id TEXT,
  actor_principal_id TEXT,
  CHECK (
    (model_run_id IS NOT NULL AND operation_id IS NULL AND actor_principal_id IS NULL)
    OR (
      operation_id IS NOT NULL AND length(trim(operation_id)) > 0
      AND actor_principal_id IS NOT NULL AND length(trim(actor_principal_id)) > 0
    )
  ),
  FOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)
);

INSERT INTO tool_traces_071_new (
  trace_id, model_run_id, gateway_call_id, tool_name, input_summary, output_summary,
  execution_status, duration_ms, envelope_hash, created_at, failure_code,
  diagnostic_json, evidence_json, catalog_revision, owner_scope, project_id, channel_id
)
SELECT
  trace_id, model_run_id, gateway_call_id, tool_name, input_summary, output_summary,
  execution_status, duration_ms, envelope_hash, created_at, failure_code,
  diagnostic_json, evidence_json, catalog_revision, owner_scope, project_id, channel_id
FROM tool_traces;

DROP TABLE tool_traces;
ALTER TABLE tool_traces_071_new RENAME TO tool_traces;

CREATE INDEX IF NOT EXISTS idx_tool_traces_model_run_id
  ON tool_traces(model_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_traces_gateway_call_id
  ON tool_traces(gateway_call_id);
CREATE INDEX IF NOT EXISTS idx_tool_traces_scope_recency
  ON tool_traces(owner_scope, project_id, created_at DESC, trace_id DESC);
CREATE INDEX IF NOT EXISTS idx_tool_traces_channel_recency
  ON tool_traces(owner_scope, project_id, channel_id, created_at DESC, trace_id DESC);
CREATE INDEX IF NOT EXISTS idx_tool_traces_operation_id
  ON tool_traces(operation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_traces_actor_principal
  ON tool_traces(actor_principal_id, created_at DESC);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (71, 'Service operation-origin tool traces');

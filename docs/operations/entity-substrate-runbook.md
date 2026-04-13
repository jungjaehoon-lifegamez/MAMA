# Entity Substrate Runbook

## Overview

The canonical entity substrate is MAMA's ontology-guided identity layer. It
ingests raw operational evidence (Slack, etc.), produces multilingual
`entity_observations`, ranks `entity_resolution_candidates`, routes ambiguous
candidates into a review queue, and projects canonical entities into recall
via `recall-bridge.ts` (never into `memory_truth` directly — see
`MAMA_ENTITY_PROJECTION_MODE`).

Operators interact with this layer when the review queue grows, when an
audit run regresses on `false_merge_rate`, or when a connector path stops
producing observations. Start here, then reach for the table rows in
`packages/mama-core/db/migrations/026-create-canonical-entity-tables.sql`,
`027-create-entity-review-support.sql`, and
`028-create-entity-audit-tables.sql` for the schema of record.

## Projection Mode Flag

`MAMA_ENTITY_PROJECTION_MODE` is read from the environment and standalone
config.

- **off** — entity substrate is fully inert. Recall falls back to the legacy
  topic path. Use this during incident response after a `regressed` audit.
- **shadow** (default in v1) — writes land in entity tables, but
  `recallMemory()` does not consume them. Legacy recall is unaffected.
- **dual-write** — `recallMemory()` additionally calls
  `queryCanonicalEntities()` from `recall-bridge.ts` so canonical projections
  appear alongside legacy recall hits.

Read the current value with `echo $MAMA_ENTITY_PROJECTION_MODE` or via the
standalone config dump. Toggling requires a standalone restart.

## Common Failure Modes

### #embedding-unavailable

Symptom: `EmbeddingUnavailableError` in logs during candidate generation.
Cause: embedding server (port 3847) is down or the model file is missing.

Fix:

1. `curl http://localhost:3847/health`
2. If unhealthy: `mama stop && mama start`
3. Candidates in `pending` status will be rescored on the next audit run —
   no manual recovery required.

### #invalid-label

Symptom: `InvalidEntityLabelError` in logs during Slack ingest.
Cause: a raw Slack message had nullish text or unexpected non-string
content.

Fix: pull the offending raw row from
`~/.mama/connectors/slack/raw.db` using the `source_raw_record_id` from the
error context. Either fix the extractor to tolerate that raw shape, or add a
skip rule to the history extractor.

### #ontology-violation

Symptom: `OntologyViolationError` in logs during resolution.
Cause: a merge was attempted between two entities with incompatible `kind`
values (e.g. `project` + `person`).

Fix: inspect the candidate via `GET /api/entities/candidates/:id` and reject
it from the review queue. The resolution engine should have refused the
auto-merge — if it didn't, that's a ranking regression worth opening an
issue for.

### #merge-target-stale

Symptom: `MergeTargetStaleError` during replay.
Cause: a merge was computed against an entity that has since been archived
or itself merged into another node.

Fix: re-run candidate generation for the affected scope. The resolution
engine will recompute merges against the latest state.

### #label-missing

Symptom: `EntityLabelMissingError` during projection.
Cause: a canonical entity reached the projection path with a null or empty
`preferred_label`.

Fix: set a non-empty label on the offending entity row before retrying the
projection.

### #candidate-stale

Symptom: 409 from `/api/entities/candidates/:id/approve` (or `/reject` or
`/defer`).
Cause: two reviewers resolved the same candidate concurrently.

Fix: refetch the candidate via `GET /api/entities/candidates/:id`. The
resolved action wins. This is the race-safety mechanism, not a bug.

### #audit-run-in-progress

Symptom: 409 from `POST /api/entities/audit/run`, or the partial unique
index `entity_audit_runs_single_running` rejects a second running insert.
Cause: another audit run is active.

Fix: wait for completion via `GET /api/entities/audit/runs`. If a run is
stuck in `running` after a standalone restart, the
`EntityAuditRunQueue.recoverOrphans()` path should mark it `failed` on
boot. If that did not fire, manually:

```sql
UPDATE entity_audit_runs
SET status = 'failed', reason = 'manual_recovery', completed_at = strftime('%s','now') * 1000
WHERE status = 'running';
```

### #false-merge-spike

Symptom: latest audit run classification = `regressed` with
`false_merge_rate > 0.02`.

Fix (disable auto-merge, investigate, restore):

1. `export MAMA_ENTITY_PROJECTION_MODE=off` to stop propagation
2. Read findings: `curl /api/entities/audit/runs/$LATEST_ID | jq .findings`
3. Identify false-merge examples, roll them back via `entity_merge_actions`
4. Re-run audit to confirm `false_merge_rate` drops under 0.02
5. Restore `MAMA_ENTITY_PROJECTION_MODE=shadow` (or `dual-write`)

### #candidate-backlog

Symptom: `pending` candidate count growing unbounded.

Fix: check `ENTITY_EMBEDDING_TOPN` (should be 50 — see
`packages/mama-core/src/entities/candidate-generator.ts`). Review the
blocking rules for overly-permissive `normalized_form` matches. Consider a
stricter structured-identifier block (email/handle/domain) for the scope.

### #entity-merge-timeline

How to read `entity_merge_actions` for an entity's history:

```sql
SELECT created_at, action_type, actor_id, reason
FROM entity_merge_actions
WHERE source_entity_id = ? OR target_entity_id = ?
ORDER BY created_at;
```

## Rollback Procedure (branch-level)

`MAMA_ENTITY_PROJECTION_MODE=off` disables projection reads and writes.
Migrations 026, 027, and 028 are append-only, so leaving data in place is
safe. No migration reversal is required. If a full rollback is desired,
drop the tables in reverse order: `entity_audit_findings`,
`entity_audit_metrics`, `entity_audit_runs`, `entity_merge_actions`,
`entity_resolution_candidates`, `entity_timeline_events`, `entity_links`,
`entity_observations`, `entity_aliases`, `entity_nodes`.

## Observability Counters

The entity substrate emits the following counters to the standard MAMA
instrumentation sink (or stdout if no sink is configured):

- `entity.candidates.generated`
- `entity.candidates.auto_merged`
- `entity.candidates.reviewed`
- `entity.projection.writes`
- `entity.audit.runs`
- `entity.audit.false_merge_rate`

## os-agent Consumption Boundary

After this branch lands, os-agent can assume:

- canonical `entity_nodes`, `entity_aliases`, and `entity_observations` exist
- Slack observations are backfilled with preserved source provenance
- `queryCanonicalEntities()` is available under `dual-write` mode

os-agent must NOT yet assume:

- wiki/dashboard projection writes are flowing
- cross-language auto-merge is enabled (review queue is the only path)
- multi-connector backfill is complete (Slack only in v1)
- stable audit baselines exist for metrics other than `false_merge_rate`
  on the gold canonical identity fixture

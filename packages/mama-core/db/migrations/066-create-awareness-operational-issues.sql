-- 066: awareness_operational_issues (One MAMA Phase 3 Task 2).
--
-- Failures become first-class evidence: gateway tool failures, envelope scope
-- mismatches, dead owner-event batches and ledger stagnation are recorded here,
-- aggregated by (surface, signature), and read into every packet so the agent
-- sees its own failures. The shape below is the exact shape the owner's
-- installed database already carries from the retired 043-060 chain, plus
-- `occurrences`. A fresh install gets the whole table here; an installed table
-- WITHOUT `occurrences` gets the column added at runtime (pragma-guarded ALTER
-- in packages/standalone/src/observability/operational-issues.ts), because
-- SQLite has no ADD COLUMN IF NOT EXISTS and this chain is plain SQL.
--
-- `status` carries no CHECK on purpose: the installed column has none, and a
-- CHECK would force a table rebuild for no gain. Values used: open,
-- repair_requested, closed - validated in TypeScript.
CREATE TABLE IF NOT EXISTS awareness_operational_issues (
  issue_id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  surface TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  source_delta_id TEXT,
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  next_retry_at INTEGER,
  last_error TEXT,
  owner_agent TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_awareness_operational_issues_status_seen
  ON awareness_operational_issues(status, last_seen_at DESC);

-- Migration 061: tool_traces.failure_code — carry the thrower's closed cause.
--
-- WHY 061, NOT 043: live DBs carry schema_version rows 44-60 from a RETIRED
-- 2026-05/06 migration chain that shared this ledger table. The runner skips
-- any file numbered at or below MAX(version), so this migration shipped as
-- 043 in core 2.1.0 and silently never applied anywhere the retired chain
-- had run. New core migrations must number ABOVE that ceiling (60) - the
-- migration-chain test pins the jump so nobody "fixes" the gap back into
-- the dead zone.
--
-- The failure choke already emits a structured code (envelope_missing,
-- context_compile_scope_denied, ...) and the sanitizer explicitly preserves
-- it; the trace INSERT was the one place that dropped it, leaving only
-- `gateway_tool_failed;sha256=...` digests (measured 2026-07-30: the dominant
-- digest covered 52% of 2,460 context_compile failures with no name).
-- Nullable on purpose: a failure without a code stays NULL — labels are
-- carried, never invented.

ALTER TABLE tool_traces ADD COLUMN failure_code TEXT;

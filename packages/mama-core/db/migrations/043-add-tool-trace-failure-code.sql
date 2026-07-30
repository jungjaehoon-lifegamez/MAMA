-- Migration 043: tool_traces.failure_code — carry the thrower's closed cause.
--
-- The failure choke already emits a structured code (envelope_missing,
-- context_compile_scope_denied, ...) and the sanitizer explicitly preserves
-- it; the trace INSERT was the one place that dropped it, leaving only
-- `gateway_tool_failed;sha256=...` digests (measured 2026-07-30: the dominant
-- digest covered 52% of 2,460 context_compile failures with no name).
-- Nullable on purpose: a failure without a code stays NULL — labels are
-- carried, never invented.

ALTER TABLE tool_traces ADD COLUMN failure_code TEXT;

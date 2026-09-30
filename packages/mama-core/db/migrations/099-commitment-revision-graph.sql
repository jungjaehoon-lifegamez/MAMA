-- 099 once backfilled a host builds_on from each commitment revision to the one before it. The
-- host no longer writes edges the agent did not state (owner, 2026-09-30); the order of revisions
-- lives in commitment_assignments. The version is kept so databases that crossed it stay aligned.
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (99, 'Commitment revision graph links');

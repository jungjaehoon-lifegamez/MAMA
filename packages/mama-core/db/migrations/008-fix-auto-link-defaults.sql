-- Migration: 008-fix-auto-link-defaults.sql
-- Description: Fix auto-generated links and update default values
-- Date: 2025-11-25
--
-- Problem: Migration 006 set incorrect defaults:
--   - created_by DEFAULT 'user' (should be 'llm' for auto-generated)
--   - approved_by_user DEFAULT 1 (should be 0 for pending approval)
--
-- This caused auto-generated links to be indistinguishable from user-approved links.
--
-- Solution:
-- 1. Identify auto-generated links by pattern matching reason field
-- 2. Mark them as created_by='llm', approved_by_user=0
-- 3. Note: Cannot change column defaults in SQLite, so application code must handle this

-- Step 1: Mark auto-generated links (identifiable by pattern in reason field)
-- Pattern: "Refines previous approach (similarity: X.XX)" or similar auto-generated reasons
UPDATE decision_edges
SET
  created_by = 'llm',
  approved_by_user = 0
WHERE reason LIKE '%similarity:%'
   OR reason LIKE '%Refines previous approach%'
   OR reason LIKE '%auto%'
   OR reason LIKE '%Auto%';

-- Step 2: Log the migration action
INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
SELECT
  from_id,
  to_id,
  relationship,
  'deprecated',
  'system',
  'Migration 008: Marked as auto-generated link requiring approval',
  unixepoch()
FROM decision_edges
WHERE created_by = 'llm' AND approved_by_user = 0;

-- Note: After this migration:
-- - Auto-generated links will require explicit approval via approve_link tool
-- - Users can review pending links with get_pending_links tool
-- - New auto-generated links should set created_by='llm', approved_by_user=0

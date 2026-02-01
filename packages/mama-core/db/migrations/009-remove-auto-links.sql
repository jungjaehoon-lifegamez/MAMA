-- Migration: 009-remove-auto-links.sql
-- Description: Remove all auto-generated links (noise cleanup)
-- Date: 2025-11-25
--
-- Context: 2025-11-25 architecture decision
-- - Analyzed 462 links: 366 refines (100% cross-topic noise), 56 supersedes (valid), 40 contradicts (mostly noise)
-- - Key insight: LLM can infer decision evolution from time-ordered search results
-- - Auto-link generation removed from decision-tracker.js
-- - MCP tools consolidated from 11 to 4 (save, search, update, load_checkpoint)
--
-- This migration removes:
-- 1. All 'refines' links (100% cross-topic noise)
-- 2. All 'contradicts' links (unreliable without LLM judgment)
-- 3. Keeps 'supersedes' links (same-topic, reliable)

-- Step 1: Backup to audit log before deletion
INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
SELECT
  from_id,
  to_id,
  relationship,
  'deprecated',
  'system',
  'Migration 009: Removed auto-generated noise links (refines, contradicts)',
  unixepoch() * 1000
FROM decision_edges
WHERE relationship IN ('refines', 'contradicts');

-- Step 2: Delete noise links
DELETE FROM decision_edges
WHERE relationship IN ('refines', 'contradicts');

-- Step 3: Verify remaining links are valid (supersedes only)
-- This is a sanity check - should only have supersedes links remaining
-- SELECT relationship, COUNT(*) FROM decision_edges GROUP BY relationship;

-- Note: After this migration:
-- - Only 'supersedes' edges remain (same-topic, created when decision replaces previous)
-- - LLM will infer refines/contradicts from search results
-- - No more auto-link generation in decision-tracker.js

-- Migration: 006-add-link-governance.sql
-- Description: Add governance fields to decision_edges for Epic 3
-- Date: 2025-11-24

-- Add governance metadata to decision_edges
ALTER TABLE decision_edges ADD COLUMN created_by TEXT DEFAULT 'user' CHECK (created_by IN ('llm', 'user'));
ALTER TABLE decision_edges ADD COLUMN approved_by_user INTEGER DEFAULT 1 CHECK (approved_by_user IN (0, 1));
ALTER TABLE decision_edges ADD COLUMN decision_id TEXT; -- Context decision where link was proposed
ALTER TABLE decision_edges ADD COLUMN evidence TEXT; -- Supporting evidence for the link
ALTER TABLE decision_edges ADD COLUMN approved_at INTEGER; -- Timestamp when link was approved (NULL for pending)

-- Create audit log table for link approval/rejection history
CREATE TABLE IF NOT EXISTS link_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('proposed', 'approved', 'rejected', 'deprecated')),
  actor TEXT NOT NULL, -- 'llm', 'user', 'system'
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000),

  FOREIGN KEY (from_id) REFERENCES decisions(id),
  FOREIGN KEY (to_id) REFERENCES decisions(id)
);

CREATE INDEX idx_link_audit_from ON link_audit_log(from_id);
CREATE INDEX idx_link_audit_to ON link_audit_log(to_id);
CREATE INDEX idx_link_audit_action ON link_audit_log(action);
CREATE INDEX idx_link_audit_created ON link_audit_log(created_at);

-- Note: Existing links (created before this migration) will have:
-- - created_by = 'user' (default)
-- - approved_by_user = 1 (default - considered approved)
-- - approved_at = created_at (for backward compatibility)
-- This preserves backward compatibility with v0 auto-generated links

-- Set approved_at for existing approved links (backward compatibility)
UPDATE decision_edges
SET approved_at = created_at
WHERE approved_by_user = 1 AND approved_at IS NULL;

-- Add is_static column for user profile (long-term preferences vs current work)
ALTER TABLE decisions ADD COLUMN is_static INTEGER DEFAULT 0;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (14, 'Add is_static column for user profile preferences');

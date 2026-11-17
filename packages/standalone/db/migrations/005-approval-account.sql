-- The account a proposed write posts as, read when it was proposed and shown on its card
-- (approvals.md, P1). The run posts only if the same account still holds the credential: a card
-- must not run as someone it did not name. Null for writes that name no account.
ALTER TABLE approval_proposals ADD COLUMN account_id TEXT;

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 5, 'Approval proposals keep the account they post as');

# MAMA v0 to v1.1 Migration Guide

This document describes the safe migration procedure from MAMA v0 to v1.1.

---

## Overview

### Migration Purpose

v1.1 introduces a new **Link Governance** policy:

| Item              | v0                             | v1.1                                            |
| ----------------- | ------------------------------ | ----------------------------------------------- |
| **Link creation** | Auto-generated (LLM inference) | LLM proposal + user approval                    |
| **Metadata**      | None (NULL)                    | `created_by`, `approved_by_user`, `decision_id` |
| **Auto-links**    | ~85% noise                     | Deleted/deprecated to <5%                       |

### Migration Summary

1. **Backup** - DB and config file backup
2. **Scan** - Identify auto-link candidates
3. **Delete** - Deprecate/delete auto-links
4. **Verify** - Confirm migration results
5. **Test** - Validate service functionality

**Estimated duration:** 1-2 minutes (including downtime)

---

## Prerequisites

- MAMA v0 installed
- Node.js >= 18.0.0
- pnpm >= 8.0.0
- DB file access permissions

---

## Migration Checklist

### Phase 1: Backup (Required)

```markdown
- [ ] Step 1.1: DB file backup
- [ ] Step 1.2: Config file backup
- [ ] Step 1.3: Backup verification
```

### Phase 2: Auto-Link Scan

```markdown
- [ ] Step 2.1: Run migration script (dry-run)
- [ ] Step 2.2: Review candidate list
- [ ] Step 2.3: Verify protected links
```

### Phase 3: Deprecation/Deletion Execution

```markdown
- [ ] Step 3.1: Execute deprecation/deletion
- [ ] Step 3.2: Check audit log
- [ ] Step 3.3: Review execution results
```

### Phase 4: Verification

```markdown
- [ ] Step 4.1: Check auto-link residual rate (target: <5%)
- [ ] Step 4.2: Confirm approved links preserved (0 loss)
- [ ] Step 4.3: Check metadata coverage
```

### Phase 5: Service Verification

```markdown
- [ ] Step 5.1: Restart MCP server
- [ ] Step 5.2: Test plugin connection
- [ ] Step 5.3: Verify functionality
- [ ] Step 5.4: Check performance metrics
- [ ] Step 5.5: Review error logs
```

---

## Detailed Procedures

### Phase 1: Backup

#### Step 1.1: DB File Backup

```bash
# Default DB path
DB_PATH=~/.claude/mama-memory.db

# Create backup directory
mkdir -p ~/.claude/backups

# Backup with timestamp
cp "$DB_PATH" ~/.claude/backups/mama-memory.db.backup.$(date +%Y%m%d%H%M%S)

# Or use script (recommended)
node scripts/backup-db.js
```

**Example output:**

```
✓ Backup created: ~/.claude/backups/mama-memory.db.backup.20251125143000
✓ File size: 15.2 MB
✓ Checksum: a1b2c3d4...
```

#### Step 1.2: Config File Backup

```bash
# Backup environment config
cp .env .env.backup.$(date +%Y%m%d)

# Backup plugin config (if exists)
cp ~/.claude/plugins/mama/config.json ~/.claude/backups/mama-config.json.backup
```

#### Step 1.3: Backup Verification

```bash
# Verify backup file exists
ls -la ~/.claude/backups/mama-memory.db.backup.*

# Verify file size (should match original)
du -h ~/.claude/mama-memory.db
du -h ~/.claude/backups/mama-memory.db.backup.*
```

---

### Phase 2: Auto-Link Scan

#### Step 2.1: Dry-run Execution

```bash
# Output candidates without actual deletion
node scripts/deprecate-auto-links.js --dry-run
```

**Example output:**

```
🔍 Scanning for auto-generated links...

📊 Scan Results:
  Total links: 1000
  Auto-generated links: 850 (85%)
  Protected links: 150 (approved_by_user=true)

📋 Auto-link candidates (first 10):
  - link_001: decision_auth_v1 → decision_db_v1 (refines)
  - link_002: decision_api_v1 → decision_cache_v1 (contradicts)
  ...

⚠️ DRY RUN - No changes made
```

#### Step 2.2: Review Candidate List

Criteria for auto-link identification:

| Condition                           | Description            |
| ----------------------------------- | ---------------------- |
| `created_by` IS NULL                | v0 links (no metadata) |
| `approved_by_user` IS NULL OR FALSE | No user approval       |
| `decision_id` IS NULL               | No supporting decision |
| `reason` IS NULL OR LEN < 20        | No or generic reason   |

#### Step 2.3: Verify Protected Links

**Links that will NOT be deleted (protected):**

| Condition                                               | Description              |
| ------------------------------------------------------- | ------------------------ |
| `approved_by_user` = TRUE                               | Explicitly user-approved |
| `created_by` = 'user'                                   | User-created directly    |
| `decision_id` IS NOT NULL AND `approved_by_user` = TRUE | LLM proposal + approved  |

---

### Phase 3: Deprecation/Deletion Execution

#### Step 3.1: Execute Deletion

```bash
# Hard delete (recommended)
node scripts/deprecate-auto-links.js --mode delete

# Or soft delete (flag only)
node scripts/deprecate-auto-links.js --mode deprecate
```

**Example output:**

```
🚀 Executing link cleanup...

📊 Execution Results:
  Links deleted: 850
  Links preserved: 150
  Errors: 0

📝 Audit log saved: ~/.claude/migration-audit.log
```

#### Step 3.2: Check Audit Log

```bash
# Review audit log
tail -20 ~/.claude/migration-audit.log
```

**Log format:**

```json
{
  "operation": "delete",
  "link_id": "link_001",
  "from_decision_id": "decision_auth_v1",
  "to_decision_id": "decision_db_v1",
  "reason": "Auto-generated link without approval",
  "timestamp": "2025-11-25T14:30:00.000Z",
  "executed_by": "system"
}
```

#### Step 3.3: Review Execution Results

Verify deletion completed successfully:

```bash
# Check remaining link count
sqlite3 ~/.claude/mama-memory.db "SELECT COUNT(*) FROM links;"

# Check auto-link residual count
sqlite3 ~/.claude/mama-memory.db "SELECT COUNT(*) FROM links WHERE approved_by_user IS NULL OR approved_by_user = 0;"
```

---

### Phase 4: Verification

#### Step 4.1: Check Residual Rate

```bash
# Run verification script
node scripts/verify-migration.js
```

**Example output:**

```
✓ Auto-link residual rate: 3.2% (target: <5%)
✓ Approved links preserved: 150/150 (100%)
✓ Metadata coverage: 98%

🎉 Migration verification PASSED
```

**Target criteria:**

- Auto-link residual rate: **<5%**
- Approved link loss: **0**
- Metadata coverage: **>90%**

#### Step 4.2: Verify Approved Links Preserved

```bash
# Check approved link count (should match pre-migration)
sqlite3 ~/.claude/mama-memory.db "SELECT COUNT(*) FROM links WHERE approved_by_user = 1;"
```

#### Step 4.3: Check Metadata Coverage

```bash
# Check ratio of links with metadata
sqlite3 ~/.claude/mama-memory.db "
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN created_by IS NOT NULL THEN 1 ELSE 0 END) AS with_metadata,
  ROUND(100.0 * SUM(CASE WHEN created_by IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS coverage_pct
FROM links;
"
```

---

### Phase 5: Service Verification

#### Step 5.1: Restart MCP Server

```bash
# Kill existing server process (if any)
pkill -f mama-server

# Start server
pnpm -C packages/mcp-server start
```

**Expected output:**

```
MCP server started on stdio
```

#### Step 5.2: Test Plugin Connection

Run in Claude Code:

```bash
# Basic command test
/mama:mama-list --limit=5
```

**Expected output:**

```
📋 Recent Decisions (5):
1. auth_strategy - JWT with refresh tokens (2025-11-25)
2. database_choice - PostgreSQL for main DB (2025-11-24)
...
```

#### Step 5.3: Verify Functionality

```bash
# Save decision test
/mama:mama-save <topic> "Migration test" "Testing v1.1 functionality"

# Search test
/mama:mama-recall <topic>

# Suggest test
/mama:mama-suggest "How should I handle authentication?"

# Checkpoint test
/mama:mama-checkpoint
/mama:mama-resume
```

#### Step 5.4: Check Performance Metrics

```bash
# Check response latency (target: p95 < 2.5s)
# From logs:
grep "Response time" logs/mama-server.log | tail -10
```

**Performance targets:**

- p50: < 1.0s
- p95: < 2.5s
- p99: < 5.0s

#### Step 5.5: Review Error Logs

```bash
# Check for critical/error level logs
grep -E "ERROR|CRITICAL" logs/mama-server.log | tail -20

# Empty output = success
```

---

## Rollback Procedures

Follow these procedures if migration fails or issues occur.

### Rollback Scenarios

| Scenario                  | Description                         | Action                        |
| ------------------------- | ----------------------------------- | ----------------------------- |
| **Migration interrupted** | Error during script execution       | Restore from backup           |
| **Verification failed**   | Residual rate exceeded or link loss | Downgrade to previous version |
| **Data corruption**       | Service malfunction                 | Restore backup + re-migrate   |

### Rollback Step 1: Restore from Backup

```bash
# Find latest backup file
ls -lt ~/.claude/backups/mama-memory.db.backup.*

# Restore from backup
cp ~/.claude/backups/mama-memory.db.backup.20251125143000 ~/.claude/mama-memory.db

# Restore environment config
cp .env.backup .env
```

### Rollback Step 2: Downgrade to Previous Version (if needed)

```bash
# Downgrade npm package
cd packages/mcp-server
npm install @jungjaehoon/mama-server@1.0.2

# Reinstall plugin
/plugin uninstall mama
/plugin install mama
```

### Rollback Step 3: Restart Service

```bash
# Restart server
pnpm -C packages/mcp-server start

# Test functionality
/mama:mama-list --limit=5
```

### Rollback Step 4: Verify Restoration

```bash
# Check data integrity
node scripts/verify-migration.js

# Test functionality
/mama:mama-save rollback_test "Rollback verification" "Testing after rollback"
/mama:mama-recall rollback_test
```

---

## Troubleshooting

### Script Execution Error

```bash
# Check Node version
node --version  # >= 18.0.0

# Reinstall dependencies
pnpm install

# Check script permissions
chmod +x scripts/*.js
```

### DB Access Error

```bash
# Check DB file permissions
ls -la ~/.claude/mama-memory.db

# Check DB integrity
sqlite3 ~/.claude/mama-memory.db "PRAGMA integrity_check;"
```

### Verification Failure

```bash
# Manual re-execution
node scripts/deprecate-auto-links.js --dry-run  # Check status
node scripts/deprecate-auto-links.js --mode delete  # Re-execute
node scripts/verify-migration.js  # Re-verify
```

### Performance Degradation

```bash
# Rebuild indexes
sqlite3 ~/.claude/mama-memory.db "REINDEX;"

# Run VACUUM (reclaim disk space)
sqlite3 ~/.claude/mama-memory.db "VACUUM;"
```

---

## Important Notes

1. **Backup is mandatory**: Always backup before migration
2. **Expect downtime**: Service will be interrupted during migration (1-2 min)
3. **Single user**: Block DB access from other processes during migration
4. **Verification is mandatory**: Always run verification script after deletion
5. **Prepare rollback**: Remember backup file location for immediate rollback if needed

---

## Post-Migration Checklist

Verify the following after successful migration:

```markdown
- [ ] Auto-link residual rate < 5%
- [ ] Approved links 100% preserved
- [ ] All slash commands working
- [ ] Checkpoint/resume functionality working
- [ ] No error logs
- [ ] Performance targets met (p95 < 2.5s)
```

---

## Related Documentation

- [Deployment Guide](./deployment.md)
- [Troubleshooting](./troubleshooting.md)
- [Epic 5 Technical Specification](../../.docs/sprint-artifacts/tech-spec-epic-5.md)
- [Link Governance Policy](../reference/mcp-protocol-spec.md)

---

_Last Updated: 2025-11-25_

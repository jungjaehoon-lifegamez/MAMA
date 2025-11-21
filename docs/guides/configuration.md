# Configuration Guide

**FR Reference:** [FR50-55 (Configuration)](../reference/fr-mapping.md)

This guide covers all configuration options for MAMA plugin, including hooks, embedding models, performance tuning, and privacy settings.

---

## Quick Reference

| Setting | Environment Variable | Config File | Default |
|---------|---------------------|-------------|---------|
| Disable Hooks | `MAMA_DISABLE_HOOKS=true` | `disable_hooks: true` | `false` |
| Embedding Model | - | `embedding_model` | `Xenova/multilingual-e5-small` |
| Database Path | `MAMA_DB_PATH` | `db_path` | `~/.claude/mama-memory.db` |
| Search Limit | - | `search_limit` | `10` |

---

## Configuration File Location

MAMA uses a JSON configuration file at:

```
~/.mama/config.json
```

**Example configuration:**

```json
{
  "disable_hooks": false,
  "embedding_model": "Xenova/multilingual-e5-small",
  "db_path": "~/.claude/mama-memory.db",
  "search_limit": 10,
  "debug": false
}
```

---

## Disable Hooks (Privacy Mode)

**FR Reference:** [FR45-49 (Privacy & Security)](../reference/fr-mapping.md)

### Option 1: Environment Variable

```bash
export MAMA_DISABLE_HOOKS=true
```

### Option 2: Config File

```json
{
  "disable_hooks": true
}
```

### Use Cases

- **🔒 Privacy Mode:** When you want complete manual control over what gets saved
- **🐛 Debug Mode:** When debugging without hook interference
- **🚀 Performance Testing:** When measuring pure performance without hooks

**Note:** When hooks are disabled, you must manually use `/mama-save` to record decisions.

---

## Change Embedding Model

**FR Reference:** [FR8-12 (Semantic Search)](../reference/fr-mapping.md)

### Via Command

```bash
/mama-configure --model Xenova/all-MiniLM-L6-v2
```

### Via Config File

```json
{
  "embedding_model": "Xenova/gte-large"
}
```

### Recommended Models

| Model | Size | Speed | Accuracy | Best For |
|-------|------|-------|----------|----------|
| `Xenova/multilingual-e5-small` | 120MB | Medium | 80% | Korean + English (default) |
| `Xenova/all-MiniLM-L6-v2` | 90MB | Fast | 75% | English-only, fast search |
| `Xenova/gte-large` | 200MB | Slow | 85% | High precision requirements |

### Model Selection Guide

**Choose `multilingual-e5-small` if:**
- You use both Korean and English
- You need balanced speed and accuracy
- 120MB model size is acceptable

**Choose `all-MiniLM-L6-v2` if:**
- You only use English
- You prioritize speed over accuracy
- You have limited disk space

**Choose `gte-large` if:**
- You need maximum accuracy
- Speed is not a priority
- You have sufficient disk space (200MB)

---

## Database Configuration

### Change Database Path

**Environment variable:**

```bash
export MAMA_DB_PATH=/custom/path/mama-memory.db
```

**Config file:**

```json
{
  "db_path": "/custom/path/mama-memory.db"
}
```

### Database Backup

MAMA uses SQLite. To back up your decisions:

```bash
# Backup
cp ~/.claude/mama-memory.db ~/backups/mama-memory-$(date +%Y%m%d).db

# Restore
cp ~/backups/mama-memory-20250121.db ~/.claude/mama-memory.db
```

---

## Performance Configuration

### Search Result Limit

Control how many results are returned:

```json
{
  "search_limit": 20
}
```

**Default:** 10 results

**Trade-offs:**
- Higher limit: More comprehensive results, slower
- Lower limit: Faster queries, may miss relevant items

### Recency Tuning

**FR Reference:** [FR13-18 (Decision Evolution)](../reference/fr-mapping.md)

Configure recency scoring behavior:

```json
{
  "recency_weight": 0.3,
  "recency_scale": 7,
  "recency_decay": 0.5
}
```

**Parameters:**
- `recency_weight`: How much to favor recent items (0-1, default 0.3)
- `recency_scale`: Days until recency boost decays (default 7)
- `recency_decay`: Score at scale point (0-1, default 0.5)

**See also:** [Performance Tuning Guide](performance-tuning.md)

---

## Debug Mode

Enable verbose logging for troubleshooting:

```json
{
  "debug": true
}
```

**Output:** Logs will appear in Claude Code's debug console.

**Note:** Debug mode may impact performance. Use only for troubleshooting.

---

## Hook Configuration

### Custom Hook Path

By default, MAMA uses hooks in `scripts/hooks/`. To customize:

```json
{
  "hook_path": "/custom/path/to/hooks"
}
```

### PreToolUse Hook

The PreToolUse hook auto-injects context when you read/edit files.

**Enable/Disable:** See [Hook Setup Tutorial](../tutorials/hook-setup.md)

**Configuration:** Hooks are configured in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read|Edit|Grep",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-mama-context"
      }]
    }]
  }
}
```

---

## Privacy Settings

**FR Reference:** [FR45-49 (Privacy & Security)](../reference/fr-mapping.md)

### Opt-out of Context Injection

Disable automatic context injection while keeping manual save:

```json
{
  "disable_hooks": true
}
```

### Audit Data Collection

Check what MAMA has stored:

```bash
/mama-list --limit 100
```

### Delete Specific Decision

```sql
sqlite3 ~/.claude/mama-memory.db
DELETE FROM decisions WHERE topic = 'topic_name';
.quit
```

### Clear All Data

```bash
rm ~/.claude/mama-memory.db
# MAMA will recreate the database on next use
```

---

## Configuration Command

Use the `/mama-configure` command to change settings interactively:

```
/mama-configure
```

**Interactive prompts:**
1. Choose setting to change
2. Enter new value
3. Confirm changes

---

## See Also

- [Troubleshooting Guide](troubleshooting.md) - Common configuration issues
- [Performance Tuning Guide](performance-tuning.md) - Optimize for your use case
- [Data Privacy](../explanation/data-privacy.md) - Privacy philosophy
- [Commands Reference](../reference/commands.md) - All `/mama-*` commands

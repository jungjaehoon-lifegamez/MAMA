---
description: View or modify MAMA configuration (database, embedding model, requirements)
allowed-tools: Read, Write, Edit
argument-hint: '[--show] [--model=<name>] [--db-path=<path>] [--tier-check]'
---

# Configure MAMA Settings

You are helping the user view or modify MAMA configuration.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse configuration action:
   - `--show` (default): Display current configuration
   - `--model=X`: Change embedding model (e.g., 'Xenova/multilingual-e5-large')
   - `--db-path=X`: Change database location (e.g., '~/.claude/mama-memory.db')
   - `--tier-check`: Re-run the requirement checks (SQLite, embedding stack)

2. For `--show` (default):
   - Read configuration from `~/.mama/config.json`
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Display whether both requirements are present
   - Show embedding model, database path, performance stats
   - Include fix instructions when a requirement is missing

3. For `--model=X`:
   - Update `~/.mama/config.json` with new model name
   - Clear embedding cache (will reload on next use)
   - Show confirmation and expected performance

4. For `--db-path=X`:
   - Update `~/.mama/config.json` with new database path
   - Warn if path doesn't exist (will create on next use)
   - Note: Does NOT migrate existing data

5. For `--tier-check`:
   - Re-run the requirement checks (node:sqlite is built into supported Node 22.13+ runtimes; verify Transformers.js availability)
   - Create `~/.mama/config.json` from the runtime defaults if it does not exist; if it does, leave its settings as they are
   - Show what is missing and how to fix it

## Example Usage

```bash
# View current configuration
/mama:configure
/mama:configure --show

# Change embedding model
/mama:configure --model=Xenova/multilingual-e5-base

# Change database path
/mama:configure --db-path=~/custom/mama.db

# Check tier status
/mama:configure --tier-check

```

## Response Format - Show Configuration

````markdown
# ⚙️ MAMA Configuration

## System Status

**Database:** {db_path} ({db_size})
**Embedding Model:** {model_name} ({embedding_dim}-dim)
**Decision Count:** {total_decisions}
**Last Updated:** {config_updated_at}

---

## Feature Status

- ✅ Vector search (semantic similarity)
- ✅ Graph search (decision evolution)
- ✅ Recency weighting
- ✅ Multi-language support (Korean-English)
- ✅ Auto-context injection

**Performance:**

- Embedding latency: ~3ms
- Search latency: ~50ms
- Hook latency: ~100ms

---

## Available Models

**Current:** {current_model}

**Alternatives:**

- `Xenova/multilingual-e5-large` (1024-dim, ~560MB q8, 100+ languages, default)
- `Xenova/multilingual-e5-base` (768-dim, 420MB, better accuracy, slower)
- `Xenova/all-MiniLM-L6-v2` (384-dim, ~90MB, English-focused, faster cold start)

**Change model:** `/mama:configure --model=<name>`

---

## Configuration File

**Location:** `~/.mama/config.json`

```json
{
  "embeddingModel": "{model_name}",
  "embeddingDim": {dim},
  "databasePath": "{db_path}"
}
```
````

````

## Response Format - Requirement Missing

```markdown
# ⚙️ MAMA Configuration

## System Status ❌

**Missing:** {missing_component}
**Breaks:** {what_it_breaks}
**Fix:** {how_to_fix}

MAMA has no degraded mode. The affected calls throw rather than returning
weaker results, so nothing below works until this is fixed.

---

## Fix Instructions

```bash
# Reinstall dependencies with Node 22.13+
cd {plugin_path}
npm install
```

After fixing, run: `/mama:configure --tier-check`

```

## Error Handling

If configuration file doesn't exist:

```

⚠️ Configuration not initialized

Run: `/mama:configure --tier-check`

This will:

1. Detect your system capabilities
2. Create ~/.mama/config.json

```

## Important Notes

- **Requirements**: `node:sqlite` (built into Node 22.13+) and the Transformers.js embedding stack. Either one missing makes the plugin unusable; there is no fallback mode
- **Model change**: Clears cache, will reload on next search (~3s first time)
- **DB path change**: Does NOT migrate data (manual migration required)
- **Config location**: `~/.mama/config.json` (user-specific)
- **Database location**: Default `~/.claude/mama-memory.db` (shared with Claude Desktop)
```
````

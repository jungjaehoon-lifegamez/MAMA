---
description: View or modify MAMA configuration (database, embedding model, tier status, security settings)
allowed-tools: Read, Write, Edit
argument-hint: '[--show] [--model=<name>] [--db-path=<path>] [--disable-http] [--disable-websocket] [--enable-all] [--set-auth-token=<token>]'
---

# Configure MAMA Settings

You are helping the user view or modify MAMA configuration.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse configuration action:
   - `--show` (default): Display current configuration
   - `--model=X`: Change embedding model (e.g., 'Xenova/multilingual-e5-small')
   - `--db-path=X`: Change database location (e.g., '~/.claude/mama-memory.db')
   - `--tier-check`: Re-run tier detection (check SQLite, embeddings availability)
   - `--disable-http`: Disable HTTP server (Graph Viewer + Mobile Chat)
   - `--disable-websocket`: Disable WebSocket/Mobile Chat only (keep Graph Viewer)
   - `--enable-all`: Enable all features (remove all disable flags)
   - `--set-auth-token=X`: Set MAMA_AUTH_TOKEN for external access
   - `--generate-token`: Generate a strong random auth token

2. For `--show` (default):
   - Read configuration from `~/.mama/config.json`
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Display tier status (Tier 1 Full vs Tier 2 Degraded)
   - Show embedding model, database path, performance stats
   - **Show security settings** (HTTP server, WebSocket, auth token status)
   - Include fix instructions if degraded mode

3. For `--model=X`:
   - Update `~/.mama/config.json` with new model name
   - Clear embedding cache (will reload on next use)
   - Show confirmation and expected performance

4. For `--db-path=X`:
   - Update `~/.mama/config.json` with new database path
   - Warn if path doesn't exist (will create on next use)
   - Note: Does NOT migrate existing data

5. For `--tier-check`:
   - Re-run tier detection (check SQLite native module, Transformers.js)
   - Update config with detected tier
   - Show remediation steps if Tier 2

6. For `--disable-http`:
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Add `"MAMA_DISABLE_HTTP_SERVER": "true"` to mcpServers.mama.env
   - Save updated plugin.json
   - Show confirmation message
   - **Remind user to restart Claude Code** for changes to take effect

7. For `--disable-websocket`:
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Add `"MAMA_DISABLE_WEBSOCKET": "true"` to mcpServers.mama.env
   - Save updated plugin.json
   - Show confirmation message
   - **Remind user to restart Claude Code**

8. For `--enable-all`:
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Remove `MAMA_DISABLE_HTTP_SERVER` and `MAMA_DISABLE_WEBSOCKET` from env
   - Save updated plugin.json
   - Show confirmation message
   - **Remind user to restart Claude Code**

9. For `--set-auth-token=X`:
   - Read plugin config from `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`
   - Add `"MAMA_AUTH_TOKEN": "X"` to mcpServers.mama.env
   - Save updated plugin.json
   - **Warning:** Show security notice about token storage
   - **Remind user to restart Claude Code**

10. For `--generate-token`:
    - Generate a cryptographically secure random token (32 bytes, base64)
    - Display the generated token
    - Ask user if they want to save it to plugin config
    - If yes, update plugin.json as in step 9
    - **Remind user to save token securely**

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

# Security settings
/mama:configure --disable-http              # Disable Graph Viewer + Mobile Chat
/mama:configure --disable-websocket         # Disable Mobile Chat only
/mama:configure --enable-all                # Enable all features

# Authentication token
/mama:configure --generate-token            # Generate random token
/mama:configure --set-auth-token=abc123     # Set specific token
```

## Response Format - Show Configuration

````markdown
# ⚙️ MAMA Configuration

## System Status

**Tier:** {tier_name} (Tier {tier_number})
**Database:** {db_path} ({db_size})
**Embedding Model:** {model_name} ({embedding_dim}-dim)
**Decision Count:** {total_decisions}
**Last Updated:** {config_updated_at}

---

## Security Settings

**HTTP Server:** {enabled/disabled}
**Graph Viewer:** {enabled/disabled}
**Mobile Chat (WebSocket):** {enabled/disabled}
**Auth Token:** {set/not set}

**Quick Actions:**

- Disable all: `/mama:configure --disable-http`
- Disable Mobile Chat: `/mama:configure --disable-websocket`
- Enable all: `/mama:configure --enable-all`
- Set auth token: `/mama:configure --generate-token`

**⚠️ Security Notice:**

- HTTP server runs on localhost (127.0.0.1:3847) only
- External access requires tunnel (ngrok, Cloudflare)
- **For production:** Use Cloudflare Zero Trust (See [Security Guide](docs/guides/security.md))
- **For testing:** Set auth token with `/mama:configure --generate-token`

---

## Feature Status

**Tier 1 - Full Features** ✅

- ✅ Vector search (semantic similarity)
- ✅ Graph search (decision evolution)
- ✅ Recency weighting
- ✅ Multi-language support (Korean-English)
- ✅ Auto-context injection

**Performance:**

- Embedding latency: ~3ms
- Search latency: ~50ms
- Hook latency: ~100ms
- Accuracy: 80%

---

## Available Models

**Current:** {current_model}

**Alternatives:**

- `Xenova/multilingual-e5-small` (384-dim, 120MB, Korean-English, recommended)
- `Xenova/multilingual-e5-base` (768-dim, 420MB, better accuracy, slower)
- `Xenova/all-MiniLM-L6-v2` (384-dim, 80MB, English only, fastest)

**Change model:** `/mama:configure --model=<name>`

---

## Configuration File

**Location:** `~/.mama/config.json`

```json
{
  "embeddingModel": "{model_name}",
  "embeddingDim": {dim},
  "databasePath": "{db_path}",
  "tier": {tier},
  "tier_detected_at": "{timestamp}"
}
```
````

````

## Response Format - Tier 2 Degraded Mode

```markdown
# ⚙️ MAMA Configuration

## System Status ⚠️

**Tier:** Degraded Mode (Tier 2)
**Issue:** {missing_component}
**Impact:** Vector search unavailable, exact match only
**Accuracy:** 40% (vs 80% in Tier 1)

---

## What's Not Working

- ❌ Vector search (no semantic similarity)
- ❌ Multilingual support
- ⚠️ Exact match search only

## What Still Works

- ✅ Graph search (decision evolution)
- ✅ All data saved and retrievable
- ✅ Auto-context injection (reduced accuracy)

---

## Fix Instructions

### macOS
```bash
# Install Xcode Command Line Tools
xcode-select --install

# Rebuild native module
cd {plugin_path}
npm rebuild better-sqlite3
````

### Linux

```bash
# Install build tools
sudo apt install build-essential python3

# Rebuild native module
cd {plugin_path}
npm rebuild better-sqlite3
```

### Windows

```bash
# Install build tools
npm install --global windows-build-tools

# Rebuild native module
cd {plugin_path}
npm rebuild better-sqlite3
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
3. Set appropriate tier (1 or 2)

```

## Important Notes

- **Tier 1 vs Tier 2**: Automatic detection based on native module availability
- **Model change**: Clears cache, will reload on next search (~3s first time)
- **DB path change**: Does NOT migrate data (manual migration required)
- **Config location**: `~/.mama/config.json` (user-specific)
- **Database location**: Default `~/.claude/mama-memory.db` (shared with Claude Desktop)
```

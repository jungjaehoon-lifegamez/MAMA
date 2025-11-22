# Installation Guide

**Complete installation instructions for MAMA**

---

## System Requirements

- **Node.js** >= 18.0.0 (Recommended: 20.0.0+)
- **Claude Code** (latest version) or **Claude Desktop**
- **Disk Space**: ~500MB (npm cache + model cache + database)
- **Build Tools** (for native module compilation):
  - macOS: Xcode Command Line Tools
  - Linux: build-essential, python3
  - Windows: windows-build-tools

**Check Node.js version:**

```bash
node --version
# Required: >= 18.0.0
```

---

## Quick Install

### For Claude Code Users

**Step 1: Install Plugin**

```bash
/plugin marketplace add jungjaehoon/claude-plugins
/plugin install mama@jungjaehoon
```

**Step 2: First Use (Automatic Setup)**

```bash
/mama-save
```

On first use, MAMA's MCP server will be automatically downloaded and set up via npx (~1-2 minutes).

**What happens:**

- npx downloads `@jungjaehoon/mama-server`
- Native modules (better-sqlite3) compile for your platform
- Embedding models download to npm cache
- Server starts automatically
- Future sessions start instantly

**That's it!** No manual npm install required.

---

### For Claude Desktop Users

MAMA's MCP server works with Claude Desktop too!

**Add to `claude_desktop_config.json`:**

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"],
      "env": {
        "MAMA_DB_PATH": "${HOME}/.claude/mama-memory.db"
      }
    }
  }
}
```

Restart Claude Desktop, and MAMA tools will be available.

---

## Manual MCP Server Installation (Optional)

If npx fails or you prefer global installation:

```bash
npm install -g @jungjaehoon/mama-server
```

Then update your MCP configuration:

**Claude Code (.mcp.json):**

```json
{
  "mcpServers": {
    "mama": {
      "command": "mama-server"
    }
  }
}
```

**Claude Desktop (claude_desktop_config.json):**

```json
{
  "mcpServers": {
    "mama": {
      "command": "mama-server"
    }
  }
}
```

---

## Verify Installation

### Check Commands (Claude Code)

```bash
# In Claude Code, type:
/mama

# Should autocomplete to:
/mama-recall
/mama-suggest
/mama-list
/mama-save
/mama-configure
```

### Check MCP Server Status

```bash
/mama-list

# Expected output:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Tier 1 (Full Features Active)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**If you see 🟡 Tier 2:** See [Tier 2 Remediation Guide](tier-2-remediation.md)

---

## First Use

After installation, try saving your first decision:

```bash
/mama-save
```

**First time will take 1-2 minutes:**

- MCP server downloads automatically
- Native modules compile
- Embedding models download

**Subsequent uses:** Instant!

---

## Troubleshooting

### Commands not appearing

**Claude Code:**

- Restart Claude Code
- Check: `/help` to see if MAMA commands are listed
- Verify marketplace: `/plugin` should show mama@jungjaehoon

### MCP Server connection fails

**Check Node.js:**

```bash
node --version
# Must be >= 18.0.0
```

**Try manual installation:**

```bash
npm install -g @jungjaehoon/mama-server
```

**Update .mcp.json to use global binary:**

```json
{
  "mcpServers": {
    "mama": {
      "command": "mama-server"
    }
  }
}
```

### Native module build fails

**Install build tools:**

**macOS:**

```bash
xcode-select --install
```

**Ubuntu/Debian:**

```bash
sudo apt-get install build-essential python3
```

**Windows:**

```bash
npm install --global windows-build-tools
```

Then retry:

```bash
npm install -g @jungjaehoon/mama-server --force
```

### Windows-specific issues

If npx fails on Windows, use the global installation method:

```bash
npm install -g @jungjaehoon/mama-server
```

Then configure with absolute path:

```json
{
  "mcpServers": {
    "mama": {
      "command": "C:\\Users\\USERNAME\\AppData\\Roaming\\npm\\mama-server.cmd"
    }
  }
}
```

**See also:** [Troubleshooting Guide](troubleshooting.md) for more details

---

## Architecture Overview

MAMA uses a **2-package architecture**:

1. **@jungjaehoon/mama-server** (MCP Server)

   - Independent npm package
   - Handles all AI/database operations
   - Shared across Claude Code, Claude Desktop, and other MCP clients
   - Contains: better-sqlite3, @huggingface/transformers

2. **mama-plugin** (Claude Code Plugin)
   - Lightweight plugin (Markdown + config)
   - Provides /mama-\* commands
   - Hooks for automatic context injection
   - References the MCP server via .mcp.json

**Benefits:**

- ✅ One MCP server, multiple clients
- ✅ Automatic dependency management (npx)
- ✅ Platform-specific compilation handled automatically
- ✅ Shared decision database across all tools

---

## Next Steps

- [Getting Started Tutorial](../tutorials/getting-started.md)
- [First Decision Tutorial](../tutorials/first-decision.md)
- [Configuration Guide](configuration.md)

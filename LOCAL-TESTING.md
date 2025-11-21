# Local Plugin Testing Guide

**Date:** 2025-11-21  
**Status:** Ready for local testing

## ✅ Setup Complete

### 1. Symlink Created
```bash
~/.claude/plugins/repos/mama -> /home/hoons/MAMA/packages/claude-code-plugin
```

### 2. Plugin Structure Verified
```
~/.claude/plugins/repos/mama/
├── .claude-plugin/
│   └── plugin.json           ✅ (836 bytes)
├── .mcp.json                 ✅ (424 bytes, absolute path)
├── commands/                 ✅ (5 commands)
│   ├── mama-save.md
│   ├── mama-recall.md
│   ├── mama-suggest.md
│   ├── mama-list.md
│   └── mama-configure.md
├── skills/                   ✅ (mama-context)
└── scripts/                  ✅ (hooks)
```

### 3. MCP Server Tested
```
[MAMA MCP] Initializing database...
[MAMA MCP] Database initialized
[MAMA MCP] Server started successfully
[MAMA MCP] Listening on stdio transport
[MAMA MCP] Ready to accept connections
```

**Server Path:** `/home/hoons/MAMA/packages/mcp-server/src/server.js`

---

## 🧪 Testing Instructions

### Step 1: Restart Claude Code
**Important:** Must restart for plugin changes to be detected
```bash
# Close Claude Code completely
# Restart Claude Code
```

### Step 2: Verify Plugin Loaded
```
# In Claude Code, type:
/help

# Expected: Should see /mama-* commands listed
/mama-save
/mama-recall
/mama-suggest
/mama-list
/mama-configure
```

### Step 3: Test Basic Functionality
```
# Save a test decision
/mama-save

# When prompted:
Topic: local_test
Decision: Testing MAMA plugin locally via symlink
Reasoning: Verifying Phase 2 monorepo setup works correctly
```

### Step 4: Check MCP Server Logs
MCP server runs in background. Check for errors:
```bash
# Database should be created
ls -la ~/.claude/mama-memory.db

# If issues, check Claude Code logs
# (Location varies by OS)
```

### Step 5: Test Auto-Context (Hook)
```
# Read any file in your project
# MAMA should inject relevant context if it finds related decisions

# Example:
# (Open a file or use a command that triggers Read/Edit/Grep)
```

---

## 🔍 Troubleshooting

### Plugin Not Showing Up
**Problem:** `/mama-*` commands don't appear after restart

**Solutions:**
1. Check symlink exists:
   ```bash
   ls -la ~/.claude/plugins/repos/mama
   ```

2. Check plugin.json is valid:
   ```bash
   cat ~/.claude/plugins/repos/mama/.claude-plugin/plugin.json
   ```

3. Try hard restart:
   - Quit Claude Code completely
   - Wait 5 seconds
   - Start again

### MCP Server Connection Error
**Problem:** "Failed to connect to MCP server"

**Solutions:**
1. Check server path is correct:
   ```bash
   cat ~/.claude/plugins/repos/mama/.mcp.json
   # Should point to: /home/hoons/MAMA/packages/mcp-server/src/server.js
   ```

2. Test server manually:
   ```bash
   node /home/hoons/MAMA/packages/mcp-server/src/server.js
   # Should output: [MAMA MCP] Server started successfully
   ```

3. Check dependencies installed:
   ```bash
   cd /home/hoons/MAMA/packages/mcp-server
   npm install
   ```

### Database Errors
**Problem:** "Cannot open database" or similar

**Solutions:**
1. Check database path:
   ```bash
   ls -la ~/.claude/mama-memory.db
   ```

2. Check write permissions:
   ```bash
   touch ~/.claude/test.db
   rm ~/.claude/test.db
   ```

3. Reset database (WARNING: deletes all data):
   ```bash
   rm ~/.claude/mama-memory.db
   # Restart Claude Code to recreate
   ```

---

## 📊 Verification Checklist

- [ ] Symlink created: `~/.claude/plugins/repos/mama`
- [ ] Claude Code restarted
- [ ] `/help` shows `/mama-*` commands
- [ ] `/mama-save` works (creates decision)
- [ ] Database created: `~/.claude/mama-memory.db`
- [ ] MCP server starts without errors
- [ ] `/mama-list` shows saved decisions
- [ ] Hooks trigger (optional, check logs)

---

## 🚀 Next Steps After Testing

### If Everything Works ✅
1. Continue using for real work
2. Test more complex scenarios
3. Prepare for Phase 3 (npm publish)

### If Issues Found ❌
1. Document the issue
2. Check logs for error messages
3. Report back with details

---

## 📝 Configuration Details

### Current .mcp.json
```json
{
  "mcpServers": {
    "mama": {
      "command": "node",
      "args": ["/home/hoons/MAMA/packages/mcp-server/src/server.js"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small",
        "NODE_ENV": "development"
      }
    }
  }
}
```

**Note:** Uses absolute path for development. Will change to `npx` for production.

### Current plugin.json
- **Name:** mama
- **Version:** 1.0.0
- **Commands:** 5 (save/recall/suggest/list/configure)
- **Skills:** 1 (mama-context)
- **Hooks:** 3 (UserPromptSubmit, PreToolUse, PostToolUse)

---

## 🔗 References

- Main repo: `/home/hoons/MAMA/`
- Plugin source: `/home/hoons/MAMA/packages/claude-code-plugin/`
- MCP server: `/home/hoons/MAMA/packages/mcp-server/`
- Migration status: `MIGRATION-STATUS.md`

---

**Last Updated:** 2025-11-21
**Phase:** 2 (Local Testing Ready)

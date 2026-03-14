# Troubleshooting Guide

**Audience:** All users experiencing issues
**Common Problems:** Plugin not loading, Node runtime mismatch, optional dependency issues, disk space, hooks not firing, database corruption, model download failures

---

## Quick Diagnostics

```bash
# Run full diagnostic check
cd ~/.claude/plugins/mama
npm test
node scripts/check-compatibility.js
node scripts/validate-manifests.js
```

---

## 1. Plugin Not Loading

**Symptoms:**

- `/mama-*` commands don't appear in command palette
- No MAMA context injections
- Claude Code shows "Plugin load failed" error

### Check 1: Node.js Version

```bash
node --version

# Required: >= 22.13.0
# Recommended: >= 22.13.0
```

**If Node too old:**

```bash
# Install Node 22 LTS via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22
nvm alias default 22
```

### Check 2: Plugin Structure

```bash
# Verify plugin.json exists
ls -la ~/.claude/plugins/mama/.claude-plugin/plugin.json

# Expected: File exists and is readable
```

**If missing:**

```bash
# Re-copy plugin directory
cp -r /path/to/mama-plugin ~/.claude/plugins/mama

# Verify all manifests
node ~/.claude/plugins/mama/scripts/validate-manifests.js
```

### Check 3: Dependencies Installed

```bash
cd ~/.claude/plugins/mama
npm install

# Check for errors in output
# Common issue: old Node runtime or missing optional image runtime (see section below)
```

### Check 4: Claude Code Logs

```bash
# Check Claude Code logs for plugin errors
# Logs location varies by platform:
# macOS: ~/Library/Logs/Claude/
# Linux: ~/.config/Claude/logs/
# Windows: %APPDATA%\Claude\logs\
```

---

## 2. Node.js Runtime and Optional Dependency Issues

**Symptoms:**

```text
Error: Cannot find module 'node:sqlite'
ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite
Could not load the "sharp" module using the current runtime
```

**Why this happens:**
MAMA now uses Node's built-in `node:sqlite`, so SQLite itself does not need compilation anymore. These failures mean either:

1. Your Node.js version is too old for `node:sqlite`
2. Optional image dependencies such as `sharp` were omitted or installed for the wrong platform

### Fix 1: Upgrade Node.js to 22.13+

```bash
node --version
# Must be >= 22.13.0
```

If not, upgrade Node and reinstall dependencies:

```bash
cd ~/.claude/plugins/mama
rm -rf node_modules package-lock.json
npm install
```

### Fix 2: Restore optional image runtime packages

If OCR, image upload, or checkpoint narrative expansion reports `sharp` runtime errors:

```bash
cd ~/.claude/plugins/mama
npm install --include=optional sharp
```

### Fix 3: Avoid `--omit=optional`

Do not install MAMA packages with `npm install --omit=optional` unless you intentionally want to disable optional image features. That flag skips platform packages used by `sharp`.

---

## 3. Disk Space Issues

**Symptoms:**

- Model download fails
- Database writes fail
- `ENOSPC: no space left on device`

### Check Disk Space

```bash
# Check available space
df -h ~

# Required minimum:
# - Model cache: 120MB
# - Database: 50MB initial (grows with usage)
# - Node modules: 150MB
# Total: ~500MB minimum
```

### Free Up Space

```bash
# 1. Clear old model caches
rm -rf ~/.cache/huggingface/transformers/.cache

# 2. Clear npm cache
npm cache clean --force

# 3. Clear old Claude Code logs (if safe)
# rm -rf ~/Library/Logs/Claude/old-logs/

# 4. Check database size
du -sh ~/.claude/mama-memory.db

# If > 100MB, consider exporting old decisions and resetting
```

### Database Size Management

```bash
# Check decision count
echo "SELECT COUNT(*) FROM decisions;" | sqlite3 ~/.claude/mama-memory.db

# If > 1000 decisions, consider:
# 1. Export old decisions
# 2. Delete obsolete topics
# 3. Or accept larger DB (decisions compress well)
```

**Expected Database Growth:**

- 100 decisions: ~5MB
- 1,000 decisions: ~20MB
- 10,000 decisions: ~100MB

---

## 4. Hooks Not Firing

**Symptoms:**

- No automatic context injection
- UserPromptSubmit hook doesn't show MAMA banner

### Check 1: Hooks Enabled

```bash
echo $MAMA_DISABLE_HOOKS

# Expected: empty or "false"
# If "true", hooks are disabled
```

**Re-enable hooks:**

```bash
unset MAMA_DISABLE_HOOKS

# Or in ~/.mama/config.json:
{
  "disable_hooks": false
}
```

### Check 2: Hook Script Permissions

```bash
ls -la ~/.claude/plugins/mama/scripts/*.js

# All .js files should have execute permissions (x)
# Example: -rwxr-xr-x
```

**Fix permissions:**

```bash
chmod +x ~/.claude/plugins/mama/scripts/*.js
```

### Check 3: Test Hook Manually

```bash
cd ~/.claude/plugins/mama

# Test UserPromptSubmit hook
export USER_PROMPT="test prompt"
export MAMA_DB_PATH=~/.claude/mama-memory.db
node scripts/userpromptsubmit-hook.js

# Expected: Should output MAMA banner or tier message
```

---

## 5. Database Corruption

**Symptoms:**

- `SQLITE_CORRUPT` errors
- `/mama-*` commands fail
- Database queries return empty results

### Check Database Integrity

```bash
sqlite3 ~/.claude/mama-memory.db "PRAGMA integrity_check;"

# Expected: "ok"
# If errors shown: Database is corrupted
```

### Fix Corrupted Database

```bash
# 1. Backup existing database (just in case)
cp ~/.claude/mama-memory.db ~/.claude/mama-memory.db.backup

# 2. Try to recover
sqlite3 ~/.claude/mama-memory.db ".recover" | sqlite3 ~/.claude/mama-memory-recovered.db

# 3. If recovery fails, reset database (WARNING: loses all data)
rm ~/.claude/mama-memory.db

# 4. Restart Claude Code to recreate fresh database
```

---

## 6. Embedding Model Download Fails

**Symptoms:**

- Stuck at "Downloading model..."
- Network timeout errors
- Falls back to Tier 2 permanently

### Check 1: Internet Connection

```bash
# Test connection to Hugging Face CDN
curl -I https://huggingface.co

# Expected: HTTP 200 OK
```

### Check 2: Manual Model Download

```bash
cd ~/.claude/plugins/mama

# Force model download with debug output
node -e "
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
(async () => {
  console.log('Downloading model...');
  await generateEmbedding('warmup');
  console.log('✅ Model downloaded successfully');
  console.log('Cache location:', process.env.HOME + '/.cache/huggingface/');
})();
"

# This should take ~987ms on first run
# Subsequent runs should be instant (cached)
```

### Check 3: Verify Model Cache

```bash
ls -lah ~/.cache/huggingface/transformers/

# Expected: Directory with ~120MB of model files
# Files: model.onnx, tokenizer.json, etc.
```

**Clear corrupt cache:**

```bash
rm -rf ~/.cache/huggingface/transformers/
# Then retry download
```

### Check 4: Firewall/Proxy Issues

If behind corporate firewall:

```bash
# Set proxy for npm
npm config set proxy http://proxy.company.com:8080
npm config set https-proxy http://proxy.company.com:8080

# Then retry install
cd ~/.claude/plugins/mama
npm install
```

---

## Advanced Troubleshooting

### Enable Debug Logging

```bash
# Set debug environment variable
export DEBUG=mama:*

# Run command with debug output
node scripts/userpromptsubmit-hook.js

# Look for error messages in output
```

### Check System Resources

```bash
# CPU usage
top -l 1 | grep "CPU usage"

# Memory available
free -h  # Linux
vm_stat  # macOS

# If resources constrained, MAMA may be slow
```

### Test Individual Components

```bash
cd ~/.claude/plugins/mama

# Test database connection
node -e "
const db = require('./src/core/db-manager.js');
db.initDB().then(() => console.log('✅ DB OK'));
"

# Test embedding generation
node -e "
const emb = require('./src/core/embeddings.js');
emb.generateEmbedding('test').then(v => console.log('✅ Embeddings OK', v.length));
"
```

---

## Getting Help

**Still having issues?**

1. **Check GitHub Issues**: [MAMA/issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
2. **Enable debug logs** and share output
3. **Run diagnostics**:
   ```bash
   cd ~/.claude/plugins/mama
   npm test  # Run test suite
   node scripts/check-compatibility.js  # Check system compatibility
   ```
4. **Provide system info**:
   - OS version
   - Node.js version
   - Claude Code version
   - Error messages from logs

---

**Related:**

- [Installation Guide](installation.md)
- [Tier 2 Remediation Guide](tier-2-remediation.md)
- [Configuration Guide](configuration.md)
- [Performance Tuning](performance-tuning.md)

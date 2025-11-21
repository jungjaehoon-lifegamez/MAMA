# Troubleshooting Guide

**Audience:** All users experiencing issues
**Common Problems:** Plugin not loading, SQLite build failures, disk space, hooks not firing, database corruption, model download failures

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

# Required: >= 18.0.0
# Recommended: >= 20.0.0
```

**If Node too old (Node.js가 너무 오래된 경우):**
```bash
# Install Node 20 LTS via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
nvm alias default 20
```

### Check 2: Plugin Structure

```bash
# Verify plugin.json exists
ls -la ~/.claude/plugins/mama/.claude-plugin/plugin.json

# Expected: File exists and is readable
```

**If missing (파일이 없으면):**
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
# Common issue: better-sqlite3 compilation failure (see section below)
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

## 2. SQLite Build Failures (better-sqlite3)

**Symptoms:**
```
npm ERR! node-gyp rebuild
npm ERR! gyp ERR! stack Error: Python executable "python" is not found
```

**Why this happens:**
`better-sqlite3` is a native module that needs C++ compilation. Build tools may be missing.

### Solutions by Platform

#### macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install

# If already installed, reset it
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install

# Then reinstall mama-plugin
cd ~/.claude/plugins/mama
rm -rf node_modules package-lock.json
npm install
```

#### Linux (Ubuntu/Debian)

```bash
# Install build essentials
sudo apt-get update
sudo apt-get install -y build-essential python3

# Then reinstall
cd ~/.claude/plugins/mama
rm -rf node_modules package-lock.json
npm install
```

#### Windows

```powershell
# Install build tools (run as Administrator)
npm install --global windows-build-tools

# Or install Visual Studio Build Tools manually
# https://visualstudio.microsoft.com/downloads/

# Then reinstall
cd %USERPROFILE%\.claude\plugins\mama
rmdir /s node_modules
del package-lock.json
npm install
```

### Alternative: Use Prebuilt Binaries

```bash
# If compilation keeps failing, try prebuilt binaries
npm install better-sqlite3 --build-from-source=false
```

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

### Free Up Space (디스크 공간 확보)

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
const { pipeline } = require('@huggingface/transformers');
(async () => {
  console.log('Downloading model...');
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
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

**Still having issues? (여전히 문제가 해결되지 않으면?)**

1. **Check GitHub Issues**: [claude-mama/issues](https://github.com/spellon/claude-mama/issues)
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

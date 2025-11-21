# MAMA Plugin - Memory-Augmented MCP Assistant

**Version:** 1.0.0
**License:** MIT
**Author:** SpineLift Team

> "Remember decision evolution, not just conclusions"

MAMA is an always-on companion for Claude Code that remembers how you think. It preserves the evolution of your decisions—from failed attempts to successful solutions—preventing you from repeating the same mistakes.

## Features

**FR Reference:** [FR1-29 (Core Features)](../docs/MAMA-PRD.md)

✅ **Decision Evolution Tracking** - See the journey from confusion to clarity ([FR13-18](../docs/MAMA-PRD.md#fr13-18-decision-graph))
✅ **Semantic Search** - Natural language queries across all decisions ([FR8-12](../docs/MAMA-PRD.md#fr8-12-semantic-search))
✅ **Always-on Context** - Automatic background hints when relevant ([FR19-24](../docs/MAMA-PRD.md#fr19-24-hook-integration))
✅ **Multi-language Support** - Korean + English cross-lingual search ([FR30-35](../docs/MAMA-PRD.md#fr30-35-multilingual-support))
✅ **Tier Transparency** - Always shows what's working, what's degraded ([FR25-29](../docs/MAMA-PRD.md#fr25-29-transparency-tier-awareness))
✅ **Local-first** - All data stored on your device ([FR45-49](../docs/MAMA-PRD.md#fr45-49-privacy-security))

## Installation

**FR Reference:** [FR50-55 (Installation & Setup)](../docs/MAMA-PRD.md#fr50-55-configuration)

### Prerequisites

- Node.js >= 18.0.0 (권장: 20.0.0 이상 / Recommended: 20.0.0+)
- Claude Code (최신 버전 / latest version)

### Quick Install (Copy-Paste)

**빠른 설치** (Quick setup for experienced users):

```bash
# 1. Clone or copy the mama-plugin directory to your Claude Code plugins folder
mkdir -p ~/.claude/plugins
cp -r /path/to/mama-plugin ~/.claude/plugins/mama

# 2. Install dependencies
cd ~/.claude/plugins/mama
npm install

# 3. Verify installation
node scripts/check-compatibility.js
```

### Manual Install

1. **Copy plugin directory**
   ```bash
   cp -r mama-plugin ~/.claude/plugins/mama
   ```

2. **Install Node.js dependencies**
   ```bash
   cd ~/.claude/plugins/mama
   npm install
   ```

3. **Verify plugin structure**
   ```bash
   # Should see:
   # ├── .claude-plugin/plugin.json   # Unified manifest
   # ├── .mcp.json                     # MCP server config
   # ├── src/                          # Core logic
   # ├── scripts/                      # Hooks
   # ├── skills/                       # Auto-context
   # └── tests/                        # Test suite
   ```

4. **Restart Claude Code**
   - Plugin auto-loads on restart
   - Check status: Hooks should be active

## Manifest Files

### `.claude-plugin/plugin.json` (Unified Manifest)

Declares all plugin components in one file:

- **Commands**: `/mama-recall`, `/mama-suggest`, `/mama-list`, `/mama-save`, `/mama-configure`
- **Skills**: `mama-context` (always-on background context injection)
- **Hooks**: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`

**Key Features:**
- Portable paths using `${CLAUDE_PLUGIN_ROOT}`
- All commands, skills, and hooks in single manifest
- Official Claude Code plugin structure

### `.mcp.json` (MCP Server Configuration)

Configures the MCP server for local stdio transport:

```json
{
  "mcpServers": {
    "mama": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/commands/index.js"],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small",
        "NODE_ENV": "production",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

**Environment Variables:**
- `MAMA_DATABASE_PATH`: Where decisions are stored
- `MAMA_EMBEDDING_MODEL`: Which embedding model to use
- `NODE_ENV`: production (or development for debugging)
- `MCP_TRANSPORT`: stdio (local) or http (future)

## First-Use Walkthrough

### Step 1: Verify Installation ✅

After installing and restarting Claude Code:

```bash
# Check if plugin loaded successfully
# You should see MAMA commands in Claude Code's command palette
```

**Expected:** Commands `/mama-*` appear when you type `/mama`

**문제 발생 시** (If issues): See [Troubleshooting](#troubleshooting) section below

### Step 2: First Decision Save 💾

Try saving your first decision:

```
You: /mama-save

Claude will ask:
- Topic (e.g., "project_architecture")
- Decision (what you decided)
- Reasoning (why you decided this)
- Confidence (0.0-1.0, default 0.5)
```

**Korean Example / 한국어 예시:**
```
Topic: 테스트_프레임워크
Decision: Vitest 사용하기로 결정
Reasoning: Jest보다 ESM 지원이 좋고, 프로젝트에 이미 설정되어 있음
Confidence: 0.9
```

**첫 저장 성공 시**: `✅ Decision saved successfully (ID: decision_...)` 메시지 확인

### Step 3: Verify Tier Detection 🎯

After first save, check what tier you're running:

```
You: /mama-list

Expected output shows tier badge:
🔍 System Status: 🟢 Tier 1 (Full Features Active)
```

**Tier Meanings / 티어 의미:**
- **🟢 Tier 1**: Full vector search + semantic matching (80% accuracy)
- **🟡 Tier 2**: Fallback exact match only (40% accuracy)

**Tier 2인 경우**: See [Tier 2 Remediation](#tier-2-fallback-mode-remediation) below

### Step 4: Test Automatic Context 🤖

MAMA automatically injects context when relevant:

```
You: "How should I handle testing?"

Expected: Before Claude responds, you'll see:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • 테스트_프레임워크 (90%, just now)
   /mama-recall 테스트_프레임워크 for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**자동 컨텍스트 원리** (How it works):
- UserPromptSubmit hook → Semantic search → Gentle hints (not walls of text)
- Privacy guarantee: 100% local, no network calls (FR45-49)

### Step 5: Explore Commands 📚

```bash
# See decision evolution (supersedes chain)
/mama-recall 테스트_프레임워크

# Semantic search across all topics
/mama-suggest "어떤 라이브러리를 써야 할까?"

# List recent decisions (default 10)
/mama-list

# List 20 recent decisions
/mama-list --limit 20
```

**Ready to use!** 🎉 MAMA is now tracking your decision evolution.

---

## Usage

### Commands (CLI Reference)

Commands follow standard Claude Code slash command syntax.

#### `/mama-recall <topic>`
**Purpose:** Show full decision evolution for a topic
**FR Reference:** [FR1-7 (Decision CRUD)](../docs/MAMA-PRD.md#fr1-7-decision-crud)

```bash
/mama-recall auth_strategy

# Output shows evolution chain:
# Latest Decision (2025-11-21)
# ✅ Use JWT with refresh tokens (confidence: 0.9)
#
# Previous Decisions:
# 1. Try session cookies (failed: scaling issues)
# 2. Consider OAuth 2.0 (rejected: too complex)
```

#### `/mama-suggest <question>`
**Purpose:** Semantic search across all decisions
**FR Reference:** [FR8-12 (Semantic Search)](../docs/MAMA-PRD.md#fr8-12-semantic-search)

```bash
/mama-suggest "How should I handle authentication?"

# Output:
# 💡 Found 3 related decisions:
# 1. auth_strategy (95%, 2 days ago)
# 2. user_session_management (78%, 1 week ago)
# 3. api_security (65%, 2 weeks ago)
```

**한국어 검색 지원** (Korean queries work too):
```bash
/mama-suggest "인증을 어떻게 처리할까?"
# Same results as English query (cross-lingual embeddings)
```

#### `/mama-list [--limit N]`
**Purpose:** List recent decisions
**FR Reference:** [FR1-7 (Decision CRUD)](../docs/MAMA-PRD.md#fr1-7-decision-crud)

```bash
/mama-list              # Default: 10 recent
/mama-list --limit 20   # Show 20 recent
```

#### `/mama-save`
**Purpose:** Explicitly save a decision (interactive prompt)
**FR Reference:** [FR1-7 (Decision CRUD)](../docs/MAMA-PRD.md#fr1-7-decision-crud)

```bash
/mama-save

# Interactive prompts:
# Topic: ________________
# Decision: _____________
# Reasoning: ____________
# Confidence (0.0-1.0): __
```

**CRITICAL Topic Naming / 중요한 토픽 명명 규칙:**
```javascript
// ✅ GOOD: Reuse same topic for evolution chain
topic: 'auth_strategy'  // First decision
topic: 'auth_strategy'  // Update (creates supersedes edge)

// ❌ BAD: Unique topics break the graph
topic: 'auth_strategy_v1'
topic: 'auth_strategy_v2'
```

#### `/mama-configure`
**Purpose:** Change embedding model or disable features
**FR Reference:** [FR50-55 (Configuration)](../docs/MAMA-PRD.md#fr50-55-configuration)

```bash
/mama-configure

# Options:
# 1. Change embedding model
# 2. Disable hooks (privacy mode)
# 3. View current config
```

### Always-On Context (Automatic)

**FR Reference:** [FR19-24 (Hook Integration)](../docs/MAMA-PRD.md#fr19-24-hook-integration)

The `mama-context` skill automatically injects relevant decisions when you:
- Submit a prompt (UserPromptSubmit hook - [FR19](../docs/MAMA-PRD.md#fr19-userpromptsubmit-hook))
- Read/Edit/Grep files (PreToolUse hook - [FR20](../docs/MAMA-PRD.md#fr20-pretooluse-hook))

**Example Output:**
```
💡 MAMA: 1 related
   • auth_strategy (90%, 2 days ago)
   /mama-recall auth_strategy for full decision

🔍 System Status: ✅ Full Features Active (Tier 1)
```

**Philosophy:** Gentle hints (40 tokens), not walls of text (250 tokens). Claude decides if relevant.

**자동 컨텍스트 철학** (Auto-context philosophy):
- 💡 Teaser format (preview only, not full data)
- 🎯 High-confidence matches only (>70% similarity)
- 🚫 No spam (max 3 suggestions per hook)

### Saving Decisions

**FR Reference:** [FR13-18 (Decision Graph)](../docs/MAMA-PRD.md#fr13-18-decision-graph)

```javascript
// CRITICAL: Reuse same topic for related decisions
// ✅ GOOD: Creates supersedes chain
topic: 'auth_strategy'  // Use for ALL auth decisions
topic: 'auth_strategy'  // Again! Shows evolution

// ❌ BAD: Unique topics break the graph
topic: 'auth_strategy_v1'
topic: 'auth_strategy_v2'
```

**중요: 토픽 재사용** (Critical: Topic reuse):
- 같은 토픽을 반복 사용하면 "supersedes" 그래프가 자동 생성됩니다
- 이를 통해 결정의 진화 과정(confusion → clarity)을 추적할 수 있습니다
- 고유한 토픽명(v1, v2 등)은 그래프 연결을 끊어버립니다

## Configuration

**FR Reference:** [FR50-55 (Configuration)](../docs/MAMA-PRD.md#fr50-55-configuration)

### Disable Hooks (Privacy/Debug)

**FR Reference:** [FR45-49 (Privacy & Security)](../docs/MAMA-PRD.md#fr45-49-privacy-security)

```bash
export MAMA_DISABLE_HOOKS=true
# Or in ~/.mama/config.json:
{
  "disable_hooks": true
}
```

**사용 시나리오** (Use cases):
- 🔒 Privacy mode: 완전히 수동 저장만 원할 때
- 🐛 Debug mode: 훅 간섭 없이 디버깅할 때
- 🚀 Performance testing: 순수 성능 측정 시

### Change Embedding Model

**FR Reference:** [FR8-12 (Semantic Search)](../docs/MAMA-PRD.md#fr8-12-semantic-search)

```bash
/mama-configure --model Xenova/all-MiniLM-L6-v2
# Or edit ~/.mama/config.json:
{
  "embedding_model": "Xenova/gte-large"
}
```

**Recommended Models:**
- Korean-English: `Xenova/multilingual-e5-small` (default, 120MB)
- English-only: `Xenova/all-MiniLM-L6-v2` (faster, 90MB)
- High accuracy: `Xenova/gte-large` (larger, 200MB)

**모델 선택 가이드** (Model selection guide):
| Model | Size | Speed | Accuracy | Best For |
|-------|------|-------|----------|----------|
| multilingual-e5-small | 120MB | Medium | 80% | 한/영 혼용 (Korean+English) |
| all-MiniLM-L6-v2 | 90MB | Fast | 75% | English only, fast search |
| gte-large | 200MB | Slow | 85% | High precision needed |

## Tier System

**FR Reference:** [FR25-29 (Transparency & Tier Awareness)](../docs/MAMA-PRD.md#fr25-29-transparency-tier-awareness)

MAMA operates in two tiers with full transparency:

| Tier | Features | Accuracy | Requirements | Status |
|------|----------|----------|--------------|--------|
| **🟢 Tier 1** | Vector search + Graph + Recency | 80% | Transformers.js + SQLite | Optimal |
| **🟡 Tier 2** | Exact match only | 40% | SQLite only | Fallback |

**Transparency Guarantee / 투명성 보장:**
Every context injection shows current tier status. You always know what's working and what's degraded.

### Tier Detection Messages

#### Tier 1 (Full Features) - 🟢

**Message:**
```
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 89ms | 3 decisions
```

**What this means:**
- ✅ Vector search enabled (semantic similarity)
- ✅ Decision graph traversal (supersedes/refines edges)
- ✅ Recency weighting (recent decisions ranked higher)
- ✅ Cross-lingual search (Korean ↔ English)

**When you see this:** Everything is working optimally. No action needed.

#### Tier 2 (Fallback Mode) - 🟡

**Message:**
```
🔍 System Status: 🟡 Tier 2 | Embeddings unavailable | ✓ 12ms | 1 decision
```

**What this means:**
- ⚠️ Vector search DISABLED (exact match only)
- ✅ Decision graph still works
- ⚠️ Accuracy dropped to ~40%
- ⚠️ Korean-English cross-lingual search unavailable

**When you see this:** System is degraded but functional. See [Tier 2 Remediation](#tier-2-fallback-mode-remediation) below.

### Tier 2 Fallback Mode Remediation

**왜 Tier 2로 떨어졌나요?** (Why did I fall back to Tier 2?)

Common causes:
1. **First install** - Transformers.js model not downloaded yet
2. **Network issue** - Model download failed during first use
3. **Disk space** - Insufficient space for model cache (~120MB)
4. **Platform incompatibility** - Some edge cases on ARM64/Windows

**해결 방법** (How to fix):

#### Step 1: Check Model Download

```bash
# Check if model cache exists
ls -la ~/.cache/huggingface/

# Expected: transformers/ directory with ~120MB
```

**없으면** (If missing): Model download failed during first use.

#### Step 2: Manual Model Download

```bash
# Force model download (takes ~987ms on first run)
node -e "
const { pipeline } = require('@huggingface/transformers');
(async () => {
  const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  console.log('✅ Model downloaded successfully');
})();
"
```

**Expected output:**
```
dtype not specified for "model". Using the default dtype (fp32) for this device (cpu).
✅ Model downloaded successfully
```

#### Step 3: Verify Disk Space

```bash
# Check available space
df -h ~

# Required: At least 500MB free for model cache + database
```

**디스크 공간 부족 시** (If insufficient space):
```bash
# Clear old model caches
rm -rf ~/.cache/huggingface/transformers/.cache

# Or choose a smaller model
/mama-configure --model Xenova/all-MiniLM-L6-v2  # 90MB instead of 120MB
```

#### Step 4: Verify Node.js Version

```bash
node --version

# Required: >= 18.0.0
# Recommended: >= 20.0.0 (for best Transformers.js support)
```

**If Node < 18:**
```bash
# Install Node.js 20 LTS
nvm install 20
nvm use 20
```

#### Step 5: Restart Claude Code

```bash
# After fixing above issues:
# 1. Quit Claude Code completely
# 2. Restart Claude Code
# 3. Try /mama-list to check tier status
```

**Expected:** Should now see `🟢 Tier 1` instead of `🟡 Tier 2`

**여전히 Tier 2인 경우** (Still Tier 2?): See [Advanced Troubleshooting](#advanced-troubleshooting) below.

## Validation

**FR Reference:** [FR50-55 (Installation Validation)](../docs/MAMA-PRD.md#fr50-55-configuration)

Run validation script to check manifest integrity:

```bash
node scripts/validate-manifests.js
```

Expected output:
```
✅ plugin.json: Valid
✅ .mcp.json: Valid
✅ All commands found
✅ All hooks executable
✅ Skill documentation present
```

**설치 검증** (Installation verification):
- 🔍 26가지 검증 항목 자동 점검 (manifests, commands, hooks, skills)
- ✅ 모든 항목이 통과해야 플러그인이 정상 작동
- ❌ 실패 시: 설치 가이드 재확인 또는 [Troubleshooting](#troubleshooting) 참조

## Testing

**FR Reference:** [FR41-44 (Testing Strategy)](../docs/MAMA-PRD.md#fr41-44-architecture)

```bash
# Run all tests
npm test

# Run specific test suite
npm test tests/skills/mama-context-skill.test.js

# Run with coverage
npm run test:coverage
```

**테스트 커버리지** (Test coverage):
- 🧪 134개 테스트 (100% 통과율)
- 📊 Unit tests: 62개 (core logic 검증)
- 🔗 Integration tests: 39개 (hook simulation, workflow simulation)
- 📈 Regression tests: 33개 (cross-cutting bugs 방지)

## Troubleshooting

**일반적인 문제 해결** (Common issues and fixes)

### 1. Plugin Not Loading

**Symptoms / 증상:**
- `/mama-*` commands don't appear in command palette
- No MAMA context injections
- Claude Code shows "Plugin load failed" error

**Solutions:**

#### Check 1: Node.js Version

```bash
node --version

# Required: >= 18.0.0
# Recommended: >= 20.0.0
```

**Node.js가 너무 오래된 경우** (If Node too old):
```bash
# Install Node 20 LTS via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
nvm alias default 20
```

#### Check 2: Plugin Structure

```bash
# Verify plugin.json exists
ls -la ~/.claude/plugins/mama/.claude-plugin/plugin.json

# Expected: File exists and is readable
```

**파일이 없으면** (If missing):
```bash
# Re-copy plugin directory
cp -r /path/to/mama-plugin ~/.claude/plugins/mama

# Verify all manifests
node ~/.claude/plugins/mama/scripts/validate-manifests.js
```

#### Check 3: Dependencies Installed

```bash
cd ~/.claude/plugins/mama
npm install

# Check for errors in output
# Common issue: better-sqlite3 compilation failure (see section below)
```

#### Check 4: Claude Code Logs

```bash
# Check Claude Code logs for plugin errors
# Logs location varies by platform:
# macOS: ~/Library/Logs/Claude/
# Linux: ~/.config/Claude/logs/
# Windows: %APPDATA%\Claude\logs\
```

### 2. SQLite Build Failures (better-sqlite3)

**Symptoms / 증상:**
```
npm ERR! node-gyp rebuild
npm ERR! gyp ERR! stack Error: Python executable "python" is not found
```

**Why this happens:**
`better-sqlite3` is a native module that needs C++ compilation. Build tools may be missing.

**Solutions by Platform:**

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

**Alternative: Use Prebuilt Binaries**

```bash
# If compilation keeps failing, try prebuilt binaries
npm install better-sqlite3 --build-from-source=false
```

### 3. Disk Space Issues

**Symptoms / 증상:**
- Model download fails
- Database writes fail
- `ENOSPC: no space left on device`

#### Check Disk Space

```bash
# Check available space
df -h ~

# Required minimum:
# - Model cache: 120MB
# - Database: 50MB initial (grows with usage)
# - Node modules: 150MB
# Total: ~500MB minimum
```

**디스크 공간 확보** (Free up space):

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

#### Database Size Management

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

### 4. Hooks Not Firing

**Symptoms / 증상:**
- No automatic context injection
- UserPromptSubmit hook doesn't show MAMA banner

#### Check 1: Hooks Enabled

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

#### Check 2: Hook Script Permissions

```bash
ls -la ~/.claude/plugins/mama/scripts/*.js

# All .js files should have execute permissions (x)
# Example: -rwxr-xr-x
```

**Fix permissions:**
```bash
chmod +x ~/.claude/plugins/mama/scripts/*.js
```

#### Check 3: Test Hook Manually

```bash
cd ~/.claude/plugins/mama

# Test UserPromptSubmit hook
export USER_PROMPT="test prompt"
export MAMA_DB_PATH=~/.claude/mama-memory.db
node scripts/userpromptsubmit-hook.js

# Expected: Should output MAMA banner or tier message
```

### 5. Database Corruption

**Symptoms / 증상:**
- `SQLITE_CORRUPT` errors
- `/mama-*` commands fail
- Database queries return empty results

#### Check Database Integrity

```bash
sqlite3 ~/.claude/mama-memory.db "PRAGMA integrity_check;"

# Expected: "ok"
# If errors shown: Database is corrupted
```

**Fix corrupted database:**

```bash
# 1. Backup existing database (just in case)
cp ~/.claude/mama-memory.db ~/.claude/mama-memory.db.backup

# 2. Try to recover
sqlite3 ~/.claude/mama-memory.db ".recover" | sqlite3 ~/.claude/mama-memory-recovered.db

# 3. If recovery fails, reset database (WARNING: loses all data)
rm ~/.claude/mama-memory.db

# 4. Restart Claude Code to recreate fresh database
```

### 6. Embedding Model Download Fails

**Symptoms / 증상:**
- Stuck at "Downloading model..."
- Network timeout errors
- Falls back to Tier 2 permanently

#### Check 1: Internet Connection

```bash
# Test connection to Hugging Face CDN
curl -I https://huggingface.co

# Expected: HTTP 200 OK
```

#### Check 2: Manual Model Download

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

#### Check 3: Verify Model Cache

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

#### Check 4: Firewall/Proxy Issues

If behind corporate firewall:

```bash
# Set proxy for npm
npm config set proxy http://proxy.company.com:8080
npm config set https-proxy http://proxy.company.com:8080

# Then retry install
cd ~/.claude/plugins/mama
npm install
```

### Advanced Troubleshooting

#### Enable Debug Logging

```bash
# Set debug environment variable
export DEBUG=mama:*

# Run command with debug output
node scripts/userpromptsubmit-hook.js

# Look for error messages in output
```

#### Check System Resources

```bash
# CPU usage
top -l 1 | grep "CPU usage"

# Memory available
free -h  # Linux
vm_stat  # macOS

# If resources constrained, MAMA may be slow
```

#### Test Individual Components

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

### Getting Help

**여전히 문제가 해결되지 않으면** (Still having issues?):

1. **Check GitHub Issues**: [mama-plugin/issues](../issues)
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

## Architecture

**FR Reference:** [FR19-24 (Hook Integration)](../docs/MAMA-PRD.md#fr19-24-hook-integration) + [FR41-44 (Architecture)](../docs/MAMA-PRD.md#fr41-44-architecture)

```
User Prompt
    ↓
UserPromptSubmit Hook (500ms timeout) ← [FR19]
    ↓
memory-inject.js (generate embedding, search, score) ← [FR8-12, FR36-38]
    ↓
Teaser Format (40 tokens) ← [FR22: Non-intrusive context]
    ↓
Claude sees context
```

**Module Boundaries:**
- `src/core/`: All business logic (embeddings, DB, scoring, graph) - [FR41](../docs/MAMA-PRD.md#fr41-modular-architecture)
- `src/commands/`: Command handlers (/mama-recall, etc.) - [FR1-7](../docs/MAMA-PRD.md#fr1-7-decision-crud)
- `src/tools/`: MCP tool handlers (save_decision, etc.) - [FR42](../docs/MAMA-PRD.md#fr42-mcp-compatibility)
- `scripts/`: Hook executables (UserPromptSubmit, PreToolUse, PostToolUse) - [FR19-21](../docs/MAMA-PRD.md#fr19-24-hook-integration)
- `skills/`: Auto-context skill documentation - [FR22](../docs/MAMA-PRD.md#fr22-non-intrusive-context)

**아키텍처 원칙** (Architecture principles):
- 🔌 Pluggable: 모든 컴포넌트는 독립적으로 교체 가능 (임베딩 모델, DB 어댑터)
- 🧪 Testable: 각 모듈은 단위 테스트 가능 (의존성 주입)
- 📦 Portable: Claude Code, Claude Desktop 모두 호환 (MCP 표준)

## Performance

**FR Reference:** [FR36-40 (Performance Requirements)](../docs/MAMA-PRD.md#fr36-40-performance-requirements)

| Operation | Target (p95) | Actual (Measured) | Status | FR |
|-----------|-------------|-------------------|--------|----|
| Hook injection latency | <500ms | ~100ms | ✅ 5x better | [FR36](../docs/MAMA-PRD.md#fr36-hook-latency) |
| Embedding generation | <30ms | 3ms | ✅ 10x better | [FR37](../docs/MAMA-PRD.md#fr37-embedding-speed) |
| Vector search | <100ms | ~50ms | ✅ PASS | [FR38](../docs/MAMA-PRD.md#fr38-search-speed) |
| Decision save | <50ms | ~20ms | ✅ PASS | [FR39](../docs/MAMA-PRD.md#fr39-save-speed) |

**성능 철학** (Performance philosophy):
- 🎯 Non-blocking: 훅은 500ms 내에 완료 (Claude 응답 지연 없음)
- 🚀 Lazy loading: 첫 검색 시에만 임베딩 모델 로드 (~987ms)
- 💾 Caching: 임베딩은 디스크에 저장 (재생성 불필요)

## Data Privacy

**FR Reference:** [FR45-49 (Privacy & Security)](../docs/MAMA-PRD.md#fr45-49-privacy-security)

✅ **100% Local** - All data stored on your device ([FR45](../docs/MAMA-PRD.md#fr45-local-storage))
✅ **No Telemetry** - Zero data sent to external servers ([FR46](../docs/MAMA-PRD.md#fr46-no-telemetry))
✅ **No Network Calls** - After initial model download ([FR47](../docs/MAMA-PRD.md#fr47-offline-mode))
✅ **User Control** - Export/import at any time ([FR48](../docs/MAMA-PRD.md#fr48-data-portability))

**Database location:** `~/.claude/mama-memory.db`

**개인정보 보호 보장** (Privacy guarantees):
- 🔒 모든 데이터는 로컬 SQLite DB에만 저장 (클라우드 전송 절대 없음)
- 🚫 텔레메트리 수집 없음 (사용 통계, 분석 데이터 전송 없음)
- 🌐 네트워크 필요 시점: 첫 설치 시 임베딩 모델 다운로드 단 한 번
- 📤 내보내기/가져오기: 언제든지 전체 DB 백업 및 마이그레이션 가능

## Development

**FR Reference:** [FR41-44 (Modular Architecture)](../docs/MAMA-PRD.md#fr41-44-architecture)

### Project Structure

```
mama-plugin/
├── .claude-plugin/
│   └── plugin.json           # Unified manifest
├── .mcp.json                  # MCP config
├── src/
│   ├── commands/              # /mama-* commands
│   ├── core/                  # Business logic
│   ├── db/                    # Database + migrations
│   └── tools/                 # MCP tool handlers
├── scripts/                   # Hook executables
├── skills/mama-context/       # Auto-context skill
├── tests/                     # Test suites
└── package.json
```

**프로젝트 구조 원칙** (Project structure principles):
- 📁 Separation of concerns: commands(CLI) vs tools(MCP) vs hooks(events)
- 🧩 Pluggable core: DB adapter, embedding model 교체 가능
- 🧪 Testable: 모든 모듈은 독립적으로 테스트 가능

### Running Tests

```bash
npm test                       # All tests
npm run test:unit             # Unit tests only
npm run test:integration      # Integration tests only
npm run test:coverage         # With coverage report
```

### Contributing

**기여 가이드** (Contribution guidelines):
1. Follow existing code style (ESLint + Prettier)
2. Add tests for new features (목표: 100% 커버리지)
3. Update documentation (README + story files)
4. Run validation: `npm run validate` (26 checks must pass)

## References

- [MAMA Architecture](../docs/MAMA-ARCHITECTURE.md)
- [MAMA PRD](../docs/MAMA-PRD.md)
- [Epic M3](../docs/epics.md)
- [Story M3.3](../docs/stories/story-M3.3.md)

## License

MIT License - see LICENSE file

## Support

- Issues: GitHub Issues
- Documentation: `docs/` directory
- Examples: See `skills/mama-context/SKILL.md`

---

**Built with ❤️ by the SpineLift Team**

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MAMA (Memory-Augmented MCP Assistant) is an always-on companion for Claude Code and Claude Desktop that remembers decision evolution. It's a monorepo containing:

1. **@jungjaehoon/mama-os** - Standalone Agent with Discord/Slack/Telegram bots (packages/standalone/)
2. **@jungjaehoon/mama-server** - MCP server published to npm (packages/mcp-server/)
3. **@jungjaehoon/mama-core** - Shared core modules (packages/mama-core/)
4. **MAMA Plugin** - Claude Code plugin distributed via marketplace (packages/claude-code-plugin/)
5. **@jungjaehoon/openclaw-mama** - OpenClaw Gateway plugin (packages/openclaw-plugin/)

## Build & Test Commands

```bash
# Install dependencies (requires pnpm)
pnpm install

# Run all tests across both packages
pnpm test

# Build all packages
pnpm build

# Run type checking
pnpm typecheck

# Clean all build artifacts
pnpm clean
```

### Package-Specific Commands

**Standalone (packages/standalone/):**

```bash
mama start                   # Start MAMA OS (global CLI, requires: npx @jungjaehoon/mama-os)
mama stop                    # Stop MAMA OS
mama status                  # Check status
```

**MCP Server (packages/mcp-server/):**

```bash
cd packages/mcp-server
npm start                    # Start MCP server via stdio
pnpm test                    # Run MCP server tests
```

**Plugin (packages/claude-code-plugin/):**

```bash
cd packages/claude-code-plugin
pnpm test                    # Run plugin tests (hooks, commands, core)
pnpm test:watch              # Watch mode for tests

# Link plugin for local testing
ln -s $(pwd) ~/.claude/plugins/repos/mama
```

### Running Single Tests

```bash
# Run specific test file
pnpm vitest run tests/hooks/pretooluse-hook.test.js

# Run tests matching pattern
pnpm vitest run -t "relevance scorer"
```

## Development Philosophy

### Reuse-First Approach

**CRITICAL:** Before adding new features, check if they exist in `packages/mcp-server/src/mama/`. In November 2025, we stopped a rewrite and migrated working code instead (~70% of required functionality already existed).

**Before contributing:**

1. Search existing code in both packages
2. Check migration history in docs/development/developer-playbook.md
3. Prefer extracting proven patterns over inventing new ones

Reference: dev-docs/project/code-reuse-analysis.md (local development docs)

### Code Organization Rules

**MCP Server:**

- Pure JavaScript (no TypeScript)
- No web framework dependencies
- All AI/database operations live here
- Stdio transport only

**Plugin:**

- Lightweight markdown-based commands
- Hook scripts must be fast (<1s)
- Teaser format for frequent hooks (40 tokens)
- Full details on demand via commands

### Testing Requirements

**Always run tests before committing:**

```bash
pnpm test
```

**Test coverage targets:**

- Core logic: Unit tests with 80%+ coverage
- Hooks: Integration tests verifying timing/rate limits
- Commands: End-to-end tests with MCP tool calls
- Regressions: Tests for all reported bugs

**Run specific test suites:**

```bash
# Hook tests
pnpm vitest run tests/hooks/

# Core module tests
pnpm vitest run tests/core/

# Command tests
pnpm vitest run tests/commands/
```

## Key Features & Constraints

### Decision Storage

- **Database:** SQLite + sqlite-vec extension
- **Location:** `~/.claude/mama-memory.db` (configurable via MAMA_DB_PATH)
- **Schema:** decisions table with embedding_vector column
- **Graph edges:** `supersedes`, `builds_on`, `debates`, `synthesizes` (v1.3), plus legacy `refines`/`contradicts`

### Embeddings

- **Model:** Xenova/all-MiniLM-L6-v2 (Transformers.js)
- **Dimension:** 384-dimensional vectors
- **Language:** Cross-lingual (English + Korean)
- **Local-first:** No API calls, runs entirely on device

### Hook Performance

- **UserPromptSubmit:** Target <1200ms (~150ms actual with HTTP embedding server; only active hook)
- **PreToolUse/PostToolUse:** Disabled (scripts retained for future use)
- **Token budget:** 40 tokens (teaser format for UserPromptSubmit)
- **HTTP Embedding Server:** Port 3847, model stays in memory for fast embedding requests

### MCP Tool Schema

All tools follow standard MCP patterns:

- Input validation via JSON schema
- Error handling with typed error codes
- Result format: `{ success: boolean, data?: any, error?: string }`

## Release & Deployment

### 1. MAMA OS (packages/standalone/) → npm

```bash
# 1. Version bump
# Edit packages/standalone/package.json "version" field
# Update CHANGELOG.md with new version entry

# 2. Commit & tag
git add packages/standalone/package.json CHANGELOG.md
git commit -m "chore(release): bump mama-os to vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags

# 3. Create GitHub Release (triggers GitHub Actions auto-publish)
gh release create vX.Y.Z --title "vX.Y.Z" --notes "See CHANGELOG.md"

# 4. Verify
npm view @jungjaehoon/mama-os version
```

- **Target**: npmjs.org (`@jungjaehoon/mama-os`)
- **Trigger**: GitHub Release → `.github/workflows/publish.yml`
- **Install**: `npx @jungjaehoon/mama-os@latest`

### 2. MCP Server (packages/mcp-server/) → npm

```bash
# Same flow as MAMA OS but with mcp-server version
# Edit packages/mcp-server/package.json
git tag mcp-server-vX.Y.Z
gh release create mcp-server-vX.Y.Z --title "MCP Server vX.Y.Z"
```

- **Target**: npmjs.org (`@jungjaehoon/mama-server`)
- **Install**: `npx @jungjaehoon/mama-server`

### 3. MAMA Core (packages/mama-core/) → npm

```bash
# Edit packages/mama-core/package.json
git tag mama-core-vX.Y.Z
gh release create mama-core-vX.Y.Z --title "MAMA Core vX.Y.Z"
```

- **Target**: npmjs.org (`@jungjaehoon/mama-core`)

### 4. Claude Code Plugin (packages/claude-code-plugin/) → Git

```bash
# 1. Version bump (BOTH files must match!)
# Edit packages/claude-code-plugin/package.json "version"
# Edit packages/claude-code-plugin/.claude-plugin/plugin.json "version"

# 2. Commit & push
git add packages/claude-code-plugin/package.json packages/claude-code-plugin/.claude-plugin/plugin.json
git commit -m "chore(release): bump plugin version to X.Y.Z"
git push origin main
```

- **Target**: Git repository (no npm publish)
- **Distribution**: Symlink (`~/.claude/plugins/repos/mama`) or marketplace
- **Important**: `plugin.json` and `package.json` versions must match (test enforces this)

### 5. Hotfix Release (MAMA OS)

```bash
# Quick fix → commit → tag → release in one flow
git add <changed-files>
git commit -m "fix(standalone): description"
# Bump version in package.json + CHANGELOG.md
git add packages/standalone/package.json CHANGELOG.md
git commit -m "chore(release): bump mama-os to vX.Y.Z"
git tag vX.Y.Z && git push origin main --tags
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Hotfix: description"
```

## Decision Recording

When changing API contracts, architecture decisions, or important implementation patterns, **always save to MAMA**:

```bash
/mama:decision topic="api_contract_name" decision="decision content" reasoning="reason"
```

Once saved:

- Automatically displayed via hook when reading related files later
- Searchable via `/mama:search`
- Decision history (evolution graph) can be tracked

**Things that should be saved:**

- API endpoint additions/changes
- Config schema changes
- Important function signature changes
- Architecture pattern decisions

## Important Constraints

1. **Never rewrite working code** - Check mcp-server/src/mama/ first
2. **Keep hooks fast** - UserPromptSubmit should complete within 1800ms
3. **Local-first** - No network calls in core functionality
4. **Backward compatibility** - Existing decisions must remain valid
5. **Test before commit** - All tests must pass (`pnpm test`)
6. **SQLite schema changes** - Require migration scripts
7. **Embedding model** - Cannot change without breaking existing vectors

## ⚠️ MAMA OS Agent Isolation — Do Not Modify Under Any Circumstances

MAMA OS agents must **operate only within the `.mama` scope**. Global settings must never leak into agents.

**Never modify the following in `persistent-cli-process.ts` + `claude-cli-wrapper.ts`:**

| Setting             | Value                                      | Reason                                                                        |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `cwd`               | `~/.mama/workspace`                        | Changing to `os.homedir()` causes `~/CLAUDE.md` to be injected every turn     |
| `.git/HEAD`         | `~/.mama/workspace/.git/HEAD`              | git boundary blocks upward traversal for CLAUDE.md                            |
| `--plugin-dir`      | `~/.mama/.empty-plugins` (empty directory) | Removing it causes global plugin skills to be injected redundantly every turn |
| `--setting-sources` | `project,local` (excludes user)            | Including `user` loads enabledPlugins from `~/.claude/settings.json`          |
| `--system-prompt`   | First turn only (persistent)               | No need for repeated injection in session persistence mode                    |

**Prohibited actions:**

- Reverting `cwd` to `os.homedir()`
- Removing the `--plugin-dir` flag
- Adding `user` to `--setting-sources` (loads global plugins)
- Adding the `--no-session-persistence` flag
- Removing the `.git/HEAD` creation logic

**Reason:** MAMA already includes persona + skills + gateway tools in `--system-prompt`. If Claude Code CLI reloads the same content from `~/CLAUDE.md` and global plugins, **thousands of tokens are wasted on duplication every turn**.

## Multi-Agent API

### Update Agent Config

```bash
# PUT /api/multi-agent/agents/:agentId
curl -X PUT 'http://localhost:3847/api/multi-agent/agents/developer' \
  -H "Content-Type: application/json" \
  -d '{"backend": "claude", "model": "claude-opus-4-5-20251101"}'
```

**Body fields:**

- `backend`: "claude" | "codex" | "codex-mcp"
- `model`: Model ID (e.g., "claude-opus-4-5-20251101", "gpt-5.3-codex")
- `tier`: 1-3 (tool permission level)
- `enabled`: boolean
- `can_delegate`: boolean

**Notes:**

- Each agent must be saved individually in the Settings UI
- Hard-coded model names in persona files are dynamically replaced in `buildSystemPrompt()`
- Hot-reload: `updateConfig()` stops all process pools (processPool, codexProcessPool, agentProcessPool)

## Getting Help

- **Issues:** https://github.com/jungjaehoon-lifegamez/MAMA/issues
- **Docs:** docs/index.md
- **Developer Playbook:** docs/development/developer-playbook.md

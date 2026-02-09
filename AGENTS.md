# MAMA PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-08 16:13:50  
**Commit:** 254557e  
**Branch:** refactor/mcp-server-core-dedup

---

## OVERVIEW

MAMA (Memory-Augmented MCP Assistant) — Contract-first memory system for Claude. Tracks WHY you decided, not just WHAT you chose. Prevents vibe coding breakage across sessions. Monorepo with 5 packages: MCP server (npm), Claude Code plugin (marketplace), MAMA OS standalone agent (npm), OpenClaw plugin (npm), shared core (npm).

**Stack:** JavaScript (MCP/plugin), TypeScript (standalone), pnpm workspaces, Vitest, SQLite + sqlite-vec, Transformers.js (local embeddings), GitHub Actions

---

## STRUCTURE

```
MAMA/
├── packages/
│   ├── mama-core/                  # Shared foundation (32 modules: embeddings, db, memory API)
│   ├── mcp-server/                 # MCP server for Claude Desktop/Code (4 tools: save/search/update/checkpoint)
│   ├── claude-code-plugin/         # Claude Code plugin (commands + hooks + local mama-core copies)
│   ├── standalone/                 # MAMA OS agent (Discord/Slack/Telegram, multi-agent swarm, CLI, web UI)
│   └── openclaw-plugin/            # OpenClaw gateway plugin
├── docs/                           # User-facing documentation (Diátaxis framework)
├── .mama/                          # Project identity (SOUL.md, IDENTITY.md, config.json)
├── .sisyphus/                      # Internal planning artifacts (drafts/, plans/)
├── .docs/                          # Development docs (PRDs, tech specs, epics, stories)
├── .claude-plugin/                 # Local dev marketplace config
├── scripts/                        # Build utilities (verify-install.js, sync-check.js, ensure-sqlite-prebuild.js)
├── .husky/                         # Git hooks (pre-commit: lint-staged + gitleaks + typecheck + tests)
└── CLAUDE.md                       # Claude Code guidance (CRITICAL: read this before editing)
```

---

## WHERE TO LOOK

| Task                          | Location                                                      | Notes                                                 |
| ----------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| **Add memory feature**        | `packages/mama-core/src/mama-api.js`                          | High-level API (2,615 lines — SPLIT CANDIDATE)        |
| **Add MCP tool**              | `packages/mcp-server/src/tools/`                              | All tools use `mama-core/mama-api`                    |
| **Modify embeddings**         | `packages/mama-core/src/embeddings.js`                        | HTTP client + local Transformers.js fallback          |
| **Modify database**           | `packages/mama-core/src/db-manager.js` + `src/db/migrations/` | SQLite + sqlite-vec, migrations required              |
| **Add Claude Code command**   | `packages/claude-code-plugin/commands/*.md`                   | Markdown-based command definitions                    |
| **Modify hooks**              | `packages/claude-code-plugin/scripts/*.js`                    | Hook scripts (must complete <1800ms)                  |
| **Add gateway integration**   | `packages/standalone/src/gateways/*.ts`                       | Discord, Slack, Telegram handlers                     |
| **Modify multi-agent**        | `packages/standalone/src/multi-agent/swarm/`                  | Wave-based orchestration (5 waves, tier-based access) |
| **Fix reuse-first violation** | Check `packages/mcp-server/src/mama/` FIRST                   | CRITICAL: 70% of features already exist here          |
| **Run all tests**             | `pnpm test` (root)                                            | Single-fork pool required (ONNX/V8 locking)           |
| **Build all packages**        | `pnpm build` (root)                                           | TypeScript compile for standalone only                |
| **Lint + format**             | `pnpm lint:fix && pnpm format`                                | ESLint + Prettier auto-fix                            |

---

## CONVENTIONS

### **Language Split**

- **JavaScript:** mama-core, mcp-server, claude-code-plugin (pure .js files)
- **TypeScript:** standalone only (tsconfig.json, .ts files, `dist/` output)
- **Rationale:** Standalone has complex agent orchestration; others are simpler MCP/plugin layers

### **Vitest Configuration (CRITICAL)**

```javascript
pool: 'forks',
poolOptions: { forks: { singleFork: true } },
maxWorkers: 1, minWorkers: 1, threads: false
```

**Why:** Prevents ONNX Runtime V8 locking issues with Transformers.js embeddings. **NEVER change to parallel execution.**

### **ESLint Deviations from Standard**

- `no-console: off` — Console logs allowed in production code
- Unused variables: `_variable` ignored (underscore prefix)
- Strict equality: `===` always (no `==`)
- Curly braces: Required for all control structures (even single-line)
- Error handling: Must throw Error objects (no literals)

### **Prettier**

- Semicolons: Required
- Quotes: Single quotes
- Tab width: 2 spaces
- Print width: 100 characters (narrower than default 80)
- Trailing commas: ES5 style

### **Test Organization (Story-Based)**

```javascript
describe('Story M1.2: SQLite Database Initialization', () => {
  describe('AC #1: Database file creation', () => {
    it('should create database file on initialization', async () => {
      // Test implementation
    });
  });
});
```

- Tests map to Story IDs (M1.2, M2.1, Story 4.1)
- Acceptance Criteria (AC) sections enable requirements → tests → code traceability
- Use `MAMA_FORCE_TIER_3=true` to skip embeddings in tests (~500ms vs ~2-9s)

### **pnpm Workspace**

- **Ignored built dependencies:** `better-sqlite3`, `esbuild`, `node-pty`, `onnxruntime-node`, `protobufjs`, `sharp` (native modules)
- **Unsafe permissions:** Enabled (`unsafePerm: true`) for native module compilation
- **GitHub Packages:** `@jungjaehoon/*` packages published to GitHub Packages (not npm)

### **Entry Point Naming (INCONSISTENT)**

- `src/server.js` (mcp-server)
- `src/index.js` (mama-core)
- `dist/index.js` (standalone, compiled)
- `index.ts` (openclaw-plugin, raw TypeScript)
- `.claude-plugin/plugin.json` (claude-code-plugin, no main field)

---

## ANTI-PATTERNS (THIS PROJECT)

### **FORBIDDEN (CRITICAL)**

```javascript
// ❌ FORBIDDEN: Rewrite working code
// ALWAYS check packages/mcp-server/src/mama/ first
// In November 2025, we stopped a rewrite and migrated working code instead (~70% existed)

// ❌ FORBIDDEN: Return dummy/fallback data on errors
return { bones: [] };           // Silent failure hides bugs
if (error) return defaultValue; // Silent fallback

// ✅ REQUIRED: Throw explicit errors
if (!data) throw new Error("Data required");

// ❌ FORBIDDEN: Change embedding model
// Breaks existing 384-dimensional vectors in SQLite

// ❌ FORBIDDEN: SQLite schema changes without migrations
// Create migration file in packages/*/src/db/migrations/

// ❌ FORBIDDEN: Network calls in core functionality
// Local-first architecture (exceptions: HTTP embedding server on localhost:3847)

// ❌ FORBIDDEN: Break backward compatibility
// Existing decisions must remain valid after updates

// ❌ FORBIDDEN: Hook execution >1800ms
// UserPromptSubmit hook must complete within 1800ms (target <1200ms)

// ❌ FORBIDDEN: Using `any` type
const x: any = getData();       // No type safety
const x: Decision = getData();  // ✅ REQUIRED

// ❌ FORBIDDEN: Using `console.log`
console.log('debug info');      // Use DebugLogger instead
DebugLogger.log('debug info');  // ✅ REQUIRED

// ❌ FORBIDDEN: TODO/FIXME in commits
// TODO: Fix this later          // Remove before committing
// FIXME: Handle edge case       // Remove before committing

// ❌ FORBIDDEN: Mock internal code in tests
// Test real implementation, not mocks
```

### **Security Warnings**

```bash
# ⚠️ CRITICAL: Never expose MAMA without authentication
# Attackers can read/write ANY file, execute ANY command, steal keys

# ⛔ FORBIDDEN: Use token auth alone for production
# Require mTLS or IP whitelist + token

# ⚠️ FORBIDDEN: Commit tokens to git
# Use environment variables or secure vaults

# ⚠️ FORBIDDEN: Share tunnel URLs publicly
# Treat as sensitive credentials

# ⚠️ FORBIDDEN: Disable authentication on tunnels
# Always set MAMA_AUTH_TOKEN before exposing
```

### **Module Boundaries**

```bash
# ❌ NEVER edit mcp-server/ for MAMA plugin development
# mcp-server/ is frozen as source of truth for legacy deployments

# ✅ ALWAYS edit mama-plugin/ for plugin-specific features

# ❌ NEVER edit mama-core without checking both mcp-server and claude-plugin
# Both depend on mama-core (mcp-server imports it, plugin has local copies)
```

---

## UNIQUE STYLES

### **Wave-Based Multi-Agent Architecture**

```
packages/standalone/src/multi-agent/swarm/
├── Wave 1: Initial analysis (read-only)
├── Wave 2: Planning (Tier 1 agent)
├── Wave 3: Implementation (Tier 2 agents)
├── Wave 4: Review (Tier 3 agents)
└── Wave 5: Completion (Tier 1 agent)
```

Sequential wave progression enables tier-based access control. Tasks within each wave execute in parallel via `Promise.all` (`wave-engine.ts` line 111).

### **AgentProcessPool (Parallel Execution)**

```
packages/standalone/src/multi-agent/agent-process-pool.ts (356 lines)
- Per-agent process pools with configurable pool_size (default: 1)
- Automatic process reuse when idle (no cold start)
- Idle timeout: 5-10 min (configurable via idleTimeoutMs)
- Hung process detection: 15 min (auto-kill via hungTimeoutMs)
- Pool status: total / busy / idle per agent
```

Configure via `config.yaml`:

```yaml
multi_agent:
  agents:
    developer:
      pool_size: 3 # 3 parallel Claude CLI processes
```

Key code path: `AgentProcessManager` (line 81: `defaultPoolSize: 1`) → `AgentProcessPool.getAvailableProcess()` → `PersistentClaudeProcess`

### **Tier System (Automatic, Not User-Selected)**

- **Tier 1:** Vector search + Graph + Recency (80% accuracy) — Requires embedding model
- **Tier 2:** Exact match only (40% accuracy) — Automatic fallback when sqlite-vec extension fails
- **Tier 3:** Skip embeddings entirely — Testing mode (`MAMA_FORCE_TIER_3=true`)

Tier degradation happens automatically at runtime (not user-configurable).

### **HTTP Embedding Server (Shared Across All Clients)**

```
127.0.0.1:3847 (configurable)
- Model stays loaded in memory
- ~50ms embedding requests (vs 2-9s cold start)
- Shared by Claude Code, Desktop, Cursor, Aider, etc.
- Port discovery via ~/.mama-embedding-port
```

### **Subprocess-Based Claude CLI (ToS Compliance)**

```typescript
// Spawns Claude CLI as subprocess (not direct API calls)
const child = spawn('claude', [...args]);
// INTENTIONAL: Avoids OAuth token extraction (ToS gray area)
```

### **Code Duplication in Claude Plugin (Unavoidable)**

```
claude-code-plugin/src/core/ — 27 modules duplicated from mama-core
Why: Claude Code plugins can't have npm dependencies; files must be self-contained
Risk: Bug fixes in mama-core don't propagate to plugin (version skew)
Mitigation: Keep copies in sync; consider bundling mama-core at build time
```

### **Reuse-First Philosophy**

```
CRITICAL: Before adding new features, check if they exist in
`packages/mcp-server/src/mama/`. In November 2025, we stopped a rewrite
and migrated working code instead (~70% of required functionality already existed).
```

---

## COMMANDS

```bash
# Install dependencies (requires pnpm)
pnpm install

# Run all tests (across all packages)
pnpm test

# Build all packages
pnpm build

# Run type checking
pnpm typecheck

# Lint + auto-fix
pnpm lint:fix

# Format code
pnpm format

# Clean build artifacts
pnpm clean

# Package-specific commands
cd packages/mcp-server
pnpm test                    # Run MCP server tests
npm start                    # Start MCP server via stdio

cd packages/claude-code-plugin
pnpm test                    # Run plugin tests (hooks, commands, core)
pnpm test:watch              # Watch mode for tests

cd packages/standalone
pnpm build                   # Compile TypeScript to dist/
pnpm test                    # Run standalone tests with coverage
mama start                   # Start MAMA OS agent (requires global install)

# Run single test file
pnpm vitest run tests/hooks/pretooluse-hook.test.js

# Run tests matching pattern
pnpm vitest run -t "relevance scorer"
```

---

## NOTES

### **Gotchas**

1. **ONNX Runtime V8 Locking:** Tests MUST run in single-fork mode (vitest config). Parallel tests will deadlock.

2. **Entry Point Inconsistency:** No standard naming convention across packages (server.js, index.js, dist/index.js, index.ts). Be careful when importing.

3. **Claude Plugin Duplication:** Plugin has local copies of mama-core modules. Bug fixes need to be applied twice (mama-core + plugin).

4. **Standalone Pins mama-server v1.5.11:** Current mcp-server is v1.7.2. Update standalone's dependency or document why v1.5.11 is required.

5. **Backward Compatibility Checks Legacy Paths:** Database adapter checks `~/.spinelift/memories.db` for users upgrading from SpineLift. Auto-migration without user action.

6. **Dead Code (PostgreSQL Statement Class):** `claude-code-plugin/src/core/db-adapter/statement.js` has PostgreSQL statement class that's never instantiated. Remove or complete multi-database support.

7. **Metrics Logged But Not Analyzed:** Hook metrics written to files (`mama-core/src/mama/hook-metrics.js`) but never aggregated or analyzed. Missing observability.

8. **Large File Complexity:** `mama-api.js` (2,615 lines, CC=175) and `graph-api.js` (2,239 lines, CC=171) should be split into smaller modules (save/recall/suggest/update/checkpoint). See `docs/development/refactoring-roadmap.md` for plan.

9. **Configuration Format Inconsistency:** YAML for standalone, JSON for others. No documented convention.

10. **Root-Level Database File:** `mama-memory.db` at monorepo root (not in .gitignore'd directory). Typically would be in `~/.claude/` or similar user directory. Shared across all packages.

---

## RELATED DOCS

- [Developer Playbook](docs/development/developer-playbook.md) — Architecture & standards
- [CLAUDE.md](CLAUDE.md) — Claude Code guidance (CRITICAL: read this before editing)
- [Testing Guide](docs/development/testing.md) — Test suite details
- [Code Standards](docs/development/code-standards.md) — Non-negotiable rules
- [Security Guide](docs/guides/security.md) — CRITICAL security warnings

---

**Node.js:** >= 22.0.0  
**pnpm:** >= 8.0.0  
**License:** MIT  
**Author:** SpineLift Team

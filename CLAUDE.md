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

## Architecture

### Two-Package Design

MAMA uses a split architecture to enable code reuse across multiple Claude clients:

```
┌─────────────────────────────────────────────────────────┐
│              MAMA Plugin Ecosystem                      │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Claude Code Plugin          Claude Desktop             │
│  ┌──────────────────┐       ┌──────────────┐            │
│  │ Commands         │       │  MCP Client  │            │
│  │ Skills           │───┐   │              │            │
│  │ Hooks            │   │   └──────────────┘            │
│  └──────────────────┘   │          │                    │
│                          │          │                    │
│                    ┌─────▼──────────▼─────┐             │
│                    │  MCP Server (stdio)  │             │
│                    │  @jungjaehoon/mama-server│         │
│                    └──────────────────────┘             │
│                              │                           │
│                    ┌─────────▼──────────┐                │
│                    │ HTTP Embedding API │                │
│                    │ port 3847 (local)  │                │
│                    └─────────▼──────────┘                │
│                    ┌─────────▼──────────┐                │
│                    │   Core Components  │                │
│                    │ - Embeddings       │                │
│                    │ - SQLite+vec       │                │
│                    │ - Decision Graph   │                │
│                    └────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

**Key Points:**

- **MCP Server** is an independent npm package shared by all clients
- **Plugin** is lightweight (commands/hooks/skills) and references the server via `.mcp.json`
- One MCP server = shared decision database across all tools
- Heavy dependencies (better-sqlite3, transformers.js, sqlite-vec) live in the server package

### MCP Server (packages/mcp-server/)

**Core Modules (src/mama/):**

- `mama-api.js` - Main API interface
- `db-manager.js` - SQLite database initialization
- `embeddings.js` - Transformers.js embedding generation
- `memory-store.js` - Decision CRUD operations
- `relevance-scorer.js` - Semantic similarity scoring
- `decision-tracker.js` - Decision graph management
- `transparency-banner.js` - Tier status display
- `query-intent.js` - Query interpretation

**MCP Tools (4 core tools, v1.3.0):**

The MCP server exposes only 4 tools. Design principle: LLM can infer decision evolution from time-ordered search results. Fewer tools = more LLM flexibility.

| Tool              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `save`            | Save decision (`type='decision'`) or checkpoint (`type='checkpoint'`) |
| `search`          | Semantic search (with `query`) or list recent items (without `query`) |
| `update`          | Update decision outcome (case-insensitive: success/failed/partial)    |
| `load_checkpoint` | Resume previous session                                               |

**Edge Types (v1.3):**

Decisions connect through relationships. Auto-detected from reasoning field:

| Edge Type     | Pattern                                 | Usage                        |
| ------------- | --------------------------------------- | ---------------------------- |
| `supersedes`  | (automatic for same topic)              | Newer version replaces older |
| `builds_on`   | `builds_on: decision_xxx`               | Extends prior work           |
| `debates`     | `debates: decision_xxx`                 | Presents alternative view    |
| `synthesizes` | `synthesizes: [decision_a, decision_b]` | Merges multiple approaches   |

**Transport:** Stdio-based MCP protocol (no HTTP server)

### Claude Code Plugin (packages/claude-code-plugin/)

**Commands (commands/):**

- `/mama-save` - Save decisions to memory
- `/mama-recall` - Search decisions by query
- `/mama-suggest` - Find related decisions
- `/mama-list` - Browse all decisions
- `/mama-configure` - Plugin settings

**Skills (skills/mama-context/):**

- `SKILL.md` - Auto-context injection spec
- Wraps hooks for background decision surfacing

**Hooks (scripts/):**

- `userpromptsubmit-hook.js` - Inject context on every prompt (75% threshold, 40 token teaser)
- `pretooluse-hook.js` - Inject context before Read/Edit/Grep (70% threshold, file-specific)
- `posttooluse-hook.js` - Track decision outcomes after tool execution

**Core Modules (src/core/):**

- Shares some modules with MCP server (db-manager, embeddings, relevance-scorer)
- `hook-metrics.js` - Hook performance tracking
- `config-loader.js` - Plugin configuration

**Tests (tests/):**

- Unit tests: 62 (core logic)
- Integration tests: 39 (hooks, workflows)
- Regression tests: 33 (bug prevention)
- 100% pass rate

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

## Common Tasks

### Adding a New MCP Tool

1. Create tool file in `packages/mcp-server/src/tools/{tool-name}.js`
2. Export tool definition with schema
3. Register in `packages/mcp-server/src/server.js`
4. Add tests in `packages/mcp-server/tests/tools/{tool-name}.test.js`
5. Update tool list in server.js:setupHandlers()

### Adding a New Command

1. Create `packages/claude-code-plugin/commands/{command-name}.md`
2. Add frontmatter: description, allowed-tools, model
3. Register in `.claude-plugin/plugin.json` commands array
4. Add test in `tests/commands/`
5. Update docs/reference/commands.md

### Adding a New Hook

1. Create hook script in `packages/claude-code-plugin/scripts/{hook-name}.js`
2. Export hook handler following hook spec
3. Create hook config in root (or define inline in plugin.json)
4. Register in `.claude-plugin/plugin.json` hooks array
5. Add performance tests (timing, rate limits)

### Modifying Core Logic

1. **First check:** Does this exist in mcp-server/src/mama/?
2. If yes: Modify there, ensure backward compatibility
3. If no: Add to server package, export for plugin if needed
4. Update shared tests in both packages
5. Run full test suite: `pnpm test`

## Dependencies

### MCP Server

- `@modelcontextprotocol/sdk` - MCP protocol
- `@huggingface/transformers` - Local embeddings
- `better-sqlite3` - SQLite database
- `sqlite-vec` - Vector similarity extension

### Plugin

- Minimal dependencies (chalk for CLI colors)
- References MCP server via npx

### Development

- `vitest` - Test runner
- `pnpm` - Package manager (workspaces)
- Node.js >= 18.0.0

## Documentation Structure

Full docs in `docs/` following Diátaxis framework:

- **Tutorials:** Getting started guides
- **Guides:** Installation, troubleshooting, workflows
- **Reference:** Commands, MCP tools, architecture
- **Development:** Contributing, testing, architecture deep-dives

Key docs:

- [Developer Playbook](docs/development/developer-playbook.md) - Architecture & standards
- [Deployment Architecture](docs/development/deployment-architecture.md) - How MAMA is distributed
- [Testing Guide](docs/development/testing.md) - Test suite details

## Monorepo Status

**Current State:** Monorepo fully operational (5 packages)

**Packages:**

- @jungjaehoon/mama-os v0.3.1 - Standalone Agent
- @jungjaehoon/mama-server v1.6.6 - MCP Server
- @jungjaehoon/mama-core v1.0.1 - Shared Core
- mama v1.6.6 - Claude Code Plugin
- @jungjaehoon/openclaw-mama - OpenClaw Plugin

**Infrastructure:**

- pnpm workspaces configured
- Tests passing (1000+ tests, 100% pass rate)
- Build system functional
- npm publishing configured

## Important Constraints

1. **Never rewrite working code** - Check mcp-server/src/mama/ first
2. **Keep hooks fast** - UserPromptSubmit should complete within 1800ms
3. **Local-first** - No network calls in core functionality
4. **Backward compatibility** - Existing decisions must remain valid
5. **Test before commit** - All tests must pass (`pnpm test`)
6. **SQLite schema changes** - Require migration scripts
7. **Embedding model** - Cannot change without breaking existing vectors

## Getting Help

- **Issues:** https://github.com/jungjaehoon-lifegamez/MAMA/issues
- **Docs:** docs/index.md
- **Developer Playbook:** docs/development/developer-playbook.md

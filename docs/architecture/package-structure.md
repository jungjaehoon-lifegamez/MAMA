# Package Structure

MAMA uses a five-package monorepo architecture with shared core modules to eliminate code duplication and enable independent package updates.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│              MAMA Package Ecosystem                      │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Claude Code Plugin          Claude Desktop             │
│  ┌──────────────────┐       ┌──────────────┐            │
│  │ Commands         │       │  MCP Client  │            │
│  │ Skills           │───┐   │              │            │
│  │ Hooks            │   │   └──────────────┘            │
│  └──────────────────┘   │          │                    │
│           │              │          │                    │
│           │        ┌─────▼──────────▼─────┐             │
│           │        │  MCP Server (stdio)  │             │
│           │        │  @jungjaehoon/mama-server│         │
│           │        │  Pure MCP (no HTTP)  │             │
│           │        └──────────┬────────────┘             │
│           │                   │                          │
│           │                   │ uses                     │
│           │                   ▼                          │
│           │        ┌──────────────────────┐              │
│           └───────>│   MAMA Core          │              │
│                    │ @jungjaehoon/mama-core│             │
│                    │ - Embeddings         │              │
│                    │ - SQLite+vec         │              │
│                    │ - Decision Graph     │              │
│                    │ - Memory Store       │              │
│                    └──────────┬────────────┘             │
│                               │                          │
│  Optional HTTP Server         │ uses                     │
│  ┌──────────────────┐         │                          │
│  │ Standalone       │─────────┘                          │
│  │ - Graph Viewer   │                                    │
│  │ - Mobile Chat    │                                    │
│  │ - Embed API      │                                    │
│  │ (port 3847)      │                                    │
│  └──────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

## Package Dependencies

### Dependency Graph

```
mama-core (foundation)
    ↑
    ├── mcp-server (workspace:*)
    ├── claude-code-plugin (workspace:*)
    └── standalone (workspace:*)
```

All packages depend on `mama-core` using pnpm workspace dependencies (`workspace:*`). This ensures:

- Single source of truth for core functionality
- No code duplication
- Consistent behavior across all packages
- Independent package versioning

## Package Descriptions

### 1. @jungjaehoon/mama-core

**Purpose:** Shared core modules for all MAMA packages

**Location:** `packages/mama-core/`

**Key Modules:**

- `embeddings.js` - Transformers.js embedding generation
- `db-manager.js` - SQLite database initialization
- `memory-store.js` - Decision CRUD operations
- `mama-api.js` - High-level API interface
- `decision-tracker.js` - Decision graph management
- `relevance-scorer.js` - Semantic similarity scoring

**Dependencies:**

- `@huggingface/transformers` - Local embeddings
- `better-sqlite3` - SQLite database
- `sqlite-vec` - Vector similarity extension

**Distribution:** npm package (future)

**Used by:** All other packages

### 2. @jungjaehoon/mama-server

**Purpose:** Pure MCP protocol server (stdio transport)

**Location:** `packages/mcp-server/`

**Key Features:**

- Exposes 4 MCP tools: `save`, `search`, `update`, `load_checkpoint`
- Stdio-based transport (no HTTP)
- Shared across all MCP clients

**Dependencies:**

- `@modelcontextprotocol/sdk` - MCP protocol
- `@jungjaehoon/mama-core` (workspace:\*) - Core functionality

**Distribution:** npm package (`@jungjaehoon/mama-server`)

**Used by:** Claude Desktop, Cursor, Aider, any MCP client

### 3. MAMA Plugin (claude-code-plugin)

**Purpose:** Claude Code plugin with commands and hooks

**Location:** `packages/claude-code-plugin/`

**Key Features:**

- Commands: `/mama-save`, `/mama-recall`, `/mama-suggest`, etc.
- Hooks: Auto-context injection on user prompts
- Skills: Background decision surfacing

**Dependencies:**

- `@jungjaehoon/mama-core` (workspace:\*) - Core functionality
- Minimal additional dependencies (chalk for CLI colors)

**Distribution:** Claude Code marketplace

**Used by:** Claude Code CLI

### 4. @jungjaehoon/mama-os

**Purpose:** Autonomous AI agent with gateway integrations

**Location:** `packages/standalone/`

**Key Features:**

- **Agent Loop:** Autonomous conversation handling with Claude API
- **Gateway Integrations:** Discord, Slack, Telegram bot support
- **Multi-Agent Swarm:** 3-tier agent hierarchy with delegation and UltraWork mode
- **Onboarding Wizard:** 10-phase autonomous discovery
- **Cron Scheduler:** Scheduled task execution with heartbeat
- **MAMA OS Viewer:** Graph viewer and mobile chat interface
- **CLI Commands:** `mama init`, `start`, `stop`, `status`, `run`, `setup`

**Dependencies:**

- `@jungjaehoon/mama-core` (workspace:\*) - Core functionality
- `@anthropic-ai/sdk` - Claude API integration
- `discord.js`, `@slack/bolt`, `node-telegram-bot-api` - Gateway integrations
- `express`, `ws` - HTTP/WebSocket server

**Distribution:** npm package (`@jungjaehoon/mama-os`)

**Used by:** Standalone deployment, bot integrations

### 5. @jungjaehoon/openclaw-mama

**Purpose:** OpenClaw/Moltbot native plugin

**Location:** `packages/openclaw-plugin/`

**Key Features:**

- Auto-recall on `before_agent_start`
- 4 native tools: `mama_search`, `mama_save`, `mama_load_checkpoint`, `mama_update`
- Auto-capture detection on `agent_end`
- Context injection via `prependContext`

**Dependencies:**

- `@jungjaehoon/mama-core` (workspace:\*) - Core functionality
- `@sinclair/typebox` - Schema validation

**Distribution:** npm package (`@jungjaehoon/openclaw-mama`)

**Used by:** OpenClaw, Moltbot gateway systems

## Code Deduplication

The extraction of mama-core eliminated significant code duplication:

**Before (Two-Package):**

- mcp-server: ~8,000 lines
- claude-code-plugin: ~9,500 lines
- **Total duplication:** ~3,000 lines (embeddings, db-manager, relevance-scorer)

**After (Four-Package):**

- mama-core: ~2,500 lines (shared)
- mcp-server: ~5,500 lines (MCP-specific)
- claude-code-plugin: ~2,000 lines (plugin-specific)
- standalone: ~3,000 lines (HTTP-specific)
- **Lines removed from plugin:** 7,551 lines

## Workspace Configuration

MAMA uses pnpm workspaces for monorepo management:

**Root `pnpm-workspace.yaml`:**

```yaml
packages:
  - 'packages/*'
```

**Package Dependencies:**

Each package references mama-core using workspace protocol:

```json
{
  "dependencies": {
    "@jungjaehoon/mama-core": "workspace:*"
  }
}
```

This ensures:

- Local development uses the local mama-core
- Published packages reference the npm version
- No need to publish mama-core during development

## Build & Test

### Install Dependencies

```bash
pnpm install
```

This installs dependencies for all packages and links workspace dependencies.

### Run Tests

```bash
# All packages
pnpm test

# Specific package
cd packages/mama-core && pnpm test
cd packages/mcp-server && pnpm test
cd packages/claude-code-plugin && pnpm test
cd packages/standalone && pnpm test
```

### Build All Packages

```bash
pnpm build
```

### Clean Build Artifacts

```bash
pnpm clean
```

## Package Versioning

Each package has independent versioning:

- **mama-core:** 1.0.4 (stable API)
- **mama-server:** 1.7.4 (follows MAMA version)
- **claude-code-plugin:** 1.7.7 (follows MAMA version)
- **mama-os:** 0.6.0 (standalone agent)

## Distribution Strategy

### npm Packages

- `@jungjaehoon/mama-core` - Published to npm (future)
- `@jungjaehoon/mama-server` - Published to npm (current)
- `@jungjaehoon/mama-os` - Published to npm (current)

### Marketplace

- `mama` (claude-code-plugin) - Distributed via Claude Code marketplace

### Installation

**Claude Code:**

```bash
/plugin install mama
```

**Claude Desktop:**

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"]
    }
  }
}
```

**Standalone Server:**

```bash
npx @jungjaehoon/mama-os
```

## Design Principles

### 1. Separation of Concerns

- **mama-core:** Core logic (no transport)
- **mcp-server:** MCP protocol (stdio only)
- **claude-code-plugin:** Claude Code integration (commands/hooks)
- **standalone:** HTTP features (viewer/chat/embed)

### 2. Code Reuse

All packages share mama-core to eliminate duplication. Heavy dependencies (better-sqlite3, transformers.js, sqlite-vec) live in mama-core.

### 3. Independent Updates

Packages can be updated independently:

- mama-core: Stable API, infrequent updates
- mcp-server: MCP protocol changes
- claude-code-plugin: Claude Code features
- standalone: Web features

### 4. Local-First

All packages work locally without network calls (except optional standalone HTTP server).

### 5. Backward Compatibility

Existing decisions remain valid across all package updates. SQLite schema changes require migration scripts.

## Migration History

### mama-os-0.1.0 (2026-02-01): Five-Package Architecture

**Changes:**

- Added standalone package with autonomous agent capabilities
- Added openclaw-plugin for native OpenClaw/Moltbot integration
- Extracted mama-core as shared foundation
- MCP server remains pure MCP (stdio only)

**Benefits:**

- Autonomous AI agent with gateway integrations
- Native OpenClaw plugin support
- Eliminated code duplication
- Clearer separation of concerns
- Independent package updates

### v1.5.9 (2026-01-30): Four-Package Architecture

**Changes:**

- Extracted mama-core from mcp-server and claude-code-plugin
- Moved HTTP features from mcp-server to standalone (viewer/chat)
- MCP server now pure MCP (stdio only)
- 7,551 lines removed from plugin

**Benefits:**

- Eliminated code duplication
- Clearer separation of concerns
- Independent package updates
- Easier testing and maintenance

### v1.1 (2025-11-21): Two-Package Architecture

**Changes:**

- Split monolithic plugin into mcp-server and claude-code-plugin
- Established pnpm workspace

**Benefits:**

- Shared MCP server across all clients
- Independent plugin updates

## Future Plans

### CI/CD Workflows

- GitHub Actions for automated testing
- npm publishing workflow for mama-core
- Plugin marketplace publishing automation

### Additional Packages

- `@jungjaehoon/mama-cli` - Standalone CLI tool
- `@jungjaehoon/mama-api` - REST API wrapper

## References

- [Developer Playbook](../development/developer-playbook.md) - Architecture & standards
- [Deployment Architecture](../development/deployment-architecture.md) - How MAMA is distributed
- [Testing Guide](../development/testing.md) - Test suite details
- [CLAUDE.md](../../CLAUDE.md) - Development guidance

---

**Last Updated:** 2026-02-07

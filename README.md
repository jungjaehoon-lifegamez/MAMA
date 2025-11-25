# MAMA - Memory-Augmented MCP Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-134%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Version 1.1.0 | Link Governance & Narrative Preservation

MAMA tracks how your decisions evolve. Instead of just remembering what you chose, it remembers why you chose it, what you tried before, and what didn't work.

## What is MAMA?

An always-on companion for Claude Code and Claude Desktop that remembers decision evolution. When you make architectural choices, try different approaches, or learn from failures, MAMA stores this context and surfaces it when relevant.

**The killer feature:** Session continuity. End your day with `/mama-checkpoint`, resume tomorrow with `/mama-resume` - and pick up exactly where you left off with full context.

---

## Installation

### Claude Code

**Quick Start (2 steps):**

```bash
# Step 1: Add MAMA marketplace (one-time setup)
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins

# Step 2: Install MAMA plugin
/plugin install mama
```

> **Note:** Claude Code uses decentralized marketplaces. You need to add the MAMA marketplace once, then you can install and update the plugin anytime.

First use of `/mama-save` downloads the MCP server automatically (~50MB for embedding model).

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Other MCP Clients

MAMA works with any MCP-compatible client. Below are verified configurations:

#### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mama]
  command = "npx"
  args = ["-y", "@jungjaehoon/mama-server"]
  disabled = false
  disabled_tools = []
```

#### Antigravity IDE (Gemini)

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"],
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

> **Note:** All MCP clients share the same database at `~/.claude/mama-memory.db`, so decisions are available across all your IDEs.

### Prerequisites

- Node.js >= 18.0.0 (20+ recommended)
- 500MB free disk space for embedding model cache
- SQLite support (included on most systems)

### Configuration

MAMA server requires environment variables for security and configuration.

1. Copy `.env.example` to `.env` in your project root:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your settings:

   ```ini
   # Security Token (Required)
   MAMA_SERVER_TOKEN=your_secure_token_here

   # Database Path (Optional, default: ./mama.db)
   MAMA_DB_PATH=./mama.db

   # Server Port (Optional, default: 3000)
   MAMA_SERVER_PORT=3000
   ```

---

## 💡 Session Continuity - Never Lose Your Context

**End your coding session. Pick up exactly where you left off.**

```bash
# End of day - save your session state
/mama-checkpoint

# Next morning - resume with full context
/mama-resume
```

**What you get:**

```
🔄 Resuming Session (from yesterday, 6:30 PM)

📝 Session Summary:
Refactoring authentication module. Switched from session-based to JWT.
Token refresh working, but need to add expiration validation.

📂 Relevant Files:
- src/auth/jwt-handler.ts
- src/middleware/auth.ts
- tests/auth.test.ts

👉 Next Steps:
1. Add token expiration validation
2. Update tests for new JWT flow
3. Document API changes in README

Ready to continue where you left off!
```

This is MAMA's killer feature - you never lose context between sessions.

---

## Quick Start

After installation:

```bash
# Save a decision
/mama-save topic="auth_strategy" decision="JWT with refresh tokens" reasoning="Need stateless auth for API scaling"

# Search for related decisions
/mama-suggest "How should I handle authentication?"

# View decision history
/mama-recall auth_strategy

# List all decisions
/mama-list
```

## Available Commands

| Command                      | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `/mama-save`                 | Save decision with reasoning and confidence     |
| `/mama-recall <topic>`       | View full evolution history for a topic         |
| `/mama-suggest <query>`      | Semantic search across all decisions            |
| `/mama-list`                 | Browse recent decisions chronologically         |
| `/mama-checkpoint <summary>` | Save current session state for later resumption |
| `/mama-resume`               | Load last checkpoint and restore context        |
| `/mama-configure`            | View/modify settings and tier status            |

---

## MCP Tool Catalog

For MCP clients (responses are JSON stringified in `content[0].text`). Full schemas live in `docs/reference/api.md`.

### Core Memory

- **`save_decision`** — Save a decision or assistant insight (`topic`, `decision`, `reasoning`; optional `confidence`, `outcome`, `type`).
- **`recall_decision`** — Markdown history for a topic (shows supersedes chain).
- **`suggest_decision`** — Semantic search by question (`userQuestion`, optional `recencyWeight`).
- **`list_decisions`** — Recent decisions (default limit 10).
- **`update_outcome`** — Update a decision outcome (`topic`, `outcome` = SUCCESS|FAILED|PARTIAL).

### Agent Protocol

- **`save_checkpoint`** — Save session state. **Use the Truthful Continuity format (Goal & Progress, Evidence w/ status, Unfinished/Risks, Next Agent briefing).**
- **`load_checkpoint`** — Resume session state (zero-context).

### Planned

- **`save_insight`** — Specialized tool for insights (use `save_decision` with `type='assistant_insight'` for now).
- **`evolve/supersede`** — Explicitly mark supersedes (currently handled implicitly by topic reuse).

---

## How It Works

MAMA uses a two-package architecture with a shared HTTP embedding server:

```
┌─────────────────────────────────────────────────┐
│              Local Machine                       │
├─────────────────────────────────────────────────┤
│  Claude Code  Claude Desktop  Cursor  Aider     │
│       │            │            │       │        │
│       └────┬───────┴────┬───────┴───┬───┘        │
│            │            │           │            │
│     ┌──────▼────────────▼───────────▼──────┐    │
│     │  HTTP Embedding Server (port 3847)   │    │
│     │  Model stays loaded in memory        │    │
│     └──────────────────────────────────────┘    │
│                      │                           │
│     ┌────────────────▼────────────────┐         │
│     │  MCP Server (stdio)             │         │
│     │  SQLite + sqlite-vec            │         │
│     └────────────────▼────────────────┘         │
│     ┌────────────────▼────────────────┐         │
│     │  mama-memory.db (shared DB)     │         │
│     └─────────────────────────────────┘         │
└─────────────────────────────────────────────────┘
```

### MCP Server (@jungjaehoon/mama-server)

Published as an independent npm package. Handles SQLite database, vector embeddings, and runs an HTTP embedding server on `127.0.0.1:3847`. Shared across Claude Code, Claude Desktop, and any MCP client on the same machine.

### HTTP Embedding Server

The MCP server starts an HTTP embedding API that keeps the model loaded in memory:

- **Port**: 3847 (localhost only for security)
- **Endpoints**: `/health`, `/embed`, `/embed/batch`
- **Benefit**: ~150ms hook latency (vs 2-9 seconds without it)

Any local LLM client can use this shared embedding service.

### Claude Code Plugin (mama)

Lightweight markdown-based plugin. Provides `/mama-*` commands and hooks. Hooks use the HTTP embedding server for fast context injection.

This separation means one database works across all your Claude environments, and the MCP server updates independently from the plugin.

---

## Key Features

**Session Continuity (💡 Killer Feature)**
Save your session state before closing Claude. Resume next time with full context: what you were working on, relevant files, and exact next steps. Never lose your flow between sessions.

**Decision Evolution Tracking**
See how your thinking changed over time, from initial attempts to final solutions.

**Semantic Search**
Natural language queries find relevant decisions even if exact keywords don't match.

**Automatic Context**
Relevant past decisions surface automatically when you're working on similar problems.

**Local-First**
All data stored on your device. No network calls, no external dependencies.

**Multilingual Support**
Queries work across different languages using multilingual embeddings.

**Tier Transparency**
System always shows what's working. Degraded mode still functions, just without vector search.

---

## Project Structure

This is a monorepo containing two packages:

```
MAMA/
├── packages/
│   ├── mcp-server/          # @jungjaehoon/mama-server (npm)
│   │   ├── src/             # Server implementation
│   │   └── tests/           # Server tests
│   │
│   └── claude-code-plugin/  # mama (marketplace)
│       ├── commands/        # Slash commands
│       ├── hooks/           # Auto-context injection
│       ├── skills/          # Background skills
│       └── tests/           # Plugin tests
│
└── docs/                    # Documentation
```

---

## Development

### Setup

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA
pnpm install
pnpm test
```

### Running Tests

```bash
# All tests
pnpm test

# MCP server only
cd packages/mcp-server && pnpm test

# Plugin only
cd packages/claude-code-plugin && pnpm test
```

### Local Testing

Link the plugin for local development:

```bash
cd packages/claude-code-plugin
ln -s $(pwd) ~/.claude/plugins/repos/mama
```

Test the MCP server standalone:

```bash
cd packages/mcp-server
npm start  # Runs in stdio mode
```

---

## Documentation

### User Guides

- [Getting Started](docs/tutorials/getting-started.md) - 10-minute quickstart
- [Installation](docs/guides/installation.md) - Complete setup guide
- [Commands Reference](docs/reference/commands.md) - All available commands
- [Troubleshooting](docs/guides/troubleshooting.md) - Common issues
- [Deployment Guide](docs/guides/deployment.md) - pnpm workspace deployment
- [Migration Guide (v0→v1.1)](docs/guides/migration-v0-to-v1.1.md) - Upgrade from v0

### Developer Docs

- [Developer Playbook](docs/development/developer-playbook.md) - Architecture overview
- [Contributing Guide](docs/development/contributing.md) - How to contribute
- [Testing Guide](docs/development/testing.md) - Test suite documentation

[Full Documentation Index](docs/index.md)

---

## Testing

134 tests, 100% pass rate:

- 62 unit tests (core logic)
- 39 integration tests (hooks, workflows)
- 33 regression tests (bug prevention)

```bash
pnpm test               # Run all tests
pnpm test -- --coverage # With coverage report
```

---

## Contributing

Contributions welcome. See [Contributing Guide](docs/development/contributing.md) for code standards, pull request process, and testing requirements.

---

## License

MIT - see [LICENSE](LICENSE) for details

---

## Acknowledgments

MAMA was inspired by the excellent work of [mem0](https://github.com/mem0ai/mem0) (Apache 2.0). While MAMA is a distinct implementation focused on local-first SQLite/MCP architecture for Claude, we appreciate their pioneering work in LLM memory management.

---

## Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- [npm Package](https://www.npmjs.com/package/@jungjaehoon/mama-server)
- [Documentation](docs/index.md)

---

**Author**: SpineLift Team
**Last Updated**: 2025-11-25

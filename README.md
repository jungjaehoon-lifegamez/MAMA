# MAMA - Memory-Augmented MCP Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-134%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Version 1.0.0 | Monorepo migration complete

MAMA tracks how your decisions evolve. Instead of just remembering what you chose, it remembers why you chose it, what you tried before, and what didn't work.

## What is MAMA?

An always-on companion for Claude Code and Claude Desktop that remembers decision evolution. When you make architectural choices, try different approaches, or learn from failures, MAMA stores this context and surfaces it when relevant.

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

### Prerequisites

- Node.js >= 18.0.0 (20+ recommended)
- 500MB free disk space for embedding model cache
- SQLite support (included on most systems)

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

# Save current session state (checkpoint)
/mama-checkpoint "Implementing auth module, token issue resolved"

# Resume from last checkpoint
/mama-resume
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

## How It Works

MAMA uses a two-package architecture:

### MCP Server (@jungjaehoon/mama-server)

Published as an independent npm package. Handles SQLite database and vector embeddings. Shared across Claude Code, Claude Desktop, and any MCP client.

### Claude Code Plugin (mama)

Lightweight markdown-based plugin. Provides `/mama-*` commands and hooks. References the MCP server via `.mcp.json`.

This separation means one database works across all your Claude environments, and the MCP server updates independently from the plugin.

---

## Key Features

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

**Session Continuity**
Save your workspace state (`/mama-checkpoint`) and resume exactly where you left off (`/mama-resume`), preventing context loss between sessions.

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
**Last Updated**: 2025-11-22

# MAMA - Memory-Augmented MCP Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-134%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> **MAMA 2.0 Release** - Now with Standalone Agent, Gateway Integrations & MAMA OS

A memory system for Claude that remembers **why** you made choices, not just what you chose.

```
Regular memory: "Likes morning meetings"
MAMA:           "Prefers morning meetings (tried afternoons but energy was low) → worked well for 3 months"
```

**What you get:**

- Claude remembers your past choices and whether they worked
- Pick up conversations without re-explaining everything
- See how your preferences evolved over time
- Free, private, all data stays on your machine

---

## 🤔 Which MAMA Do You Need?

Choose the right package for your use case:

### 🤖 Want an Always-On AI Agent?

**→ Discord/Slack/Telegram bot**  
**→ Autonomous agent loop**  
**→ Scheduled tasks & heartbeat monitoring**

**Use:** [MAMA OS](packages/standalone/README.md)

```bash
npm install -g @jungjaehoon/mama-os
mama init
mama start
```

**Package:** `@jungjaehoon/mama-os` v0.1.0  
**Tagline:** _Your AI Operating System_

---

### 💻 Want Memory in Claude Desktop/Code?

**→ MCP protocol integration**  
**→ Slash commands & auto-context**  
**→ Session continuity**

**Use:** [MAMA MCP Server](packages/mcp-server/README.md)

**For Claude Code:**

```bash
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins
/plugin install mama
```

**For Claude Desktop:**

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

**Package:** `@jungjaehoon/mama-server` v1.6.5

---

### 🔧 Building Custom Integration?

**→ Embedding & search APIs**  
**→ Decision graph management**  
**→ SQLite + vector storage**

**Use:** [MAMA Core](packages/mama-core/README.md)

```bash
npm install @jungjaehoon/mama-core
```

```javascript
const { generateEmbedding, initDB } = require('@jungjaehoon/mama-core');
const mamaApi = require('@jungjaehoon/mama-core/mama-api');
```

**Package:** `@jungjaehoon/mama-core` v1.0.0

---

## 📦 All Packages

| Package                                                          | Version | Description                                  | Distribution       |
| ---------------------------------------------------------------- | ------- | -------------------------------------------- | ------------------ |
| [@jungjaehoon/mama-os](packages/standalone/README.md)            | 0.1.0   | Your AI Operating System (agent + gateway)   | npm                |
| [@jungjaehoon/mama-server](packages/mcp-server/README.md)        | 1.6.5   | MCP server for Claude Desktop/Code           | npm                |
| [@jungjaehoon/mama-core](packages/mama-core/README.md)           | 1.0.0   | Shared core library (embeddings, DB, memory) | npm                |
| [mama](packages/claude-code-plugin/README.md)                    | 1.6.5   | Claude Code plugin                           | Claude Marketplace |
| [@jungjaehoon/openclaw-mama](packages/openclaw-plugin/README.md) | 0.3.0   | OpenClaw plugin                              | npm                |

> **Note:** "MAMA 2.0" is the marketing name for this release. Individual packages have independent version numbers.

---

## ✨ Key Features

**🔄 Session Continuity** - Save your session state, resume tomorrow with full context. Never lose your flow between sessions. [Learn more →](docs/tutorials/getting-started.md#session-continuity)

**📊 Decision Evolution Tracking** - See how your thinking changed over time, from initial attempts to final solutions. [Learn more →](docs/explanation/decision-graph.md)

**🔍 Semantic Search** - Natural language queries find relevant decisions even if exact keywords don't match. [Learn more →](docs/reference/commands.md#mama-suggest)

**🤖 Autonomous Agent** - Run MAMA as a standalone service with Discord, Slack, or Telegram bot support. [Learn more →](packages/standalone/README.md)

**🌐 MAMA OS** - Built-in graph viewer and mobile chat interface for managing memory from anywhere. [Learn more →](packages/standalone/README.md#mama-os)

**🔒 Local-First** - All data stored on your device. No network calls, no external dependencies. [Learn more →](docs/explanation/data-privacy.md)

---

## 🚀 Quick Start

### For Claude Code Users

```bash
# Install plugin
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins
/plugin install mama

# Save a decision
/mama-save topic="auth_strategy" decision="JWT with refresh tokens" reasoning="Need stateless auth for API scaling"

# Search for related decisions
/mama-suggest "How should I handle authentication?"
```

[Full Claude Code Guide →](packages/claude-code-plugin/README.md)

### For Standalone Agent Users

```bash
# Install globally
npm install -g @jungjaehoon/mama-standalone

# Initialize workspace
mama init

# Start agent
mama start

# Check status
mama status
```

[Full Standalone Guide →](packages/standalone/README.md)

---

## 📚 Documentation

### Getting Started

- [Installation Guide](docs/guides/installation.md) - Complete setup for all clients
- [Getting Started Tutorial](docs/tutorials/getting-started.md) - 10-minute quickstart
- [Troubleshooting](docs/guides/troubleshooting.md) - Common issues and fixes

### Reference

- [Commands Reference](docs/reference/commands.md) - All available commands
- [MCP Tool API](docs/reference/api.md) - Tool interfaces
- [Architecture](docs/explanation/architecture.md) - System architecture

### Development

- [Developer Playbook](docs/development/developer-playbook.md) - Architecture & standards
- [Contributing Guide](docs/development/contributing.md) - How to contribute
- [Testing Guide](docs/development/testing.md) - Test suite documentation

[Full Documentation Index →](docs/index.md)

---

## 🏗️ Project Structure

This is a monorepo containing five packages:

```
MAMA/
├── packages/
│   ├── standalone/          # @jungjaehoon/mama-standalone (npm)
│   ├── mama-core/           # @jungjaehoon/mama-core (npm)
│   ├── mcp-server/          # @jungjaehoon/mama-server (npm)
│   ├── claude-code-plugin/  # mama (Claude Code marketplace)
│   └── openclaw-plugin/     # @jungjaehoon/openclaw-mama (npm)
└── docs/                    # Documentation
```

---

## 🛠️ Development

```bash
# Clone repository
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA

# Install dependencies
pnpm install

# Run all tests
pnpm test

# Build all packages
pnpm build
```

[Contributing Guide →](docs/development/contributing.md)

---

## 🤝 Contributing

Contributions welcome! See [Contributing Guide](docs/development/contributing.md) for code standards, pull request process, and testing requirements.

---

## 📄 License

MIT - see [LICENSE](LICENSE) for details

---

## 🙏 Acknowledgments

MAMA was inspired by the excellent work of [mem0](https://github.com/mem0ai/mem0) (Apache 2.0). While MAMA is a distinct implementation focused on local-first SQLite/MCP architecture for Claude, we appreciate their pioneering work in LLM memory management.

---

## 🔗 Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- [Documentation](docs/index.md)
- [npm: @jungjaehoon/mama-server](https://www.npmjs.com/package/@jungjaehoon/mama-server)
- [npm: @jungjaehoon/mama-standalone](https://www.npmjs.com/package/@jungjaehoon/mama-standalone)
- [npm: @jungjaehoon/mama-core](https://www.npmjs.com/package/@jungjaehoon/mama-core)

---

**Author**: SpineLift Team  
**Last Updated**: 2026-02-01

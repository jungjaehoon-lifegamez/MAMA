# MAMA Plugin - Memory-Augmented MCP Assistant

**Version:** 1.8.0
**License:** MIT
**Author:** SpineLift Team

> "Tracks WHY you decided, not just WHAT you chose"

MAMA prevents vibe coding breakage by tracking your decisions with reasoning. When Claude switches between frontend/backend/database, it checks MAMA instead of guessing. No more mismatched schemas, wrong field names, or forgotten contracts.

---

## ✨ Key Features

✅ **Decision Evolution Tracking** - See the journey from confusion to clarity
✅ **Semantic Search** - Natural language queries across all decisions
✅ **Always-on Context** - Automatic background hints when relevant
✅ **Multi-language Support** - Korean + English cross-lingual search
✅ **Tier Transparency** - Always shows what's working, what's degraded
✅ **Local-first** - All data stored on your device

---

## 🚀 Quick Install

**Prerequisites:** Node.js >= 22.13.0

### Claude Code

```bash
/plugin marketplace add jungjaehoon/claude-plugins
/plugin install mama@jungjaehoon
```

**First use:** MCP server downloads automatically (~1-2 min)

### Claude Desktop

Add to `claude_desktop_config.json`:

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

**Works with both!** Same MCP server, shared database.

**Configuration:** See `.mcp.json` for MCP server settings.

**Feature flags:**

- `MAMA_V2_CONTRACTS=false` to disable contract detection (enabled by default)

**Detailed guide:** [Installation Guide](../../docs/guides/installation.md)

---

## 📚 Getting Started

### 1. Verify Installation

```text
/mama:resume
# Expected: 🟢 Tier 1 (Full Features Active)
```

### 2. Save Your First Decision

```text
/mama:decision
Topic: test_framework
Decision: Use Vitest for testing
Reasoning: Better ESM support than Jest
Confidence: 0.9
```

### 3. Automatic Context Injection

MAMA automatically shows relevant decisions when you ask questions:

```text
You: "How should I handle testing?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • test_framework (90%, just now)
   /mama:search test_framework for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Full tutorial:** [Getting Started Guide](../../docs/tutorials/getting-started.md)

---

## 💻 Commands Reference

| Command                | Purpose                            |
| ---------------------- | ---------------------------------- |
| `/mama:decision`       | Save a decision with reasoning     |
| `/mama:search <query>` | Semantic search across decisions   |
| `/mama:checkpoint`     | Save current session state         |
| `/mama:resume`         | Resume from last checkpoint        |
| `/mama:configure`      | Change embedding model or settings |

**Full reference:** [Commands Reference](../../docs/reference/commands.md)

---

## 🤖 Agents

MAMA Plugin includes two specialized agents (planned, not yet registered):

| Agent               | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **mama-researcher** | Deep research agent that searches decisions, explores codebase, and synthesizes findings |
| **mama-reviewer**   | Code review agent that checks changes against stored decisions and contracts             |

> **Note:** These agents are defined as concepts but not yet registered in the plugin manifest. They will be implemented in a future release.

---

## 🎯 Tier System

MAMA operates in **two tiers** with full transparency:

| Tier          | Features                        | Accuracy |
| ------------- | ------------------------------- | -------- |
| **🟢 Tier 1** | Vector search + Graph + Recency | 80%      |
| **🟡 Tier 2** | Exact match only                | 40%      |

**If you see Tier 2:** [Tier 2 Remediation Guide](docs/guides/tier-2-remediation.md)

**Learn more:** [Understanding Tiers Tutorial](docs/tutorials/understanding-tiers.md)

---

## 📖 Documentation

### For New Users

- **[Getting Started Tutorial](docs/tutorials/getting-started.md)** - 10-minute quickstart
- **[First Decision Tutorial](docs/tutorials/first-decision.md)** - Best practices
- **[Understanding Tiers](docs/tutorials/understanding-tiers.md)** - Tier system explained

### Task-Oriented Guides

- **[Installation Guide](docs/guides/installation.md)** - Complete installation
- **[Troubleshooting Guide](docs/guides/troubleshooting.md)** - Common issues and fixes
- **[Configuration Guide](docs/guides/configuration.md)** - All settings

### Technical Reference

- **[Commands Reference](docs/reference/commands.md)** - All `/mama:*` commands
- **[MCP Tool API](docs/reference/api.md)** - Tool interfaces
- **[Hooks Reference](docs/reference/hooks.md)** - Hook configuration

### Understanding MAMA

- **[Architecture](docs/explanation/architecture.md)** - System architecture
- **[Decision Graph](docs/explanation/decision-graph.md)** - Decision evolution
- **[Data Privacy](docs/explanation/data-privacy.md)** - Privacy-first design

### For Contributors

- **[Developer Playbook](docs/development/developer-playbook.md)** - Architecture & standards
- **[Contributing Guide](docs/development/contributing.md)** - How to contribute
- **[Testing Guide](docs/development/testing.md)** - Test suite

**Full navigation:** [Documentation Index](docs/index.md)

---

## 🔧 Configuration

### Disable Hooks (Privacy Mode)

```bash
export MAMA_DISABLE_HOOKS=true
# Or in ~/.mama/config.json:
{ "disable_hooks": true }
```

### Change Embedding Model

```bash
/mama:configure --model Xenova/multilingual-e5-small
```

**Full guide:** [Configuration Guide](docs/guides/configuration.md)

---

## 🐛 Troubleshooting

**Common issues:**

- **Commands not appearing:** Restart Claude Code, check [Plugin Not Loading](docs/guides/troubleshooting.md#1-plugin-not-loading)
- **Runtime dependency issues:** Check Node 22.13+ and optional image runtime notes in [Troubleshooting Guide](docs/guides/troubleshooting.md#2-nodejs-runtime-and-optional-dependency-issues)
- **Tier 2 detected:** Follow [Tier 2 Remediation Guide](docs/guides/tier-2-remediation.md)
- **Hooks not firing:** Check permissions, see [Hooks Not Firing](docs/guides/troubleshooting.md#4-hooks-not-firing)

**Full guide:** [Troubleshooting Guide](docs/guides/troubleshooting.md)

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test tests/skills/mama-context-skill.test.js

# With coverage
npm run test:coverage
```

**Test coverage:** 328 tests (100% pass rate)

- Unit tests: ~130 (core logic, modules, DB)
- Integration tests: ~80 (hooks, tools, workflows)
- Regression tests: 43 (bug prevention)
- Skills: 28
- Manifests: 28
- Commands: 19

**Guide:** [Testing Guide](docs/development/testing.md)

---

## 🛡️ Privacy & Security

**FR Reference:** [FR45-49 (Privacy & Security)](docs/reference/fr-mapping.md)

- ✅ 100% local processing (no network calls)
- ✅ All data in `~/.claude/mama-memory.db`
- ✅ No telemetry, no tracking
- ✅ Hooks can be disabled anytime

**Learn more:** [Data Privacy Explanation](docs/explanation/data-privacy.md)

---

## 🚀 Performance

**With HTTP Embedding Server (Default):**

- Hook latency: ~150ms (model stays loaded in memory)
- Embedding requests: ~50ms via HTTP

**Without HTTP Server (Fallback):**

- First query: ~987ms (model load + inference)
- Subsequent queries: ~89ms (cached)

**Tier 2 (Exact Match):**

- All queries: ~12ms (no embeddings)

**Learn more:** [Performance Characteristics](docs/explanation/performance.md)

---

## 📦 Architecture

MAMA uses a **core-first package structure**:

```
┌─────────────────────────────────────────────────┐
│              Local Machine                       │
├─────────────────────────────────────────────────┤
│  Claude Code  Claude Desktop  Cursor  Aider     │
│       │            │            │       │        │
│       └────────────┴────────────┴───────┘        │
│                      │                           │
│     ┌────────────────▼────────────────┐         │
│     │  MAMA Core                      │         │
│     │  Embeddings + SQLite + Graph    │         │
│     └────────────────┬────────────────┘         │
│                      │                           │
│     ┌────────────────▼────────────────┐         │
│     │  MCP Server (stdio)             │         │
│     │  Tools: save/search/update/load │         │
│     └─────────────────────────────────┘         │
│     ┌─────────────────────────────────┐         │
│     │  Optional Standalone Runtime    │         │
│     │  API/UI: 3847, Embed: 3849      │         │
│     └─────────────────────────────────┘         │
└─────────────────────────────────────────────────┘
```

### 1. MCP Server (@jungjaehoon/mama-server)

Independent npm package shared across all MCP clients. Default mode is pure stdio MCP (no HTTP embedding server startup).

### 2. MAMA Core (@jungjaehoon/mama-core)

Shared runtime for embeddings, storage, and graph logic. Owns heavy dependencies like `@huggingface/transformers`.

### 3. Claude Code Plugin (mama-plugin)

Lightweight plugin referencing the MCP server. Hooks can use a shared HTTP embedding endpoint (`127.0.0.1:3849`) for fast context injection when Standalone (or MCP legacy opt-in mode) is running.

**Benefits:**

- ✅ One MCP server → Multiple clients (Code, Desktop, etc.)
- ✅ Heavy runtime centralized in `mama-core`
- ✅ Shared HTTP embedding endpoint (`3849`) keeps hook latency low (~150ms)
- ✅ Shared decision database across all tools

**Guide:** [Developer Playbook](docs/development/developer-playbook.md)

---

## 📦 Related Packages

- **[@jungjaehoon/mama-os](../standalone/README.md)** - Your AI Operating System with Discord/Slack/Telegram integrations
- **[@jungjaehoon/mama-server](../mcp-server/README.md)** - MCP server for Claude Desktop and other MCP clients
- **[@jungjaehoon/mama-core](../mama-core/README.md)** - Core library for building custom integrations

---

## 🤝 Contributing

We welcome contributions! Please see:

- [Contributing Guide](docs/development/contributing.md)
- [Developer Playbook](docs/development/developer-playbook.md)
- [Code Standards](docs/development/code-standards.md)

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🔗 Links

- **Documentation:** [docs/index.md](docs/index.md)
- **GitHub:** [github.com/jungjaehoon-lifegamez/MAMA](https://github.com/jungjaehoon-lifegamez/MAMA)
- **Issues:** [github.com/jungjaehoon-lifegamez/MAMA/issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- **PRD:** [docs/project/prd.md](docs/project/prd.md)

---

**Status:** Production-ready
**Last Updated:** 2026-02-22

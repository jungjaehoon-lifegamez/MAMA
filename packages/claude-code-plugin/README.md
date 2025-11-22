# MAMA Plugin - Memory-Augmented MCP Assistant

**Version:** 1.0.0
**License:** MIT
**Author:** SpineLift Team

> "Remember decision evolution, not just conclusions"

MAMA is an always-on companion for Claude Code that remembers how you think. It preserves the evolution of your decisions—from failed attempts to successful solutions—preventing you from repeating the same mistakes.

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

**Prerequisites:** Node.js >= 18.0.0

### Claude Code

```bash
/plugin marketplace add jungjaehoon-ui/claude-plugins
/plugin install mama@jungjaehoon-ui
```

**First use:** MCP server downloads automatically (~1-2 min)

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon-ui/mama-server"]
    }
  }
}
```

**Works with both!** Same MCP server, shared database.

**Detailed guide:** [Installation Guide](../../docs/guides/installation.md)

---

## 📚 Getting Started

### 1. Verify Installation

```
/mama-list
# Expected: 🟢 Tier 1 (Full Features Active)
```

### 2. Save Your First Decision

```
/mama-save
Topic: test_framework
Decision: Use Vitest for testing
Reasoning: Better ESM support than Jest
Confidence: 0.9
```

### 3. Automatic Context Injection

MAMA automatically shows relevant decisions when you ask questions:

```
You: "How should I handle testing?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • test_framework (90%, just now)
   /mama-recall test_framework for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Full tutorial:** [Getting Started Guide](../../docs/tutorials/getting-started.md)

---

## 💻 Commands Reference

| Command                    | Purpose                            |
| -------------------------- | ---------------------------------- |
| `/mama-save`               | Save a decision with reasoning     |
| `/mama-recall <topic>`     | View decision evolution history    |
| `/mama-suggest <question>` | Semantic search across decisions   |
| `/mama-list [--limit N]`   | List recent decisions (default 10) |
| `/mama-configure`          | Change embedding model or settings |

**Full reference:** [Commands Reference](../../docs/reference/commands.md)

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

- **[Commands Reference](docs/reference/commands.md)** - All `/mama-*` commands
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
/mama-configure --model Xenova/all-MiniLM-L6-v2
```

**Full guide:** [Configuration Guide](docs/guides/configuration.md)

---

## 🐛 Troubleshooting

**Common issues:**

- **Commands not appearing:** Restart Claude Code, check [Plugin Not Loading](docs/guides/troubleshooting.md#1-plugin-not-loading)
- **SQLite build fails:** Install build tools, see [SQLite Build Failures](docs/guides/troubleshooting.md#2-sqlite-build-failures)
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

**Test coverage:** 134 tests (100% pass rate)

- Unit tests: 62 (core logic)
- Integration tests: 39 (hooks, workflows)
- Regression tests: 33 (bug prevention)

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

**Tier 1:**

- First query: ~987ms (model load + inference)
- Subsequent queries: ~89ms (cached)

**Tier 2:**

- All queries: ~12ms (exact match only)

**Learn more:** [Performance Characteristics](docs/explanation/performance.md)

---

## 📦 Architecture

MAMA uses a **2-package structure**:

### 1. MCP Server (@jungjaehoon-ui/mama-server)

Independent npm package shared across all MCP clients:

```
@jungjaehoon-ui/mama-server/
├── src/
│   ├── server.js       # MCP server implementation
│   ├── db/             # SQLite + better-sqlite3
│   ├── embeddings/     # @huggingface/transformers
│   ├── search/         # Vector search + scoring
│   └── graph/          # Decision graph expansion
├── package.json        # npm dependencies
└── dist/               # Compiled output
```

### 2. Claude Code Plugin (mama-plugin)

Lightweight plugin referencing the MCP server:

```
mama-plugin/
├── .claude-plugin/     # Plugin manifest
├── .mcp.json           # References @jungjaehoon-ui/mama-server
├── commands/           # /mama-* command definitions (Markdown)
├── hooks/              # Hook configurations (JSON)
├── skills/             # Auto-context skill (Markdown)
└── docs/               # Documentation (Diátaxis framework)
```

**Benefits:**

- ✅ One MCP server → Multiple clients (Code, Desktop, etc.)
- ✅ Automatic dependency management (npx)
- ✅ Shared decision database across all tools

**Guide:** [Developer Playbook](docs/development/developer-playbook.md)

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
- **GitHub:** [github.com/jungjaehoon-ui/MAMA](https://github.com/jungjaehoon-ui/MAMA)
- **Issues:** [github.com/jungjaehoon-ui/MAMA/issues](https://github.com/jungjaehoon-ui/MAMA/issues)
- **PRD:** [docs/project/prd.md](docs/project/prd.md)

---

**Status:** Documentation restructuring in progress (Story M4.5)
**Last Updated:** 2025-11-21

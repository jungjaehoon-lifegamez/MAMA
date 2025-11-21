# MAMA - Memory-Augmented MCP Assistant

**Version:** 1.0.0
**License:** MIT
**Author:** SpineLift Team

> "Remember decision evolution, not just conclusions"

MAMA is an always-on companion for Claude Code and Claude Desktop that remembers how you think. It preserves the evolution of your decisions—from failed attempts to successful solutions—preventing you from repeating the same mistakes.

---

## 📦 Packages

This monorepo contains:

### 1. [@spellon/mama-server](packages/mcp-server/)
MCP (Model Context Protocol) server implementation. Published to npm and used by both Claude Code and Claude Desktop.

**Installation:**
```bash
npx -y @spellon/mama-server
# or
npm install -g @spellon/mama-server
```

### 2. [MAMA Plugin](packages/claude-code-plugin/)
Lightweight Claude Code plugin providing `/mama-*` commands, hooks, and auto-context injection.

**Installation:**
```bash
/plugin marketplace add spellon/claude-plugins
/plugin install mama@spellon
```

---

## 🚀 Quick Start

### For Users

**Claude Code:**
```bash
/plugin marketplace add spellon/claude-plugins
/plugin install mama@spellon
/mama-save  # First use auto-downloads MCP server
```

**Claude Desktop:**
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@spellon/mama-server"]
    }
  }
}
```

**Full installation guide:** [Installation Guide](packages/claude-code-plugin/docs/guides/installation.md)

---

## 🔧 Development

### Setup

```bash
# Clone repository
git clone https://github.com/spellon/claude-mama.git
cd claude-mama

# Install dependencies (requires pnpm)
pnpm install

# Run all tests
pnpm test

# Build all packages
pnpm build
```

### Project Structure

```
claude-mama/
├── packages/
│   ├── mcp-server/           # @spellon/mama-server (npm package)
│   │   ├── src/              # MCP server implementation
│   │   ├── tests/            # Server tests
│   │   └── package.json
│   │
│   └── claude-code-plugin/   # MAMA plugin (marketplace distribution)
│       ├── .claude-plugin/   # Plugin manifest
│       ├── commands/         # /mama-* commands
│       ├── hooks/            # Hook configurations
│       ├── skills/           # Auto-context skill
│       ├── docs/             # User documentation (Diátaxis)
│       ├── tests/            # Plugin tests
│       └── package.json
│
├── .github/
│   └── workflows/            # CI/CD
├── docs/                     # Shared documentation
└── package.json              # Monorepo root
```

### Running Tests

```bash
# All tests
pnpm test

# MCP server tests only
cd packages/mcp-server
pnpm test

# Plugin tests only
cd packages/claude-code-plugin
pnpm test
```

### Local Development

**Test MCP Server:**
```bash
cd packages/mcp-server
npm start
# Test with Claude Desktop or MCP Inspector
```

**Test Plugin:**
```bash
cd packages/claude-code-plugin
# Link to ~/.claude/plugins/repos/mama for testing
ln -s $(pwd) ~/.claude/plugins/repos/mama
```

---

## 📖 Documentation

### For Users
- **[Getting Started](packages/claude-code-plugin/docs/tutorials/getting-started.md)** - 10-minute quickstart
- **[Installation Guide](packages/claude-code-plugin/docs/guides/installation.md)** - Complete installation
- **[Commands Reference](packages/claude-code-plugin/docs/reference/commands.md)** - All `/mama-*` commands
- **[Troubleshooting](packages/claude-code-plugin/docs/guides/troubleshooting.md)** - Common issues

### For Developers
- **[Developer Playbook](packages/claude-code-plugin/docs/development/developer-playbook.md)** - Architecture & standards
- **[Deployment Architecture](packages/claude-code-plugin/docs/development/deployment-architecture.md)** - How MAMA is distributed
- **[Contributing Guide](packages/claude-code-plugin/docs/development/contributing.md)** - How to contribute
- **[Testing Guide](packages/claude-code-plugin/docs/development/testing.md)** - Test suite

**Full navigation:** [Documentation Index](packages/claude-code-plugin/docs/index.md)

---

## ✨ Key Features

- ✅ **Decision Evolution Tracking** - See the journey from confusion to clarity
- ✅ **Semantic Search** - Natural language queries across all decisions
- ✅ **Always-on Context** - Automatic background hints when relevant
- ✅ **Multi-language Support** - Korean + English cross-lingual search
- ✅ **Tier Transparency** - Always shows what's working, what's degraded
- ✅ **Local-first** - All data stored on your device

---

## 🏗️ Architecture

MAMA uses a **2-package architecture**:

### Package 1: MCP Server (@spellon/mama-server)
- Independent npm package
- Handles all AI/database operations
- Shared across Claude Code, Claude Desktop, and other MCP clients
- Contains: better-sqlite3, @huggingface/transformers, sqlite-vec

### Package 2: Claude Code Plugin (mama@spellon)
- Lightweight plugin (Markdown + config)
- Provides `/mama-*` commands
- Hooks for automatic context injection
- References the MCP server via `.mcp.json`

**Benefits:**
- ✅ One MCP server → Multiple clients
- ✅ Automatic dependency management (npx)
- ✅ Shared decision database across all tools

**Learn more:** [Deployment Architecture](packages/claude-code-plugin/docs/development/deployment-architecture.md)

---

## 🧪 Testing

```bash
# Run all tests
pnpm test

# With coverage
pnpm test -- --coverage
```

**Test coverage:** 134 tests (100% pass rate)
- Unit tests: 62 (core logic)
- Integration tests: 39 (hooks, workflows)
- Regression tests: 33 (bug prevention)

---

## 🤝 Contributing

We welcome contributions! Please see:
- [Contributing Guide](packages/claude-code-plugin/docs/development/contributing.md)
- [Developer Playbook](packages/claude-code-plugin/docs/development/developer-playbook.md)
- [Code Standards](packages/claude-code-plugin/docs/development/code-standards.md)

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🔗 Links

- **Documentation:** [docs/index.md](packages/claude-code-plugin/docs/index.md)
- **GitHub:** [github.com/spellon/claude-mama](https://github.com/spellon/claude-mama)
- **Issues:** [github.com/spellon/claude-mama/issues](https://github.com/spellon/claude-mama/issues)
- **npm Package:** [@spellon/mama-server](https://www.npmjs.com/package/@spellon/mama-server)
- **Plugin Marketplace:** [spellon/claude-plugins](https://github.com/spellon/claude-plugins)

---

**Status:** Monorepo migration in progress (2025-11-21)
**Last Updated:** 2025-11-21

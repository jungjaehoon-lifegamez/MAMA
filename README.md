# MAMA - Memory-Augmented MCP Assistant

<p align="center">
  <img src="docs/website/assets/mama-icon.svg" alt="MAMA" width="120" height="120">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-1097%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://jungjaehoon-lifegamez.github.io/MAMA)

> **MAMA 2.0 Release** - Now with Standalone Agent, Gateway Integrations & MAMA OS

A memory system for Claude that remembers **why** you made choices, not just what you chose.

```
Regular memory: "Likes morning meetings"
MAMA:           "Prefers morning meetings (tried afternoons but energy was low) → worked well for 3 months"
```

## 🚀 Why MAMA for Development?

### You've been here before

**Yesterday:** "Claude, make me a login API"  
→ Works great. You test it. Perfect.

**Today:** "Claude, add the frontend login form"  
→ 404 error. Wrong endpoint. Wrong fields. Nothing connects.

**Why?** Claude forgot everything from yesterday.

### The Root Cause

Here's what actually happens inside Claude's "brain":

**Same session, switching languages:**
TypeScript → Python → SQL → back to TypeScript

- **Writes frontend:** `userId` (camelCase)
- **Writes backend:** `user_id` (snake_case)
- **Writes SQL:** `userID` (mixed case)
- **Result:** Nothing connects. Three different names for the same field.

**Different sessions:**
No memory of what was built before. Every session starts from zero.

**The debugging loop:**
Writes code → Error → Fixes it → Forgets the fix → Same error next time

**It's not you. It's me (Claude).** I lose context switching between languages, and I forget solutions I already found.

### The Real Problem

When you ask Claude to build fullstack:

- **Session 1**: Frontend calls `/api/register` with `{ email, password, name }`
- **Session 2**: Backend creates `/api/signup` expecting `{ username, pwd }`
- **Session 3**: You spend 2 hours debugging why they don't connect

You're not debugging your code. You're debugging my amnesia.

### What MAMA Does

Gives Claude external memory. When I write code, MAMA saves the "contracts":

```
Day 1: You ask for frontend → I write: POST /api/register { email, password }
       → MAMA saves: "Frontend expects POST /api/register with email, password"

Day 3: You ask for backend → I check MAMA first
       → I see: "Frontend already expects POST /api/register"
       → I write matching code automatically
```

**That's it.** I remember what I built. No more mismatches. No more debugging.

MAMA solves MY context loss problem. You benefit from consistent code.

### Does This Actually Work?

Real timeline from our testing:

- **11:00am**: Built backend login (Python FastAPI) - snake_case fields
- **2:00pm**: Switched to frontend work (TypeScript React) - camelCase expected
- **2:05pm**: Asked "add login form"
- **Result**: Worked first try. Zero debugging. Correct casing.

Different session. Different language. Different naming convention. Same contract.

**The fix:** MAMA reminded me what I wrote in Python, so I wrote matching TypeScript.

### Who This Helps

You know you need MAMA if you've said:

- "Why doesn't frontend connect to backend?"
- "I literally told it the endpoint name yesterday"
- "Do I have to paste the API spec every time?"
- "Claude keeps guessing wrong field names"
- "Why is it snake_case in Python but camelCase in TypeScript?"

**The problem:** Claude (me) loses context. Between sessions. Between languages. Even between files.

**Before MAMA:**
Paste API docs every session → Hope Claude remembers → Debug for hours

**With MAMA:**
Build once → Claude checks memory first → Everything connects

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

**Package:** `@jungjaehoon/mama-os` v0.3.1
**Tagline:** _Your AI Operating System_

> ⚠️ **Security Notice**: MAMA OS runs an autonomous AI agent with file system access.
> We strongly recommend running it in an isolated environment:
>
> - **Docker container** (recommended)
> - **VPS/Cloud VM** with limited permissions
> - **Sandbox** (Firejail, bubblewrap)
>
> See [Security Guide](docs/guides/security.md) for details.

<details>
<summary>✅ <strong>Why CLI Subprocess? (ToS & Stability)</strong></summary>

MAMA OS deliberately uses **Claude Code CLI as a subprocess** rather than direct API calls with OAuth tokens. This architectural choice prioritizes long-term stability:

**How it works:**

```
MAMA OS → spawn('claude', [...args]) → Official Claude CLI → Anthropic API
```

**Why this matters:**

| Approach           | Method                            | Risk                                   |
| ------------------ | --------------------------------- | -------------------------------------- |
| Direct OAuth       | Extract token → call API directly | Token refresh conflicts, ToS gray area |
| **CLI Subprocess** | Spawn official `claude` binary    | ✅ Officially supported, stable        |

**Benefits of CLI subprocess approach:**

- 🔒 **ToS Compliant** - Uses the [official subagent pattern](https://code.claude.com/docs/en/sub-agents) documented by Anthropic
- 🛡️ **Future-Proof** - Anthropic maintains CLI compatibility; no risk from internal API changes
- 🔄 **Auth Handled** - CLI manages token refresh internally; no race conditions
- 📊 **Usage Tracking** - Proper session/cost tracking through official tooling

**Historical Context:**
In January 2026, Anthropic [tightened safeguards](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses) against tools that spoofed Claude Code headers. MAMA OS was unaffected because we chose the legitimate CLI approach from the start—not because other approaches are "wrong," but because we prioritized stability for an always-on autonomous agent that users depend on daily.

</details>

**Requires:** [Claude Code CLI](https://claude.ai/claude-code) installed and authenticated.

---

### 💻 Building Software with Claude Code/Desktop?

**→ Stop frontend/backend mismatches**
**→ Auto-track API contracts & function signatures**
**→ Claude remembers your architecture decisions**

**Use:** [MAMA MCP Server](packages/mcp-server/README.md) + [Claude Code Plugin](packages/claude-code-plugin/README.md)

#### For Claude Code (Recommended for Development):

```bash
# Install both MCP server and plugin
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

**Package:** `@jungjaehoon/mama-server` v1.7.0

**What happens after installation:**

1. **PostToolUse Hook** (Claude Code only)
   - Detects when you write/edit code
   - Extracts API contracts automatically
   - Suggests saving via `/mama:decision`

2. **MCP Tools** (Both Desktop & Code)
   - `/mama:search` - Find past decisions
   - `/mama:decision` - Save contracts/choices
   - `/mama:checkpoint` - Resume sessions

3. **Auto-Context Injection**
   - Before editing: Claude sees related contracts
   - Before API calls: Recalls correct schemas
   - Cross-session: Remembers your architecture

**Example workflow:**

```bash
# Day 1: Build backend
You: "Create login API"
Claude: [Writes code]
MAMA: Saved contract - POST /api/auth/login returns { userId, token }

# Day 3: Build frontend (new session)
You: "Add login form"
Claude: "I see you have POST /api/auth/login that returns { userId, token }"
       [Writes correct fetch() call, first try]
```

---

### 🦞 Using OpenClaw Gateway?

**→ Direct gateway integration**
**→ No MCP overhead (~5ms vs ~180ms)**
**→ Same MAMA features**

**Use:** [OpenClaw MAMA Plugin](packages/openclaw-plugin/README.md)

```bash
openclaw plugins install @jungjaehoon/openclaw-mama
```

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "openclaw-mama" },
    "entries": { "openclaw-mama": { "enabled": true } }
  }
}
```

**Package:** `@jungjaehoon/openclaw-mama` v0.4.1

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

**Package:** `@jungjaehoon/mama-core` v1.0.1

---

## 📦 All Packages

| Package                                                          | Version | Description                                  | Distribution       |
| ---------------------------------------------------------------- | ------- | -------------------------------------------- | ------------------ |
| [@jungjaehoon/mama-os](packages/standalone/README.md)            | 0.3.1   | Your AI Operating System (agent + gateway)   | npm                |
| [@jungjaehoon/mama-server](packages/mcp-server/README.md)        | 1.7.0   | MCP server for Claude Desktop/Code           | npm                |
| [@jungjaehoon/mama-core](packages/mama-core/README.md)           | 1.0.1   | Shared core library (embeddings, DB, memory) | npm                |
| [mama](packages/claude-code-plugin/README.md)                    | 1.6.6   | Claude Code plugin                           | Claude Marketplace |
| [@jungjaehoon/openclaw-mama](packages/openclaw-plugin/README.md) | 0.4.1   | OpenClaw plugin                              | npm                |

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
npm install -g @jungjaehoon/mama-os

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
│   ├── standalone/          # @jungjaehoon/mama-os (npm)
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

**Memory System:**
MAMA was inspired by the excellent work of [mem0](https://github.com/mem0ai/mem0) (Apache 2.0). While MAMA is a distinct implementation focused on local-first SQLite/MCP architecture for Claude, we appreciate their pioneering work in LLM memory management.

**Agent Architecture:**
MAMA OS was inspired by [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot), an open-source AI gateway system. We built MAMA OS as a standalone implementation because:

- **Claude-Native**: MAMA OS is optimized specifically for Claude's tool-use patterns and conversation style
- **Memory-First**: Deep integration with MAMA's decision graph and semantic search
- **Simplified Setup**: Single `npm install` instead of running a separate gateway server
- **Direct CLI**: Uses Claude Code CLI directly, avoiding additional abstraction layers

We provide `@jungjaehoon/openclaw-mama` plugin for users who prefer the OpenClaw ecosystem.

---

## 🔗 Links

- [**Documentation Site**](https://jungjaehoon-lifegamez.github.io/MAMA) ← Start here!
- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- [Local Documentation](docs/index.md)
- [npm: @jungjaehoon/mama-server](https://www.npmjs.com/package/@jungjaehoon/mama-server)
- [npm: @jungjaehoon/mama-os](https://www.npmjs.com/package/@jungjaehoon/mama-os)
- [npm: @jungjaehoon/mama-core](https://www.npmjs.com/package/@jungjaehoon/mama-core)
- [npm: @jungjaehoon/openclaw-mama](https://www.npmjs.com/package/@jungjaehoon/openclaw-mama)

---

**Author**: SpineLift Team  
**Last Updated**: 2026-02-01

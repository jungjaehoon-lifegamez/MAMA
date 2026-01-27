# MAMA - Memory-Augmented MCP Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-134%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Version 1.5.9 | Mobile Chat, Graph Viewer & Clawdbot Support

## What is MAMA?

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

## Why MAMA?

**Use MAMA if you want to:**

- Pick up where you left off without losing context
- Remember why you made a choice, not just what you chose
- Track which decisions worked and which didn't
- Keep your data local and free

**Skip MAMA if you:**

- Just want simple "remember this" notes → try memory-lancedb
- Want zero setup → try memory-core
- Need the highest accuracy search → use paid solutions

### Reasoning Graph

Choices don't exist in isolation. MAMA connects them:

```
workout_plan_v1 (stopped: too intense)
    ↓ learned from
workout_plan_v2 (partial: good but took too long)
    ↓ improved
workout_plan_v3 (working well: 30min sessions)
```

When you ask about workouts, MAMA shows how you got to your current routine—not just the latest choice.

### Auto-Recall

MAMA automatically brings up relevant memories during conversation:

```
You: "I want to start a new diet"

[MAMA finds related context]
┌─────────────────────────────────────────────────┐
│ 📝 Related past decisions:                      │
│ • diet_approach: "Focus on protein, not carbs"  │
│ • meal_timing: "Skip breakfast, eat 12-8pm"     │
└─────────────────────────────────────────────────┘

Claude: "Based on your previous preference for
        intermittent fasting and high protein..."
```

You don't need to remind Claude what worked before—MAMA brings it up automatically.

### Comparison with Other Memory Solutions

| Feature              | MAMA                  | memory-lancedb        | memory-core     |
| -------------------- | --------------------- | --------------------- | --------------- |
| **Embeddings**       | Local (free, 384d)    | OpenAI API ($, 3072d) | None            |
| **Semantic Search**  | ✅ sqlite-vec         | ✅ LanceDB            | ❌ keyword only |
| **Auto-capture**     | LLM-judged            | Regex patterns        | ❌ manual       |
| **Reasoning Graph**  | ✅ builds_on, debates | ❌                    | ❌              |
| **Outcome Tracking** | ✅ success/failed     | ❌                    | ❌              |
| **Setup Complexity** | MCP server            | API key               | Zero            |
| **Cost**             | Free                  | ~$0.0001/embed        | Free            |
| **Privacy**          | 100% local            | API calls             | 100% local      |

**Honest Assessment:**

| Use Case                 | Best Choice    | Why                                        |
| ------------------------ | -------------- | ------------------------------------------ |
| "What did I say?"        | memory-lancedb | Higher quality embeddings, full automation |
| "Why did I decide that?" | MAMA           | Reasoning + outcome tracking               |
| Quick notes              | memory-core    | Zero setup, just markdown                  |

**The Real Differentiator: Linked Decisions**

Both MAMA and memory-lancedb use LLM to save memories. The difference:

```
memory-lancedb: detect pattern → save → done
MAMA:           detect pattern → search related → link → save
```

The extra "search → link" step creates a **reasoning graph**. Without it, you just have isolated memories. With it, you can trace how your thinking evolved:

```
sleep_schedule_v1 (failed) → v2 (adjusted from v1) → v3 (combined best of v1 & v2)
```

**MAMA's Tradeoffs:**

- ✅ Free, local, private
- ✅ Decision evolution tracking
- ✅ Outcome verification (did it work?)
- ⚠️ Lower embedding quality than OpenAI
- ⚠️ Requires "search before save" discipline
- ⚠️ Learning curve (topic, reasoning, outcome concepts)

---

## Installation

### Clawdbot (Recommended)

Native plugin with **auto-recall** — memories surface automatically during conversation.

```bash
clawdbot plugins install @jungjaehoon/clawdbot-mama
```

Enable in `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "slots": { "memory": "clawdbot-mama" },
    "entries": { "clawdbot-mama": { "enabled": true } }
  }
}
```

**What you get:**

- Auto-recall: relevant decisions injected on every agent start
- 4 tools: `mama_search`, `mama_save`, `mama_load_checkpoint`, `mama_update`

### Claude Code

```bash
# Add marketplace (one-time)
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins

# Install plugin
/plugin install mama
```

First use downloads the embedding model (~50MB).

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

### Other MCP Clients

MAMA works with any MCP-compatible client:

<details>
<summary>Codex</summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mama]
  command = "npx"
  args = ["-y", "@jungjaehoon/mama-server"]
```

</details>

<details>
<summary>Antigravity IDE (Gemini)</summary>

Add to `~/.gemini/antigravity/mcp_config.json`:

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

</details>

> **Note:** All clients share the same database (`~/.claude/mama-memory.db`).

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

## MCP Tool Catalog (v1.3.0)

**Design principle:** LLM can infer decision evolution from time-ordered search results. Fewer tools = more LLM flexibility.

| Tool                  | Description                    | Key Parameters                                                        |
| --------------------- | ------------------------------ | --------------------------------------------------------------------- |
| **`save`**            | Save decision or checkpoint    | `type` ('decision' or 'checkpoint'), then type-specific fields        |
| **`search`**          | Semantic search or list recent | `query` (optional), `type` ('all', 'decision', 'checkpoint'), `limit` |
| **`update`**          | Update decision outcome        | `id`, `outcome` (case-insensitive: success/failed/partial), `reason`  |
| **`load_checkpoint`** | Resume previous session        | (none)                                                                |

### Edge Types (v1.3)

Decisions connect through relationships. When saving, include references in your reasoning:

| Edge Type     | Pattern in Reasoning                    | Meaning                      |
| ------------- | --------------------------------------- | ---------------------------- |
| `supersedes`  | (automatic for same topic)              | Newer version replaces older |
| `builds_on`   | `builds_on: decision_xxx`               | Extends prior work           |
| `debates`     | `debates: decision_xxx`                 | Presents alternative view    |
| `synthesizes` | `synthesizes: [decision_a, decision_b]` | Merges multiple approaches   |

### Multi-Agent Collaboration

Edge types enable tracking decisions across multiple LLM sessions or agents. When different agents have conflicting opinions, the pattern is:

1. **Agent A** saves initial decision (topic: `protocol_design`)
2. **Agent B** disagrees → saves with `debates: decision_xxx` in reasoning
3. **Agent C** reconciles → saves with `synthesizes: [id_a, id_b]`
4. Future agents see the full evolution chain and understand the final consensus

This was used internally during v1.3 development where multiple LLMs debated the AX Supersede Protocol design.

### save Tool

```json
{
  "type": "decision",
  "topic": "auth_strategy",
  "decision": "Use JWT with refresh tokens",
  "reasoning": "Need stateless auth for API scaling",
  "confidence": 0.8
}
```

```json
{
  "type": "checkpoint",
  "summary": "Refactoring auth module. JWT working, need expiration validation.",
  "next_steps": "1. Add expiration check\n2. Update tests",
  "open_files": ["src/auth/jwt.ts", "tests/auth.test.ts"]
}
```

### search Tool

```json
{ "query": "authentication", "limit": 5 }
```

Without `query`, returns recent items sorted by time (like a list command).

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

## 🔍 Graph Viewer (New in v1.4)

Visualize how your decisions connect and evolve over time.

![MAMA Reasoning Graph](docs/images/reasoning-graph1.4.5.png)

**Access:** `http://localhost:3847/viewer` (when MCP server is running)

**Features:**

- Interactive network graph with physics simulation
- Click nodes to see 3-depth connected relationships
- **Checkpoint sidebar** - Always-visible timeline of session checkpoints
- **Draggable detail panel** - Move the decision panel anywhere on screen
- Legend panel showing edge types and node size meanings
- Filter by topic, view full decision details
- Update outcomes directly from the viewer

The viewer runs on the existing HTTP embedding server—no additional setup required.

> **Tip:** Use `MAMA_HTTP_PORT` environment variable to change the port (default: 3847).

---

## 📱 MAMA Mobile (New in v1.5)

**Connect to MAMA and chat with Claude Code from anywhere** - your phone, tablet, or any device. Access your Claude Code sessions remotely through a mobile-optimized web interface with voice input and TTS.

Whether you're on the couch, commuting, or traveling, stay connected to your development workflow with real-time access to Claude Code.

![MAMA Mobile Chat Interface](docs/images/1.5-chat.png)

### ⚠️ Requirements

| Feature                      | Claude Code Plugin | Claude Desktop (MCP) |
| ---------------------------- | ------------------ | -------------------- |
| MCP Tools (/mama-save, etc.) | ✅                 | ✅                   |
| Graph Viewer                 | ✅                 | ✅                   |
| **Mobile Chat**              | ✅                 | ❌                   |

**Mobile Chat requires Claude Code CLI:**

- Uses `claude` command as subprocess
- Not available in Claude Desktop (MCP-only)
- Automatically enabled when using Claude Code plugin

### Starting the HTTP Server

```bash
cd packages/mcp-server
node start-http-server.js
```

The server will start on `http://localhost:3847` with:

- **Graph Viewer:** `http://localhost:3847/viewer` (Memory tab)
- **Mobile Chat:** `http://localhost:3847/viewer` (Chat tab)

**Features:**

- **Real-time chat** with Claude Code sessions via WebSocket
- **Voice input** (Web Speech API, Korean optimized)
- **Text-to-speech** with adjustable speed (1.8x default for Korean)
- **Hands-free mode** - Auto-listen after TTS completes
- **Long press to copy** messages (750ms)
- **PWA support** - Install as a mobile app with offline capability
- **Slash commands** - `/save`, `/search`, `/checkpoint`, `/resume`, `/help`
- **Auto-checkpoint** - 5-minute idle auto-save with session resume
- **Session resume** - Auto-detect resumable sessions with banner UI
- **MCP tool display** - See real-time tool execution (Read, Write, Bash, etc.)
- **44px touch targets** - Mobile-optimized button sizing

### External Access Setup

⚠️ **CRITICAL:** External access gives attackers **full control** of your computer via Claude Code.

**Choose based on use case:**

#### 🌟 Production Use: Cloudflare Zero Trust (RECOMMENDED)

**Best for:** Real deployment, long-term use, maximum security

```bash
# 1. Install cloudflared
# Download: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 2. Create tunnel
cloudflared tunnel login
cloudflared tunnel create mama-mobile

# 3. Configure Zero Trust access (your Google email only)
# Cloudflare Dashboard → Zero Trust → Access → Applications
# Full setup: See docs/guides/security.md

# 4. Start tunnel
cloudflared tunnel run mama-mobile
```

**What you get:**

- ✅ Google/GitHub account authentication
- ✅ 2FA automatically enforced
- ✅ Only your email can access
- ✅ FREE for personal use

📖 **Full Guide:** [Security Guide - Cloudflare Zero Trust](docs/guides/security.md#cloudflare-zero-trust-recommended-for-production)

#### ⚠️ Testing Only: Quick Tunnel + Token

**Use ONLY for:** Temporary testing (minutes/hours)

```bash
# 1. Set token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# 2. Start Quick Tunnel
cloudflared tunnel --url http://localhost:3847

# 3. Access with token
# https://xxx.trycloudflare.com/viewer?token=YOUR_TOKEN
```

**DO NOT use for production** - Token alone is weak security

**Testing Connection:** Chat tab → Globe icon → Test Connection

---

## 🔒 Security

**IMPORTANT:** MAMA is designed for localhost use only by default. External access via tunnels introduces security risks.

### Default Security Posture

✅ **Secure by default:**

- HTTP server binds to `127.0.0.1` only (localhost)
- No external access without tunnels
- No authentication needed for local use
- Features can be disabled via environment variables

### External Access Risks

⚠️ **CRITICAL:** When using tunnels, an attacker can take **complete control** of your computer:

**What they can access:**

- 🔓 Chat with Claude Code (send any prompt)
- 🔓 Read ANY file on your computer
- 🔓 Write ANY file on your computer
- 🔓 Execute ANY command (install backdoors, steal data)
- 🔓 Your decision database
- 🔓 API keys, SSH keys, passwords

**This is not just data theft - it's full system compromise.**

### Recommended: Cloudflare Zero Trust

**For production use, ALWAYS use Cloudflare Zero Trust:**

✅ **Benefits:**

- Only your Google/GitHub account can access
- 2FA automatically enforced
- No token management needed
- FREE for personal use
- Enterprise-grade security

```bash
# Quick setup (15 minutes)
cloudflared tunnel login
cloudflared tunnel create mama-mobile

# Configure access (Cloudflare Dashboard)
# Zero Trust → Access → Applications
# Add your Google email to allow list

# Start tunnel
cloudflared tunnel run mama-mobile
```

📖 **Full Guide:** [Cloudflare Zero Trust Setup](docs/guides/security.md#cloudflare-zero-trust-recommended-for-production)

### Alternative: Token Authentication (Testing Only)

⚠️ **Use ONLY for temporary testing** (minutes/hours)

```bash
# Generate token
export MAMA_AUTH_TOKEN="$(openssl rand -base64 32)"

# Access with token
https://your-tunnel-url/viewer?token=YOUR_TOKEN
```

**DO NOT use for production** - Token alone is weak security

### Configuration

**Easy Way: Use `/mama-configure` command (Claude Code only)**

```bash
# View current settings
/mama-configure

# Disable features
/mama-configure --disable-http              # Disable all web features
/mama-configure --disable-websocket         # Disable Mobile Chat only
/mama-configure --enable-all                # Enable everything

# Set authentication token
/mama-configure --generate-token            # Generate random token
/mama-configure --set-auth-token=abc123     # Set specific token
```

**After configuration changes, restart Claude Code for changes to take effect.**

**Manual Way: Edit plugin configuration**

For Claude Code, edit `~/.claude/plugins/repos/mama/.claude-plugin/plugin.json`:

```json
{
  "mcpServers": {
    "mama": {
      "env": {
        "MAMA_DISABLE_HTTP_SERVER": "true",
        "MAMA_DISABLE_WEBSOCKET": "true",
        "MAMA_AUTH_TOKEN": "your-token-here"
      }
    }
  }
}
```

For Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"],
      "env": {
        "MAMA_DISABLE_HTTP_SERVER": "true"
      }
    }
  }
}
```

### Security Warnings

MAMA will warn you when external access is detected:

```
⚠️  ========================================
⚠️  SECURITY WARNING: External access detected!
⚠️  ========================================
⚠️
⚠️  Your MAMA server is being accessed from outside localhost.
⚠️  ❌ CRITICAL: MAMA_AUTH_TOKEN is NOT set!
⚠️  Anyone with your tunnel URL can access your local machine.
```

📖 **Read the [Security Guide](docs/guides/security.md) for detailed information.**

---

## Project Structure

This is a monorepo containing three packages:

```
MAMA/
├── packages/
│   ├── mcp-server/          # @jungjaehoon/mama-server (npm)
│   │   ├── src/             # Server implementation
│   │   └── tests/           # Server tests
│   │
│   ├── claude-code-plugin/  # mama (Claude Code marketplace)
│   │   ├── commands/        # Slash commands
│   │   ├── hooks/           # Auto-context injection
│   │   ├── skills/          # Background skills
│   │   └── tests/           # Plugin tests
│   │
│   └── clawdbot-plugin/     # @jungjaehoon/clawdbot-mama (npm)
│       ├── index.ts         # Plugin entry (lifecycle hooks + tools)
│       └── scripts/         # Postinstall scripts
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
**Last Updated**: 2026-01-27

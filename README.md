# MAMA - Memory-Augmented MCP Assistant

<p align="center">
  <img src="docs/website/assets/mama-icon.svg" alt="MAMA" width="120" height="120">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-2175%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://jungjaehoon-lifegamez.github.io/MAMA)

> Your AI that works while you sleep.

MAMA is a **24/7 autonomous AI agent** that lives on your machine. It connects to Discord, Slack, and Telegram — runs scheduled tasks, monitors markets, reviews PRs, and remembers every decision you've ever made together.

```text
You: "매시간 당근마켓에서 맥미니 M4 찾아서 알려줘"
MAMA: ✅ Cron registered (0 * * * *) — skill matched: 당근마켓 모니터링
      → Fetches listings → Filters by price → Reports to Discord
      → Repeats every hour. You go to sleep.
```

## What Makes MAMA Different

| Feature          | Other AI Tools            | MAMA OS                                                                |
| ---------------- | ------------------------- | ---------------------------------------------------------------------- |
| **Memory**       | Forgets after session     | Remembers decisions with reasoning across sessions                     |
| **Availability** | Only when you're chatting | 24/7 daemon with cron scheduler                                        |
| **Skills**       | Fixed capabilities        | User-installable `.md` skills — write instructions, agent follows them |
| **Platforms**    | Single interface          | Discord, Slack, Telegram, Web Dashboard                                |
| **Agents**       | Single agent              | Multi-Agent Swarm with tiered permissions and delegation               |
| **Ecosystem**    | Closed                    | Anthropic Cowork plugins, MCP servers, custom skills — all installable |

## How It Actually Works

**1. You install a skill** (just a markdown file in `~/.mama/skills/`):

```markdown
# 당근마켓 모니터링

keywords: [당근, 중고, 매물]

## 지시사항

1. fetch 도구로 당근마켓 검색 URL에 접속
2. JSON-LD에서 매물 파싱
3. 가격/지역 필터링 후 보고
```

**2. Or just ask the agent** — you don't install anything manually. Tell the agent what you need, and it handles the rest:

```text
You: "당근마켓 모니터링 스킬 설치해줘"
MAMA: ✅ Installed danggeun-monitor from catalog

You: "Cowork에서 task management 플러그인 찾아서 설치해"
MAMA: ✅ Installed task-planner from anthropics/knowledge-work-plugins

You: "https://github.com/user/custom-skill 이거 설치해"
MAMA: ✅ Installed custom-skill from GitHub
```

The agent can browse and install from all sources:

| Source                                                                     | What                                       | How                                         |
| -------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| **MAMA Skills**                                                            | Built-in `.md` skill templates             | Pre-installed via `mama init`, or ask agent |
| **[Cowork Plugins](https://github.com/anthropics/knowledge-work-plugins)** | Anthropic's official plugin catalog        | Agent browses catalog and installs          |
| **MCP Servers**                                                            | External tool integrations (DB, API, etc.) | Auto-merged from plugin `.mcp.json`         |
| **GitHub Repos**                                                           | Any public repo with skill files           | Give the agent a URL                        |

You can also browse and install from the **Viewer UI → Skills tab**, but talking to the agent is faster.

**3. You talk naturally** — the agent matches skills by keywords and follows instructions exactly.

**4. You schedule it** — cron jobs run your prompts on a timer, visible in the dashboard and settings.

**5. Decisions persist** — every choice is saved with reasoning. Next session, the agent remembers _why_, not just _what_.

```text
Session 1: "Use JWT with refresh tokens"
           → MAMA saves reasoning: "Tried simple JWT, users complained about frequent logouts"

Session 5: "Add logout endpoint"
           → Agent checks MAMA → "I see you use JWT with refresh tokens..."
           → Writes matching code. No guessing.
```

## 🤔 Which MAMA Do You Need?

Choose the right package for your use case:

### 🤖 Want an Always-On AI Agent?

**→ Discord/Slack/Telegram bot with 24/7 agent loop**
**→ Installable skill system** — drop a `.md` file, agent follows it
**→ Built-in cron scheduler** — manage from dashboard or settings UI
**→ Multi-Agent Swarm** — tiered permissions, delegation, UltraWork mode

**Use:** [MAMA OS](packages/standalone/README.md)

```bash
npm install -g @jungjaehoon/mama-os
mama init    # copies default skills to ~/.mama/skills/
mama start   # opens web dashboard at localhost:3847
```

**Package:** `@jungjaehoon/mama-os` 0.8.0
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

```text
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

#### Multi-Agent Swarm

> Built independently, announced the same day as Anthropic's [Agent Teams](https://docs.anthropic.com/en/docs/claude-code/agent-teams).
> Same vision — coordinated AI agents — but for **chat platforms**, not just CLI.

Multiple specialized AI agents collaborate in Discord, each with their own persona,
tier-based permissions, and the ability to delegate tasks to each other.

```text
User message → Orchestrator → 5-Stage Routing
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         🏔️ Sisyphus      🔧 Developer     📝 Reviewer
          (Tier 1)          (Tier 2)         (Tier 3)
        Full tools        Read-only         Read-only
        Can delegate      Implements        Reviews
                │
                └── DELEGATE::developer::Fix the auth bug
```

| Feature                | Description                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| **3-Tier Permissions** | Tier 1: all tools + delegation. Tier 2: advisory (read-only). Tier 3: scoped execution (read-only) |
| **5-Stage Routing**    | free_chat → explicit_trigger → category_match → keyword_match → default_agent                      |
| **Category Router**    | Korean/English regex patterns for auto-routing                                                     |
| **Task Delegation**    | `DELEGATE::{agent}::{task}` with depth-1 safety                                                    |
| **Task Continuation**  | Auto-resume incomplete responses (Korean/English)                                                  |
| **UltraWork Mode**     | Autonomous sessions: delegation + continuation loop                                                |

[Setup Guide →](packages/standalone/README.md#multi-agent-swarm) | [Architecture →](docs/architecture-mama-swarm-2026-02-06.md)

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

**Package:** `@jungjaehoon/mama-server` 1.7.4

**What happens after installation:**

1. **PreToolUse Hook** (Claude Code only)
   - Executes MCP search before Read/Edit/Grep
   - Injects contract-only results + Reasoning Summary (grounded in matches)
   - Blocks guessing when no contract exists (shows save template)

2. **PostToolUse Hook** (Claude Code only)
   - Detects when you write/edit code
   - Extracts API contracts automatically (TypeScript, Python, Java, Go, Rust, SQL, GraphQL)
   - Requires structured reasoning (Context/Evidence/Why/Unknowns) for contract saves
   - Uses per-session long/short output to reduce repeated guidance

3. **MCP Tools** (Both Desktop & Code)
   - `/mama:search` - Find past decisions
   - `/mama:decision` - Save contracts/choices
   - `/mama:checkpoint` - Resume sessions

4. **Auto-Context Injection**
   - Before editing: Claude sees related contracts
   - Before API calls: Recalls correct schemas
   - Cross-session: Remembers your architecture

---

## ✨ Key Strengths

- **Contract-first coding:** PreToolUse searches contracts before edits and blocks guessing when none exist.
- **Grounded reasoning:** Reasoning Summary is derived from actual matches (unknowns are explicit).
- **Persistence across sessions:** Contracts saved in MCP prevent schema drift over time.
- **Low-noise guidance:** Per-session long/short output reduces repetition.
- **Safer outputs:** Prompt-sanitized contract injection reduces prompt-injection risk.

**Example workflow:**

```bash
# Day 1: Build backend
You: "Create login API"
Claude: [Writes code]
MAMA: Saved contract - POST /api/auth/login returns { userId, token, email }

# Day 3: Build frontend (new session)
You: "Add login form"
Claude: "I see you have POST /api/auth/login that returns { userId, token, email }"
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

**Package:** `@jungjaehoon/openclaw-mama` 0.4.1

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

**Package:** `@jungjaehoon/mama-core` 1.0.4

---

## 📦 All Packages

| Package                                                          | Version | Description                                  | Distribution       |
| ---------------------------------------------------------------- | ------- | -------------------------------------------- | ------------------ |
| [@jungjaehoon/mama-os](packages/standalone/README.md)            | 0.8.0   | Your AI Operating System (agent + gateway)   | npm                |
| [@jungjaehoon/mama-server](packages/mcp-server/README.md)        | 1.7.4   | MCP server for Claude Desktop/Code           | npm                |
| [@jungjaehoon/mama-core](packages/mama-core/README.md)           | 1.0.4   | Shared core library (embeddings, DB, memory) | npm                |
| [mama](packages/claude-code-plugin/README.md)                    | 1.7.8   | Claude Code plugin                           | Claude Marketplace |
| [@jungjaehoon/openclaw-mama](packages/openclaw-plugin/README.md) | 0.4.1   | OpenClaw plugin                              | npm                |

> **Note:** "MAMA 2.0" is the marketing name for this release. Individual packages have independent version numbers.

---

## ✨ Key Features

**🧩 Skill System** - Drop a `.md` file in `~/.mama/skills/` and the agent follows it. Write instructions in natural language — no code needed. [Learn more →](packages/standalone/README.md)

**⏰ Cron Scheduler** - Register recurring tasks from chat, dashboard, or settings UI. Agent executes your prompt on schedule. [Learn more →](packages/standalone/README.md)

**🧠 Decision Memory** - Every choice is saved with reasoning. Cross-session, cross-language. Claude remembers _why_, not just _what_. [Learn more →](docs/explanation/decision-graph.md)

**🤝 Multi-Agent Swarm** - Specialized agents collaborate in Discord with tiered permissions, delegation chains, and autonomous UltraWork sessions. [Learn more →](packages/standalone/README.md#multi-agent-swarm)

**🤖 24/7 Agent** - Always-on daemon with Discord, Slack, Telegram gateways. Web dashboard at `localhost:3847`. [Learn more →](packages/standalone/README.md)

**🔒 Local-First** - All data on your device. SQLite + local embeddings. No API calls for core functionality. [Learn more →](docs/explanation/data-privacy.md)

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

**Multi-Agent Architecture:**
The Multi-Agent Swarm system was inspired by [oh-my-opencode](https://github.com/nicepkg/oh-my-opencode), a multi-agent orchestration framework for AI coding assistants. While MAMA's swarm shares the vision of coordinated AI agents with tiered permissions, it was built specifically for **chat platforms** (Discord, Slack, Telegram) rather than CLI environments, enabling collaborative agent teams accessible from anywhere.

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
**Last Updated**: 2026-02-12

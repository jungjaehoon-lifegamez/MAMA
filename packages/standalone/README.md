# @jungjaehoon/mama-os

> Stop re-explaining yourself to AI. MAMA remembers so you don't have to.

## The Problem

Every time you start a new Claude session, it knows nothing. The architecture decision from last week, the deadline someone mentioned in Slack, the reason you chose JWT over sessions three PRs ago — all gone. You spend the first few minutes re-loading context that you've already explained before.

Your knowledge is scattered across Slack, Telegram, email, code reviews, and your own head. No single tool sees all of it.

## What MAMA OS Does

MAMA OS is a local daemon that runs on your machine 24/7. It silently connects to your apps, watches conversations, and builds a private knowledge graph — then injects the right context into every new AI session automatically.

```
Without MAMA:  New session → "Last week we decided to use JWT..." → re-explain everything
With MAMA:     New session → context already loaded → you just work
```

**What you get:**

- **Never re-explain context** — Decisions from past sessions surface automatically when relevant
- **Cross-app awareness** — Slack deadline + code decision + email thread = one connected picture
- **Private by design** — All data stays on your device. Nothing leaves your machine. Ever.
- **AI-independent** — Works with Claude, Codex, or any future backend. Your memory outlives any AI provider.
- **Always watching, always learning** — 15 connectors poll your apps continuously, extracting what matters without you lifting a finger

## How It's Secured

MAMA OS has full system access — so security is not optional, it's foundational.

- **Local-only by default** — Binds to localhost. External access requires explicit tunnel setup with authentication (Cloudflare Zero Trust).
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode for unknown sources, bulk extraction limits. Built from a real incident, not theory.
- **Intrusion detection** — Honeypot traps for scanner probes (`.git`, `.env`, `wp-login.php`), per-IP suspicion scoring, automatic tarpit delays, and IP deny-listing when thresholds are exceeded.
- **Agent permission tiers** — Tier 1 (full access), Tier 2 (read-only), Tier 3 (scoped read-only). Each agent only gets the tools it needs.
- **Fail-safe shutdown** — When an intrusion cannot be contained, MAMA shuts itself down gracefully rather than operating in a compromised state.

These aren't theoretical protections. The prompt injection defense was built after a real attack where an adversary injected a fake "server failure" message into a monitored channel, causing the AI agent to voluntarily expose system configuration. The IP banning system has blocked actual intrusion attempts in production.

## Quick Start

```bash
# 1. Authenticate a backend CLI (one-time)
claude    # or: codex login

# 2. Install and start
npx @jungjaehoon/mama-os init
mama start

# 3. Open the viewer
open http://localhost:3847
```

**Prerequisites:** Node.js >= 18, one authenticated backend CLI (Claude or Codex), 500MB disk space.

## Connectors (15)

MAMA connects to your apps and extracts structured facts into the memory graph.

| Source | Connectors |
|--------|-----------|
| **Messengers** | Slack, Discord, Telegram, Chatwork, iMessage |
| **Google Workspace** | Gmail, Calendar, Drive, Sheets |
| **Knowledge** | Notion, Obsidian, Trello |
| **Dev Tools** | Claude Code (plugin hooks), Kagemusha |

```bash
mama connector add slack      # Activate + auth guide
mama connector list           # Status of all connectors
```

Each connector classifies its source (truth / hub / spoke / reference) for the 3-pass extraction pipeline. Config: `~/.mama/connectors.json`.

## Knowledge Agents

MAMA OS runs specialized agents for knowledge management — not coding (that's what Claude Code does natively).

| Agent | Role |
|-------|------|
| **Conductor** | Orchestrates other agents, handles user chat |
| **Dashboard Agent** | Generates project briefings from connected sources |
| **Wiki Agent** | Compiles knowledge into Obsidian vault |
| **Memory Agent** | Extracts decisions from conversations automatically |

Agents delegate via `delegate()` with skill injection and automatic retry. Configure in `~/.mama/config.yaml`.

## Viewer

Web UI at `http://localhost:3847`. PWA-enabled for mobile (add to home screen).

| Tab | What it shows |
|-----|--------------|
| **Dashboard** | Agent activity, memory stats, system health |
| **Feed** | Real-time stream from all connected sources |
| **Wiki** | Knowledge base (syncs with Obsidian vault) |
| **Memory** | Interactive reasoning graph (1000+ nodes), search, export |
| **Logs** | Daemon logs with filtering, pinning, stats, WebSocket mode |
| **Settings** | Connectors, gateways, agents, cron, token budget |

Floating chat panel on every tab — voice input, TTS, slash commands.

## Gateway Integrations

Run MAMA as a bot in Discord, Slack, Telegram, or Chatwork. Configure via `mama setup` or edit `~/.mama/config.yaml` directly.

## Architecture

```
Connectors (15)          Gateways (4)
Slack, Gmail, Sheets...  Discord, Slack, Telegram, Chatwork
       |                        |
       v                        v
 3-Pass Extraction       Multi-Agent System
       |                        |
       +--------+-------+------+
                |
         MAMA Core (mama-memory.db)
         Local SQLite + 1024-dim embeddings
                |
         +------+------+
         |             |
    Viewer UI     Claude Code Plugin
```

## CLI

| Command | Description |
|---------|-------------|
| `mama init` | Initialize workspace |
| `mama setup` | Interactive setup wizard |
| `mama start` | Start daemon |
| `mama stop` | Stop daemon |
| `mama status` | Check status |
| `mama connector <add\|remove\|list\|status>` | Manage connectors |

## Configuration

Main config: `~/.mama/config.yaml`

| Variable | Default |
|----------|---------|
| `MAMA_DB_PATH` | `~/.mama/mama-memory.db` |
| `MAMA_HTTP_PORT` | `3847` |
| `MAMA_WORKSPACE` | `~/.mama/workspace` |

## Related Packages

| Package | Purpose |
|---------|---------|
| **@jungjaehoon/mama-os** | Always-on AI runtime (this package) |
| **@jungjaehoon/mama-server** | MCP server for Claude Desktop |
| **@jungjaehoon/mama-core** | Shared memory engine |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test       # 2800+ tests across all packages
```

## Links

[GitHub](https://github.com/jungjaehoon-lifegamez/MAMA) · [npm](https://www.npmjs.com/package/@jungjaehoon/mama-os) · [Docs](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs) · [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

## License

MIT

---

**Last Updated:** 2026-04-10

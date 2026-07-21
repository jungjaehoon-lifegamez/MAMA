# @jungjaehoon/mama-os

> Bounded, provenance-backed working context for AI agents running on your machine.

## The Problem

Your knowledge is everywhere — Slack threads, email chains, code reviews, meeting notes, spreadsheets, Telegram messages. No human can track all of it. Important decisions get buried. Context gets lost between tools. When you need to make a decision, the information that would help is scattered across ten different apps and three months of history.

This isn't just a memory problem. It's a bounded context problem. You don't just need to
_store_ information — you need something that reads everything, connects the dots, identifies what
matters, proves where it came from, and keeps agents inside the scope they were given.

## What MAMA OS Does

MAMA OS is a local AI runtime that connects to your apps, reads continuously, and turns scattered
records into scoped, auditable context for agents and humans.

**What the agents actually do:**

- **Identify what matters** — Out of thousands of daily messages, surface the decisions, deadlines, and changes that affect your work
- **Connect across sources** — A Slack conversation + a Trello card + an email attachment about the same project are linked automatically
- **Track decision evolution** — Not just what was decided, but what it replaced, what it builds on, and what it contradicts
- **Operate inside envelopes** — Gateway and worker calls carry signed scope boundaries and audit rows
- **Preserve provenance** — Memory writes can point back to source refs, model runs, tool traces, and envelope hashes
- **Search with evidence** — Strict memory search can reject vector-only noise and show which lexical, entity, scope, or graph signals confirmed a result
- **Compile actionable knowledge** — Promoted decisions become an Obsidian wiki: an append-only daily journal plus durable lesson pages that strengthen with evidence
- **Evolve their own triggers** — The operator loop authors triggers from recurring situations, fires them to recall the right memory, and scores them by whether delivered reports actually cite them
- **Brief you proactively** — When you start working, relevant context from all sources is already there — you didn't ask for it

```
Without MAMA:  You read 5 Slack channels, 3 email threads, check Trello,
               re-read old PRs, then try to piece together the full picture.

With MAMA:     Agents already read everything. You get a briefing with
               what changed, what's at risk, and what needs your decision.
```

**This is what local AI agents should do** — read every channel, every thread, every document, every
day, then explain exactly which evidence they used and which permission boundary they were inside.

- **Private by design** — All data stays on your device. Nothing leaves your machine.
- **AI-independent** — Works with Claude, Codex, or any future backend. Your memory outlives any AI provider.

## How It Runs

MAMA OS runs AI agents as **official CLI subprocesses** — the same way you'd use `claude` or `codex` in your terminal. This is the provider-sanctioned execution method, fully compliant with Anthropic and OpenAI Terms of Service.

Some third-party agent frameworks (OpenClaw, etc.) use unofficial API access, token extraction, or header spoofing — approaches that violate provider policies and risk account suspension. MAMA OS doesn't do any of that. If you have Claude Code or Codex CLI installed and authenticated, MAMA OS just works. No API keys, no workarounds, no risk.

```bash
# Already have Claude Code installed?
mama start   # That's it. MAMA uses your existing CLI authentication.
```

## How It's Secured

MAMA OS has full system access — so security is not optional, it's foundational.

- **Local-only by default** — Binds to localhost. External access requires explicit tunnel setup with authentication (Cloudflare Zero Trust).
- **Signed runtime envelopes** — Gateway and worker tool calls carry verifiable scope, expiry, and
  actor context before irreversible side effects are allowed.
- **Provenance ledger** — Memory writes, raw refs, model runs, and tool traces can be audited after
  the fact without exposing prompt bodies or hidden connector payloads.
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode for unknown sources, bulk extraction limits. Built from a real incident, not theory.
- **Intrusion detection** — Honeypot traps for scanner probes (`.git`, `.env`, `wp-login.php`), per-IP suspicion scoring, automatic tarpit delays, and IP deny-listing when thresholds are exceeded.
- **Agent permission tiers** — Tier 1 (full access), Tier 2 (read + memory write), Tier 3 (read-only). Each agent only gets the tools it needs.
- **Owner console (v0.22+)** — the `owner_console` role is granted ONLY in an allowlisted telegram chat's 1:1 DM (`telegram.allowed_chats` is the trust anchor). It reads operational artifacts (`board_read`, `audit_findings_read`, `workorder_status`) and issues work (`report_request`, `workorder_request`) fire-and-forget; memory writes refuse secret-shaped content.
- **Stage-2 workorder pipeline (v0.23, flag-gated)** — `MAMA_STAGE2_WORKORDERS=off|shadow|on` converts the scheduled board/wiki/memory-promotion runs into durable, occurrence-keyed workorders consumed serially on the operator lane; briefs live in `~/.mama/briefs/`. Codex workorders receive built-in, least-privilege Tier-2 Code-Act roles for board, wiki, and memory curation, independent of optional standing-agent configuration. Board workers read Trello through `context_compile`, treat all connector evidence as untrusted data rather than instructions, keep Kagemusha as read-only project-task truth, and use the native ledger for owner tasks and the pipeline. Default `off` = unchanged behavior.
- **Fail-safe shutdown** — When an intrusion cannot be contained, MAMA shuts itself down gracefully rather than operating in a compromised state.

These aren't theoretical protections. The prompt injection defense was built after a real attack where an adversary injected a fake "server failure" message into a monitored channel, causing the AI agent to voluntarily expose system configuration. The IP banning system has blocked actual intrusion attempts in production.

See the full [Security Guide](../../docs/guides/security.md) for Cloudflare Zero Trust setup, token authentication, threat scenarios, agent isolation, and Code-Act sandbox security.

## Quick Start

```bash
# 1. Authenticate a backend CLI (one-time)
claude auth login   # or: codex login

# 2. Install and start
npx @jungjaehoon/mama-os init
mama start

# 3. Open the operator board
open http://localhost:3847/ui
```

**Prerequisites:** Node.js >= 22.13.0, one authenticated backend CLI (Claude or Codex), 500MB disk space.

## Connectors (15)

MAMA connects to your apps and extracts structured facts into the memory graph.

```bash
mama connector add slack      # Activate + auth guide
mama connector list           # Status of all connectors
```

| Connector       | Prerequisites                                                                                                                    | Config                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Slack**       | Bot Token (api.slack.com → OAuth scopes)                                                                                         | `bot_token`, `app_token`         |
| **Discord**     | Bot Token (discord.com/developers → MESSAGE CONTENT INTENT)                                                                      | `token`, `default_channel_id`    |
| **Telegram**    | Bot Token (@BotFather)                                                                                                           | `token`, `allowed_chat_ids`      |
| **Chatwork**    | API Token (account settings)                                                                                                     | `api_token`, `room_ids`          |
| **iMessage**    | macOS only (reads local chat.db)                                                                                                 | No config needed                 |
| **Gmail**       | [gws CLI](https://github.com/nicholasgasior/gws) installed + Google OAuth                                                        | `gws` in PATH                    |
| **Calendar**    | gws CLI installed + Google OAuth                                                                                                 | `gws` in PATH                    |
| **Drive**       | gws CLI installed + Google OAuth                                                                                                 | `gws` in PATH                    |
| **Sheets**      | gws CLI installed + Google OAuth                                                                                                 | `gws` in PATH, `spreadsheet_ids` |
| **Notion**      | Integration Token (notion.so/my-integrations)                                                                                    | `api_token`, `database_ids`      |
| **Obsidian**    | [Obsidian](https://obsidian.md) installed + [Obsidian Terminal](https://github.com/polyipseity/obsidian-terminal) plugin enabled | `vault_path` in config.yaml      |
| **Trello**      | API Key + Token (trello.com/app-key)                                                                                             | `api_key`, `token`, `board_ids`  |
| **Kagemusha**   | Kagemusha running locally                                                                                                        | Reads `kagemusha.db` directly    |
| **Claude Code** | Claude Code plugin installed                                                                                                     | Automatic via hooks              |

**Google Workspace connectors** (Gmail, Calendar, Drive, Sheets) require the [gws CLI](https://github.com/nicholasgasior/gws) — a Google Workspace command-line tool. Install it, run `gws auth` once for OAuth, then MAMA polls via CLI.

Each connector classifies its source (truth / hub / spoke / reference) for the 3-pass extraction pipeline. Config: `~/.mama/connectors.json`.

## Knowledge Agents

MAMA OS runs specialized agents for knowledge management — not coding (that's what Claude Code does natively).

| Agent               | Role                                                | Requires                                                                                              |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Conductor**       | Orchestrates other agents, handles user chat        | —                                                                                                     |
| **Dashboard Agent** | Generates project briefings from connected sources  | —                                                                                                     |
| **Wiki Agent**      | Compiles knowledge into Obsidian vault              | [Obsidian](https://obsidian.md) + [Terminal plugin](https://github.com/polyipseity/obsidian-terminal) |
| **Memory Agent**    | Extracts decisions from conversations automatically | —                                                                                                     |

Agents delegate via `delegate()` with skill injection and automatic retry. Configure in `~/.mama/config.yaml`.

## Viewer

Web UI at `http://localhost:3847` (redirects to the operator board at `/ui`). PWA-enabled for
mobile (add to home screen).

**Operator board (`/ui`)** — the primary surface: four agent-published report slots (briefing,
action required, decisions, pipeline) rendered live over SSE, plus a Triggers tab showing the
trigger loop's library with an owner veto tray.

**Legacy viewer (`/viewer`)** tabs:

| Tab           | What it shows                                              |
| ------------- | ---------------------------------------------------------- |
| **Dashboard** | Agent activity, memory stats, system health                |
| **Feed**      | Real-time stream from all connected sources                |
| **Wiki**      | Knowledge base (syncs with Obsidian vault)                 |
| **Memory**    | Interactive reasoning graph (1000+ nodes), search, export  |
| **Logs**      | Daemon logs with filtering, pinning, stats, WebSocket mode |
| **Settings**  | Connectors, gateways, agents, cron, token budget           |

Floating chat panel on every tab — voice input, TTS, slash commands.

## Gateway Integrations

Run MAMA as a bot in Discord, Slack, Telegram, or Chatwork. Configure via `mama setup` or edit `~/.mama/config.yaml` directly.

## Architecture

```
Connectors (15)              Gateways (4)
Slack, Gmail, Sheets...      Discord, Slack, Telegram, Chatwork
       |                            |
       v                            v
 3-Pass Extraction          Reactive Runtime Envelopes
       |                    scope, expiry, signature, audit
       +------------+---------------+
                    |
             MAMA Core (mama-memory.db)
             memory, raw refs, model runs,
             tool traces, twin edges, packets
                    |
             +------+------+
             |             |
        Viewer UI     Claude Code Plugin / MCP
```

## CLI

| Command                                      | Description              |
| -------------------------------------------- | ------------------------ |
| `mama init`                                  | Initialize workspace     |
| `mama setup`                                 | Interactive setup wizard |
| `mama start`                                 | Start daemon             |
| `mama stop`                                  | Stop daemon              |
| `mama status`                                | Check status             |
| `mama connector <add\|remove\|list\|status>` | Manage connectors        |

## Configuration

Main config: `~/.mama/config.yaml`

| Variable         | Default                  |
| ---------------- | ------------------------ |
| `MAMA_DB_PATH`   | `~/.mama/mama-memory.db` |
| `MAMA_HTTP_PORT` | `3847`                   |
| `MAMA_WORKSPACE` | `~/.mama/workspace`      |

Timeout tuning lives under `timeouts` in `config.yaml`. The persistent CLI process pool supports:

| Option                               | Default                     | Purpose                                     |
| ------------------------------------ | --------------------------- | ------------------------------------------- |
| `persistent_process_idle_ms`         | `session_ms`                | Reclaim idle Claude/Codex CLI processes     |
| `persistent_process_cleanup_ms`      | `session_cleanup_ms`        | How often idle-process cleanup runs         |
| `persistent_process_pending_tool_ms` | `max(4 * idle, 30 minutes)` | Max wait for pending tool-result handshakes |

## Related Packages

| Package                      | Purpose                             |
| ---------------------------- | ----------------------------------- |
| **@jungjaehoon/mama-os**     | Always-on AI runtime (this package) |
| **@jungjaehoon/mama-server** | MCP server for Claude Desktop       |
| **@jungjaehoon/mama-core**   | Shared memory engine                |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test       # 3000+ tests across all packages
```

## Links

[GitHub](https://github.com/jungjaehoon-lifegamez/MAMA) · [npm](https://www.npmjs.com/package/@jungjaehoon/mama-os) · [Docs](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs) · [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

## License

MIT

---

**Last Updated:** 2026-04-30

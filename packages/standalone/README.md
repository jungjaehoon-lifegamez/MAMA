# @jungjaehoon/mama-os

> **Your digital life, remembered locally.**  
> _Always-on AI runtime that connects your apps, remembers what matters, and keeps it all on your device._

## What is MAMA OS?

MAMA OS is a **local AI runtime** — not just a tool that Claude picks up and puts down, but a daemon that runs continuously on your machine. It watches your conversations across coding sessions, messengers, and connected apps, automatically extracts important decisions and context, and surfaces them when you need them.

**What makes it different from an MCP server:**

```
MCP Server:  Claude calls mama_save → saves one fact → done
             (Tool. Works when called. Silent otherwise.)

MAMA OS:     Always running on localhost:3847
             Polls messengers and connected apps continuously
             Memory agent extracts decisions automatically
             Multi-agent team collaborates in chat channels
             (Runtime. Watches, learns, acts. Always on.)
```

**Core capabilities:**

- **Cross-source memory** — Slack + Telegram + Claude Code + Gmail = one unified knowledge graph
- **Always-on daemon** — Watches, learns, and provides context without user prompting
- **Multi-agent orchestration** — Agent teams that collaborate in Discord/Slack/Telegram channels
- **Connector framework** — 15 connectors feed data into a local-first memory engine
- **Local-first** — All data stays on your device. No cloud dependency.

## Installation

```bash
# Install globally
npm install -g @jungjaehoon/mama-os

# Or use with npx (no installation)
npx @jungjaehoon/mama-os init
```

### Prerequisites

- **Node.js** >= 18.0.0
- **At least one authenticated backend CLI:**
  - Claude CLI: `npm install -g @anthropic-ai/claude-code` then `claude`
  - Codex CLI: `npm install -g @openai/codex` then `codex login`
- **500MB disk space** for embedding model cache

## Quick Start

```bash
# 1. Authenticate a backend CLI (one-time)
claude    # or: codex login

# 2. Initialize workspace
mama init

# 3. Start the daemon
mama start

# 4. Open the viewer
open http://localhost:3847
```

MAMA runs as a background daemon. Use `mama status` to check, `mama stop` to stop.

## Viewer (Web UI)

Access at `http://localhost:3847`. PWA-enabled for mobile.

### Tabs

| Tab | Purpose |
|-----|---------|
| **Dashboard** | Project intelligence view — agent activity, memory stats, system health |
| **Feed** | Real-time connector feed — messages from all connected sources |
| **Wiki** | Knowledge base with Obsidian vault integration |
| **Memory** | Interactive reasoning graph (1000+ nodes), checkpoint timeline, search |
| **Logs** | Full-featured daemon log viewer — filtering, pinning, stats, export, WebSocket mode |
| **Settings** | Connectors, gateways, agent config, cron jobs, token budget |

### Chat

Floating chat panel available on all tabs:
- Real-time conversation with the Conductor agent
- Voice input (Web Speech API)
- Text-to-speech with adjustable speed
- Slash commands: `/save`, `/search`, `/checkpoint`, `/resume`

### Mobile

1. Open `http://localhost:3847` on your phone
2. Add to home screen (PWA)
3. Use voice input for hands-free interaction

For external access, use [Cloudflare Zero Trust tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

## Connector Framework

MAMA OS connects to external data sources via a plugin-based connector framework. Each connector polls its source and feeds structured facts into the memory engine.

### Available Connectors (15)

| Connector | Auth | Role |
|-----------|------|------|
| **Slack** | Bot Token | Hub (project channels) |
| **Discord** | Bot Token | Hub |
| **Telegram** | Bot Token | Spoke (individual) |
| **Chatwork** | API Token | Hub |
| **iMessage** | Local DB | Spoke |
| **Gmail** | Google Workspace CLI | Spoke |
| **Calendar** | Google Workspace CLI | Reference |
| **Drive** | Google Workspace CLI | Deliverable |
| **Sheets** | Google Workspace CLI | Truth (structured data) |
| **Notion** | API Token | Reference |
| **Obsidian** | Local vault | Reference |
| **Trello** | API Token | Truth (kanban) |
| **Kagemusha** | Local DB | Hub (team monitoring) |
| **Claude Code** | Plugin hooks | Hub (coding sessions) |

### CLI

```bash
mama connector add slack      # Activate + auth guide
mama connector remove slack   # Deactivate
mama connector list           # Status of all connectors
mama connector status         # Health + last poll time
```

### Source Role Classification

Connectors classify channels by role for the 3-pass memory extraction pipeline:
- **Truth** — Spreadsheets, kanban boards (structured facts, no LLM needed)
- **Hub** — Project channels (cross-source activity extraction)
- **Deliverable** — File storage (document tracking)
- **Spoke** — Individual channels (linked to projects via context)
- **Reference** — Calendar, docs (supplementary context)

Config: `~/.mama/connectors.json`

## Multi-Agent System

Run multiple AI agents that collaborate, delegate tasks, and work autonomously across chat platforms.

### Agent Tiers

| Tier | Role | Tool Access |
|------|------|-------------|
| **Tier 1** | Orchestrator (Conductor) | All tools + delegation |
| **Tier 2** | Advisor | Read-only tools |
| **Tier 3** | Executor | Scoped read-only |

### Delegation

Agents delegate via the `delegate()` gateway tool:

```json
{"name": "delegate", "input": {"agentId": "developer", "task": "implement the login endpoint", "skill": "code-review"}}
```

- **Background mode** — fire-and-forget delegation
- **Skill injection** — loads `~/.mama/skills/{skill}.md` and prepends to delegation prompt
- **Retry with backoff** — 3 retries on busy/crash, channel history injection on restart
- **Permission control** — tier-based tool filtering per agent

### Configuration

```yaml
multi_agent:
  enabled: true
  agents:
    conductor:
      name: 'Conductor'
      tier: 1
      can_delegate: true
      persona_file: '~/.mama/personas/conductor.md'

    developer:
      name: 'Developer'
      tier: 1
      persona_file: '~/.mama/personas/developer.md'
      auto_respond_keywords: ['bug', 'code', 'implement']

    reviewer:
      name: 'Reviewer'
      tier: 2
      persona_file: '~/.mama/personas/reviewer.md'
```

### OS Agent Mode

When running without gateway bots, MAMA OS operates as an OS Agent — the Conductor delegates specialized work to sub-agents instead of doing everything directly. Sub-agent-specific tools (report_publish, wiki_publish, obsidian) are blocked on the Conductor to enforce delegation.

## Gateway Integrations

Connect MAMA to chat platforms. Configure via `mama setup` or `~/.mama/config.yaml`.

| Platform | Setup |
|----------|-------|
| **Discord** | Create bot at discord.com/developers, enable MESSAGE CONTENT INTENT, invite to server |
| **Slack** | Create app at api.slack.com, add bot scopes, enable Socket Mode |
| **Telegram** | Message @BotFather, create bot, set `allowed_chat_ids` |
| **Chatwork** | Generate API token in account settings |

## Wiki (Obsidian Integration)

MAMA OS compiles project knowledge into an Obsidian vault at `~/.mama/wiki/`.

- Wiki agent searches existing notes before writing (prevents duplicates)
- Change detection — skips compilation when no new information
- Automatic frontmatter with tags, date, source links
- View and edit in the Viewer's Wiki tab or Obsidian app

## CLI Commands

| Command | Description |
|---------|-------------|
| `mama init` | Initialize workspace |
| `mama setup` | Interactive setup wizard |
| `mama start` | Start daemon (background) |
| `mama start -f` | Start in foreground |
| `mama stop` | Stop daemon |
| `mama status` | Check status |
| `mama run <prompt>` | Execute single prompt |
| `mama connector <add\|remove\|list\|status>` | Manage connectors |

## Architecture

```
Connectors (15)          Gateways
Slack, Gmail, Sheets...  Discord, Slack, Telegram
       |                        |
       v                        v
 Polling Scheduler       Message Router
       |                        |
       v                        v
 3-Pass Extraction    Multi-Agent System
 (Truth → Hub → Spoke)  (Conductor → Sub-agents)
       |                        |
       +--------+-------+------+
                |
         MAMA Core (mama-memory.db)
         Memory Graph + Embeddings
                |
         +------+------+
         |             |
    Viewer UI     Claude Code Plugin
   localhost:3847   (Hook injection)
```

**Key modules:**

| Module | Path | Responsibility |
|--------|------|---------------|
| Runtime orchestration | `src/cli/runtime/` | 14 modules extracted from start.ts |
| Agent system | `src/agent/` | AgentLoop, GatewayToolExecutor, ToolRegistry |
| Multi-agent | `src/multi-agent/` | AgentProcessManager, delegation, personas |
| Connectors | `src/connectors/` | 15 connector implementations |
| Wiki | `src/wiki/` | Obsidian writer, compiler |
| API handlers | `src/api/` | Dashboard, wiki, report, intelligence |
| Viewer | `public/viewer/` | TypeScript modules, viewer.html |

## Configuration

Main config: `~/.mama/config.yaml`

```yaml
agent:
  model: 'claude-sonnet-4-20250514'
  max_turns: 10
  timeout_seconds: 300

database:
  path: '~/.mama/mama-memory.db'

logging:
  level: info
  path: '~/.mama/logs/daemon.log'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAMA_DB_PATH` | SQLite database location | `~/.mama/mama-memory.db` |
| `MAMA_HTTP_PORT` | Viewer port | `3847` |
| `MAMA_WORKSPACE` | Workspace directory | `~/.mama/workspace` |
| `MAMA_TRUST_CLOUDFLARE_ACCESS` | Trust Cloudflare Access headers | `false` |

## Security

MAMA OS has full system access via the backend CLI. Treat it accordingly.

**Recommendations:**
- Run in a Docker container for isolation
- Use Cloudflare Zero Trust for external access (never expose raw port)
- Set `allowed_chat_ids` for Telegram
- Use role-based permissions in Discord
- Review `~/.mama/config.yaml` gateway tokens

**Compliance:** Operators must comply with their backend provider's Terms of Service. Do not share personal CLI accounts or run multi-user bots on personal plans.

## Related Packages

| Package | Purpose | Install |
|---------|---------|---------|
| **@jungjaehoon/mama-os** | Always-on AI runtime | `npx @jungjaehoon/mama-os` |
| **@jungjaehoon/mama-server** | MCP server for Claude Desktop | `npx @jungjaehoon/mama-server` |
| **@jungjaehoon/mama-core** | Shared memory engine | (dependency) |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install
cd packages/standalone
pnpm build    # Build
pnpm test     # Run tests (2500+)
pnpm typecheck  # Type check
```

## Links

- [GitHub](https://github.com/jungjaehoon-lifegamez/MAMA)
- [npm](https://www.npmjs.com/package/@jungjaehoon/mama-os)
- [Documentation](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

## License

MIT

## Acknowledgments

Inspired by [mem0](https://github.com/mem0ai/mem0) (Apache 2.0) for LLM memory management and [oh-my-opencode](https://github.com/nicepkg/oh-my-opencode) for agent orchestration patterns.

---

**Last Updated:** 2026-04-10

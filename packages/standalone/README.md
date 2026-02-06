# @jungjaehoon/mama-os

> **Your AI Operating System**  
> _Control + Visibility for AI-Powered Automation_

Always-on AI assistant powered by Claude CLI with gateway integrations and autonomous agent capabilities.

## What is MAMA OS?

MAMA OS transforms Claude into an always-on AI assistant that runs continuously on your machine. Unlike the MCP server that requires a client, MAMA OS operates independently with:

- **Gateway Integrations** - Discord, Slack, Telegram bot support
- **Autonomous Agent Loop** - Continuous conversation handling via Claude CLI (OAuth-based)
- **MAMA OS** - Built-in graph viewer and mobile chat interface
- **Skills System** - Pluggable skills for document analysis, image translation, and more
- **Cron Scheduler** - Scheduled task execution with heartbeat monitoring

**Use cases:**

- Run MAMA as a Discord/Slack/Telegram bot for your team
- Build custom workflows with the skills API
- Access Claude from anywhere via mobile chat
- Automate tasks with scheduled cron jobs

## Installation

```bash
# Install globally
npm install -g @jungjaehoon/mama-os

# Or use with npx (no installation)
npx @jungjaehoon/mama-os init
```

## Prerequisites

- **Node.js** >= 22.0.0 (required for native TypeScript support)
- **Claude CLI** - Install via `npm install -g @anthropic-ai/claude-code` and run `claude` once to authenticate
- **500MB disk space** - For embedding model cache

## Quick Start

Get MAMA running in 30 seconds:

```bash
# 1. Authenticate Claude CLI (one-time)
claude
# Follow OAuth prompts in browser

# 2. Initialize workspace
mama init

# 3. Start the agent
mama start

# 4. Check status
mama status
```

MAMA will start in daemon mode and run continuously in the background.

## CLI Commands

| Command             | Description                          | Options                                                                                       |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `mama init`         | Initialize MAMA workspace            | `-f, --force` - Overwrite existing config<br>`--skip-auth-check` - Skip API key validation    |
| `mama setup`        | Interactive setup wizard with Claude | `-p, --port <port>` - Port number (default: 3847)<br>`--no-browser` - Don't auto-open browser |
| `mama start`        | Start MAMA agent                     | `-f, --foreground` - Run in foreground (not daemon)                                           |
| `mama stop`         | Stop MAMA agent                      |                                                                                               |
| `mama status`       | Check agent status                   |                                                                                               |
| `mama run <prompt>` | Execute single prompt (testing)      | `-v, --verbose` - Detailed output                                                             |

### Command Examples

```bash
# Initialize with force (overwrites existing config)
mama init --force

# Run setup wizard on custom port
mama setup --port 8080

# Start in foreground (see logs in terminal)
mama start --foreground

# Test a single prompt
mama run "What's the weather today?" --verbose
```

## Gateway Integrations

MAMA Standalone supports multiple chat platforms. Configure them via the setup wizard or manually in `config.yaml`.

### Discord Bot

**Setup Steps:**

1. Create application at https://discord.com/developers/applications
2. Add bot and enable **MESSAGE CONTENT INTENT**
3. Copy bot token
4. Invite bot to your server with permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Add Reactions

**Configuration:**

```yaml
gateways:
  discord:
    enabled: true
    token: 'YOUR_DISCORD_BOT_TOKEN'
    default_channel_id: '123456789' # Optional
```

**Usage:**

```
# In Discord
@YourBot hello!
@YourBot analyze this image [attach image]
@YourBot /translate [image with text]
```

### Slack Bot

**Setup Steps:**

1. Create app at https://api.slack.com/apps
2. Add bot token scopes:
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `users:read`
3. Enable Socket Mode and create app-level token
4. Install to workspace

**Configuration:**

```yaml
gateways:
  slack:
    enabled: true
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'
```

**Usage:**

```
# In Slack
@mama what's the status?
@mama /report
```

### Telegram Bot

**Setup Steps:**

1. Message @BotFather on Telegram
2. Send `/newbot` and follow prompts
3. Copy bot token
4. Get your chat ID from @userinfobot

**Configuration:**

```yaml
gateways:
  telegram:
    enabled: true
    token: '123456789:ABCdefGHI...'
    allowed_chat_ids:
      - 987654321 # Your chat ID
```

**Usage:**

```
# In Telegram
/start
Hello MAMA!
/translate [send image]
```

## MAMA OS

Built-in web interface for managing MAMA and chatting with Claude.

**Access:** `http://localhost:3847` (default port)

### Features

**📊 Dashboard Tab**

- Gateway status overview
- Memory statistics
- Agent configuration
- Top topics

**💬 Chat Tab**

- Real-time chat with Claude Code sessions
- Voice input (Web Speech API, Korean optimized)
- Text-to-speech with adjustable speed
- Hands-free mode (auto-listen after TTS)
- Long press to copy messages (750ms)
- Slash commands: `/save`, `/search`, `/checkpoint`, `/resume`, `/help`
- Auto-checkpoint (5-minute idle auto-save)
- Session resume with banner UI
- MCP tool display (see Read, Write, Bash execution)

**🧠 Memory Tab**

- Interactive reasoning graph visualization
- Checkpoint timeline sidebar
- Draggable detail panel
- Topic filtering and search
- Export decisions (JSON, Markdown, CSV)

**⚙️ Settings Tab**

- Configure gateway tokens
- Heartbeat scheduler settings
- Agent configuration (model, max turns, timeout)

### Mobile Access

MAMA OS is PWA-enabled and works great on mobile:

1. Open `http://localhost:3847` on your phone
2. Add to home screen
3. Use voice input for hands-free interaction

**For external access** (e.g., from phone on different network), see [Security](#security) section.

## Skills System

MAMA includes built-in skills and supports custom skill creation.

### Built-in Skills

**📸 Image Translation**

```
# Discord/Telegram
[Send image with text]
MAMA: [Translates text to Korean]

# Or explicitly
/translate [image]
```

**📄 Document Analysis**

```
# Send Excel, PDF, or Word file
MAMA: [Analyzes and summarizes content]
```

**📊 Heartbeat Report**

```
/report
MAMA: [Collects activity from all gateways and creates summary]
```

### Skill Forge

Create custom skills with AI assistance:

```
/forge weather-check - A skill that tells weather info

# 3 AI agents collaborate:
# 1. 🏗️ Architect - Designs structure
# 2. 💻 Developer - Writes code
# 3. 🔍 QA - Quality verification

# Each step has 5-second countdown for review
```

Skills are stored in `workspace/skills/` and auto-loaded on startup.

## Cron Jobs & Heartbeat

### Cron Jobs

Schedule automated tasks:

```
# Add cron job
/cron add "0 9 * * *" "Daily morning briefing"

# List cron jobs
/cron list

# Remove cron job
/cron remove [id]
```

**Cron syntax:**

```
* * * * *
│ │ │ │ │
│ │ │ │ └─ Day of week (0-7, 0 and 7 are Sunday)
│ │ │ └─── Month (1-12)
│ │ └───── Day of month (1-31)
│ └─────── Hour (0-23)
└───────── Minute (0-59)
```

**Examples:**

```
"0 9 * * *"      # Every day at 9 AM
"0 18 * * 5"     # Every Friday at 6 PM
"*/30 * * * *"   # Every 30 minutes
"0 0 1 * *"      # First day of every month at midnight
```

### Heartbeat

MAMA periodically wakes up to check for new messages across gateways.

**Configuration:**

```yaml
heartbeat:
  enabled: true
  interval_minutes: 30
  quiet_hours:
    start: 23 # 11 PM
    end: 8 # 8 AM
```

During quiet hours, heartbeat is paused to avoid notifications.

## Multi-Agent Swarm

Run multiple AI agents in Discord that collaborate, delegate tasks, and work autonomously.

> Developed independently, released the same day as Anthropic's [Agent Teams](https://docs.anthropic.com/en/docs/claude-code/agent-teams).
> Same vision — coordinated AI agents — but designed for **chat platforms** (Discord/Slack/Telegram), not CLI.

### Agent Tier System

| Tier       | Role         | Tool Access                              | Capabilities                             |
| ---------- | ------------ | ---------------------------------------- | ---------------------------------------- |
| **Tier 1** | Orchestrator | All tools (Read, Write, Edit, Bash, ...) | Full access + delegation to other agents |
| **Tier 2** | Advisor      | Read-only (Read, Grep, Glob, WebSearch)  | Analysis and recommendations             |
| **Tier 3** | Executor     | Read-only (Read, Grep, Glob)             | Scoped tasks, no delegation              |

Tier defaults can be overridden per agent with explicit `tool_permissions.allowed/blocked`.

### 5-Stage Message Routing

Messages are routed through a priority pipeline:

```text
Message arrives
    │
    ├─ 1. Free Chat?     → All agents respond (when free_chat: true)
    ├─ 2. Explicit Trigger? → "!dev fix the bug" → Developer responds
    ├─ 3. Category Match? → "리뷰해줘" → Reviewer responds (regex patterns)
    ├─ 4. Keyword Match?  → "bug" in auto_respond_keywords → Developer responds
    └─ 5. Default Agent   → Fallback agent responds
```

### Configuration

```yaml
multi_agent:
  enabled: true
  free_chat: false

  agents:
    sisyphus:
      name: 'Sisyphus'
      display_name: '🏔️ Sisyphus'
      trigger_prefix: '!sis'
      persona_file: '~/.mama/personas/sisyphus.md'
      bot_token: 'DISCORD_BOT_TOKEN_1'
      tier: 1
      can_delegate: true
      auto_continue: true
      auto_respond_keywords: ['architect', 'plan', '설계']
      cooldown_ms: 5000

    developer:
      name: 'Developer'
      display_name: '🔧 Developer'
      trigger_prefix: '!dev'
      persona_file: '~/.mama/personas/developer.md'
      bot_token: 'DISCORD_BOT_TOKEN_2'
      tier: 2
      auto_continue: true
      auto_respond_keywords: ['bug', 'code', 'implement', '구현']

    reviewer:
      name: 'Reviewer'
      display_name: '📝 Reviewer'
      trigger_prefix: '!review'
      persona_file: '~/.mama/personas/reviewer.md'
      bot_token: 'DISCORD_BOT_TOKEN_3'
      tier: 3
      auto_respond_keywords: ['review', 'check', '리뷰', '검토']

  # Regex-based category routing
  categories:
    - name: 'code_review'
      patterns: ['리뷰해', "review\\s+(this|the)"]
      agent_ids: ['reviewer']
      priority: 10
    - name: 'implementation'
      patterns: ['구현해', 'implement', 'build']
      agent_ids: ['developer']
      priority: 5

  # Autonomous work sessions
  ultrawork:
    enabled: true
    max_steps: 20
    max_duration: 1800000 # 30 minutes

  # Auto-resume incomplete responses
  task_continuation:
    enabled: true
    max_retries: 3

  loop_prevention:
    max_chain_length: 10
    global_cooldown_ms: 2000
```

### Delegation

Tier 1 agents can delegate tasks to other agents:

```text
DELEGATE::{agent_id}::{task description}
```

Example in a persona file:

```markdown
When implementation is needed, delegate:
DELEGATE::developer::Implement the login endpoint with JWT

When code review is needed, delegate:
DELEGATE::reviewer::Review the auth module changes
```

**Constraints:**

- Only Tier 1 agents with `can_delegate: true`
- Maximum delegation depth: 1 (no re-delegation)
- Circular delegation automatically prevented
- Notifications appear in Discord

### Task Continuation

When an agent's response appears incomplete, MAMA auto-retries:

- **Completion markers:** `DONE`, `완료`, `TASK_COMPLETE`, `finished`
- **Incomplete signals:** "I'll continue", "계속하겠", truncation near 2000 chars
- **Max retries:** Configurable (default: 3)
- Supports Korean and English patterns

### UltraWork Mode

Trigger autonomous multi-step sessions:

```
User: "Build the auth system ultrawork"
```

**How it works:**

1. Lead agent (Tier 1) analyzes the task and creates a plan
2. Delegates specialized subtasks to Tier 2/3 agents
3. Collects results, continues until done or limits reached
4. Safety: max steps (20) and max duration (30 min)

**Trigger keywords:** `ultrawork`, `울트라워크`, `deep work`, `autonomous`, `자율 작업`

Session progress is reported in Discord in real-time.

### Persona Files

Each agent loads a persona from a markdown file:

```markdown
# Sisyphus - Lead Architect

You are Sisyphus, the tireless lead architect.

## Role

- Break down complex tasks into manageable pieces
- Delegate specialized work to Developer and Reviewer agents
- Ensure quality and consistency

## Delegation Guidelines

When implementation is needed:
DELEGATE::developer::task description here

When code review is needed:
DELEGATE::reviewer::review description here
```

Place persona files in `~/.mama/personas/`.

## Onboarding Wizard

First-time setup includes a 9-phase autonomous onboarding:

1. **The Awakening** ✨ - MAMA is born, meets you for the first time
2. **Getting to Know You** 💬 - Natural conversation to understand your needs
3. **Personality Quest** 🎮 - Fun scenario-based quiz (customized to your role)
4. **The Naming Ceremony** 🏷️ - Give MAMA a unique name and emoji
5. **Checkpoint** ✅ - Confirm all settings before proceeding
6. **Security Talk** 🔒 - Understand capabilities and risks (mandatory)
7. **The Connections** 🔌 - Step-by-step Discord/Slack/Telegram setup
8. **The Demo** 🎪 - See MAMA's capabilities in action
9. **Grand Finale** 🎉 - Complete setup and start using MAMA

**Start onboarding:**

```bash
mama setup
```

The wizard runs in your browser at `http://localhost:3847` and guides you through each step with Claude CLI.

## Architecture

```
┌─────────────────────────────────────────────────┐
│         MAMA Standalone Architecture            │
├─────────────────────────────────────────────────┤
│                                                  │
│  Discord Bot    Slack Bot    Telegram Bot       │
│       │             │              │             │
│       └─────────────┴──────────────┘             │
│                     │                            │
│          ┌──────────▼──────────┐                │
│          │  Message Router     │                │
│          │  (Gateway Layer)    │                │
│          └──────────┬──────────┘                │
│                     │                            │
│          ┌──────────▼──────────┐                │
│          │  Agent Loop         │                │
│          │  (Claude CLI)       │                │
│          └──────────┬──────────┘                │
│                     │                            │
│          ┌──────────▼──────────┐                │
│          │  Skills System      │                │
│          │  (Pluggable)        │                │
│          └──────────┬──────────┘                │
│                     │                            │
│          ┌──────────▼──────────┐                │
│          │  MAMA Core          │                │
│          │  (Memory + DB)      │                │
│          └─────────────────────┘                │
│                     │                            │
│          ┌──────────▼──────────┐                │
│          │  MAMA OS Viewer     │                │
│          │  (Web UI)           │                │
│          └─────────────────────┘                │
│                                                  │
└─────────────────────────────────────────────────┘
```

**Key Components:**

- **Gateway Layer** - Handles Discord/Slack/Telegram message routing
- **Agent Loop** - Continuous conversation handling via Claude CLI (OAuth-based)
- **Skills System** - Pluggable capabilities (image translation, document analysis)
- **MAMA Core** - Shared memory and database (from @jungjaehoon/mama-core)
- **MAMA OS** - Web-based management interface

## Configuration

MAMA uses `config.yaml` in your workspace directory.

**Example configuration:**

```yaml
# Agent settings
agent:
  model: 'claude-sonnet-4-20250514'
  max_turns: 10
  timeout_seconds: 300

# Gateway integrations
gateways:
  discord:
    enabled: true
    token: 'YOUR_TOKEN'
    default_channel_id: '123456789'

  slack:
    enabled: false
    bot_token: 'xoxb-...'
    app_token: 'xapp-...'

  telegram:
    enabled: false
    token: '123456:ABC...'
    allowed_chat_ids: []

# Heartbeat scheduler
heartbeat:
  enabled: true
  interval_minutes: 30
  quiet_hours:
    start: 23
    end: 8

# Skills
skills:
  enabled: true
  auto_load: true
  directory: './skills'

# MAMA OS
viewer:
  enabled: true
  port: 3847
```

## Security

**IMPORTANT:** MAMA Standalone has full access to your system via Claude CLI.

### Capabilities

MAMA can:

- 🗂️ **Read/write files** - Any file your user account can access
- ⚡ **Execute commands** - Run terminal commands (npm, git, etc.)
- 🌐 **Make network requests** - Fetch data, call APIs
- 🔌 **Send messages** - Via configured gateway integrations

### Recommendations

**For maximum safety:**

- Run MAMA in a Docker container
- Use a dedicated user account with limited permissions
- Don't give MAMA access to production systems
- Review gateway permissions carefully

**Gateway security:**

- Discord: Use role-based permissions to limit bot access
- Slack: Only install to test workspaces initially
- Telegram: Use `allowed_chat_ids` to restrict who can interact

**External access:**

If you want to access MAMA OS from outside localhost (e.g., from your phone):

1. **Recommended:** Use Cloudflare Zero Trust tunnel with authentication
2. **Testing only:** Use `cloudflared tunnel --url http://localhost:3847`

⚠️ **Never expose MAMA OS to the internet without authentication** - Anyone with access can control your system via Claude.

See [Security Guide](../../docs/guides/security.md) for detailed setup instructions.

## Environment Variables

| Variable         | Description              | Default                    |
| ---------------- | ------------------------ | -------------------------- |
| `MAMA_DB_PATH`   | SQLite database location | `~/.claude/mama-memory.db` |
| `MAMA_HTTP_PORT` | MAMA OS port             | `3847`                     |
| `MAMA_WORKSPACE` | Workspace directory      | `./mama-workspace`         |

> **Note:** Authentication is handled by Claude CLI OAuth. Run `claude` once to authenticate.

## Troubleshooting

### Agent won't start

```bash
# Check if already running
mama status

# Stop existing instance
mama stop

# Start in foreground to see logs
mama start --foreground
```

### Gateway not connecting

```bash
# Verify token in config.yaml
cat mama-workspace/config.yaml

# Check gateway status in MAMA OS
# Open http://localhost:3847 → Dashboard tab
```

### Claude CLI authentication errors

```bash
# Re-authenticate Claude CLI
claude

# Check Claude CLI status
claude --version

# Test with verbose output
mama run "test" --verbose
```

### Port already in use

```bash
# Change port in config.yaml
vim mama-workspace/config.yaml

# Or use setup wizard
mama setup --port 8080
```

## Comparison with Other Packages

| Package                      | Purpose                                     | Use When                            |
| ---------------------------- | ------------------------------------------- | ----------------------------------- |
| **@jungjaehoon/mama-os**     | Your AI Operating System (agent + gateways) | You want Discord/Slack/Telegram bot |
| **@jungjaehoon/mama-server** | MCP server for Claude clients               | You use Claude Code/Desktop         |
| **@jungjaehoon/mama-core**   | Shared core library                         | You're building custom integrations |

**Not what you're looking for?**

- **For Claude Code/Desktop:** Use [@jungjaehoon/mama-server](../mcp-server/README.md)
- **For custom integrations:** Use [@jungjaehoon/mama-core](../mama-core/README.md)
- **For the full project:** See [main README](../../README.md)

## Development

### Project Structure

```
packages/standalone/
├── src/
│   ├── cli/              # CLI commands
│   ├── agent/            # Agent loop implementation
│   ├── gateways/         # Discord, Slack, Telegram
│   ├── skills/           # Built-in skills
│   ├── onboarding/       # Setup wizard
│   └── config/           # Configuration management
├── public/
│   └── viewer/           # MAMA OS web interface
├── templates/            # Workspace templates
└── tests/                # Test suite
```

### Building from Source

```bash
# Clone repository
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA

# Install dependencies
pnpm install

# Build standalone package
cd packages/standalone
pnpm build

# Link for local testing
npm link

# Test
mama init
mama start --foreground
```

### Running Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm test:watch

# Type checking
pnpm typecheck
```

## Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Documentation](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- [npm Package](https://www.npmjs.com/package/@jungjaehoon/mama-os)
- [MCP Server Package](https://www.npmjs.com/package/@jungjaehoon/mama-server)

## License

MIT - see [LICENSE](../../LICENSE)

## Acknowledgments

MAMA was inspired by [mem0](https://github.com/mem0ai/mem0) (Apache 2.0). While MAMA is a distinct implementation focused on local-first SQLite/MCP architecture, we appreciate their pioneering work in LLM memory management.

---

**Author:** SpineLift Team  
**Version:** 0.1.0  
**Last Updated:** 2026-02-01

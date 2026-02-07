# Commands Reference

**MAMA Slash Commands (Claude Code Plugin)**

> **v1.6.5:** Commands simplified to match 4 MCP tools. Shorter names for faster typing.

| Command            | Description          | MCP Tool                 |
| ------------------ | -------------------- | ------------------------ |
| `/mama:decision`   | Save a decision      | `save` (type=decision)   |
| `/mama:search`     | Search or list items | `search`                 |
| `/mama:checkpoint` | Save session state   | `save` (type=checkpoint) |
| `/mama:resume`     | Load checkpoint      | `load_checkpoint`        |
| `/mama:configure`  | Settings             | -                        |

---

## `/mama:decision`

Save a decision to MAMA's memory.

**Key Concept:** Same topic = new decision **supersedes** previous, creating an evolution chain.

**Usage:**

```
/mama:decision <topic> <decision> <reasoning> [--confidence=0.8]
```

**Parameters:**

- `topic` (required): Decision identifier (e.g., 'auth_strategy'). Reuse same topic for related decisions.
- `decision` (required): What was decided
- `reasoning` (required): Why this was decided
- `confidence` (optional): 0.0-1.0, default 0.5

**Examples:**

```
/mama:decision auth_strategy "Use JWT" "Stateless, scalable" --confidence=0.9
/mama:decision database "PostgreSQL" "Need ACID + JSON support"
```

---

## `/mama:search`

Search decisions and checkpoints. Semantic search with query, or list recent without query.

**Usage:**

```
/mama:search [query] [--type=all|decision|checkpoint] [--limit=10]
```

**Parameters:**

- `query` (optional): Search query. If empty, lists recent items.
- `--type`: Filter by type - 'all' (default), 'decision', 'checkpoint'
- `--limit`: Number of results (default: 10)

**Examples:**

```
/mama:search                           # List recent items
/mama:search auth                      # Semantic search for "auth"
/mama:search "database strategy"       # Semantic search
/mama:search --type=checkpoint         # List checkpoints only
/mama:search --limit=20                # List 20 recent items
```

**Note:** Cross-lingual search supported (Korean-English).

---

## `/mama:checkpoint`

Save current session state for later resumption.

**Usage:**

```
/mama:checkpoint
```

Claude will automatically:

- Analyze conversation history
- Extract relevant files from tool usage
- Infer next steps from pending work
- Save everything with verification prompts

**Output Format:**

```markdown
# Goal & Progress

- Goal: [Session goal]
- Progress: [What was done, where stopped]

# Evidence & Verification

- File `path/to/file.js` — Status: Verified
- Command `npm test` — Status: Not run

# Unfinished & Risks

- Remaining work: ...
- Risks/unknowns: ...

# Next Agent Briefing

- DoD: [Definition of Done]
- Quick checks: npm test, curl localhost:3000/health
```

---

## `/mama:resume`

Resume from the latest checkpoint.

**Usage:**

```
/mama:resume
```

**Output:** Loads previous session context including:

- Session summary
- Relevant files
- Next steps
- Where you left off

---

## `/mama:configure`

Configure MAMA settings.

**Usage:**

```
/mama:configure --show
/mama:configure --tier-check
```

**Options:**

- `--show`: Display current configuration (tier, database, model)
- `--tier-check`: Re-run tier detection

---

## mama CLI

**MAMA Standalone CLI Commands**

> **Package:** `@jungjaehoon/mama-os` - Always-on agent with gateway integrations

The `mama` CLI is used to manage MAMA Standalone, an autonomous agent that runs continuously with Discord, Slack, and Telegram bot support.

### `mama init`

Initialize MAMA workspace with default configuration.

**Usage:**

```bash
mama init [options]
```

**Options:**

- `-f, --force` - Overwrite existing configuration
- `--skip-auth-check` - Skip API key validation (testing only)

**Examples:**

```bash
mama init                    # Initialize with prompts
mama init --force            # Overwrite existing config
mama init --skip-auth-check  # Skip API validation
```

**What it does:**

- Creates `mama-workspace/` directory
- Generates default `config.yaml`
- Initializes SQLite database
- Validates Claude API key (unless skipped)

---

### `mama setup`

Interactive setup wizard powered by Claude.

**Usage:**

```bash
mama setup [options]
```

**Options:**

- `-p, --port <port>` - Port number for MAMA OS (default: 3848)
- `--no-browser` - Don't automatically open browser

**Examples:**

```bash
mama setup                # Start wizard on default port
mama setup --port 8080    # Use custom port
mama setup --no-browser   # Don't open browser
```

**What it does:**

- Launches 9-phase onboarding wizard
- Configures gateway integrations (Discord, Slack, Telegram)
- Sets up personality and preferences
- Opens MAMA OS web interface for interactive setup

---

### `mama start`

Start MAMA agent in daemon mode.

**Usage:**

```bash
mama start [options]
```

**Options:**

- `-f, --foreground` - Run in foreground (not daemon)

**Examples:**

```bash
mama start              # Start as background daemon
mama start --foreground # Run in foreground with logs
```

**What it does:**

- Starts autonomous agent loop
- Connects to configured gateways (Discord, Slack, Telegram)
- Enables heartbeat scheduler
- Runs MAMA OS web interface
- Logs to `mama-workspace/logs/`

---

### `mama stop`

Stop running MAMA agent.

**Usage:**

```bash
mama stop
```

**What it does:**

- Gracefully shuts down agent loop
- Disconnects from gateways
- Stops MAMA OS web server
- Saves current state

---

### `mama status`

Check MAMA agent status.

**Usage:**

```bash
mama status
```

**Output:**

```
MAMA Agent Status:
  Status: Running
  PID: 12345
  Uptime: 2 hours 34 minutes
  Gateways: Discord (connected), Slack (disconnected)
  Memory: 45 decisions, 3 checkpoints
  MAMA OS: http://localhost:3847
```

---

### `mama run`

Execute single prompt without starting daemon (testing only).

**Usage:**

```bash
mama run <prompt> [options]
```

**Options:**

- `-v, --verbose` - Show detailed output

**Examples:**

```bash
mama run "What's the weather today?"
mama run "Analyze this project" --verbose
```

**What it does:**

- Sends single prompt to Claude API
- Executes agent loop once
- Prints response and exits
- Useful for testing configuration

---

**Related:**

- [MAMA Standalone Package](../../packages/standalone/README.md) - Full standalone documentation
- [MCP Tool API](api.md) - 4 core tools reference
- [Getting Started Tutorial](../tutorials/getting-started.md)

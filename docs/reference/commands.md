# Commands Reference

**MAMA Slash Commands (Claude Code Plugin)**

> **v1.2.1:** Commands simplified to match 4 MCP tools. Shorter names for faster typing.

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

**Related:**

- [MCP Tool API](api.md) - 4 core tools reference
- [Getting Started Tutorial](../tutorials/getting-started.md)

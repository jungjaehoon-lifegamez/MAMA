# Commands Reference

**All MAMA slash commands (Claude Code Plugin)**

> **Note (v1.2.0):** These slash commands are part of the Claude Code plugin. They use the simplified 4-tool MCP API internally.

---

## `/mama-save`

Save a decision to MAMA's memory.

**Usage:**

```
/mama-save
Topic: <topic_name>
Decision: <what_you_decided>
Reasoning: <why_you_decided>
Confidence: <0.0-1.0>
```

**Key Concept:** Same topic = new decision **supersedes** previous, creating an evolution chain.

**Parameters:**

- `topic` (required): Decision identifier (e.g., 'auth_strategy'). Reuse same topic for related decisions.
- `decision` (required): What was decided
- `reasoning` (required): Why this was decided
- `confidence` (optional): 0.0-1.0, default 0.5

**Examples:**

```
/mama-save
Topic: database_choice
Decision: Use PostgreSQL
Reasoning: Better JSON support and ACID guarantees needed
Confidence: 0.9
```

**MCP Tool:** Uses `save` with `type='decision'`

---

## `/mama-recall <topic>`

Search for decisions related to a topic.

**Usage:**

```
/mama-recall <topic>
```

**Examples:**

```
/mama-recall auth_strategy
/mama-recall database_choice
```

**Output:** Shows matching decisions with evolution history (LLM infers supersedes from time order).

**MCP Tool:** Uses `search` with `query=<topic>`

---

## `/mama-suggest <question>`

Semantic search across all decisions.

**Usage:**

```
/mama-suggest <question>
```

**Examples:**

```
/mama-suggest "How should I handle authentication?"
/mama-suggest "What database should I use?"
```

**Note:** Cross-lingual search supported. Multilingual queries will match decisions across different languages.

**Output:** Relevant decisions ranked by semantic similarity.

**MCP Tool:** Uses `search` with `query=<question>`

---

## `/mama-list [--limit N]`

List recent decisions and checkpoints.

**Usage:**

```
/mama-list [--limit N]
```

**Examples:**

```
/mama-list               # Default 10 recent items
/mama-list --limit 20    # Last 20 items
```

**Output:** Shows recent decisions and checkpoints sorted by time.

**MCP Tool:** Uses `search` without query

---

## `/mama-checkpoint`

Save current session state for later resumption.

**Usage:**

```
/mama-checkpoint
```

**Output:** Saves summary, next steps, and relevant files.

**MCP Tool:** Uses `save` with `type='checkpoint'`

---

## `/mama-resume`

Resume from the latest checkpoint.

**Usage:**

```
/mama-resume
```

**Output:** Loads previous session context to continue work.

**MCP Tool:** Uses `load_checkpoint`

---

## `/mama-configure`

Configure MAMA settings.

**Usage:**

```
/mama-configure --show
/mama-configure --disable-hooks
```

**Options:**

- `--show`: Display current configuration
- `--disable-hooks`: Disable automatic context injection

---

**Related:**

- [MCP Tool API](api.md) - 4 core tools reference
- [Configuration Options](configuration-options.md)
- [Getting Started Tutorial](../tutorials/getting-started.md)

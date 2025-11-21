# Commands Reference

**All MAMA slash commands**

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
Outcome: <pending|success|failure|partial|superseded>
```

**Parameters:**
- `topic` (required): Decision identifier (e.g., 'auth_strategy')
- `decision` (required): What was decided
- `reasoning` (required): Why this was decided
- `confidence` (optional): 0.0-1.0, default 0.5
- `outcome` (optional): Decision status, default 'pending'

**Examples:**
```
/mama-save
Topic: database_choice
Decision: Use PostgreSQL
Reasoning: Better JSON support and ACID guarantees needed
Confidence: 0.9
Outcome: success
```

---

## `/mama-recall <topic>`

View decision evolution history for a specific topic.

**Usage:**
```
/mama-recall <topic>
```

**Examples:**
```
/mama-recall auth_strategy
/mama-recall database_choice
```

**Output:** Shows full decision history with supersedes chain.

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

**Note:** Cross-lingual search supported. Korean queries (e.g., "인증") will match English decisions (e.g., "authentication").

**Output:** Top 3 relevant decisions with similarity scores.

---

## `/mama-list [--limit N]`

List recent decisions.

**Usage:**
```
/mama-list [--limit N]
```

**Examples:**
```
/mama-list               # Default 10 recent decisions
/mama-list --limit 20    # Last 20 decisions
```

**Output:** Shows decision previews with tier status.

---

## `/mama-configure`

Configure MAMA settings.

**Usage:**
```
/mama-configure --model <model_name>
/mama-configure --disable-hooks
```

**Options:**
- `--model`: Change embedding model
- `--disable-hooks`: Disable automatic context injection

**Examples:**
```
/mama-configure --model Xenova/all-MiniLM-L6-v2
/mama-configure --disable-hooks
```

---

**Related:**
- [MCP Tool API](api.md)
- [Configuration Options](configuration-options.md)
- [Getting Started Tutorial](../tutorials/getting-started.md)

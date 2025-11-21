# Data Privacy Principles

**MAMA's privacy-first design**

**FR Reference:** [FR45-49 (Privacy & Security)](../reference/fr-mapping.md)

---

## Core Guarantees

### 1. 100% Local Processing
- All data stored in `~/.claude/mama-memory.db`
- No network calls (except initial model download)
- No telemetry, no tracking, no analytics

### 2. No Cloud Dependencies
- Embeddings generated locally (Transformers.js)
- Database is SQLite (file-based)
- MCP transport is stdio (local process)

### 3. User Control
- Hooks can be disabled anytime
- Database can be deleted anytime
- All operations are manual-first (hooks are optional enhancement)

---

## Data Storage

**Location:** `~/.claude/mama-memory.db`

**Contents:**
- Decisions you explicitly save
- Embeddings (384-dimensional vectors)
- Supersedes graph edges

**NOT stored:**
- Claude Code conversations (never captured)
- File contents (never captured)
- User prompts (only used for search, not stored)

---

## Network Calls

**Only network call:** Initial model download

```bash
# Downloads from Hugging Face CDN (first run only)
https://huggingface.co/Xenova/multilingual-e5-small
# ~120MB model file
# Cached locally at ~/.cache/huggingface/
```

**After first download:** Zero network calls, 100% offline.

---

## Hook Privacy

### UserPromptSubmit Hook
- **Reads:** User's prompt (from environment variable)
- **Stores:** Nothing (search only, no logging)
- **Sends:** Nothing (100% local search)

### Can be disabled:
```bash
export MAMA_DISABLE_HOOKS=true
```

---

## Data Ownership

**You own all data:**
- Export: `sqlite3 ~/.claude/mama-memory.db .dump > backup.sql`
- Delete: `rm ~/.claude/mama-memory.db`
- Migrate: Copy database file to another machine

**No vendor lock-in:** SQLite is portable, open format.

---

## Security Considerations

### Filesystem Permissions
```bash
# Database file permissions (user-only read/write)
chmod 600 ~/.claude/mama-memory.db
```

### No Encryption
- Database is NOT encrypted at rest
- Relies on OS-level filesystem encryption (FileVault, LUKS, BitLocker)
- For sensitive decisions, use encrypted filesystem

### No Authentication
- MCP server is stdio (local process only)
- No network port, no remote access
- Only accessible by Claude Code process

---

## Compliance

**GDPR:** Compliant (no personal data leaves device)
**CCPA:** Compliant (no data collection)
**HIPAA:** Not certified (do not store PHI)

---

## Transparency

**Tier status always visible:**
```
🔍 System Status: 🟢 Tier 1 | Full Features Active
```

**You always know:**
- What tier is active
- What features are working
- What features are degraded

**No silent degradation, no hidden behavior.**

---

**Related:**
- [Architecture Overview](architecture.md)
- [Configuration Guide](../guides/configuration.md)
- [Hooks Reference](../reference/hooks.md)

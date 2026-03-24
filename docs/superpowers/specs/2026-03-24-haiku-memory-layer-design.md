# Haiku Memory Layer — Design Spec

**Issue:** TBD (to be created after spec approval)
**Date:** 2026-03-24
**Status:** Draft
**Branch:** `feat/haiku-memory-layer`

## Background

MAMA's memory system currently relies on manual `mama_save` calls and embedding-only cosine similarity search. Compared to systems like Supermemory, key gaps remain:

1. No automatic fact extraction from conversations
2. Embedding search can't judge what's meaningful or understand query intent
3. Superseded decisions pollute search results (no `isLatest` filtering)
4. No user profile concept (static vs dynamic facts)
5. No keyword search (exact term matching fails with embeddings alone)

This spec adds an optional Haiku intelligence layer inside the MCP server that addresses all five gaps using the user's existing Claude CLI OAuth tokens (no API key setup needed).

## Design Principles

- **Opt-in**: When OAuth token is unavailable, 100% existing behavior. Zero breakage.
- **Local-first**: OAuth tokens from `~/.claude/.credentials.json`. No new cloud dependencies beyond Anthropic API (which the user already has).
- **Incremental**: Each phase delivers standalone value. Phase 1 alone is a meaningful upgrade.
- **No new packages**: All changes within existing mama-core, mcp-server, standalone.

## Phase 1: Auto-Extract + isLatest Filter

### 1.1 HaikuClient

**File:** `packages/mama-core/src/haiku-client.ts` (new)

Lightweight wrapper around Anthropic SDK using OAuth tokens from the existing `OAuthManager` pattern (`packages/standalone/src/auth/oauth-manager.ts`).

```ts
interface HaikuClient {
  available(): boolean; // OAuth token exists?
  complete(system: string, user: string): Promise<string>; // single Haiku call
}
```

- Reads `~/.claude/.credentials.json` via OAuthManager
- Uses same OAuth headers as `ClaudeClient` (authToken, OAUTH_HEADERS, Claude Code identity)
- Model: `claude-haiku-4-5-20251001`
- Timeout: 10s per call
- If token unavailable or expired: `available()` returns false, callers skip Haiku

**MCP server usage**: The MCP server (`packages/mcp-server/`) is pure JS but already imports mama-core via `require('@jungjaehoon/mama-core/mama-api')`. HaikuClient lives in mama-core (TypeScript, compiled to JS) and the MCP server consumes it via `require('@jungjaehoon/mama-core/haiku-client')`. This follows the existing pattern and respects the reuse-first principle.

**Token refresh**: HaikuClient reuses the existing `OAuthManager.getToken()` pattern which handles auto-refresh. Long coding sessions must not silently lose Haiku features due to token expiry. If the token becomes permanently unavailable (e.g., user logged out), emit a visible warning: `[MAMA] Smart memory disabled: OAuth token unavailable. Use mama_save for manual saving.`

**Circuit breaker**: After 3 consecutive Haiku call failures, disable Haiku for 5 minutes and fall back to embedding-only. Log `[MAMA] Smart memory paused (API errors). Retrying in 5m.` This prevents cascading timeouts in Phase 3 gateway auto-save.

### 1.2 FactExtractor

**File:** `packages/mama-core/src/fact-extractor.ts` (new)

Extracts structured facts from conversation text using Haiku.

```ts
interface ExtractedFact {
  topic: string; // e.g., "database_choice"
  decision: string; // e.g., "Use SQLite for local storage"
  reasoning: string; // e.g., "No network dependency, embedded"
  is_static: boolean; // true = long-term (tech stack), false = short-term (current task)
  confidence: number; // 0.0-1.0
}

async function extractFacts(content: string, haiku: HaikuClient): Promise<ExtractedFact[]>;
```

**System prompt** (fixed, not user-configurable):

```
You are a fact extractor for a developer's memory system.
Given a conversation between a user and an AI assistant, extract ONLY:
- Architecture decisions (database, framework, language choices)
- Technical choices (API design, config changes, deployment strategy)
- Important constraints or requirements discovered
- Lessons learned (what worked, what failed, why)

DO NOT extract:
- Greetings, thanks, casual chat
- Questions without answers
- Temporary debugging steps
- Code snippets (the code itself is in the repo)

For each fact, classify as:
- static: true if this is a long-term preference/choice (tech stack, coding style, role)
- static: false if this is about current work (this PR, this sprint, this bug)

Return JSON array of: {topic, decision, reasoning, is_static, confidence}
Return empty array [] if nothing worth saving.
```

**After extraction:**

1. For each fact, call `mama.search(fact.topic)` to find existing decisions
2. If similar decision exists on same topic (similarity > 0.75): let Haiku judge whether it's a true supersedes relationship or a separate decision. Threshold 0.75 matches existing `queryVectorSearch` default.
3. Save via `mama.save()` with extracted fields

### 1.3 mama_add MCP Tool

**File:** `packages/mcp-server/src/tools/add-memory.js` (new)

```json
{
  "name": "mama_add",
  "description": "Ingest conversation content. MAMA automatically extracts and saves important decisions and facts. Use after completing meaningful tasks.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "Conversation content or summary to extract facts from"
      }
    },
    "required": ["content"]
  }
}
```

**Flow:**

1. Receive content
2. If HaikuClient available → FactExtractor → structured facts → mama.save() each
3. If HaikuClient unavailable → return `{ success: false, error: "Smart memory unavailable. Use mama_save to save decisions manually." }` (do not save raw content — it would pollute the decisions table with unsearchable entries)

**Response:** `{ success: true, extracted: 3, saved: 2, skipped_duplicates: 1 }`

**Relationship with existing `mama_save`**: `mama_add` is for raw content (conversations, docs) that need Haiku extraction. `mama_save` is for pre-structured decisions the user/agent already formulated. Both coexist — `mama_add` calls `mama_save` internally after extraction. MCP instructions guide the agent: use `mama_add` after completing tasks, use `mama_save` when you already know the exact decision to record.

### 1.4 isLatest Filter

**Approach:** Use `superseded_by IS NULL` as the filter condition instead of adding a separate `is_latest` column. The existing `decisions` table already has a `superseded_by` field that is set when a `supersedes` edge is created. Adding a redundant column creates a sync risk.

**No DB migration needed for this feature.**

**Search change:** Default WHERE clause adds `AND superseded_by IS NULL`. Optional parameter `include_superseded: true` to see full history.

**Trigger:** When `decision-tracker.ts` creates a `supersedes` edge, `superseded_by` is already set on the old decision. No additional code needed — just the search filter.

### 1.5 MCP Server Instructions

Add `instructions` field to MCP server constructor so all clients receive guidance:

```ts
const server = new Server(
  { name: 'mama', version: '2.0.0' },
  {
    instructions: `You have access to MAMA memory tools.
After completing any meaningful task, call mama_add with a summary of what was decided and why.
Before starting work on any topic, call mama_search to check for prior decisions.
Do NOT call mama_add for greetings, casual chat, or trivial exchanges.`,
  }
);
```

## Phase 2: Smart Search + Hybrid + User Profile

### 2.1 Hybrid Search (FTS5)

**DB migration:** Create FTS5 virtual table for keyword search.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  topic, decision, reasoning,
  content='decisions',
  content_rowid='rowid'
);
```

**FTS5 sync triggers** (required for `content=` external content tables):

```sql
-- After INSERT on decisions
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;

-- Before DELETE on decisions
CREATE TRIGGER IF NOT EXISTS decisions_ad BEFORE DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;

-- Before UPDATE on decisions
CREATE TRIGGER IF NOT EXISTS decisions_au BEFORE UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;

-- After UPDATE on decisions
CREATE TRIGGER IF NOT EXISTS decisions_au2 AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;
```

**Search flow:**

```
mama_search(query)
  → 1. FTS5 keyword match (exact terms)     → candidates A
  → 2. Embedding cosine similarity           → candidates B
  → 3. Merge A + B, deduplicate by id
  → 4. If Haiku available: rerank merged results
  → 5. If not: score by (0.4 * fts_rank + 0.6 * cosine_similarity)
```

### 2.2 SmartSearch (Haiku Rerank)

**File:** `packages/mama-core/src/smart-search.ts` (new)

```ts
async function rerankResults(
  query: string,
  candidates: SearchResult[],
  haiku: HaikuClient
): Promise<SearchResult[]>;
```

**System prompt:**

```
Given a search query and candidate memory results, rerank by relevance.
Consider: query intent, temporal relevance, decision currency (is it still valid?).
Return indices in order of relevance, with brief explanation for top result.
```

Only called when Haiku is available AND candidates exceed configurable threshold (default: 3, configurable via `smart_memory.rerank_min_candidates`).

### 2.3 User Profile (is_static)

**DB migration:** Add `is_static` column to `decisions` table.

```sql
ALTER TABLE decisions ADD COLUMN is_static INTEGER DEFAULT 0;
```

**FactExtractor** already classifies facts as static/dynamic (Phase 1 spec).

**Profile injection:** When `mama_search` is called, static facts matching the query get priority boost (+0.2 to relevance score). This means "User prefers TypeScript" always surfaces above "Used Python for this script".

**New MCP tool:** `mama_profile`

```json
{
  "name": "mama_profile",
  "description": "Get user profile summary: long-term preferences, tech stack, role, coding style.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": { "type": "number", "default": 10 }
    }
  }
}
```

Returns all `is_static = 1, is_latest = 1` decisions, sorted by confidence.

## Phase 3: Gateway Auto-Save

### 3.1 Gateway Integration

In each gateway's message handler (Telegram, Discord, Slack), after response is sent:

```ts
// After sending response
await this.sendMessage(chatId, result.response);

// Auto-save (fire-and-forget, non-blocking)
if (factExtractor.available()) {
  factExtractor.extractAndSaveInBackground(`User: ${text}\nAssistant: ${result.response}`);
}
```

This makes gateway conversations automatically feed into the memory system without the agent needing to call `mama_add`.

### 3.2 Rate Limiting

- Max 1 extraction per conversation turn (no duplicate extraction)
- Min content length: 100 chars (skip very short exchanges)
- Max content length: 10,000 chars (truncate to avoid excessive Haiku costs)
- Cooldown: 30s between extractions per channel
- Buffer accumulation: accumulate 3-5 turns before extracting, or let Haiku judge whether accumulated content has extractable decisions (avoids partial-conversation noise)

## DB Migration Summary

**Migration files** (following existing numbering from `013-replace-vss-with-embeddings.sql`):

```sql
-- 014-add-is-static-column.sql (Phase 2)
ALTER TABLE decisions ADD COLUMN is_static INTEGER DEFAULT 0;

-- 015-add-fts5-search.sql (Phase 2)
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  topic, decision, reasoning,
  content='decisions',
  content_rowid='rowid'
);
-- Plus sync triggers (see section 2.1 for full trigger SQL)

-- Backfill existing decisions into FTS index:
INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  SELECT rowid, topic, decision, reasoning FROM decisions;
```

Phase 1 requires **no DB migration** — `isLatest` filter uses existing `superseded_by IS NULL`.

Backward compatible — existing decisions get `is_static=0` default.

## Config

Standalone uses `~/.mama/config.yaml` (parsed by standalone config-loader). MCP server reads environment variables. Both are supported:

```yaml
# ~/.mama/config.yaml (standalone)
smart_memory:
  enabled: true
  model: claude-haiku-4-5-20251001
  auto_extract_gateway: true
  min_content_length: 100
  max_content_length: 10000
  extraction_cooldown_ms: 30000
  rerank_min_candidates: 3
```

```bash
# Environment variables (MCP server)
MAMA_SMART_MEMORY=true
MAMA_SMART_MODEL=claude-haiku-4-5-20251001
```

OAuth token is auto-detected from `~/.claude/.credentials.json`. No config needed.

## Cost Estimate

| Operation           | Haiku Cost | Frequency                          |
| ------------------- | ---------- | ---------------------------------- |
| mama_add extraction | ~$0.001    | Per meaningful conversation        |
| mama_search rerank  | ~$0.0005   | Per search with >3 candidates      |
| mama_profile        | $0         | DB query only, no Haiku            |
| Gateway auto-save   | ~$0.001    | Per gateway message (rate limited) |

Typical daily cost for active developer: **~$0.01-0.05/day**.

## File Change Summary

### New Files

| File                                 | Package    | Purpose                                   |
| ------------------------------------ | ---------- | ----------------------------------------- |
| `mama-core/src/haiku-client.ts`      | mama-core  | OAuth-based Haiku API client              |
| `mama-core/src/fact-extractor.ts`    | mama-core  | Conversation → structured facts via Haiku |
| `mama-core/src/smart-search.ts`      | mama-core  | Haiku rerank for search results           |
| `mcp-server/src/tools/add-memory.js` | mcp-server | mama_add MCP tool                         |
| `mcp-server/src/tools/profile.js`    | mcp-server | mama_profile MCP tool                     |

### Modified Files

| File                                  | Package    | Change                                             |
| ------------------------------------- | ---------- | -------------------------------------------------- |
| `mama-core/src/db-manager.ts`         | mama-core  | Add is_latest, is_static columns, FTS5 table       |
| `mama-core/src/decision-tracker.ts`   | mama-core  | Set is_latest=0 on superseded decisions            |
| `mama-core/src/memory-store.ts`       | mama-core  | Add is_latest filter to search queries             |
| `mama-core/src/relevance-scorer.ts`   | mama-core  | Add is_static priority boost, hybrid score merge   |
| `mama-core/src/mama-api.ts`           | mama-core  | Add `add()` function, expose profile query         |
| `mcp-server/src/server.js`            | mcp-server | Add instructions, register mama_add + mama_profile |
| `standalone/src/gateways/telegram.ts` | standalone | Phase 3: auto-save after response                  |
| `standalone/src/gateways/discord.ts`  | standalone | Phase 3: auto-save after response                  |
| `standalone/src/gateways/slack.ts`    | standalone | Phase 3: auto-save after response                  |

### Not Changed

| What                 | Why                                                     |
| -------------------- | ------------------------------------------------------- |
| DB schema structure  | Only additive columns + FTS virtual table               |
| Existing mama_save   | Works as before, manual saving still available          |
| Existing mama_search | Backward compatible, new features are additive          |
| claude-code-plugin   | Hooks still work. MCP server gets smarter transparently |
| Embedding model      | Still used for 1st-pass candidate retrieval             |

## Testing Strategy

**Happy path:**

- Unit tests for FactExtractor (mock Haiku responses, verify extraction logic)
- Unit tests for isLatest (supersedes edge → old decision filtered via `superseded_by IS NULL`)
- Unit tests for FTS5 hybrid search (keyword + vector merge)
- Unit tests for SmartSearch rerank (mock Haiku, verify ordering)
- Integration test: mama_add → extract → save → mama_search returns it
- Fallback test: no OAuth token → all features degrade gracefully to existing behavior

**Edge cases:**

- Haiku returns malformed JSON from extraction prompt → graceful error, no crash
- Content passed to mama_add exceeds max_content_length → truncation applied correctly
- FTS5 index rebuild mechanism if index becomes corrupted (`INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')`)
- Concurrent mama_add calls → no race condition on supersedes edge creation (SQLite serialized writes handle this)
- Circuit breaker: 3 consecutive failures → Haiku disabled → re-enabled after cooldown → Haiku calls resume
- Token expiry mid-session → warning emitted, graceful fallback, recovery when token refreshes

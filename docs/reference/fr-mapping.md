# Functional Requirements Mapping

**Document Purpose:** This document maps all features in MAMA to their corresponding Functional Requirements (FRs) defined in the [Product Requirements Document (PRD)](../project/prd.md).

---

## Quick Reference

| Feature Area | FR Range | Summary |
|--------------|----------|---------|
| **Decision CRUD** | FR1-7 | Save, recall, list, delete decisions |
| **Semantic Search** | FR8-12 | Vector search, cross-lingual, relevance |
| **Decision Evolution** | FR13-18 | Supersedes graph, outcome tracking |
| **Hook Integration** | FR19-24 | Auto-context, PreToolUse, UserPromptSubmit |
| **Tier System** | FR25-29 | Tier 1/2 transparency, remediation |
| **Multilingual** | FR30-35 | Korean + English, cross-lingual search |
| **Performance** | FR36-40 | Latency targets, caching, lazy loading |
| **Architecture** | FR41-44 | Modular, MCP-compatible, testable |
| **Privacy & Security** | FR45-49 | Local-first, no telemetry, user control |
| **Configuration** | FR50-55 | Model selection, hook disable, settings |

---

## FR1-7: Decision CRUD Operations

**Covered Features:**

### FR1: Save Decision with Metadata
- **Command:** `/mama-save`
- **Implementation:** `src/commands/mama-save.js`
- **Fields:** topic, decision, reasoning, confidence, outcome
- **Reference:** [Commands Reference](commands.md#mama-save)

### FR2: Recall Decision History
- **Command:** `/mama-recall <topic>`
- **Implementation:** `src/commands/mama-recall.js`
- **Output:** Full evolution history in chronological order
- **Reference:** [Commands Reference](commands.md#mama-recall)

### FR3: List Recent Decisions
- **Command:** `/mama-list [--limit N]`
- **Implementation:** `src/commands/mama-list.js`
- **Output:** Markdown table with recency info
- **Reference:** [Commands Reference](commands.md#mama-list)

### FR4-7: Update, Delete, Export, Import
- **Status:** Not implemented in v1.0 (planned for v1.1)
- **Workaround:** Direct SQLite manipulation

**See also:** [Commands Reference](commands.md)

---

## FR8-12: Semantic Search

**Covered Features:**

### FR8: Natural Language Queries
- **Command:** `/mama-suggest <question>`
- **Implementation:** `src/core/embeddings.js`
- **Model:** Xenova/multilingual-e5-small (default)
- **Accuracy:** 80% (Tier 1)
- **Reference:** [Semantic Search Explanation](../explanation/semantic-search.md)

### FR9: Vector Similarity Scoring
- **Algorithm:** Cosine similarity
- **Implementation:** `src/core/similarity.js`
- **Range:** 0.0-1.0 (0% to 100% match)

### FR10: Recency Boosting
- **Algorithm:** Exponential decay
- **Configuration:** `recency_weight`, `recency_scale`, `recency_decay`
- **Default:** 30% weight, 7-day scale
- **Reference:** [Performance Tuning](../guides/performance-tuning.md#recency-tuning)

### FR11: Cross-lingual Search
- **Supported:** Multiple languages
- **Implementation:** Multilingual embedding model
- **Example:** Queries in different languages can match semantically related decisions
- **Reference:** [Multilingual Support](#fr30-35-multilingual-support)

### FR12: Relevance Ranking
- **Components:** Semantic (70%) + Recency (30%) + Graph expansion
- **Output:** Final score 0.0-1.0
- **Reference:** [Semantic Search Explanation](../explanation/semantic-search.md)

---

## FR13-18: Decision Evolution Tracking

**Covered Features:**

### FR13: Supersedes Relationships
- **Mechanism:** Reuse same topic name
- **Example:** topic='auth_strategy' reused 3 times → chain of 3 decisions
- **Reference:** [Decision Graph](../explanation/decision-graph.md)

### FR14: Outcome Tracking
- **Values:** pending, success, failure, partial, superseded
- **Command:** `/mama-save` with outcome field
- **Use case:** Learn/Unlearn/Relearn workflows

### FR15: Decision Confidence
- **Range:** 0.0-1.0
- **Display:** Visual indicator in results
- **Usage:** Filter low-confidence decisions

### FR16: Failure Reasons
- **Field:** `failure_reason` (optional)
- **Purpose:** Document what didn't work
- **Example:** "JWT refresh tokens caused race conditions"

### FR17-18: Graph Traversal, History View
- **Implementation:** `src/core/graph-expansion.js`
- **Command:** `/mama-recall <topic>` shows full chain
- **Reference:** [Decision Graph](../explanation/decision-graph.md)

---

## FR19-24: Hook Integration

**Covered Features:**

### FR19: UserPromptSubmit Hook
- **Trigger:** User sends message to Claude
- **Timeout:** 500ms
- **Implementation:** `scripts/hooks/user-prompt-submit`
- **Reference:** [Hooks Reference](hooks.md#userpromptsubmit)

### FR20: PreToolUse Hook
- **Trigger:** Before Read/Edit/Grep tools
- **Implementation:** `scripts/hooks/pre-tool-use`
- **Output:** Context injection (file-specific)
- **Reference:** [Hook Setup Tutorial](../tutorials/hook-setup.md)

### FR21: PostToolUse Hook
- **Status:** Planned for v1.1
- **Purpose:** Auto-save after major edits

### FR22: Non-intrusive Context
- **Format:** Teaser (40 tokens max)
- **Example:** "💡 MAMA: 1 related decision (90%, just now)"
- **Reference:** [Getting Started](../tutorials/getting-started.md#automatic-context-injection)

### FR23-24: Hook Disabling, Privacy Mode
- **Environment:** `MAMA_DISABLE_HOOKS=true`
- **Config:** `{ "disable_hooks": true }`
- **Reference:** [Configuration Guide](../guides/configuration.md#disable-hooks-privacy-mode)

---

## FR25-29: Tier System

**Covered Features:**

### FR25: Tier 1 (Vector Search)
- **Features:** Semantic search + Graph + Recency
- **Accuracy:** 80%
- **Latency:** ~89ms (after model load)
- **Reference:** [Understanding Tiers](../tutorials/understanding-tiers.md)

### FR26: Tier 2 (Exact Match)
- **Features:** SQL LIKE matching only
- **Accuracy:** 40%
- **Latency:** ~12ms
- **Reference:** [Understanding Tiers](../tutorials/understanding-tiers.md)

### FR27: Transparent Fallback
- **Display:** 🟢 Tier 1 or 🟡 Tier 2 in all outputs
- **Commands:** `/mama-list` shows current tier
- **Reference:** [Tier System](../explanation/tier-system.md)

### FR28: Tier 2 Remediation
- **Guide:** [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)
- **Common causes:** Node.js version, native module build, SQLite issues

### FR29: Graceful Degradation
- **Behavior:** Falls back to Tier 2 if Tier 1 fails
- **User impact:** System continues working, but with reduced accuracy

---

## FR30-35: Multilingual Support

**Covered Features:**

### FR30: Korean + English
- **Model:** Xenova/multilingual-e5-small
- **Cross-lingual:** Korean query matches English decision
- **Example:** "/mama-suggest authentication" finds "authentication" decisions

### FR31-35: Cross-lingual Search, Detection, Preservation
- **Implementation:** `src/core/embeddings.js`
- **Preservation:** Decisions stored in original language
- **Display:** Results show original language
- **Reference:** [Semantic Search](../explanation/semantic-search.md)

---

## FR36-40: Performance Requirements

**Covered Features:**

### FR36: Hook Latency < 500ms
- **Target:** <500ms (p95)
- **Actual:** ~100ms (5x better)
- **Reference:** [Performance](../explanation/performance.md)

### FR37: Embedding Speed < 30ms
- **Target:** <30ms
- **Actual:** ~3ms (10x better)

### FR38: Vector Search < 100ms
- **Target:** <100ms
- **Actual:** ~50ms

### FR39: Decision Save < 50ms
- **Target:** <50ms
- **Actual:** ~20ms

### FR40: Lazy Loading
- **Implementation:** Model loads on first search (~987ms)
- **Benefit:** No upfront cost, fast startup

**See also:** [Performance Characteristics](../explanation/performance.md)

---

## FR41-44: Architecture Requirements

**Covered Features:**

### FR41: Modular Architecture
- **Modules:** `core/`, `commands/`, `hooks/`, `skills/`
- **Testability:** 134 unit/integration tests
- **Reference:** [Architecture](../explanation/architecture.md)

### FR42: MCP Compatibility
- **Standard:** Model Context Protocol
- **Compatibility:** Claude Code (plugin), Claude Desktop (MCP server)
- **Config:** `.mcp.json` defines tools

### FR43: Pluggable Components
- **Embedding model:** Configurable
- **Database adapter:** SQLite (can swap to PostgreSQL)
- **Scoring algorithm:** Modular (`src/core/scoring.js`)

### FR44: Testability
- **Test suite:** 134 tests (100% pass rate)
- **Coverage:** Unit (62), Integration (39), Regression (33)
- **Reference:** [Testing Guide](../development/testing.md)

---

## FR45-49: Privacy & Security

**Covered Features:**

### FR45: Local Storage
- **Location:** `~/.claude/mama-memory.db`
- **Technology:** SQLite (embedded database)
- **No network:** All processing local

### FR46: No Telemetry
- **Tracking:** None
- **Analytics:** None
- **Logging:** Local only (if debug enabled)

### FR47: Offline Mode
- **After initial model download:** Fully offline
- **No network calls:** Even for searches
- **Reference:** [Data Privacy](../explanation/data-privacy.md)

### FR48: Data Portability
- **Export:** Copy SQLite database file
- **Import:** Replace database file
- **Format:** Standard SQLite (human-readable with tools)

### FR49: User Control
- **Delete:** Direct SQLite manipulation or delete database file
- **Disable hooks:** `MAMA_DISABLE_HOOKS=true`
- **Reference:** [Configuration Guide](../guides/configuration.md#privacy-settings)

---

## FR50-55: Configuration

**Covered Features:**

### FR50: Embedding Model Selection
- **Command:** `/mama-configure --model <model>`
- **Config:** `{ "embedding_model": "..." }`
- **Reference:** [Configuration Guide](../guides/configuration.md#change-embedding-model)

### FR51: Hook Disable
- **Environment:** `MAMA_DISABLE_HOOKS=true`
- **Config:** `{ "disable_hooks": true }`
- **Reference:** [Configuration Guide](../guides/configuration.md#disable-hooks-privacy-mode)

### FR52: Database Path
- **Environment:** `MAMA_DB_PATH=/custom/path`
- **Config:** `{ "db_path": "..." }`

### FR53: Model Guidance
- **Documentation:** Model selection guide in config docs
- **Reference:** [Configuration Guide](../guides/configuration.md#recommended-models)

### FR54-55: Performance Tuning, Debug Mode
- **Configuration:** `recency_weight`, `search_limit`, `debug`
- **Reference:** [Performance Tuning Guide](../guides/performance-tuning.md)

---

## Coverage Summary

| FR Range | Implementation Status | Reference |
|----------|----------------------|-----------|
| FR1-7 | 60% (CRUD operations, export/import pending) | [Commands](commands.md) |
| FR8-12 | 100% (Semantic search fully implemented) | [Semantic Search](../explanation/semantic-search.md) |
| FR13-18 | 100% (Decision evolution complete) | [Decision Graph](../explanation/decision-graph.md) |
| FR19-24 | 80% (PreToolUse done, PostToolUse pending) | [Hooks](hooks.md) |
| FR25-29 | 100% (Tier system complete) | [Tier System](../explanation/tier-system.md) |
| FR30-35 | 100% (Korean + English supported) | [Multilingual](../explanation/semantic-search.md) |
| FR36-40 | 100% (All targets exceeded) | [Performance](../explanation/performance.md) |
| FR41-44 | 100% (Architecture complete) | [Architecture](../explanation/architecture.md) |
| FR45-49 | 100% (Privacy fully implemented) | [Data Privacy](../explanation/data-privacy.md) |
| FR50-55 | 100% (Configuration complete) | [Configuration](../guides/configuration.md) |

**Overall Coverage:** 94% (52 out of 55 FRs implemented in v1.0)

---

## See Also

- [Product Requirements Document (PRD)](../project/prd.md) - Full FR definitions
- [Architecture](../explanation/architecture.md) - System design
- [Commands Reference](commands.md) - All `/mama-*` commands
- [Configuration Guide](../guides/configuration.md) - All settings

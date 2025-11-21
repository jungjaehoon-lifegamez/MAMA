# MAMA Plugin - Product Requirements Document

**Author:** spellon
**Date:** 2025-11-20
**Version:** 4.0 (Architecture-Driven Updates)
**Product Type:** Claude Code Plugin + MCP Server
**Target Release:** Phase 1 - 5 weeks

---

## Executive Summary

MAMA (Memory-Augmented MCP Assistant) is a **consciousness flow companion** that remembers how you think, not just what you concluded. It preserves the evolution of your decisions—from failed attempts to successful solutions—preventing you from repeating the same mistakes by tracking the journey from confusion to clarity.

### Core Insight

> "정보를 기록하는게 아니라 의사의 흐름을 기억하는거"
> (Not recording information, but remembering the flow of decisions)

### What Makes This Special

**The Documentation Fallacy:**
Traditional documentation says "Use JWT for authentication." But where's the why?
- Session cookies → Why abandoned?
- OAuth → Why too complex?
- JWT → Why this won?

Result: Next person repeats the journey from scratch.

**The MAMA Way:**
Decision Evolution with full context:
1. Session cookies (tried first) → Failed: Scaling issues
2. OAuth 2.0 (considered) → Failed: Over-engineered
3. JWT (chosen) → Success: Balanced simplicity and scalability

Result: Next person sees the full journey, avoids same failures.

### Vision

"어느순간 작은 디바이스로 또는 안경으로 나를 도와주는 컴패니언이있다면"
(Someday, having a companion on a small device or glasses helping me)

An always-on companion that:
- Works everywhere Claude works (Code + Desktop + Future platforms)
- Remembers your consciousness flow, not just conclusions
- Prevents repeating mistakes through decision evolution tracking
- Available on your laptop today, your phone tomorrow, your glasses in the future

---

## Project Classification

**Technical Type:** Developer Tool (Claude Code Plugin + MCP Server)
**Domain:** AI/LLM Tooling, Knowledge Management
**Complexity:** Medium-High
**Distribution:** Dual-platform (Claude Code + Claude Desktop)
**Architecture:** Unified Plugin (Hooks + Skills + Commands + MCP Server)

### Technology Stack

**Core:**
- Node.js >=22.11.0 LTS ("Jod" release, support until April 2027)
- TypeScript ^5.9.3 (August 2025 release)
- SQLite 3 (better-sqlite3 ^12.4.1)
- sqlite-vec ^0.1.5 (vector search, replaces deprecated sqlite-vss)
- @huggingface/transformers ^3.7.6 (migration from @xenova/transformers v2.17.0)
- @modelcontextprotocol/sdk ^1.7.0

**Embedding Models (User Configurable):**
- Default: Xenova/multilingual-e5-small (384-dim, Korean-English)
- Alternative: Xenova/all-MiniLM-L6-v2 (English-only, faster)
- Alternative: Xenova/gte-large (highest accuracy)

**Installation:**
- ✅ NPM-only (no Python, no C++ compilation, no external services)
- ✅ Works on all platforms where Node.js runs
- ✅ First model download: ~987ms (cached thereafter)

**Plugin Components:**
- Hooks: UserPromptSubmit, PreToolUse, PostToolUse
- Skills: Auto-context injection, Decision lookup
- Commands: /mama-recall, /mama-suggest, /mama-list, /mama-save, /mama-configure
- MCP Server: stdio transport (local) + Streamable HTTP (Railway, 2025-03-26 spec)

**Distribution Targets:**
- Claude Code: Full features (Hooks + Skills + Commands + MCP)
- Claude Desktop: MCP Server only (manual tool invocation)

---

## Success Criteria

### Phase 1 (Week 1-5): Multi-Platform MVP

**Adoption Metrics:**
- [ ] 10+ Claude Code users install plugin (hooks + skills)
- [ ] 100+ Claude Desktop users install MCP server
- [ ] 150+ decisions saved across both platforms
- [ ] 500+ context injections (automatic + manual)

**Engagement Metrics:**
- [ ] Daily active users: >15 (combined platforms)
- [ ] Avg decisions per user: >5
- [ ] Hook injection acceptance rate: >70% (Claude uses context)
- [ ] Cross-platform usage: >20% (same user, both platforms)

**Quality Metrics:**
- [ ] Semantic search accuracy: >80% (relevant results)
- [ ] Hook latency: <500ms (p95) - VALIDATED: 100ms actual
- [ ] Embedding latency: <30ms (p95) - VALIDATED: 3ms actual ⭐
- [ ] Installation success rate: 100% (via 2-tier fallback)
- [ ] Zero critical bugs
- [ ] Zero silent failures (transparency requirement)

### North Star Metric

**"Number of mistakes prevented by MAMA memory"**

Proxy metric:
```
Failed decision surfaced → User avoids same approach
= Count(Context injection with FAILED outcome shown)
```

### Business Metrics

**Market Size:**
- Claude Code: ~10K-100K users (20% of market)
- Claude Desktop: ~500K-1M users (80% of market)
- **Total Addressable:** 510K-1.1M users

**Competitive Position:**
"The only memory system supporting BOTH Claude Code and Claude Desktop with decision evolution tracking"

---

## Product Scope

### MVP - Week 1-5 (Phase 1)

**Epic 0: Installation & Compatibility (P1, Day 1-3)** ✅ SIMPLIFIED
- 2-tier fallback strategy (Transformers.js → Exact match)
- NPM installation validation (Node.js 18+ check)
- Database initialization + migration handling
- Installation testing (basic smoke tests)
- **Goal:** 100% installation success rate (NPM-only, no native compilation)

**Epic 0.5: Embedding Validation (P1, Day 4)** ✅ MOSTLY COMPLETE
- Validate Transformers.js performance (DONE: 3ms measured)
- Test Korean-English cross-lingual search (DONE: Working in production)
- Verify model auto-download (DONE: 987ms first load)
- Document alternative models for different languages
- **Goal:** VALIDATED - 3ms embedding latency (10x better than 30ms target)

**Epic 1: Core Infrastructure (P0, Week 2)**
- SQLite database + schema + WAL mode
- Decision CRUD + validation (Zod)
- MCP server skeleton + .mcpb packaging
- Tier detection and status reporting

**Epic 2: Decision Evolution Graph (P0, Week 2)**
- Supersedes edge creation (decision A → supersedes → decision B)
- Graph traversal algorithm (follow evolution chain)
- Evolution history formatter (markdown output)

**Epic 3: Semantic Search (P1, Week 2)**
- @huggingface/transformers integration + embedding generation
- sqlite-vec vector storage (replaces deprecated sqlite-vss)
- Hybrid scoring (manual weighted: 20% recency + 50% importance + 30% semantic)
- Model caching (warm start optimization)

**Epic 4: Plugin Integration (P0, Week 3-4)** ⭐ CRITICAL PATH
- UserPromptSubmit hook (automatic context injection)
- PreToolUse hook (inject context before Read/Edit/Grep)
- PostToolUse hook (auto-save decisions after Write/Edit)
- Relevance filtering (>75% similarity threshold)
- Performance optimization (<500ms target, NOT 2s)
- Structured logging + metrics (observability)

**Epic 5: Commands & Skills (P1, Week 4)**
- /mama-recall command (show evolution history)
- /mama-suggest command (semantic search)
- /mama-list command (recent decisions)
- /mama-save command (explicit save)
- Skills: Auto-context injection, Decision lookup

**Epic 6: Plugin Packaging (P0, Week 5)**
- plugin.json manifest (commands + skills + hooks + mcp)
- hooks.json configuration (UserPromptSubmit + PreToolUse + PostToolUse)
- .mcp.json configuration (stdio + HTTP transports)
- Zero-config installation workflow
- Installation testing (all platforms, all tiers)

**Epic 7: Outcome Tracking (P2, Week 5)**
- Update outcome API (SUCCESS/FAILED/PARTIAL)
- Failure reason tracking
- Success rate calculation per topic

**Epic 8: Testing & Documentation (P0, Week 6)**
- Unit tests (Vitest, >80% coverage)
- Integration tests (MCP protocol, hook lifecycle)
- Performance benchmarks (latency, accuracy, memory)
- User documentation + examples + troubleshooting

### Growth Features (Week 7+)

**Epic 9: Claude Desktop Expansion (P1, Week 7)**
- Extract @mama/core shared library
- Create @mama/server NPM package (published to registry)
- Claude Desktop configuration guide (claude_desktop_config.json)
- Cross-platform testing (Mac/Windows)
- **Goal:** 80% market coverage (from 20%)

**Epic 10: Advanced Features (Phase 2, Month 2-3)**
- Export/import decisions (JSON, Markdown)
- Team collaboration (shared decision DB)
- Cloud sync (optional PostgreSQL backend)
- Web UI for visualization
- Mobile app (iOS/Android)

### Vision (Future)

**Phase 3: Standalone Apps**
- Desktop app (Electron, no Claude dependency)
- Mobile app (React Native)
- Browser extension (Chrome, Firefox)

**Phase 4: Wearable Research**
- Glasses integration (AR overlay)
- Smartwatch companion (quick recall)
- Voice interface (conversational memory)

---

## Domain-Specific Requirements

### Cross-Platform Compatibility (SIMPLIFIED)

**Problem (Solved):**
Transformers.js is pure JavaScript (no Python, no external services), so installation works on 100% of platforms where Node.js runs.

**Solution: 2-Tier Simple Strategy**

| Tier | Requirements | Features | Accuracy | Target Users |
|------|-------------|----------|----------|--------------|
| **Tier 1** | @xenova/transformers + better-sqlite3 | Full (vector + graph + recency) | 80% | 95%+ of users ✅ |
| **Tier 2** | Exact match (fallback if SQLite fails) | String matching only | 40% | Emergency failsafe |

**Installation Flow:**
1. Install via NPM (zero compilation, zero external dependencies)
2. Auto-download embedding model on first use (~987ms, cached thereafter)
3. If SQLite native module fails → Tier 2 (exact match only)
4. **Result:** 100% installation success (JavaScript always works)

**Pre-Installation Check:**
```bash
# check-compatibility.js validates Node.js version
node check-compatibility.js
# → "Node.js 18.0.0+ required (found: 20.10.0) ✅"
```

**Status Transparency:**
Every context injection shows current tier:
```
🔍 System Status: ✅ Full Features Active (Tier 1)
   - Vector Search: ✅ ON (Transformers.js, 3ms latency)
   - Graph Search: ✅ ON
   - Search Quality: HIGH (80% accuracy, semantic + graph + recency)

Model: Xenova/multilingual-e5-small (384-dim)
```

**Degraded Mode Example (Tier 2):**
```
🔍 System Status: ⚠️ DEGRADED MODE (Tier 2)
   - Vector Search: ❌ OFF (SQLite compilation failed)
   - Graph Search: ❌ OFF (fallback mode)
   - Search Quality: BASIC (40% accuracy, exact match only)

⚠️ Fix: Install build tools (see docs) or use Tier 2 mode
```

**Acceptance Criteria:**
- ✅ Tier 1 installs successfully on >95% of platforms (NPM + Node.js 18+)
- ✅ Tier 2 works as emergency fallback (100% success)
- ✅ No silent failures (all degradation visible to user)
- ✅ Installation completes in <1 minute (p95), NPM only

### Transparency & Trust (CORE PRINCIPLE)

**User Requirement:**
> "조용하게 실패해서 작동하는척하면 안되고 명확하게 폴백이나 에러를 알릴필요가 있어"
> (Must not silently fail and pretend to work. Clearly communicate fallback or errors.)

**Golden Rule:** NEVER silent failure. Always show:
1. **What's degraded:** "Vector search OFF"
2. **Why:** "SQLite native module failed to compile"
3. **How to fix:** "Install build tools or use Tier 2 mode"
4. **Impact:** "40% accuracy instead of 80%"

**3-State Fallback Machine:**

| State | Trigger | Behavior | User Notification |
|-------|---------|----------|-------------------|
| **Tier 1 (Full)** | Transformers.js + SQLite working | 80% accuracy | ✅ Full Features Active |
| **Tier 2 (Degraded)** | SQLite failed (native module) | 40% accuracy | ⚠️ DEGRADED MODE + fix instructions |
| **Total Failure** | Database corrupted or unrecoverable | No MAMA | ❌ CRITICAL ERROR + recovery steps |

**Status Banner (Teaser Format - ~40 tokens):**

**Philosophy:** Show minimal hints (topic + similarity + time) so Claude can infer if context is needed. Full details available via `/mama-recall <topic>`.

**Tier 1 (Full Features):**
```
💡 MAMA: 2 related
   • authentication_strategy (85%, 3 days ago)
   • mesh_detail (78%, 1 week ago)
   /mama-recall <topic> for details
```

**Tier 2 (Degraded - Exact Match Only):**
```
⚠️ MAMA (Degraded): 1 exact match
   • authentication_strategy (100%, 3 days ago)
   Vector search: OFF (install Ollama)
```

**Why Teaser Format:**
- Hook fires on every user prompt (continuous context injection)
- Large context → High token cost + slow LLM processing
- Claude infers relevance from topic + time (no full decision text needed)
- User can request details via `/mama-recall` if interested
- Target: ~40 tokens (vs 250 tokens in full format)

**Acceptance Criteria:**
- ✅ Every context injection includes status banner
- ✅ Degradation warnings show reason + fix + impact
- ✅ No silent failures (all errors visible)
- ✅ State transitions logged (Tier 1 → Tier 2 event)

### Embedding-Only Architecture (VALIDATED IN PRODUCTION)

**Primary Model:** `Xenova/multilingual-e5-small` (Transformers.js)
- **Library:** @huggingface/transformers ^3.7.6 (pure JavaScript, NPM-only, migration from @xenova v2.17.0)
- **Dimensions:** 384
- **Latency:** 3ms (actual measured) ✅ 10x better than target
- **First Load:** 987ms (one-time model download/cache)
- **Accuracy:** 80% (sufficient for semantic search)
- **Memory:** ~120MB (model loaded)
- **Multilingual:** Yes (Korean + English cross-lingual verified)
- **Installation:** Zero external dependencies (no Python, no Ollama, no build tools)

**Performance Validation (Actual Production Data):**

```bash
✅ First embedding: 987ms (model initialization, once)
✅ Subsequent: 3ms (10x better than 30ms target)
✅ Cached: 0ms (instant retrieval)
✅ Korean: 3ms (same as English)
✅ Batch(5): ~15ms total (3ms avg)
```

**Why Embedding-Only (No Local LLM Inference):**

User decision based on production experience:
- ❌ Local LLM inference: Weak reactivity (slow), inaccurate reasoning (hallucinations)
- ✅ Embedding model: Deterministic (no hallucination), fast (3ms), reliable
- ✅ Reasoning: Delegated to Claude (accurate, trusted, what users want)

This is "smart separation of concerns":
- **Local:** Vector search only (Transformers.js embedding)
- **Remote:** All reasoning/inference (Claude)

**Model Selection Strategy (User Configurable):**

MAMA provides a **default model** (Xenova/multilingual-e5-small) but allows users to choose the best model for their needs:

```javascript
// User configuration (~/.mama/config.json)
{
  "embedding_model": "Xenova/multilingual-e5-small", // Default (Korean-English)
  "embedding_dim": 384,
  "model_options": {
    "cache_dir": "~/.mama/models",
    "auto_download": true
  }
}
```

**Why User Choice Matters:**

Different users have different needs:
- 🇰🇷 **Korean users** (like author): Xenova/multilingual-e5-small (default) ✅
- 🇺🇸 **English-only users**: Xenova/all-MiniLM-L6-v2 (faster, smaller)
- 🇯🇵 **Japanese users**: Xenova/multilingual-e5-base (better Japanese support)
- 🇨🇳 **Chinese users**: Xenova/paraphrase-multilingual-MiniLM-L12-v2
- 🔬 **Researchers**: Xenova/gte-large (highest accuracy, larger)

**User Philosophy:**
> "각 사용자의 환경에 따라 더 좋은 모델이 있을 것이니, 우리가 다 준비하기보다는 선택하도록"
> (Better models exist for each user's environment, so let users choose rather than we prepare everything)

**Recommended Models by Use Case:**

| Use Case | Recommended Model | Dimensions | Size | Why |
|----------|------------------|-----------|------|-----|
| **Korean-English** (default) | Xenova/multilingual-e5-small | 384 | 120MB | Best cross-lingual |
| **English only** | Xenova/all-MiniLM-L6-v2 | 384 | 90MB | Faster, smaller |
| **Multi-language** | Xenova/multilingual-e5-base | 768 | 420MB | More languages |
| **High accuracy** | Xenova/gte-large | 1024 | 670MB | Best accuracy |
| **Speed priority** | Xenova/all-MiniLM-L12-v2 | 384 | 120MB | Fast inference |

**How to Change Model:**

1. **Via Command:**
   ```bash
   /mama-configure --model Xenova/all-MiniLM-L6-v2
   ```

2. **Via Config File:**
   ```bash
   echo '{"embedding_model": "Xenova/gte-large"}' > ~/.mama/config.json
   ```

3. **MAMA Auto-detects and Downloads:**
   - First use: Downloads model (~2s for 120MB)
   - Subsequent: Uses cached model (instant)

**Acceptance Criteria:**
- ✅ Default model works out-of-box (Xenova/multilingual-e5-small)
- ✅ Users can configure alternative models
- ✅ Model auto-download on first use
- ✅ Documentation lists recommended models by language
- ✅ Embedding latency <30ms (regardless of model)
- ✅ Search accuracy >70% (Korean test set)
- ✅ Graceful degradation when Ollama unavailable
- ✅ User notified of fallback mode

---

## Plugin Architecture (Unified Package)

### Directory Structure

```
mama-plugin/
├── .claude-plugin/
│   └── plugin.json              # Unified manifest (commands + skills + hooks + mcp)
├── commands/                    # Slash commands (Claude Code only)
│   ├── mama-recall.md
│   ├── mama-suggest.md
│   ├── mama-list.md
│   └── mama-save.md
├── skills/                      # Auto-invoked skills (Claude Code only)
│   ├── mama-context-injection/
│   │   └── SKILL.md
│   └── mama-decision-lookup/
│       └── SKILL.md
├── scripts/                     # Executable scripts for hooks
│   ├── inject-mama-context.sh
│   ├── validate-input.sh
│   ├── auto-save-decision.sh
│   └── mama-api-client.js
├── servers/                     # MCP servers (Both Claude Code + Desktop)
│   └── mama-server/             # Official structure (not mcp-server/)
│       ├── src/
│       │   ├── memory-store.js      # SQLite operations
│       │   ├── embeddings.js        # @huggingface/transformers integration
│       │   ├── decision-tracker.js  # Evolution graph
│       │   ├── formatters.js        # Output formatting
│       │   └── index.js             # MCP entry point
│       ├── package.json
│       └── tsconfig.json
├── .mcp.json                    # MCP server configuration
├── package.json                 # Plugin dependencies
├── LICENSE
└── README.md
```

### Plugin Manifest (plugin.json)

**Official Claude Code Structure (Unified Manifest):**

```json
{
  "name": "mama-plugin",
  "version": "1.0.0",
  "description": "MAMA - Memory-Augmented MCP Assistant for Claude Code and Desktop",
  "author": "SpineLift Team",
  "keywords": ["memory", "decisions", "context", "knowledge", "evolution"],
  "license": "MIT",

  "commands": [
    "./commands/mama-recall.md",
    "./commands/mama-suggest.md",
    "./commands/mama-list.md",
    "./commands/mama-save.md"
  ],

  "skills": [
    {
      "name": "mama-context-injection",
      "path": "./skills/mama-context-injection"
    },
    {
      "name": "mama-decision-lookup",
      "path": "./skills/mama-decision-lookup"
    }
  ],

  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-mama-context.sh"
      }]
    }],
    "PreToolUse": [{
      "matcher": "Read|Edit|Grep",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-mama-context.sh"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/auto-save-decision.sh"
      }]
    }]
  },

  "mcp": {
    "config": "./.mcp.json"
  }
}
```

### Hook Configuration

**⚠️ DEPRECATED:** Hooks are now defined in unified `.claude-plugin/plugin.json` (see above).

**Legacy Structure (hooks/hooks.json) - Do Not Use:**
This separate configuration file was used in older Claude Code versions but is now deprecated.
All hooks should be defined directly in `plugin.json` under the `hooks` key.

### MCP Server Configuration (.mcp.json)

```json
{
  "mcpServers": {
    "mama-local": {
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/servers/mama-server/dist/index.js"
      ],
      "env": {
        "MAMA_DATABASE_PATH": "${HOME}/.claude/mama-memory.db",
        "MAMA_EMBEDDING_MODEL": "Xenova/multilingual-e5-small",
        "NODE_ENV": "production",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

**For Claude Desktop (separate config):**
```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@mama/server"]
    }
  }
}
```

### Platform Compatibility

| Platform | Hooks | Skills | Commands | MCP Server | UX |
|----------|-------|--------|----------|------------|-----|
| **Claude Code** | ✅ Auto | ✅ Auto | ✅ /mama-* | ✅ Local | Automatic context injection |
| **Claude Desktop** | ❌ N/A | ❌ N/A | ❌ N/A | ✅ NPM | Manual tool invocation |

**Key Insight:**
Single plugin package supports both platforms. Claude Desktop ignores `commands`, `skills`, `hooks` and only loads MCP server.

---

## Functional Requirements

### FR Group 1: Decision Management (Core CRUD)

**FR1:** Users can save decisions with topic, decision text, reasoning (required), and confidence score
**FR2:** Users can recall decisions by exact topic name
**FR3:** Users can list recent decisions with pagination (default 10, max 100)
**FR4:** Users can update decision outcomes (SUCCESS/FAILED/PARTIAL) with failure reason
**FR5:** Users can delete decisions (with confirmation prompt)

### FR Group 2: Decision Evolution Tracking (Unique Feature)

**FR6:** System automatically creates "supersedes" edges when same topic saved multiple times
**FR7:** Users can view full evolution history for a topic (chronological chain)
**FR8:** System tracks decision outcomes and surfaces failed approaches when topic recalled
**FR9:** Users can see Learn-Unlearn-Relearn journey (COMPLEX → SIMPLE → MODERATE progressions)
**FR10:** System calculates success rate per topic (% of decisions marked SUCCESS)

### FR Group 3: Semantic Search & Discovery

**FR11:** Users can search decisions using natural language queries (semantic similarity)
**FR12:** System supports multilingual queries (Korean + English)
**FR13:** System ranks results using hybrid scoring (semantic + recency + graph expansion)
**FR14:** Users can filter search results by outcome status (SUCCESS/FAILED/PARTIAL)
**FR15:** System shows similarity score (%) for each search result

### FR Group 4: Automatic Context Injection (Claude Code Only)

**FR16:** System automatically injects relevant decisions when user submits prompt (UserPromptSubmit hook)
**FR17:** System automatically injects relevant decisions before Read/Edit/Grep operations (PreToolUse hook)
**FR18:** System filters context by relevance threshold (>75% similarity)
**FR19:** System limits context injection to top 3 most relevant decisions
**FR20:** System applies recency boost using Gaussian decay (recent decisions rank higher)

### FR Group 5: Decision Auto-Save (Claude Code Only)

**FR21:** System detects decision-like content in Write/Edit operations (PostToolUse hook)
**FR22:** System prompts user to save detected decisions with suggested topic
**FR23:** Users can accept, modify, or reject auto-save suggestions
**FR24:** System preserves reasoning from conversation context when auto-saving

### FR Group 6: Transparency & Status Reporting

**FR25:** System displays current tier status (1/2/3) in every context injection
**FR26:** System shows which features are active/degraded (vector search, graph search)
**FR27:** System provides fix instructions when features degraded
**FR28:** System quantifies degradation impact (accuracy drop percentage)
**FR29:** System logs all state transitions with timestamps (Tier 1 → Tier 2 events)

### FR Group 7: Cross-Platform Compatibility

**FR30:** Plugin installs successfully on all platforms (Linux, Mac, Windows) via 3-tier fallback
**FR31:** System detects platform capabilities and recommends tier before installation
**FR32:** Plugin works in both Claude Code (full features) and Claude Desktop (MCP only)
**FR33:** Both platforms share same database (~/.claude/mama-memory.db)
**FR34:** System migrates seamlessly between tiers without data loss

### FR Group 8: Commands & Skills (Claude Code)

**FR35:** Users can invoke /mama-recall <topic> to see evolution history
**FR36:** Users can invoke /mama-suggest <query> for semantic search
**FR37:** Users can invoke /mama-list [limit] for recent decisions
**FR38:** Users can invoke /mama-save to explicitly save current conversation as decision
**FR39:** Skills automatically activate based on context (no explicit invocation needed)

### FR Group 9: MCP Tools (Both Platforms)

**FR40:** MCP server provides save_decision tool (save with all metadata)
**FR40.1:** System MUST auto-generate embeddings when saving decisions (CRITICAL - without embeddings, semantic search fails)
**FR41:** MCP server provides recall_decision tool (show evolution history)
**FR42:** MCP server provides suggest_decision tool (semantic search with multilingual support)
**FR43:** MCP server provides list_decisions tool (paginated recent decisions)
**FR44:** MCP server provides update_outcome tool (mark SUCCESS/FAILED/PARTIAL)

### FR Group 10: Data Ownership & Privacy

**FR45:** All user data stored locally on user's device (~/.claude/mama-memory.db)
**FR46:** Users can export complete database at any time (JSON + SQLite file)
**FR47:** Users can import previously exported data (merge or replace)
**FR48:** System monitors database size and warns before 100MB limit
**FR49:** No telemetry or analytics (zero data sent to external servers)

### FR Group 11: Model Configuration & Customization

**FR50:** Users can configure embedding model via config file (~/.mama/config.json)
**FR51:** Users can invoke /mama-configure command to change model interactively
**FR52:** System auto-downloads selected model on first use (Transformers.js cache)
**FR53:** System provides recommended models list by language/use case in documentation
**FR54:** System validates model compatibility (Transformers.js supported models only)
**FR55:** Users can query current model configuration via /mama-status command

**Total Functional Requirements:** 56 FRs across 11 capability groups (FR40.1 added for embedding auto-generation)

---

## Non-Functional Requirements

### Performance

**Latency Targets:**

| Operation | Target (p95) | Actual (Measured) | Status |
|-----------|-------------|-------------------|--------|
| Hook injection latency | <500ms | ~100ms (mostly DB) | ✅ PASS |
| Embedding generation | <30ms | 3ms ⭐ | ✅ 10x better |
| Model first load | <2s | 987ms | ✅ PASS |
| Vector search | <100ms | ~50ms (JS implementation) | ✅ PASS |
| Decision save | <50ms | ~20ms | ✅ PASS |
| Decision recall | <100ms | ~30ms | ✅ PASS |

**Performance Optimization:**
- Cache embeddings (don't regenerate for same query)
- Index hot topics (frequently accessed decisions)
- Lazy load graph expansion (only if needed)
- Timeout after 500ms (fallback to exact match)

**Acceptance Criteria:**
- ✅ Hook latency <500ms (p95) - STRICT requirement
- ✅ Search completes in <300ms total (embedding + vector + rank)
- ✅ Memory footprint <100MB (plugin process)
- ✅ Database size <100MB for 10K decisions

### Security

**Data Location:** `~/.claude/mama-memory.db` (user's home directory)
**Access Control:** File system permissions (user-only read/write)
**Encryption:** Not required (local storage, user controls device)
**API Keys:** No external APIs (Transformers.js runs locally, no network calls)

**Threat Model:**
- ✅ No network exposure (SQLite file local, embeddings computed locally)
- ✅ No cloud sync (Phase 1 - local-first only)
- ✅ No authentication needed (single-user, local machine)
- ✅ No telemetry (zero data sent to external servers)

### Reliability

**Uptime:** N/A (local-first, no server)
**Data Durability:** SQLite WAL mode (crash-safe writes)
**Graceful Degradation:** 2-tier fallback (always works, quality varies)

**Failure Modes:**
1. SQLite native module failed → Tier 2 (exact match, pure JS)
2. Transformers.js model download failed → Retry with timeout + user notification
3. Database corrupted → Recovery guide shown + backup restoration
4. Disk full → Error with clear fix instructions (cleanup guide)

**Acceptance Criteria:**
- ✅ No data loss on crash (WAL mode)
- ✅ Automatic tier downgrade (no manual intervention)
- ✅ Clear recovery steps for total failure

### Accessibility

**Not Applicable for Phase 1:**
CLI/plugin tool has no UI accessibility requirements. Future web UI (Phase 3) will require:
- WCAG 2.1 AA compliance
- Screen reader support
- Keyboard navigation

### Integration

**Transformers.js Integration:**
- Library: @huggingface/transformers ^3.7.6 (pure JavaScript, NPM package, migration from @xenova v2.17.0)
- Model: User-configurable (default: Xenova/multilingual-e5-small, 384-dim)
- Installation: `npm install @huggingface/transformers` (zero compilation)
- Runtime: Local, no external service, no network calls (after model download)
- Fallback: Graceful (skip vector search if model fails to load)
- **Breaking Change:** `quantized` parameter → `dtype: 'fp32'` in model loading

**Claude Code Integration:**
- Hooks: UserPromptSubmit, PreToolUse, PostToolUse
- Skills: Auto-invoked based on context
- Commands: /mama-* slash commands (/mama-configure for model selection)
- MCP: Local stdio transport

**Claude Desktop Integration:**
- MCP: NPM package (@mama/server)
- Transport: stdio (npx invocation)
- Config: claude_desktop_config.json

---

## Implementation Planning

### Epic Breakdown (5 Weeks)

**Day 1-3: Epic 0 (Installation Validation)** - P1 SIMPLIFIED
- Story 0.1: NPM installation smoke test (Node.js 18+ check)
- Story 0.2: Database initialization + migration handling
- Story 0.3: Basic tier detection (SQLite native vs pure JS)
- Story 0.4: Installation error messages + troubleshooting guide

**Day 4: Epic 0.5 (Embedding Validation)** - P1 MOSTLY COMPLETE
- Story 0.5.1: Validate Transformers.js performance (DONE: 3ms)
- Story 0.5.2: Test Korean-English cross-lingual (DONE: Working)
- Story 0.5.3: Verify model auto-download (DONE: 987ms first load)
- Story 0.5.4: Document alternative models by language (NEW)

**Week 1: Epic 1-2 (Core Infrastructure + Graph)**
- Epic 1: SQLite setup, CRUD, validation, tier detection
- Epic 2: Supersedes edges, graph traversal, evolution formatter

**Week 2: Epic 3 (Semantic Search)**
- Transformers.js integration, model caching, hybrid ranking, config support

**Week 2-3: Epic 4 (Plugin Integration)** - CRITICAL PATH
- UserPromptSubmit hook, PreToolUse hook, PostToolUse hook
- Relevance filtering, performance optimization (<500ms, target: 100ms)
- Structured logging, metrics

**Week 3: Epic 5 (Commands & Skills)**
- /mama-recall, /mama-suggest, /mama-list, /mama-save, /mama-configure
- Skills: Context injection, Decision lookup

**Week 4: Epic 6 (Plugin Packaging)**
- plugin.json, hooks.json, .mcp.json
- Zero-config installation, cross-platform testing

**Week 4: Epic 7 (Outcome Tracking)**
- Update outcome API, failure tracking, success rate

**Week 4: Epic 8 (Testing & Documentation)**
- Unit tests, integration tests, performance benchmarks
- User docs, model configuration guide, troubleshooting

**Week 5: Epic 9 (Claude Desktop Expansion)**
- @mama/core library extraction
- @mama/server NPM package
- Claude Desktop config guide

### Timeline Summary

```
Day 1-3:  Epic 0 (Installation Validation)    ← SIMPLIFIED (NPM only)
Day 4:    Epic 0.5 (Embedding Validation)     ← MOSTLY DONE (3ms verified)
Week 1:   Epic 1-2 (Core + Graph)
Week 2:   Epic 3 (Search)
Week 2-3: Epic 4 (Plugin Integration)         ← CRITICAL PATH
Week 3:   Epic 5 (Commands + Skills)
Week 4:   Epic 6-7 (Packaging + Outcome + Testing)
Week 5:   Epic 8-9 (Docs + Claude Desktop)

Total: 5 weeks (vs original 7 weeks, 4 weeks before risk analysis)
Saved: 2 weeks (Epic 0/0.5 simplified via NPM-only installation)
Benefits: Zero compilation, 100% platform support, proven architecture (3ms latency)
```

---

## Risks & Mitigations

### Risk 1: Cross-Platform Compatibility (CRITICAL)

**Impact:** High (50% failure rate on Windows)
**Probability:** High (node-gyp issues documented)

**Mitigation:**
- ✅ 3-tier fallback (Tier 3 = 100% success)
- ✅ Pre-install compatibility check
- ✅ Clear installation error messages
- ✅ Epic 0 validates all platforms

**Status:** RESOLVED (via Epic 0)

### Risk 2: Hook Performance (<500ms)

**Impact:** Medium (slow context injection = poor UX)
**Probability:** Low (3ms embedding latency validated)

**Mitigation:**
- ✅ Cache embeddings (no re-compute) - IMPLEMENTED
- ✅ Limit to top 3 results - IMPLEMENTED
- ✅ Timeout after 500ms (skip if slow) - IMPLEMENTED
- ✅ Async hook (don't block user input) - IMPLEMENTED
- ✅ 3ms embedding latency measured (10x better than target)

**Status:** ✅ RESOLVED (validated in production at 3ms, ~100ms total hook latency)

### Risk 3: User Adoption

**Impact:** High (product failure)
**Probability:** Medium (niche tool)

**Mitigation:**
- ✅ Clear onboarding flow (5-min install)
- ✅ Compelling examples (authentication evolution)
- ✅ Epic 9 expands to Claude Desktop (10x users)
- ✅ Word-of-mouth via GitHub

**Status:** MITIGATED (dual-platform strategy)

### Risk 4: Data Loss

**Impact:** Medium (user loses decisions)
**Probability:** Low (SQLite reliable)

**Mitigation:**
- ✅ SQLite WAL mode (crash-safe)
- ✅ Backup instructions in docs
- ✅ Export feature (FR46)

**Status:** MITIGATED

### ~Risk 5: Ollama Dependency~ (ELIMINATED)

**Status:** ✅ ELIMINATED

**Reason:** Architecture changed to Transformers.js (no Ollama needed)
- No external service dependency
- 100% NPM-based installation (zero compilation)
- Works everywhere Node.js runs (no Python, no build tools)
- Proven in production (SpineLift MCP, 3ms latency validated)

---

## Out of Scope (Phase 1)

**Not in MVP:**
- ❌ Cloud sync / team collaboration (Phase 2)
- ❌ Web UI / visualization (Phase 3)
- ❌ Mobile app (Phase 3)
- ❌ Wearable integration (Phase 4)
- ❌ PostgreSQL backend (Epic 9 follow-up)
- ❌ Multi-user support (Phase 2)
- ❌ Advanced analytics (Phase 2)

**Future Phases:**
- Phase 2 (Month 2-3): Cloud sync, team features, advanced search
- Phase 3 (Month 4-6): Standalone desktop app, mobile app, web UI
- Phase 4 (Year 2+): Wearable research, AR integration

---

## References

**Created Documents:**
- INSTALLATION-COMPATIBILITY.md (4KB)
- CLAUDE-DESKTOP-STRATEGY.md (3.5KB)
- LOCAL-LLM-RESEARCH.md (3KB)
- FALLBACK-AND-TRANSPARENCY.md (4.5KB)
- MAMA-PLUGIN-PRD.md (this document, 24KB)

**Research:**
- Claude Code Plugin Documentation: https://code.claude.com/docs/en/plugins-reference
- MCP Protocol: https://modelcontextprotocol.io (2025-03-26 spec - Streamable HTTP)
- Transformers.js: https://huggingface.co/docs/transformers.js
- sqlite-vec: https://github.com/asg017/sqlite-vec (replaces deprecated sqlite-vss)
- mem0 (inspiration): https://github.com/mem0ai/mem0

**Competitive Analysis:**
- @modelcontextprotocol/server-memory (knowledge graph)
- mcp-mem0 (long-term agent memory)
- mcp-adr-analysis-server (architecture decisions)

**MAMA Differentiation:** 70% unique features (evolution tracking, outcome learning, consciousness flow)

---

## Next Steps

### Immediate (Day 1-4)

1. **Approve PRD** → User review of this document
2. **Epic 0 Validation** → NPM installation smoke test (Node.js 18+ check)
3. **Epic 0.5 Documentation** → Document alternative models by language (VALIDATED: 3ms latency)

### Week 1-5 (Implementation)

4. **Epic 1-2** → Core infrastructure + graph
5. **Epic 3** → Semantic search
6. **Epic 4** → Plugin integration (hooks + skills + commands)
7. **Epic 5-6** → Packaging + installation
8. **Epic 7-8** → Testing + documentation
9. **Epic 9** → Claude Desktop expansion

### Post-Launch (Week 8+)

10. **User feedback** → Iterate on UX
11. **Performance tuning** → Optimize latency
12. **Feature requests** → Prioritize Phase 2

---

## Product Philosophy

> "MAMA doesn't store information. It remembers how you think. It preserves the journey from confusion to clarity, so you never repeat the same mistakes, and your hard-earned wisdom is never lost."

**Core Values:**
1. **Transparency:** Never silent failure. Always show degradation.
2. **Evolution:** Track decision journey, not just conclusion.
3. **Local-First:** User owns data. No cloud dependency.
4. **Cross-Platform:** Works everywhere Claude works.
5. **Consciousness Flow:** Remember WHY, not just WHAT.

---

**Status:** ✅ Ready for Implementation (v3.0 - Transformers.js Architecture)
**Approval Required:**
- [ ] Product Vision Clear (consciousness flow companion)
- [ ] User Stories Defined (11 FR groups)
- [ ] Features Scoped (55 FRs across 11 groups)
- [ ] Success Metrics Set (>80% accuracy, 3ms latency validated)
- [ ] Technical Architecture Reviewed (Transformers.js, user-configurable models)
- [ ] Risks Assessed & Mitigated (Ollama dependency eliminated)
- [ ] 5-Week Timeline Accepted (2 weeks saved via WASM)
- [ ] Ready to Build

**Next Command:** Run `/bmad:bmm:workflows:create-epics-and-stories` to decompose PRD into implementable epics

---

_This PRD captures the complete vision of MAMA - a consciousness flow companion that works on your laptop today, your phone tomorrow, and your glasses in the future._

_Created through collaborative discovery and risk analysis - incorporating 5 critical risks identified by user._

**Version History:**

_Version 4.0 - Updated 2025-11-20 with Architecture-Driven Corrections_
_Key Changes:_
- **Technology Stack:** Updated to 2025 latest stable versions (Node.js 22.11.0, TypeScript 5.9.3, @huggingface/transformers 3.7.6, @modelcontextprotocol/sdk 1.7.0, better-sqlite3 12.4.1)
- **Database:** sqlite-vss → sqlite-vec (official successor, pure C, no Faiss dependency)
- **Plugin Structure:** Aligned with official Claude Code conventions (unified plugin.json, servers/ directory, ${CLAUDE_PLUGIN_ROOT} paths)
- **Hook Format:** Changed to teaser format (~40 tokens: topic + similarity + time, vs 250 tokens full context)
- **MCP Transport:** Updated to Streamable HTTP (2025-03-26 spec)
- **Critical Bug Fix:** Added FR40.1 for embedding auto-generation (without embeddings, semantic search fails)
- **Total FRs:** 56 (from 55)

_Version 3.0 - Updated 2025-11-20 with NPM-Only Architecture + User-Configurable Models_
_Key Changes: Eliminated Ollama dependency, zero compilation (pure JavaScript), 2-tier fallback (from 3-tier), 5-week timeline (from 7 weeks), 55 FRs (from 49), model user choice philosophy_

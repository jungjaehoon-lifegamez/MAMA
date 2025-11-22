# PRD: MAMA v1.1 - Hierarchical Tools & Unified Schema

**Status:** 🔬 Experimental
**Branch:** `experiment/primitives-architecture`
**Created:** 2025-11-22
**Author:** SpineLift Team

---

## Executive Summary

MAMA v1.1 introduces a hierarchical tool architecture with slash-based namespacing and a unified type-based schema. This redesign aligns with MCP best practices, reduces cognitive load, and enables dynamic context-aware tool exposure.

**Key Changes:**
- 7 flat tools → 4 domain actions with 10 sub-tools
- 3 separate tables → 1 unified `memories` table
- Static tool list → Dynamic context-aware exposure
- Implicit types → Explicit type-based storage

**Expected Impact:**
- 40% reduction in tool selection confusion
- 60% faster tool discovery through namespacing
- Unified search across all memory types
- Foundation for future context-aware features

---

## 1. Problem Statement

### Current Pain Points

**1.1 Tool Confusion**
```
Current: save_decision, recall_decision, suggest_decision, list_decisions,
         update_outcome, save_checkpoint, load_checkpoint

Problem: 7 flat tools with unclear relationships
- "Should I use suggest or recall?"
- "What's the difference between list and recall?"
```

**1.2 Implicit Type Distinction**
```
save_decision()    → decisions table
save_checkpoint()  → checkpoints table
save_insight()     → ??? (doesn't exist)

Problem: Tool choice = only way to specify type
         No DB-level type validation
         Cross-type search requires UNION queries
```

**1.3 Scattered Metadata**
```sql
decisions:   reasoning, confidence, outcome, supersedes
checkpoints: open_files, next_steps, status
sessions:    rolling_summary, latest_exchange

Problem: Type-specific fields spread across tables
         No consistent metadata structure
```

**1.4 Inflexible Tool Exposure**
```
Context: "어제 작업 이어서 하자"
Exposed: All 7 tools (including irrelevant save_decision)

Problem: Cannot hide irrelevant tools
         Increases cognitive load
         LLM must filter manually
```

### Research Findings

**MCP Best Practices (Official Spec):**
- ❌ Avoid: CRUD operations (`create_record`, `update_row`)
- ✅ Use: Domain-aware actions (`submit_expense_report`, `approve_leave`)
- **Reason:** "Higher-level tools are easier for agents to understand, reason about, and chain together"

**Anthropic's Guidance:**
- "Most successful AI agent implementations use **simple, composable patterns**"
- "Find the **simplest solution possible**"
- Agentic systems trade latency/cost for performance

**Unix Philosophy:**
- Do one thing well
- Clean interfaces for composition
- Text streams = natural fit for LLMs

**Cognitive Load Research:**
- Too many tools → Decision paralysis
- Too generic tools → Limits thinking ("here's your boundary")
- Balance needed: Clear intent + Flexibility

---

## 2. Goals & Non-Goals

### Goals

✅ **Reduce cognitive load** through clear hierarchical organization
✅ **Align tool design with DB schema** (type-based unification)
✅ **Enable context-aware tool exposure** (dynamic filtering)
✅ **Follow MCP best practices** (domain-aware, slash namespace)
✅ **Maintain backward compatibility** (old tools deprecated, not removed)
✅ **Prepare for future features** (auto-suggestions, pattern detection)

### Non-Goals

❌ **Not** a complete rewrite - incremental migration
❌ **Not** adding new features beyond architecture change
❌ **Not** breaking existing user workflows
❌ **Not** optimizing for theoretical perfection - practical improvement

---

## 3. User Stories

### US1: Developer Saving a Decision
```
As a developer,
When I make an architectural decision,
I want to clearly understand which tool to use,
So that I don't waste time choosing between similar tools.

Before: "Should I use save_decision or... wait, is there save_insight?"
After: "I'll use save/decision - clear and obvious"
```

### US2: Developer Resuming Work
```
As a developer,
When I return to work the next day,
I want Claude to only show me resume-related tools,
So that I'm not distracted by irrelevant save tools.

Before: 7 tools shown (save_decision, recall_decision, etc.)
After: 2 tools shown (load/checkpoint, load/context) - context-aware
```

### US3: Developer Searching Memory
```
As a developer,
When I search for past decisions,
I want a single search that covers everything,
So that I don't need to know which table stores what.

Before: recall_decision (decisions), suggest_decision (semantic), list_decisions (all)
After: search/by_topic, search/by_context, search/recent - unified
```

### US4: Developer Tracking Outcomes
```
As a developer,
When a decision fails in production,
I want to clearly mark it as failed,
So that future Claude sessions avoid that approach.

Before: update_outcome(decision_id, 'FAILED', reason)
After: evolve/outcome(decision_id, 'FAILED', reason) - clear evolution intent
```

---

## 4. Technical Design

### 4.1 Tool Hierarchy

```
save/
  ├─ decision        # Architectural choices with reasoning
  ├─ checkpoint      # Session state for continuity
  └─ insight         # Quick lessons learned (NEW)

load/
  ├─ checkpoint      # Resume previous session
  └─ context         # Load specific decision context (NEW)

search/
  ├─ by_topic        # Exact topic match → evolution chain
  ├─ by_context      # Semantic search → relevance
  └─ recent          # Time-based browsing

evolve/
  ├─ outcome         # Mark SUCCESS/FAILED/PARTIAL
  └─ supersede       # Replace with new decision (NEW)
```

**Design Principles:**
1. **Top-level = User intent** (save, load, search, evolve)
2. **Sub-tool = Specific method** (decision, checkpoint, by_topic)
3. **Slash namespace = MCP standard** (SEP-986 compliant)
4. **Domain-aware naming** (not CRUD: create/read/update)

### 4.2 Unified Schema

```sql
-- New unified memories table
CREATE TABLE memories (
  id TEXT PRIMARY KEY,              -- "decision_auth_2025_xyz"
  type TEXT NOT NULL,               -- 'decision', 'checkpoint', 'insight', 'context'

  -- Common fields
  content TEXT NOT NULL,            -- Main content (decision, summary, etc.)
  topic TEXT,                       -- Optional topic (mainly for decisions)

  -- Type-specific metadata (JSON)
  metadata TEXT,                    -- {
                                    --   decision: {reasoning, confidence, outcome, supersedes},
                                    --   checkpoint: {open_files, next_steps, status},
                                    --   insight: {category, tags, source}
                                    -- }

  -- Graph relationships
  related_to TEXT,                  -- JSON array of related memory IDs

  -- Embeddings (for semantic search)
  embedding_vector BLOB,            -- 384-dim vector (Transformers.js)

  -- Timestamps
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),

  -- Constraints
  CHECK (type IN ('decision', 'checkpoint', 'insight', 'context'))
);

-- Indexes
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_topic ON memories(topic) WHERE topic IS NOT NULL;
CREATE INDEX idx_memories_created ON memories(created_at);

-- Virtual table for vector search (sqlite-vec)
CREATE VIRTUAL TABLE vss_memories USING vss0(
  embedding(384)
);
```

**Schema Benefits:**
- ✅ Tool → Type 1:1 mapping
- ✅ Unified search (single table query)
- ✅ Flexible metadata (JSON per type)
- ✅ Graph relationships (related_to field)
- ✅ Semantic search ready (embedding_vector)

### 4.3 Tool Implementation Examples

**save/decision:**
```javascript
{
  name: 'save/decision',
  description: `Save an architectural decision with reasoning.

  Use when:
  - Making technology choices (JWT vs Session, React vs Vue)
  - Architectural patterns (Microservices, Event sourcing)
  - Design decisions with trade-offs

  Don't use for:
  - End of session → use save/checkpoint
  - Quick notes → use save/insight`,

  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Decision topic (e.g., "auth_strategy")' },
      decision: { type: 'string', description: 'What was decided' },
      reasoning: { type: 'string', description: 'Why this decision' },
      confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.7 }
    },
    required: ['topic', 'decision', 'reasoning']
  },

  handler: async ({ topic, decision, reasoning, confidence = 0.7 }) => {
    await db.insert('memories', {
      id: generateId('decision', topic),
      type: 'decision',
      content: decision,
      topic,
      metadata: JSON.stringify({ reasoning, confidence, outcome: null }),
      created_at: Date.now()
    });
  }
}
```

**load/checkpoint:**
```javascript
{
  name: 'load/checkpoint',
  description: `Resume your last work session.

  Use when:
  - Starting a new coding session
  - User says "continue from yesterday"
  - Returning after a break

  Returns: Session summary, open files, next steps`,

  handler: async () => {
    const checkpoint = await db.query(
      `SELECT * FROM memories
       WHERE type='checkpoint'
       ORDER BY created_at DESC
       LIMIT 1`
    );

    const meta = JSON.parse(checkpoint.metadata);
    return {
      summary: checkpoint.content,
      open_files: meta.open_files,
      next_steps: meta.next_steps,
      timestamp: checkpoint.created_at
    };
  }
}
```

### 4.4 Dynamic Tool Exposure

**Context Detection (UserPromptSubmit Hook):**
```javascript
// Hook triggered on every user message
async function detectContext(userMessage) {
  const contexts = {
    resuming: /어제|이어서|continue|resume/i.test(userMessage),
    deciding: /결정|decide|choice|선택/i.test(userMessage),
    searching: /찾아|search|recall|어떻게 했/i.test(userMessage),
    tracking: /실패|성공|failed|success/i.test(userMessage)
  };

  // Dynamic tool filtering
  if (contexts.resuming) {
    return {
      allowed: ['load/checkpoint', 'load/context'],
      priority: ['load/checkpoint']
    };
  }

  if (contexts.deciding) {
    return {
      allowed: ['save/decision', 'save/insight', 'search/by_context'],
      priority: ['save/decision']
    };
  }

  // Default: show all
  return { allowed: 'all' };
}

// MCP ToolListChangedNotification
async function updateToolList(context) {
  const tools = context.allowed === 'all'
    ? getAllTools()
    : getToolsByNames(context.allowed);

  await mcp.notify('tools/list_changed', { tools });
}
```

**Benefits:**
- ✅ Reduced tool clutter
- ✅ Faster tool selection
- ✅ Better UX for Claude
- ✅ Contextual guidance

---

## 5. Implementation Plan

### Phase 1: Schema Migration (Week 1)

**Tasks:**
- [ ] Create migration `005-unified-memories.sql`
- [ ] Implement data migration script
- [ ] Test migration on sample data
- [ ] Verify all existing data migrates correctly

**Deliverables:**
- `memories` table created
- All `decisions` → `memories` (type='decision')
- All `checkpoints` → `memories` (type='checkpoint')
- Old tables kept (deprecated)

### Phase 2: Tool Refactoring (Week 2)

**Tasks:**
- [ ] Implement `save/*` tools (decision, checkpoint, insight)
- [ ] Implement `load/*` tools (checkpoint, context)
- [ ] Implement `search/*` tools (by_topic, by_context, recent)
- [ ] Implement `evolve/*` tools (outcome, supersede)
- [ ] Update tool descriptions with usage examples
- [ ] Deprecate old tools (keep for compatibility)

**Deliverables:**
- 10 new hierarchical tools
- Updated `packages/mcp-server/src/tools/`
- Updated tool registration in `server.js`

### Phase 3: Dynamic Exposure (Week 3)

**Tasks:**
- [ ] Implement context detection in UserPromptSubmit hook
- [ ] Implement `ToolListChangedNotification`
- [ ] Create context → tool mapping rules
- [ ] Test dynamic filtering in real scenarios

**Deliverables:**
- Context-aware tool exposure
- Updated `packages/claude-code-plugin/scripts/userpromptsubmit-hook.js`

### Phase 4: Testing & Documentation (Week 4)

**Tasks:**
- [ ] Unit tests for new tools
- [ ] Integration tests for dynamic exposure
- [ ] Migration tests (data integrity)
- [ ] Update README with new tool structure
- [ ] Update command docs
- [ ] Write migration guide for users

**Deliverables:**
- 100% test pass rate
- Updated documentation
- Migration guide

### Phase 5: Gradual Rollout (Week 5)

**Tasks:**
- [ ] Alpha release (opt-in flag)
- [ ] Collect feedback from early users
- [ ] Fix critical bugs
- [ ] Beta release (default on, can opt-out)
- [ ] Final release (deprecate old tools)

**Deliverables:**
- MAMA v1.1.0 release
- Old tools marked deprecated
- Backward compatibility maintained

---

## 6. Success Metrics

### Quantitative

- **Tool Selection Time:**
  - Before: ~15s (choosing between 7 tools)
  - Target: <5s (clear hierarchy)

- **Tool Selection Accuracy:**
  - Before: 70% (often use wrong tool first)
  - Target: 90% (clearer intent)

- **Context Injection Latency:**
  - Before: N/A (no dynamic exposure)
  - Target: <100ms (hook overhead)

- **Search Performance:**
  - Before: 3 separate queries (decisions, checkpoints, sessions)
  - Target: 1 unified query (memories table)

### Qualitative

- User feedback: "Easier to understand tool structure"
- Claude behavior: More confident tool selection
- Developer experience: Clearer intent when reading code
- Documentation clarity: Simpler to explain hierarchy

---

## 7. Risks & Mitigation

### R1: Migration Complexity
**Risk:** Data migration fails, users lose memory
**Mitigation:**
- Comprehensive migration tests
- Backup before migration
- Rollback script ready
- Keep old tables until verified

### R2: Dynamic Exposure Confusion
**Risk:** Claude gets confused by changing tool list
**Mitigation:**
- Always expose core tools (save/decision, load/checkpoint)
- Clear logging of context detection
- Override flag for debugging
- Gradual rollout with opt-out

### R3: Performance Degradation
**Risk:** JSON metadata queries slower than dedicated columns
**Mitigation:**
- Index on type + common metadata fields
- Benchmark before/after
- Optimize hot paths
- Consider materialized views if needed

### R4: Backward Compatibility
**Risk:** Breaking changes for existing users
**Mitigation:**
- Keep old tools (deprecated)
- Migration guide with examples
- Version bump (v1.1.0)
- Support both old and new for 3 months

### R5: MCP Client Compatibility
**Risk:** Not all MCP clients support `tools/list_changed` notification
**Mitigation:**
- **MANDATORY Fallback**: Always expose all tools if client doesn't support dynamic exposure
- Feature detection via MCP capability negotiation
- Graceful degradation: Dynamic exposure = enhancement, not requirement
- Test matrix: Claude Code, Claude Desktop, Codex, Antigravity IDE
- Fallback trigger: If notification fails or times out (>500ms), revert to static list

**Implementation:**
```javascript
async function updateToolList(context) {
  try {
    const supportsNotification = await mcp.checkCapability('tools/list_changed');
    if (!supportsNotification) {
      return getAllTools(); // Fallback: show all
    }

    const tools = context.allowed === 'all'
      ? getAllTools()
      : getToolsByNames(context.allowed);

    await mcp.notify('tools/list_changed', { tools }, { timeout: 500 });
  } catch (error) {
    console.warn('Dynamic tool exposure failed, using static list:', error);
    return getAllTools(); // Fallback on any error
  }
}
```

### R6: Relationship Intelligence Complexity
**Risk:** DBSCAN clustering adds implementation complexity with minimal initial value
**Mitigation:**
- **v1.1 Scope**: EXCLUDE automatic clustering - use simple cosine similarity only
- **v1.1 Implementation**: Manual synonym detection via similarity threshold (0.75)
- **v1.2+ Feature**: Promote DBSCAN to future enhancement after v1.1 validation
- **Early Data Problem**: Clustering requires minimum 50+ relationships to be useful
- **Incremental Approach**: Start simple, add intelligence based on actual usage patterns

**v1.1 Scope (INCLUDED):**
- ✅ Explicit link creation via `links[]` parameter
- ✅ Cosine similarity for synonym detection
- ✅ Multilingual embedding (Korean + English)

**v1.2+ Scope (DEFERRED):**
- ⏸️ Automatic DBSCAN clustering
- ⏸️ Canonical relationship promotion
- ⏸️ Auto-merging of synonym clusters

### R7: Graph Traversal Performance
**Risk:** Deep graph traversal becomes expensive as data grows
**Mitigation:**
- **Hard Limit**: `max_depth` = 5 for all queries (prevent runaway traversal)
- **Depth Strategy**:
  - `search/by_topic`: max_depth=3 (direct evolution chain)
  - `search/by_context`: max_depth=5 (semantic exploration)
  - `load/context`: max_depth=2 (immediate context only)
- **Caching Strategy**:
  - Cache frequently accessed paths (LRU cache, 100 entries)
  - Cache key: `${start_id}:${link_type}:${depth}`
  - TTL: 5 minutes (balance freshness vs performance)
  - Invalidate on new link creation for affected nodes
- **Performance Budget**: <100ms for graph traversal (benchmark requirement)

**Implementation:**
```javascript
const traversalCache = new LRUCache({ max: 100, ttl: 5 * 60 * 1000 });

async function traverseGraph(start_id, options) {
  const { max_depth = 5, link_types } = options;
  const cacheKey = `${start_id}:${link_types.join(',')}:${max_depth}`;

  if (traversalCache.has(cacheKey)) {
    return traversalCache.get(cacheKey);
  }

  const results = await breadthFirstSearch(start_id, {
    max_depth: Math.min(max_depth, 5), // Hard cap at 5
    link_types
  });

  traversalCache.set(cacheKey, results);
  return results;
}
```

---

## 8. Open Questions

1. **Checkpoint ID format:** Use new unified ID or keep separate?
   - Option A: `checkpoint_<timestamp>_<hash>`
   - Option B: Migrate to `memory_checkpoint_<timestamp>`

2. **Old tool deprecation timeline:** How long to support?
   - Proposal: 3 months warning, then remove in v2.0.0

3. **Context detection accuracy:** What if we get it wrong?
   - Fallback: Show all tools if confidence < 70%

4. **Metadata schema evolution:** How to version JSON fields?
   - Proposal: Include `schema_version` in metadata JSON

---

## 9. Future Enhancements (Out of Scope)

- Auto-suggest tools based on past patterns
- Tool composition (combine multiple sub-tools)
- Custom user-defined tool hierarchies
- Multi-level hierarchy (save/decision/architectural)
- Tool usage analytics dashboard

---

## 10. References

**Research:**
- [Anthropic: Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)
- [MCP Tool Naming (SEP-986)](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)
- [Dynamic Tool Updates](https://spring.io/blog/2025/05/04/spring-ai-dynamic-tool-updates-with-mcp/)
- [Context-Aware Tools](https://www.ragie.ai/blog/making-mcp-tool-use-feel-natural-with-context-aware-tools)

**Related Decisions:**
- `mama_architecture_tool_philosophy` - Tool design limits thinking
- `mama_tool_design_claude_semantic` - Claude's semantic understanding
- `mama_identity_evolving_project` - MAMA as learning system
- `mama_v1.1_hierarchical_architecture` - This PRD's parent decision

---

**Approval Required:** @hoonsam
**Next Steps:** Review → Approve → Start Phase 1

# Experiment: Primitives-Based Architecture

**Branch:** `experiment/primitives-architecture`
**Created:** 2025-11-22
**Status:** 🔬 Active Experiment

## Problem Statement

Current MAMA architecture uses 7 fixed, high-level tools:

- `save_decision`, `recall_decision`, `suggest_decision`, `list_decisions`
- `update_outcome`
- `save_checkpoint`, `load_checkpoint`

**The philosophical concern:** Fixed tools define the boundaries of thought.

> "Limits are defined by the given tools and environment. 100 precisely divided tools = only 100 tasks possible. But if you can combine tools or create tools = infinite possibilities."

When we give Claude a fixed tool like `save_decision(topic, decision, reasoning, confidence)`, we implicitly say:

- "Decisions must have this shape"
- "You can only think about decisions in this way"
- "Here are your limits"

This isn't just about complexity - it's about **constraining the possibility space**.

## Hypothesis

**Primitives + Composition > Fixed High-Level Tools**

By providing low-level primitives that can be combined freely, we:

1. ✅ Remove artificial constraints on how Claude thinks about memory
2. ✅ Enable emergent behaviors we haven't anticipated
3. ✅ Allow the memory structure to evolve with usage
4. ❓ Trade clarity for flexibility (need to test)

## Proposed Architecture

### Current (Fixed Tools)

```javascript
// High-level, opinionated
save_decision({
  topic: 'auth_strategy',
  decision: 'Use JWT',
  reasoning: '...',
  confidence: 0.9,
});
```

### Experiment (Primitives)

```javascript
// Low-level, composable
memory.write('auth_2025', {
  type: 'decision',
  content: 'Use JWT',
  context: '...',
  metadata: { confidence: 0.9 },
});

graph.link('auth_2025', 'supersedes', 'auth_2024');
graph.link('auth_2025', 'relates_to', 'session_management');

search.tag('auth_2025', ['security', 'backend', 'critical']);
```

### Layered Approach (Compromise)

```
Level 1 (High-level): save_decision, recall_decision
  → Easy to use, covers 80% of cases
  → "You can stop here if you want"

Level 2 (Primitives): memory.*, graph.*, search.*
  → Flexible, handles edge cases
  → "But you're not limited"
```

## Experiment Plan

### Phase 1: Design Primitives (Week 1)

1. **Identify core primitives**
   - Memory operations: write, read, update, delete
   - Graph operations: link, traverse, query
   - Search operations: tag, filter, semantic_search
   - Meta operations: schema, validate, export

2. **Design MCP tool signatures**

   ```javascript
   memory_write(id, data, options);
   memory_read(id, options);
   graph_link(from_id, relation, to_id, metadata);
   graph_traverse(start_id, direction, filters);
   search_tag(id, tags);
   search_query(query, filters);
   ```

3. **Document use cases**
   - How to implement `save_decision` using primitives
   - How to implement `recall_decision` using primitives
   - New patterns that weren't possible before

### Phase 2: Prototype Implementation (Week 2)

1. **Implement primitives in MCP server**
   - New tools in `packages/mcp-server/src/tools/primitives/`
   - Keep existing tools for comparison

2. **Create example compositions**
   - Decision tracking (replicate current behavior)
   - Session management (replicate current behavior)
   - Novel patterns (explore new possibilities)

3. **Test with Claude**
   - Can Claude figure out how to use primitives?
   - Does it lead to more creative memory usage?
   - What's the cognitive load?

### Phase 3: Evaluation (Week 3)

Compare primitives vs fixed tools:

**Metrics:**

- ✅ Flexibility: Can we express things we couldn't before?
- ✅ Emergence: Do new patterns emerge naturally?
- ✅ Claude's understanding: Does it "get it" or struggle?
- ❌ Cognitive load: Is it too complex?
- ❌ Consistency: Does structure degrade over time?

**Decision criteria:**

- If primitives clearly win → merge to main
- If fixed tools clearly win → close branch
- If mixed → implement layered approach

## Key Questions

1. **Will Claude understand primitives?**
   - Can it compose them effectively?
   - Or does it need explicit high-level tools?

2. **Does flexibility outweigh complexity?**
   - Is the cognitive load worth the freedom?

3. **What new patterns emerge?**
   - What memory structures will Claude create?
   - Will they be useful or chaotic?

4. **Is layering the answer?**
   - Best of both worlds?
   - Or worst of both worlds?

## Success Criteria

This experiment succeeds if:

1. ✅ Claude can use primitives to replicate current functionality
2. ✅ New, useful patterns emerge that weren't possible before
3. ✅ The cognitive load is manageable (Claude doesn't get confused)
4. ✅ Memory structures remain coherent over time

This experiment fails if:

1. ❌ Claude consistently misuses primitives
2. ❌ Cognitive load is too high (descriptions, examples don't help)
3. ❌ No new useful patterns emerge
4. ❌ Memory becomes fragmented/incoherent

## Notes

This experiment embodies MAMA's identity as an **evolving project**:

- We don't claim to have the answer
- We're learning alongside Claude
- The architecture should emerge from usage, not be imposed

Related decisions:

- `mama_architecture_tool_philosophy` - Original insight
- `mama_identity_evolving_project` - MAMA as learning system

---

**Next Steps:**

1. Design primitive operations
2. Document composition patterns
3. Implement prototype
4. Test with real usage
5. Evaluate and decide

**Questions/Discussion:**

- Should primitives be strictly typed or flexible?
- How to prevent memory fragmentation?
- Should we version the memory schema?
- Can we auto-detect patterns and suggest high-level tools?

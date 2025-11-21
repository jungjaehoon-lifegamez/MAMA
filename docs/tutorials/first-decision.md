# Your First Decision Save

**Audience:** New users who completed Getting Started
**Duration:** 5 minutes
**Goal:** Understand decision saving best practices

---

## Why Save Decisions?

MAMA is not a note-taking app. It's a **decision evolution tracker** that remembers:
- ❌ What you tried that **didn't work**
- ✅ What you decided that **did work**
- 🔄 **Why** you changed your mind later

This prevents you from repeating the same failed experiments.

---

## The Right Way to Save Decisions

### ✅ DO: Reuse Topics for Evolution

```javascript
// CRITICAL: Reuse same topic for related decisions
// ✅ GOOD: Creates supersedes chain
topic: 'auth_strategy'  // Use for ALL auth decisions
topic: 'auth_strategy'  // Again! Shows evolution

// ❌ BAD: Unique topics break the graph
topic: 'auth_strategy_v1'
topic: 'auth_strategy_v2'
```

**Why this matters:**
- Reusing the same topic automatically creates a "supersedes" graph
- This lets you track the evolution from confusion to clarity
- Unique topic names (v1, v2, etc.) break the graph connections

**Learn more:** [Decision Graph Concept](../explanation/decision-graph.md)

---

## Example: Evolution Over Time

### Day 1: First Attempt
```
/mama-save
Topic: auth_strategy
Decision: Use session cookies for authentication
Reasoning: Simple to implement, built-in Express support
Confidence: 0.6
Outcome: pending
```

### Day 3: Discovered Problem
```
/mama-save
Topic: auth_strategy  # SAME topic!
Decision: Switch to JWT with refresh tokens
Reasoning: Session cookies don't scale horizontally, discovered during load testing
Confidence: 0.8
Outcome: success
```

### Day 5: Recall Evolution
```
/mama-recall auth_strategy

📚 Decision History for: auth_strategy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. [3 days ago] ⏳ Pending → Session cookies
   Reasoning: Simple to implement...
   ⚠️ SUPERSEDED by next decision

2. [just now] ✅ Success → JWT with refresh tokens
   Reasoning: Session cookies don't scale...
   🔗 SUPERSEDES: Decision #1
```

**This is the power of decision evolution tracking!** 🎉

---

## Decision Lifecycle

```
pending → success
         ↓
         partial (mixed results)
         ↓
         failure (didn't work)
         ↓
         superseded (replaced by better decision)
```

**Update outcomes:**
```
/mama-save
Topic: auth_strategy
Outcome: success  # or failure, partial, superseded
```

---

## Topic Naming Best Practices

### ✅ Good Topic Names
- `auth_strategy` - Covers all auth decisions
- `database_choice` - Covers all DB decisions
- `mama_architecture` - Covers all MAMA arch decisions

### ❌ Bad Topic Names
- `auth_jwt_2025_01_15` - Too specific, won't reuse
- `decision_1` - Meaningless
- `todo` - Too generic

**Rule of thumb:** If you'll never revisit this topic, it's not a decision worth tracking.

---

## Confidence Scores

- **0.9-1.0**: High confidence, thoroughly researched
- **0.7-0.8**: Good confidence, some research done
- **0.5-0.6**: Medium confidence, still exploring
- **0.3-0.4**: Low confidence, experimental
- **0.0-0.2**: Very uncertain, placeholder

**Quick guide:**
- Very certain: 0.9+
- Pretty confident: 0.7-0.8
- Unsure: 0.5-0.6
- Experimental: 0.3-0.4
- No idea: 0.0-0.2

---

## Recording Failures (Critical!)

**Don't just record successes!** Recording failures is MORE valuable:

```
/mama-save
Topic: auth_strategy
Decision: Tried OAuth 2.0 with multiple providers
Reasoning: Wanted to support Google, GitHub, Twitter login
Confidence: 0.4
Outcome: failure
Failure Reason: Over-engineered for our use case, added 2 weeks of complexity
```

**Why record failures:**
- You won't try the same thing twice
- Team members learn from your mistakes
- Shows the journey (confusion → clarity)

---

## Next Steps

- **Understand tiers:** [Understanding Tiers Tutorial](understanding-tiers.md)
- **Set up automatic context:** [Hook Setup Tutorial](hook-setup.md)
- **Learn all commands:** [Commands Reference](../reference/commands.md)

---

**Related:**
- [Decision Graph Concept](../explanation/decision-graph.md)
- [Semantic Search Explanation](../explanation/semantic-search.md)
- [Commands Reference](../reference/commands.md)

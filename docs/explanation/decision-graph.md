# Decision Graph Concept

**How MAMA tracks decision evolution**

---

## The Problem

Traditional documentation shows final decisions:

> "Use JWT for authentication"

But where's the why?

- Why not session cookies?
- Why not OAuth?
- What problems led to JWT?

**Result:** Next developer repeats the same journey from scratch.

---

## The MAMA Way

Track the **evolution**, not just the conclusion:

```
1. Session Cookies (tried first) → Failed
   Reasoning: Scaling issues with Redis session store
   Outcome: failure

2. OAuth 2.0 (considered) → Rejected
   Reasoning: Over-engineered for our use case
   Outcome: failure

3. JWT (chosen) → Success
   Reasoning: Balanced simplicity and scalability
   Outcome: success
```

**Result:** Next developer sees the full journey, avoids same failures.

---

## Decision Graph Structure

### Nodes

Each decision is a node with:

- **topic**: Decision identifier (e.g., 'auth_strategy')
- **decision**: What was decided
- **reasoning**: Why it was decided
- **confidence**: 0.0-1.0
- **outcome**: pending/success/failure/partial/superseded

### Edges (v1.2.0 Simplification)

In v1.2.0, MAMA uses only **supersedes** edges (same topic, automatic):

- **supersedes**: Decision A replaces Decision B (same topic)

**Removed:** refines, contradicts edges

- **Why?** LLM can infer these relationships from time-ordered search results
- **Benefit:** Simpler architecture, fewer constraints, more LLM flexibility

---

## Topic Reuse is Critical

**✅ GOOD: Reuse same topic**

```javascript
topic: 'auth_strategy'; // First attempt
topic: 'auth_strategy'; // Second attempt
topic: 'auth_strategy'; // Final decision
```

**Result:** Automatic supersedes chain showing evolution.

**❌ BAD: Unique topics**

```javascript
topic: 'auth_strategy_v1';
topic: 'auth_strategy_v2';
topic: 'auth_strategy_final';
```

**Result:** No graph connections, lost evolution history.

---

## Graph Traversal

When you recall a topic:

```
/mama-recall auth_strategy

📚 Decision History for: auth_strategy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. [3 days ago] ⏳ Pending → Session cookies
   Reasoning: Simple to implement...
   ⚠️ SUPERSEDED by next decision

2. [1 day ago] ❌ Failure → OAuth 2.0
   Reasoning: Wanted enterprise features...
   Failure: Over-engineered, 2 weeks wasted
   ⚠️ SUPERSEDED by next decision

3. [just now] ✅ Success → JWT with refresh tokens
   Reasoning: Learned from failures...
   🔗 SUPERSEDES: Decision #1, #2
```

**This is the power of decision evolution!**

---

## Why This Matters

### Prevents Repetition

See what was already tried and why it failed.

### Shows Context

Understand the constraints and trade-offs.

### Tracks Confidence

See how certainty evolved over time.

### Records Failures

Failures are MORE valuable than successes!

---

## Learn/Unlearn/Relearn Pattern

```
Learn:    First decision (confidence: 0.6)
          ↓
Unlearn:  Discovered problem (outcome: failure)
          ↓
Relearn:  Better decision (confidence: 0.9, outcome: success)
```

**MAMA preserves this entire cycle.**

---

**Related:**

- [First Decision Tutorial](../tutorials/first-decision.md)
- [Semantic Search](semantic-search.md)
- [Tier System](tier-system.md)
- [Architecture](architecture.md)

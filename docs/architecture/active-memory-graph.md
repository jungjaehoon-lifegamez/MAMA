# MAMA v1.2: Active Memory & Connected Reasoning Architecture (AX Focused)

## 1. Philosophy: From UX to AX (Agent Experience)

MAMA v1.2 shifts the focus from User Experience (UX) to **Agent Experience (AX)**.
The primary "user" of MAMA is not the human, but the **LLM Agent**.

- **Goal**: Optimize for **Easy Retrieval**, **Easy Comprehension**, and **Easy Connection** for the Agent.
- **Metaphor**: "Fading Memories & Connected Thoughts" (멀수록 희미해지고, 꼬리에 꼬리를 무는 기억)

---

## 2. Core Concepts

### 2.1. Nudging over Injection (AX Pattern)

Instead of forcing context via Hooks (Context Injection), we use **Tool Definitions** to guide the Agent's behavior.

- **Trigger**: "User makes a decision", "User says 'remember this'", "Lesson learned"
- **Action**: Proactively call `mama:save`.
- **Pre-requisite**: Before saving, call `mama:search` to find connections.

### 2.2. Reasoning Graph (Connected Memories)

Decisions should not be isolated islands. They must be connected to form a narrative.

- **Explicit Connection**: `supersedes` (Replacement)
- **Implicit Connection**: `topic` (Evolution)
- **Reference Connection**: `related_to` (New Field)
  - Example: "Choosing React (`decision_A`) influenced choosing Next.js (`decision_B`)" -> `decision_B.related_to = ['decision_A']`

### 2.3. Temporal Decay (Fading Memory)

Not all memories are equal. Relevance should be a function of:

1.  **Similarity**: How closely does it match the current thought?
2.  **Recency**: How fresh is the memory? (Time Decay)
3.  **Connectivity**: How close is it in the graph?

---

## 3. Implementation Plan

### 3.1. Tool Description Updates (AX Writing)

Modify `packages/mcp-server/src/tools/save-decision.js` and `search-decisions.js`.

**`mama:save`**:

- **Tone**: "You are a partner."
- **Instruction**: "Search first. Link your thoughts. Don't create orphans."

**`mama:search`**:

- **Tone**: "Seek wisdom before acting."
- **Output**: Return structured data (Graph Sub-view) instead of flat text.

### 3.2. Schema Update

Update `Decision` schema in `packages/mcp-server/src/mama/db-manager.js`.

```javascript
{
  // ... existing fields
  related_to: ["decision_id_1", "decision_id_2"], // Array of IDs
  importance: 0.0-1.0 // Optional: To prevent important memories from fading
}
```

### 3.3. Search Logic Enhancement (Future)

Implement a scoring algorithm that considers Time Decay and Graph Distance.

```javascript
Score = VectorSim * 0.6 + Recency * 0.3 + GraphConn * 0.1;
```

---

## 4. Agent Experience (AX) Scenario

### Scenario: Natural Language Save

**User**: "기억해줘: 이번 프로젝트에서는 Redux 대신 Zustand를 쓰기로 했어. 보일러플레이트가 너무 싫어서."

**LLM (Internal Monologue)**:

1.  _User said "기억해줘". This is a trigger._
2.  _Topic is state management. Let me search if we discussed this before._ -> `mama:search("state management")`
3.  _Found `decision_redux_101` (We used Redux last year)._
4.  _I should save this new decision and link it to the old one._
5.  _Call `mama:save` with:_
    - `topic`: "state_management"
    - `decision`: "Use Zustand"
    - `reasoning`: "Redux boilerplate is too heavy. Zustand is simpler."
    - `related_to`: ["decision_redux_101"]

**MAMA Response (Feedback)**:
"✅ Saved. Linked to `decision_redux_101`. Your reasoning graph is growing."

---

## 5. Roadmap

1.  **Phase 1 (Immediate)**: Update Tool Descriptions (Prompt Engineering for AX).
2.  **Phase 2 (Short-term)**: Add `related_to` field to DB and Tools.
3.  **Phase 3 (Mid-term)**: Implement "Auto-Extraction" logic (Regex/LLM hybrid).
4.  **Phase 4 (Long-term)**: Implement Graph Visualization & Advanced Scoring.

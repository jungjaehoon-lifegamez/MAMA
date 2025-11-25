---
description: Save the current session state for later resumption
allowed-tools: Read, Grep
argument-hint: ''
---

# Save Session Checkpoint (with Self-Verification)

You are helping the user save the current session state to MAMA memory.

**User Arguments:** `$ARGUMENTS`

## 💬 Checkpoint Writing Guide

A checkpoint is a handoff to the next AI. Be candid so the next person can resume fast.

### 🤔 Ask yourself before writing

1. **Goal & Progress?** What was today’s goal and where did you stop?
2. **Evidence?** What did you verify? Mark status as `Verified | Not run | Assumed`.
3. **Unfinished/Risks?** What’s incomplete, blocked, or risky?
4. **Next Agent Briefing?** What quick health/start commands should they run first?

It doesn’t have to be perfect—state what’s missing.

### 😊 Good pattern

```markdown
# 🎯 Goal & Progress

- Goal: [Session goal]
- Progress: [What you did, where you stopped, why unfinished]

# ✅ Evidence & Verification

- File `path/to/file.js` — Status: Verified (cite test/log/line)
- Command `npm test ...` — Status: Not run (reason: time)
- Log `[MAMA MCP] ...` — Status: Assumed (reused log)

# ⏳ Unfinished & Risks

- Remaining work: ...
- Tests/health checks not run: ... (reason)
- Risks/unknowns: ...

# 🚦 Next Agent Briefing

- DoD: [Definition of Done for next session]
- Quick checks: npm test ..., curl http://localhost:3000/health
- Constraints: [Constraints/cautions]

🔧 Trust lift (after resume): run 1-2 quick checks above, sample-verify one claim per section (file/log/command), and relabel Assumed → Verified/Not run before re-saving.
```

### Step 4: Call MCP Tool

```javascript
mcp__plugin_mama_mama__save_checkpoint({
  summary: '...', // Use the Goal/Evidence/Unfinished format above
  open_files: ['file1.js', 'file2.md'],
  next_steps: 'DoD + quick checks (e.g., npm test ..., curl ...)',
});
```

## 😅 This makes handoff hard

**Vague:**

- "Epic 3 done!" → unclear what’s done

**Better:**

- "Epic 3: Story 3.1-3.2 done; 3.3 coded but untested"

**Instead of “all done”:**

- "proposeLink implemented (file.js:100), tests not written"

## 💬 Real example

```
# 🎯 Goal & Progress
- Goal: Ship Epic 2 (Narrative) & Epic 3 (Link Governance)
- Progress: Added narrative embeddings; added 5 link APIs. Missing approval filter/latency timing/tests.

# ✅ Evidence & Verification
- File `packages/mcp-server/src/mama/embeddings.js` — Status: Verified (Narrative field embedding lines 134-167)
- File `packages/mcp-server/src/mama/mama-api.js` — Status: Verified (link propose/approve APIs lines 906-1145)
- Tests `npm test` — Status: Verified (136/136 passed; new API tests absent)
- File `packages/mcp-server/src/mama/db-manager.js:354` — Status: Not run (approved_by_user filter missing)

# ⏳ Unfinished & Risks
- Missing approved-only filter (db-manager.js:354)
- Checkpoint latency measurement not implemented (checkpoint-tools.js)
- No link-tools API tests → risk

# 🚦 Next Agent Briefing
- DoD: Add approval filter + add checkpoint latency timing + author/run link-tools tests
- Quick checks: grep "approved_by_user" packages/mcp-server/src/mama/db-manager.js; add timing in checkpoint-tools.js; run npm test (include new tests)
- Constraints: Do not break existing query behavior when adding filter
```

**Note:** Ignore `$ARGUMENTS` - always auto-generate with verification.

## Example Usage

```
/mama-checkpoint
```

That's it! No arguments needed. Claude will:

- Analyze the conversation history
- Extract files from tool usage (Read/Edit/Write)
- Infer next steps from todos or pending work
- Save everything automatically

## Important Notes

- **Zero configuration**: Just run `/mama-checkpoint` with no arguments
- **Smart analysis**: Claude automatically extracts relevant context
- **File tracking**: Captures all Read/Edit/Write operations
- **Next steps**: Inferred from incomplete todos or mentioned tasks

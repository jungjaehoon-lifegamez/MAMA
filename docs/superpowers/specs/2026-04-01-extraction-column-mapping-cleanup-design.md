# Extraction & Column Mapping Cleanup

**Date:** 2026-04-01
**Branch:** feat/v016-memory-engine
**Status:** Approved

## Problem

1. **Column mapping confusion:** `SaveMemoryInput.summary` writes to both `decisions.decision` and `decisions.summary` (identical values). `SaveMemoryInput.details` writes to `decisions.reasoning` but contains either the entire conversation text (regex path) or LLM-generated quote (LLM path) — inconsistent.

2. **Regex-first extraction contradicts proven learning:** Decision `memorybench_extraction_strategy_v3` concluded "whole conversation → Sonnet 1 call is the answer" because regex splitting destroys context (Luna→"has a cat", IKEA→lost). Current branch went back to regex-first, causing coverage gaps.

3. **Hallucination post-filter too weak:** 50% keyword match threshold lets through invented facts.

## Design

### Column Role Definitions (no schema change)

| DB column    | Role                                               | Source                       |
| ------------ | -------------------------------------------------- | ---------------------------- |
| `decision`   | Extracted core statement (search target)           | `SaveMemoryInput.summary`    |
| `summary`    | Copy of `decision` (FTS5 search)                   | `SaveMemoryInput.summary`    |
| `reasoning`  | Quoted source sentences from original conversation | `SaveMemoryInput.details`    |
| `event_date` | Real-world date of the event                       | `SaveMemoryInput.event_date` |

**Key change:** `details` parameter must contain **relevant quoted sentences** from the original text, not the entire conversation.

### Extraction Strategy

**Before:** regex-first → LLM fallback (LLM skipped when regex finds facts)
**After:** LLM-only + post-validation

#### LLM Extraction (existing, kept)

- Whole conversation → single Sonnet call → structured `ExtractedMemoryUnit[]`
- `extraction-prompt.ts` already instructs: `details: "quote the exact sentence(s)"`

#### Post-validation (strengthened)

- Current: 50% keyword match (too permissive)
- New: 70% threshold + proper noun verification
  - Extract words >4 chars from summary
  - Check each exists in original conversation text (case-insensitive)
  - Reject units below 70% match ratio

#### fact-extractor.ts

- Remove from extraction pipeline (no longer called in `ingestConversation`)
- File retained for potential future use but not imported

### ingestConversation Flow (after)

```
conversation text
  → LLM extraction (summary + details quote)
  → post-validation (70% keyword match, proper noun check)
  → noise filter (existing, unchanged)
  → dedup filter (existing, unchanged)
  → saveMemory(summary=extracted statement, details=quoted sentences)
  → DB: decision=statement, reasoning=quoted sentences, summary=statement
```

### Scope

**In scope:**

- Remove regex-first stage from `ingestConversation`
- Strengthen post-validation threshold (50%→70%)
- Ensure `details` contains quoted sentences, not full conversation
- Restore scope-aware topic loading for LLM (was removed in regex-first change)

**Out of scope:**

- `recallMemory` changes (temporal boost, supersede chain — working fine)
- Edge quality improvements (separate effort)
- DB schema changes (none needed)
- `fact-extractor.ts` deletion (keep file, just stop importing)

### Verification

- Run 12Q benchmark after each change
- Target: maintain Top1 92%+ / Top3 100%
- Regression test: any drop below 90% Top1 blocks the change

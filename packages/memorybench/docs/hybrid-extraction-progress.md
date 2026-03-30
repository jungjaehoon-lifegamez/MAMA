# Hybrid Extraction Progress — LongMemEval Benchmark

## Summary

Developed a hybrid extraction approach (code regex + Sonnet LLM supplement) for the LongMemEval memory benchmark. Starting from 40% accuracy with code-only extraction, iteratively improved to **100% accuracy on 10 questions** across all question types, using Opus as the answering model.

## Results

| Stage                                | Accuracy     | Key Change                                                           |
| ------------------------------------ | ------------ | -------------------------------------------------------------------- |
| Code-only baseline                   | 4/10 (40%)   | Regex patterns only                                                  |
| + Hybrid (Sonnet fallback, code==0)  | 6/10 (60%)   | Sonnet extracts facts for zero-code sessions                         |
| + Regex expansion + code<2 threshold | 7/10 (70%)   | Added 15+ patterns (I've been+verb-ing, etc), lowered Sonnet trigger |
| + question_date in answer prompt     | 8/10 (80%)   | Temporal reasoning now uses correct time reference                   |
| + DB superseded status fix           | 10/10 (100%) | Fixed entity key collision causing fact burial                       |

## Question Coverage (10 questions, all types)

| QID           | Type                      | Answer                             |
| ------------- | ------------------------- | ---------------------------------- |
| gpt4_2f8be40d | multi-session             | 3 weddings (Rachel, roommate, Jen) |
| 7024f17c      | multi-session             | 0.5 hours (30min jog)              |
| 3fdac837      | multi-session             | 12 days (Japan 8 + Chicago 4)      |
| 2ce6a0f2      | multi-session             | 4 art events                       |
| 2ebe6c90      | temporal-reasoning        | 21 days (Nightingale)              |
| gpt4_483dd43c | temporal-reasoning        | Game of Thrones first              |
| gpt4_8279ba03 | temporal-reasoning        | smoker                             |
| 15745da0      | single-session-user       | three months                       |
| d24813b1      | single-session-preference | lemon poppyseed cake               |
| c7dc5443      | knowledge-update          | 5-2 record                         |

## Architecture

### Extraction Pipeline

```
Session (user messages)
  |
  +-- Phase 1: Code Regex (15+ patterns)
  |     +-- I've been + verb-ing (collecting, listening, meaning...)
  |     +-- I started/finished/attended/got/bought...
  |     +-- I usually/finally/upgraded/assembled...
  |     +-- my + family member + proper noun
  |     +-- Domain labels (Reading/Travel/Sports/Event...)
  |
  +-- Phase 2: Sonnet Supplement (when code < 2 facts)
  |     +-- Persistent Claude session (stream-json protocol)
  |     +-- Returns JSON array of facts with date prefix
  |     +-- Unique entity key per fact (includes fact index)
  |
  +-- Save to MAMA DB via /api/mama/save
        +-- topic: hyb_{runTag}_{sessionId}_{entityKey}
        +-- decision: "{date}: {domain label}: {fact}"
        +-- supersedes: entity key match across sessions
```

### Search Pipeline

```
Question
  |
  +-- Temporal resolution ("10 days ago" -> actual date)
  +-- MAMA /api/mama/search with topicPrefix filter
  |     +-- NEW: Vector search pre-filters by topic BEFORE limit
  +-- Top-10 results as context
  |
  +-- Answer via independent claude -p call
        +-- Prompt includes question_date for temporal reasoning
```

### MAMA Core Improvement: topicPrefix Pre-filter

**Before**: vector search -> global top-N -> topic filter (loses scoped results)
**After**: vector search with topic pre-filter -> scoped top-N (all relevant results preserved)

Chain: `adapter.vectorSearch(topicPrefix)` -> `db-manager` -> `recallMemory` -> `suggest` -> `graph-api`

## Key Lessons

1. **Supersedes collision**: When Sonnet extracts multiple facts from the same session, identical entity keys cause a supersedes chain where only the last fact survives in search. Fix: include fact index in entity key.

2. **question_date is mandatory**: Temporal reasoning questions ("how long", "last week", "this year") require the question timestamp as reference. Without it, the model interprets relative time against today's date.

3. **Context pollution in persistent sessions**: Persistent answer sessions accumulate context from prior questions, degrading answer quality. Independent `claude -p` calls per question are safer for benchmarks.

4. **Code extraction covers ~58% of answer sessions**: The remaining ~42% require LLM supplementation. Expanded regex patterns (I've been + verb-ing, I finally, I usually, etc.) improve coverage but can't catch all natural language patterns.

5. **Search recall > extraction quality**: Extracted facts that don't appear in search results are the bigger bottleneck. The topicPrefix pre-filter in MAMA core vector search was the most impactful infrastructure fix.

## 500-Question Benchmark Estimate

| Phase                                         | Time          |
| --------------------------------------------- | ------------- |
| Extraction (Sonnet persistent, ~16,400 calls) | ~18 hours     |
| MAMA API (save calls)                         | ~2.4 hours    |
| Answer (Opus, independent calls x500)         | ~2.1 hours    |
| Evaluate (Opus, independent calls x500)       | ~1.7 hours    |
| Search                                        | ~3 min        |
| **Total**                                     | **~24 hours** |

Key metrics:

- Avg 48.2 sessions/question
- Code < 2 rate: 67.9% (with expanded regex)
- Sonnet calls/question: ~32.8

### Optimization options to reduce time:

- **Batch Sonnet calls** (5 sessions per prompt): ~16,400 -> ~3,300 calls, extraction down to ~4 hours
- **Parallel extraction** with multiple Sonnet sessions: 2x-3x speedup
- **Total with batch optimization**: ~10-12 hours

## Files

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `scripts/test-hybrid-v2.mjs`           | 10-question hybrid test (extraction + answer + evaluate) |
| `scripts/test-hybrid-extraction.mjs`   | 5-question extraction-only test                          |
| `scripts/test-hybrid-answer.mjs`       | Answer+evaluate on existing DB                           |
| `scripts/test-code-extraction.mjs`     | Code-only extraction test                                |
| `src/providers/mama/index.ts`          | MAMAProvider with code extraction integration            |
| `mama-core/.../node-sqlite-adapter.ts` | topicPrefix pre-filter in vector search                  |
| `mama-core/.../memory/api.ts`          | RecallMemoryOptions.topicPrefix                          |

## Next Steps

1. Integrate hybrid v2 into MAMAProvider (`MEMORYBENCH_HYBRID_EXTRACT=true`)
2. Implement batch Sonnet calls (5 sessions per prompt) to reduce extraction time
3. Run full 500-question benchmark (~24h, or ~10h with batch optimization)
4. Rebuild FTS5 triggers (dropped during DB cleanup)
5. Compare against v68 baseline (50% accuracy with raw ingest)

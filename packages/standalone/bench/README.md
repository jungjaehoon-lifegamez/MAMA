# MAMA Memory Benchmark

Production-level memory quality benchmark using the LongMemEval dataset (500 questions, 6 categories).

## Quick Start

```bash
# Run 12-question sample (2 per category, ~2min)
pnpm bench:sample

# Run full 500-question benchmark (~30min, requires API keys)
pnpm bench:full

# Run specific category
pnpm bench:category single-session-user
```

## Requirements

- MAMA OS running (`mama start`)
- LongMemEval dataset at `~/.mama/workspace/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json`
- For answer generation: `ANTHROPIC_API_KEY` env var

## What It Tests

| Category                  | Count | What It Proves                         |
| ------------------------- | ----- | -------------------------------------- |
| single-session-user       | 70    | Recall facts the user stated           |
| single-session-assistant  | 56    | Recall facts the assistant provided    |
| single-session-preference | 30    | Recall user preferences                |
| multi-session             | 133   | Connect facts across multiple sessions |
| temporal-reasoning        | 133   | Reason about time-ordered events       |
| knowledge-update          | 78    | Latest fact supersedes older ones      |

## How It Works

1. **Ingest**: Each question's haystack sessions are saved to MAMA via the save API
2. **Search**: The question is searched against saved memories
3. **Answer**: An LLM generates an answer from retrieved context
4. **Judge**: Another LLM judges if the answer matches ground truth
5. **Report**: Accuracy, latency, and per-category breakdown

## Output

```
╔══════════════════════════════════════════════════════════╗
║            MAMA MEMORY BENCHMARK REPORT                 ║
╠══════════════════════════════════════════════════════════╣
║ Category                  │ Correct │ Total │ Accuracy  ║
║ single-session-user       │      12 │    14 │    85.7%  ║
║ single-session-preference │       5 │     6 │    83.3%  ║
║ knowledge-update          │      13 │    16 │    81.3%  ║
║ ...                       │         │       │           ║
╠══════════════════════════════════════════════════════════╣
║ OVERALL                   │      42 │    50 │    84.0%  ║
╚══════════════════════════════════════════════════════════╝
```

## Baseline

| Version            | Questions | Accuracy | Avg Search Ms |
| ------------------ | --------- | -------- | ------------- |
| v5 (provider-path) | 10        | 100%     | 26,183ms      |
| v6 (this branch)   | 12        | TBD      | TBD           |

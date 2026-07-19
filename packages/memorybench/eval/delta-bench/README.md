# Delta Bench — temporal-truth QA from real decision chains

Measures the behavioral delta between a plain LLM and the same LLM augmented
with MAMA memory, on questions whose correct answer CHANGED over time.

## Why this exists

Architecture claims ("decision graph", "truth projection") are not evidence.
The claim that matters is: **distilled current truth beats a raw history dump
in long context** — same data, same model, different representation. If raw
context wins, MAMA's positioning fails; this bench is a falsification test
before it is a promotion asset.

## How it works

1. **extract.mjs** (read-only) groups a MAMA DB's `decisions` rows into
   temporal chains by topic (MAMA semantics: topic reuse supersedes). Each
   chain with a real delta becomes one multiple-choice item:
   - answer = the newest decision
   - distractors = prior versions that actually existed
   - option order is seed-shuffled; test-pollution topics are excluded
2. **run.mjs** asks each question under three conditions via the Claude CLI
   (`claude -p`, prompt on stdin, neutral cwd so no CLAUDE.md leaks in):
   - `vanilla` — question only (floor; most chains have 2 options → ~50% chance)
   - `raw` — full chronological decision dump in context, then the question
   - `mama` — what `mama.suggest()` (the real MCP search path) returned
3. Metrics per condition: accuracy, stale rate (picked a superseded version),
   invalid rate, approx tokens/item, latency.

## Usage

```bash
# 1. Extract (read-only against any MAMA DB)
MAMA_DB_PATH=~/.claude/mama-memory.db \
  node eval/delta-bench/extract.mjs --out /tmp/delta --max-items 40

# 2. Copy the DB before the mama condition (initDB may migrate)
cp ~/.claude/mama-memory.db /tmp/delta-copy.db

# 3. Run (resumable; results append to results.jsonl)
MAMA_DB_PATH=/tmp/delta-copy.db \
  node eval/delta-bench/run.mjs --qa /tmp/delta --out /tmp/delta/results \
  --conditions vanilla,raw,mama --limit 40
```

`run.mjs` refuses to run the mama condition against the live DB paths
(`~/.claude/mama-memory.db`, `~/.mama/mama-memory.db`).

## Interpreting results

- Most chains have length 2 (one distractor), so the vanilla floor sits near
  50%, not 25% — compare conditions against each other, not against zero.
- The mama condition inherits real retrieval behavior, including its defects.
  A low mama score is a product finding, not a bench bug.

## Tests

```bash
node --test eval/delta-bench/lib.test.mjs
```

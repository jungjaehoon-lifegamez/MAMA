# Delta Bench — temporal-truth + lineage QA from real decision chains

Measures the behavioral delta between a plain LLM and the same LLM augmented
with MAMA memory, on questions whose correct answer CHANGED over time.

## Why this exists

Architecture claims ("decision graph", "truth projection") are not evidence.
The claim that matters is: **distilled current truth beats a raw history dump
in long context** — same data, same model, different representation. If raw
context wins, MAMA's positioning fails; this bench is a falsification test
before it is a promotion asset.

## Two QA types

- **truth** — which option is the CURRENT decision on a topic. Answer = the
  newest version; distractors = superseded versions of the same topic.
- **lineage** — which statement describes why a topic's decision was revised.
  Answer = the newest version's actual `reasoning` text (the revision
  rationale); distractors = OTHER topics' revision reasonings (real recorded
  text, never generated). Filters: chain length ≥ 2, the answer reasoning ≥ 40
  chars and distinct from every prior version's reasoning. Chains that fail are
  counted (`excludedLineageChains`) in `meta.json`.

## How it works

1. **extract.mjs** (read-only) groups a MAMA DB's `decisions` rows into
   temporal chains by topic (MAMA semantics: topic reuse supersedes). Each
   chain with a real delta becomes multiple-choice items. `--types truth,lineage`
   (default both) selects which to emit; every item carries a `qaType` field.
   Option order is seed-shuffled; test-pollution topics are excluded.
2. **run.mjs** asks each question under these conditions via the Claude CLI
   (`claude -p`, prompt on stdin, neutral cwd so no CLAUDE.md leaks in):
   - `vanilla` — question only (floor; most chains have 2 options → ~50% chance)
   - `raw` — full chronological decision dump in context, then the question
   - `mama` — what `mama.suggest()` (the real MCP search path) returned (flat)
   - `mama-lineage` — `mama.suggest()`'s topics, each topic's FULL chain
     re-fetched from the DB copy and rendered as a lineage block
     (`v1 (reasoning head) -> ... -> CURRENT: decision`). **This rendering is
     the R2 reasoning-precompute prototype under test** — the falsification is
     `mama-lineage` vs `mama`.
   - `oracle` — the context a CORRECT projection WOULD return (ceiling): the
     current decision marked current (truth) or the asked chain rendered
     perfectly (lineage).
3. Metrics per condition AND per qaType: accuracy, stale rate (picked a
   superseded version), invalid rate, approx tokens/item, latency.

## Usage

```bash
# 1. Extract (read-only against any MAMA DB); default emits both QA types
MAMA_DB_PATH=~/.claude/mama-memory.db \
  node eval/delta-bench/extract.mjs --out /tmp/delta --max-items 40 \
  --types truth,lineage

# 2. Copy the DB before the mama / mama-lineage conditions (initDB may migrate)
cp ~/.claude/mama-memory.db /tmp/delta-copy.db

# 3. Run (resumable; results append to results.jsonl)
MAMA_DB_PATH=/tmp/delta-copy.db \
  node eval/delta-bench/run.mjs --qa /tmp/delta --out /tmp/delta/results \
  --conditions vanilla,raw,mama,mama-lineage,oracle --limit 40

# 4. Offline retrieval decomposition + per-type accuracy (no LLM calls)
MAMA_DB_PATH=/tmp/delta-copy.db \
  node eval/delta-bench/analyze.mjs --qa /tmp/delta --results /tmp/delta/results
```

`run.mjs` refuses to run the mama / mama-lineage conditions against the live DB
paths (`~/.claude/mama-memory.db`, `~/.mama/mama-memory.db`).

## Interpreting results

- Most chains have length 2 (one distractor), so the vanilla floor sits near
  50%, not 25% — compare conditions against each other, not against zero.
- The mama and mama-lineage conditions inherit real retrieval behavior,
  including its defects. A low score is a product finding, not a bench bug.
- Lineage items: `mama` carries the current `reasoning` field verbatim, while
  `mama-lineage` renders prior reasoning heads + the current decision. Whether
  the structured lineage rendering beats the flat hit list is exactly the
  question the falsification design answers — it may not, and that is a result.
- `run.mjs` prints an all-items summary and one per qaType; `report.json` also
  stores `summaryByType`.

## Tests

```bash
node --test eval/delta-bench/lib.test.mjs
```

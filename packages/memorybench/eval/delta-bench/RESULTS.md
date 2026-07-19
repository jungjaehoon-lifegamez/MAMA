# Delta Bench — first clean run (dev DB, 2026-07-19)

Corpus: the maintainer's real dev DB (1,097 decision rows → 44 temporal chains
→ 40 MC items; answer = newest version, distractors = actually-existed priors).
Model: Claude CLI default (claude-opus-4-8), isolated with
`--setting-sources project` + neutral cwd. Seed 20260719. Mostly 2-option
items → chance ≈ 47%.

## Headline table

| condition  | what the model saw                         | accuracy  | ~tokens/item |
| ---------- | ------------------------------------------ | --------- | ------------ |
| vanilla    | question only (floor)                      | 50.0%     | 286          |
| **mama**   | `mama.suggest()` top-5 (current pipeline)  | **57.5%** | 1,395        |
| raw        | full chronological history dump            | 82.5%     | 79,194       |
| **oracle** | what correct truth projection WOULD return | **92.5%** | 426          |

## Verdict

1. **The design thesis holds at the ceiling**: distilled, marked current truth
   (oracle) beats the full-history dump by +10pp at 1/186 the tokens.
2. **The current pipeline does not cash it**: `mama.suggest()` scores 25pp
   BELOW raw long context and barely above the no-context floor. The
   falsification threshold defined before the run ("mama must beat raw or halt
   promotion") FIRED.
3. **Failure is mostly retrieval, not model choice** (offline decomposition of
   suggest() top-5 per item):
   - topicHitRate 57.5% — for 42.5% of items the top-5 contained not a single
     row of the asked topic, with the topic string itself as the query
   - currentPresentRate 50.0% — current truth reached the model half the time
   - currentRank1Rate 17.5%
   - of 17 mama misses: 13 retrieval failures (current absent), 4 choice
     failures (current present but unmarked next to stale versions;
     conditional accuracy when present: 80% vs oracle 92.5% when marked)

## Repair round 1 (same day) — measured gap close

After fixing the three retrieval defects in mama-core (fusion scale inversion
where graph-expansion hits outscored the entire primary RRF range; missing
topic-field weighting; no current/superseded marking in suggest results):

| metric                       | before    | after                      |
| ---------------------------- | --------- | -------------------------- |
| topicHit@5                   | 57.5%     | 82.5%                      |
| currentPresent@5             | 50.0%     | 77.5%                      |
| **mama end-to-end accuracy** | **57.5%** | **75.0%** (~2.2k tok/item) |

mama now sits 7.5pp under raw (82.5% @ 79k tok) at 1/36 the tokens, with
17.5pp of ceiling headroom left (oracle 92.5%). Remaining misses: 6 retrieval,
4 choice. An Opus adversarial review then caught a scope-blindness defect in
the currency marking (topic collisions across projects/channels would mark
in-scope truth stale) - fixed with scope-restricted comparison, deterministic
tiebreaks, word-boundary topic matching, and a topic index, with metrics
unchanged after hardening.

## Fix list this measures (re-run after each)

1. Retrieval: query-side e5 prefix omission + lexical/topic matching (a topic
   string failing to retrieve its own rows 42.5% of the time).
2. Truth projection surfacing: mark current vs superseded in suggest() results
   (closes the present-but-unmarked gap, 80% → ~92.5%).

## Experiment-integrity notes (biased runs archived, not deleted)

- `results-biased-preamble.jsonl`: instruction example letter '(e.g. "B")'
  made every condition answer B for 80%+ of items.
- `results-hook-contaminated.jsonl`: `claude -p` executes user-level plugin
  hooks; the user's live MAMA SessionStart injection contaminated every call
  (oracle 65% → 92.5% once isolated).

# Canonical Entity Benchmark And Audit Design

## Overview

Canonical entity resolution is not a simple true/false classification problem.

MAMA will not become useful by pretending that a single benchmark score can determine whether the system is "correct."

Instead, the entity layer must be designed as a **measured, reviewable, and continuously improving system**.

That means the architecture needs:

- benchmark datasets
- baseline comparisons
- ingest quality audits
- candidate and merge quality audits
- ontology consistency audits
- projection quality audits
- operational review workload audits

The goal is not one-shot perfection.

The goal is to create a system that can:

- ingest real raw evidence
- expose uncertainty honestly
- compare runs against prior baselines
- detect regressions
- show where quality improved
- guide the next tuning iteration

---

## Why Binary Evaluation Is Not Enough

Entity systems fail in more than one way.

Examples:

- a candidate was never generated
- the correct candidate existed but ranked too low
- a false merge was auto-approved
- ontology constraints were violated
- the entity graph improved but downstream wiki/dashboard projection regressed
- the review queue became too large to operate

These outcomes cannot be reduced to one boolean label.

MAMA needs a multi-layer evaluation model that measures:

- correctness where gold labels exist
- ambiguity handling where they do not
- operational sustainability
- improvement over time

---

## Evaluation Philosophy

### 1. Improvement over perfection

The first successful version is not the version that "solves entity resolution."

It is the version that lets us prove:

- false merges are controlled
- multilingual candidates are surfacing
- ontology violations are visible
- downstream fragmentation is dropping
- each tuning change can be compared to a prior baseline

### 2. False merge minimization first

The first release should optimize primarily for:

- **not** merging the wrong entities

It is acceptable for v1 to miss some valid merges if it produces:

- trustworthy candidates
- reviewable evidence
- low irreversible damage

### 3. Candidate recall second

After false merge risk is under control, the next optimization target is:

- candidate recall, especially for Korean/English/Japanese aliases

### 4. Auditability is part of quality

If the system cannot explain:

- why this candidate exists
- why this merge happened
- why this split happened
- why this projection changed

then it is not a trustworthy entity system, regardless of metric scores.

---

## Benchmark Layers

MAMA should use multiple benchmark classes, because each benchmark answers a different question.

### Benchmark A: Gold Canonical Identity Set

Purpose:

- measure precision/recall when ground truth exists

Contents:

- manually curated project/person/entity groups
- explicit alias sets
- approved canonical identities
- reviewed relationship links

Recommended usage:

- pairwise metrics
- cluster metrics
- false merge analysis

### Benchmark B: Cross-Language Alias Set

Purpose:

- specifically measure Korean/English/Japanese resolution behavior

Contents:

- multilingual aliases for the same project/person
- transliteration variants
- partial shorthand and source-native labels

Recommended usage:

- `candidate_recall@k`
- multilingual review-needed hit rate
- cross-language false merge avoidance

### Benchmark C: Perturbation Set

Purpose:

- stress test normalization and blocking

Contents:

- punctuation changes
- spacing changes
- abbreviation variants
- source-local shorthand
- casing and Unicode variants

Recommended usage:

- normalization regressions
- blocking coverage
- candidate explosion prevention

### Benchmark D: Historical Replay Set

Purpose:

- simulate real-world ingest improvement over time

Contents:

- runtime-only replay exports derived from real raw records, stored outside the repo
- optional synthetic or redacted replay samples that mimic production shape safely
- archived versions of extractors/rules/models

Recommended usage:

- before/after comparisons
- projection diffs
- queue growth or shrinkage
- regression detection on operational data

### Benchmark E: Review Workload Set

Purpose:

- measure whether the system is operable by humans

Contents:

- candidate queue snapshots
- review decisions
- approval/rejection/defer timing

Recommended usage:

- backlog growth
- median review age
- reviewer throughput
- accepted-vs-rejected candidate mix

---

## Quality Layers And Metrics

MAMA should evaluate canonical entity quality at seven distinct layers.

### 1. Ingest quality

Questions:

- did raw data arrive?
- was it parsed into observations?
- was provenance retained?

Recommended metrics:

- `raw_ingest_success_rate`
- `observation_extraction_rate`
- `parse_error_rate`
- `provenance_completeness`
- `structured_identifier_extraction_rate`

### 2. Candidate generation quality

Questions:

- does the correct entity appear in the candidate set?
- how high does it rank?

Recommended metrics:

- `candidate_recall@1`
- `candidate_recall@5`
- `candidate_recall@10`
- `blocking_recall`
- `candidate_precision@k`
- `cross_language_candidate_recall@k`

### 3. Merge quality

Questions:

- are approved merges mostly right?
- are wrong merges escaping review?

Recommended metrics:

- `false_merge_rate`
- `merge_precision`
- `review_approval_rate`
- `review_rejection_rate`
- `split_after_merge_rate`

### 4. Cluster quality

Questions:

- are aliases clustered into the correct canonical groups?

Recommended metrics:

- pairwise precision
- pairwise recall
- pairwise F1
- B-cubed precision
- B-cubed recall
- B-cubed F1
- duplicate_cluster_rate
- orphan_entity_rate

Notes:

- pairwise and cluster metrics can disagree
- MAMA should report both

### 5. Ontology consistency quality

Questions:

- does the resolved graph obey class and relation rules?

Recommended metrics:

- `ontology_violation_count`
- `class_disjointness_violation_count`
- `invalid_relation_count`
- `missing_evidence_violation_count`
- `review_rule_violation_count`

### 6. Projection quality

Questions:

- do downstream surfaces become more coherent?

Recommended metrics:

- `projection_completeness`
- `projection_consistency`
- `projection_fragmentation_rate`
- `duplicate_page_rate`
- `dashboard_entity_fragmentation_rate`
- `memory_recall_coherence_score`

### 7. Operational quality

Questions:

- can humans actually operate the review workflow?

Recommended metrics:

- `review_queue_size`
- `median_review_age`
- `candidates_per_raw_record`
- `reviewer_throughput_per_day`
- `backlog_growth_rate`
- `defer_rate`

---

## Primary V1 Metrics

The first release should have a very small set of top-level success metrics.

### Metric 1: `false_merge_rate`

This is the most important metric in v1.

If this regresses, the release should be treated as unsafe even if recall improved.

### Metric 2: `cross_language_candidate_recall@10`

The system must surface multilingual candidates well enough for review to work.

If Korean/English/Japanese candidates never reach the reviewer, the architecture is not viable.

### Metric 3: `ontology_violation_count`

An ontology-guided system that silently violates its own ontology is structurally unsound.

### Metric 4: `projection_fragmentation_rate`

Even if candidate metrics look better, the release is not useful if downstream views remain fragmented.

---

## Audit Run Model

The entity layer should have its own audit run model, similar in spirit to validation sessions but specialized for canonical identity quality.

### Entity audit run purpose

An audit run should answer:

- did ingest improve or regress?
- did candidate quality improve or regress?
- did false merge risk improve or regress?
- did ontology consistency improve or regress?
- did projection coherence improve or regress?

### Recommended audit statuses

- `improved`
- `regressed`
- `stable`
- `inconclusive`

### Recommended audit output

Each audit run should store:

- benchmark set used
- source set used
- raw count
- observation count
- candidate count
- auto-merge count
- review-needed count
- score summary
- metric deltas vs baseline
- violation summary
- notable examples
- recommendation summary

---

## Baseline Comparison Model

Every major change to the entity system should be compared against a saved baseline.

### Baseline dimensions

At minimum:

- candidate recall
- false merge rate
- ontology violations
- fragmentation rate
- queue size

### Baseline comparison semantics

Each metric should declare its direction:

- lower is better
- higher is better
- stable band preferred

Examples:

- `false_merge_rate`: down is good
- `candidate_recall@10`: up is good
- `ontology_violation_count`: down is good
- `review_queue_size`: depends on context, but uncontrolled growth is bad

### Classification rules

Audit summary should not rely on a single score.

Instead:

- `improved`: critical guardrails hold and at least one key objective improved
- `stable`: no meaningful gain, no meaningful regression
- `regressed`: critical guardrail worsened or downstream fragmentation/violations worsened materially
- `inconclusive`: sample too small, benchmark invalid, provenance incomplete, or metrics conflict too strongly

---

## Review-Driven Continuous Improvement Loop

The canonical entity system should improve through repeated loops:

1. ingest and candidate generation
2. review decisions
3. benchmark replay
4. baseline comparison
5. tuning
6. repeat

### Tuning levers

The system should be designed so these can improve independently:

- normalization rules
- blocking rules
- structural scoring weights
- graph/context scoring weights
- embedding-based ranking inputs
- ontology constraints
- review thresholds
- projection formatting rules

### Why this matters

The first version will not be complete.

MAMA should optimize for becoming more correct over time, not for pretending to be final on day one.

---

## Recommended Storage For Benchmarks And Audit Results

### Benchmark fixtures

Recommended repository location:

- `packages/mama-core/tests/entities/fixtures/`

Suggested fixtures:

- `gold-canonical-identities.json`
- `cross-language-aliases.json`
- `perturbation-cases.json`
- `historical-replay-sample.json` - synthetic or redacted replay sample only

### Runtime replay corpora

Real historical replay corpora should live **outside the repository**.

They may be exported from operator-managed raw stores for local or controlled audit use, but they should not be committed to git because:

- they may contain sensitive operational data
- they change over time
- they are much larger than repo fixtures

Repository fixtures are for deterministic tests.

Runtime replay corpora are for operational audit runs.

### Audit result storage

Recommended runtime storage:

- `entity_audit_runs`
- `entity_audit_metrics`
- `entity_audit_findings`

These should be distinct from validation sessions because the target problem is different.

### Why separate them

Validation sessions evaluate agent/system behavior.

Entity audit runs evaluate canonical identity quality and projection quality.

The concepts overlap, but the metrics and failure modes are not the same.

---

## Recommended APIs

The first audit/benchmark APIs should be minimal.

### Benchmark APIs

- `POST /api/entities/benchmarks/replay`
- `GET /api/entities/benchmarks/runs`
- `GET /api/entities/benchmarks/runs/:id`

### Audit APIs

- `POST /api/entities/audit/run`
- `GET /api/entities/audit/runs`
- `GET /api/entities/audit/runs/:id`

### Candidate quality APIs

- `GET /api/entities/candidates`
- `GET /api/entities/candidates/:id`

### Review APIs

- `POST /api/entities/candidates/:id/approve`
- `POST /api/entities/candidates/:id/reject`
- `POST /api/entities/candidates/:id/defer`

---

## Minimal Reviewer-Facing Reports

Each run should produce a compact summary that a human can actually use.

Suggested report sections:

1. baseline comparison
2. critical guardrails
3. candidate quality changes
4. false merge examples
5. ontology violations
6. downstream projection changes
7. review workload trend
8. recommended next tuning move

This is more valuable than a single leaderboard number.

---

## Release Gates

The first meaningful branch should not be merged unless:

1. `false_merge_rate` is no worse than baseline
2. `cross_language_candidate_recall@10` is at least measurable and acceptable for review
3. `ontology_violation_count` is zero or explicitly understood
4. one real raw replay path works end-to-end
5. audit output can classify the run as `improved`, `stable`, `regressed`, or `inconclusive`

---

## Current Gap In MAMA

Today, MAMA has:

- validation thinking for agent/system behavior
- memory truth projection
- some event logging

But it does **not** yet have:

- entity-specific benchmark fixtures
- entity-specific audit runs
- baseline comparison for canonical resolution
- false-merge-first release gates
- review workload quality metrics

Without this layer, the entity architecture may still be technically elegant but operationally untrustworthy.

---

## Final Recommendation

MAMA should treat canonical entity quality as a **continuous audit problem**, not a one-time classification problem.

The right question is not:

- "Is the entity layer correct?"

The right questions are:

- "Did it get safer?"
- "Did it get less fragmented?"
- "Did multilingual candidate recall improve?"
- "Did false merges stay under control?"
- "Did the review burden stay manageable?"

That is the benchmark and audit model the system should be built around.

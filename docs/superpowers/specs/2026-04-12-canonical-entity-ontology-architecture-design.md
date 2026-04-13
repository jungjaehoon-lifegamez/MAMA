# Canonical Entity Ontology Architecture Design

## Overview

MAMA's current memory core is useful, but it is still centered on `topic`-keyed memory records and decision evolution.

That is not enough for the system we now want to build.

The next architecture stage must stop treating project names, person names, aliases, and source-specific labels as if they were already resolved truth.

Instead, MAMA needs a canonical entity substrate that:

- starts from immutable raw evidence
- extracts entity observations
- normalizes multilingual aliases
- generates and ranks resolution candidates
- applies conservative merge rules
- escalates ambiguous cases into review
- projects canonical entities into the current memory, truth, wiki, dashboard, and agent-facing recall systems

This document defines that ontology-guided architecture.

It is intentionally broader than the current `mama-core` implementation. The current core is a constraint to migrate from, not the boundary of the target system.

---

## Why The Current Core Is Not Enough

### Current strength

`mama-core` already has:

- memory records
- truth projection
- vector and lexical retrieval
- scope bindings
- memory evolution edges
- event logging

This is a strong memory graph substrate.

### Current structural limit

However, the current substrate is still fundamentally:

- `topic`-centric
- memory-record-centric
- post-interpretation-centric

The core data model does **not** yet have first-class representations for:

- canonical entities
- aliases and multilingual labels
- raw-vs-observation separation
- resolution candidates
- merge provenance
- reversible identity operations
- entity timelines

This means the system can remember statements about a project, but it cannot yet reliably determine whether:

- `Project Alpha`
- `프로젝트 알파`
- `プロジェクトアルファ`
- `Alpha launch stream`

refer to the same project, related projects, or merely similar surface strings.

### Practical consequence

Without a canonical entity layer:

- `os-agent` can read pages but cannot build durable project/person identity
- dashboard and wiki views are vulnerable to duplicated or fragmented entities
- long-running history across connectors remains brittle
- multilingual sources become a source of ambiguity instead of cumulative knowledge

---

## Design Goals

1. Build a canonical entity substrate below existing memory/truth systems.
2. Keep raw evidence immutable and replayable.
3. Support multilingual alias handling across Korean, English, and Japanese from day one.
4. Make entity resolution reviewable, attributable, and reversible.
5. Use embeddings and graph context for candidate generation, not for blind auto-merge.
6. Project canonical entities back into existing MAMA systems instead of replacing them wholesale.
7. Keep the first implementation operationally conservative.

---

## Non-Goals For This Phase

- Building a full RDF triple-store-first platform
- Rewriting all current memory APIs before the substrate exists
- Aggressive automatic cross-language entity merging
- Full `os-agent` same-view completion in the same branch
- Global `conductor -> auditor` rename across the tree

---

## Reference Model And Standards Alignment

This architecture should be **ontology-guided**, but it should not force MAMA into a heavyweight semantic-web runtime before the product model is proven.

The recommended stance is:

- relational-first storage
- ontology-informed schema
- explicit provenance
- rule-checked review workflow

### OWL-inspired responsibilities

Use ontology concepts similar to OWL 2 for:

- class hierarchy
- disjointness
- relation semantics
- domain/range constraints

Examples:

- `Project` and `Person` are disjoint classes
- `works_on(Person, Project)` is valid
- `subproject_of(Project, Project)` is valid
- `works_on(Project, Project)` is invalid

MAMA does not need full OWL reasoning in v1, but it **does** need explicit schema semantics.

### SKOS-inspired responsibilities

Use a SKOS-like label model for:

- preferred labels
- alternative labels
- hidden/search labels
- language/script tags

This is directly relevant to:

- Korean/English/Japanese alias handling
- preserving source-native labels
- separating canonical identity from surface forms

### SHACL-inspired responsibilities

Use SHACL-like validation rules for:

- candidate completeness
- merge safety
- evidence requirements
- reviewer action constraints

Examples:

- a candidate cannot be auto-approved without evidence
- an entity alias must have at least one source observation
- a merge action must point to source and target canonical entities

### PROV-inspired responsibilities

Use provenance concepts similar to W3C PROV for:

- raw source origin
- extraction activity
- candidate generation activity
- review actions
- merge/unmerge history

MAMA must be able to answer:

- where did this entity claim come from?
- which raw records supported this alias?
- which model or rule generated this candidate?
- who approved or rejected this merge?

---

## Architectural Principles

### 1. Raw Is Immutable

Raw records are evidence, not truth.

They must be:

- append-only
- attributable to source
- reprocessable with newer extractors and resolvers

### 2. Observation Comes Before Truth

The system should never jump directly from raw source data into canonical truth.

It must pass through an observation layer first.

### 3. Canonical Entity Beats Topic As Identity

`topic` remains useful for recall and memory projection, but it must stop being the primary identity key for real-world projects and people.

### 4. Projection, Not Replacement

Current MAMA memory/truth/search assets should become consumers of canonical entity projection.

They are not the authority for identity.

### 5. Ambiguity Must Surface, Not Hide

When a cross-language or semantically similar case is uncertain, the system should produce a ranked review candidate instead of inventing certainty.

### 6. Auto-Merge Must Be Narrow

False merges are more expensive than delayed merges.

In v1:

- exact structural identity can auto-merge
- cross-language semantic similarity can generate candidates
- ambiguous candidates must go to review

### 7. Merge Must Be Reversible

Canonical entity operations must support:

- approve
- reject
- defer
- split / unmerge
- audit trail replay

---

## Target Dataflow

```text
Raw Source Record
  -> Observation Extraction
  -> Alias Normalization
  -> Blocking / Candidate Generation
  -> Candidate Scoring
  -> Ontology Constraint Filter
  -> Resolution Decision
      -> Auto-merge (narrow cases only)
      -> Review-needed
  -> Canonical Entity Store
  -> Projection Layer
      -> Memory / Truth
      -> Wiki
      -> Dashboard
      -> Agent-facing recall
```

---

## Canonical Ontology Model

### Core entity classes

The initial ontology should support at least:

- `Project`
- `Person`
- `Organization`
- `WorkItem`

Future classes can expand later, but v1 should stay disciplined.

### Core relationship types

Recommended initial relation set:

- `works_on(Person, Project)`
- `belongs_to(Project, Organization)`
- `subproject_of(Project, Project)`
- `assigned_to(WorkItem, Person)`
- `part_of(WorkItem, Project)`
- `related_to(Project, Project)` as a low-confidence fallback link

### Label model

Each entity should carry:

- one canonical preferred label
- many aliases
- alias metadata:
  - original text
  - normalized text
  - language tag
  - script tag
  - source
  - confidence
  - current state

### Constraint model

The ontology must encode:

- class disjointness
- allowed relation signatures
- merge restrictions
- candidate review states

---

## Relational Schema Recommendation

The first implementation should introduce the following tables.

### `entity_nodes`

Purpose:

- canonical identity nodes

Suggested columns:

- `id`
- `kind`
- `preferred_label`
- `status`
- `created_at`
- `updated_at`
- `merged_into`

### `entity_aliases`

Purpose:

- multilingual and source-derived labels

Suggested columns:

- `id`
- `entity_id`
- `label`
- `normalized_label`
- `lang`
- `script`
- `label_type` (`pref`, `alt`, `hidden`, `source_native`)
- `source_type`
- `source_ref`
- `created_at`

### `entity_observations`

Purpose:

- extracted entity-bearing claims before canonical resolution

Suggested columns:

- `id`
- `raw_record_id`
- `entity_kind_hint`
- `surface_form`
- `normalized_form`
- `lang`
- `script`
- `context_summary`
- `related_surface_forms`
- `timestamp_observed`
- `extractor_version`
- `created_at`

### `entity_resolution_candidates`

Purpose:

- pair or cluster review candidates

Suggested columns:

- `id`
- `candidate_kind` (`alias_to_entity`, `entity_to_entity`, `cluster`)
- `left_ref`
- `right_ref`
- `status` (`pending`, `auto_merged`, `approved`, `rejected`, `deferred`)
- `score_total`
- `score_structural`
- `score_string`
- `score_context`
- `score_graph`
- `score_embedding`
- `rule_trace`
- `created_at`
- `updated_at`

### `entity_links`

Purpose:

- durable typed links among canonical entities

Suggested columns:

- `id`
- `from_entity_id`
- `to_entity_id`
- `relation_type`
- `confidence`
- `source_basis`
- `created_at`
- `updated_at`

### `entity_timeline_events`

Purpose:

- entity-owned time history

Suggested columns:

- `id`
- `entity_id`
- `event_type`
- `valid_from`
- `valid_to`
- `observed_at`
- `source_ref`
- `summary`
- `details`
- `created_at`

### `entity_merge_actions`

Purpose:

- provenance and reversibility for merge review

Suggested columns:

- `id`
- `action_type` (`merge`, `reject`, `defer`, `split`)
- `source_entity_id`
- `target_entity_id`
- `candidate_id`
- `actor_type`
- `actor_id`
- `reason`
- `evidence_json`
- `created_at`

---

## Candidate Generation Architecture

### Stage 1: Deterministic blocking

Do not compare everything with everything.

Use blocking keys such as:

- external stable IDs
- email
- username/handle
- domain/path identifiers
- normalized surface label
- source-local entity references

### Stage 2: String and structural similarity

Use:

- exact normalized match
- prefix/suffix-safe match
- edit-distance-style match
- token overlap
- structured identifier match

This stage is strong for:

- same-script variants
- punctuation differences
- spacing differences
- abbreviations with strong local evidence

### Stage 3: Context and graph similarity

Use:

- co-occurring people
- co-occurring projects
- source/workspace hints
- parent/child relationship hints
- neighboring resolved entities

This is critical because entity resolution is not only a string problem.

### Stage 4: Embedding similarity

Use embedding similarity to rank candidates for:

- multilingual aliases
- paraphrased project references
- source-specific shorthand

However:

- embeddings should score **candidates**
- embeddings should not independently authorize merge

### Stage 5: Ontology filter

Before approval or auto-merge, reject candidates that violate ontology constraints.

Examples:

- `Project` cannot merge into `Person`
- `Organization` cannot be assigned via `works_on`
- link direction/type must match allowed signatures

---

## Cross-Language Alias Policy

Korean, English, and Japanese aliases are first-class input in v1.

### Allowed in v1

- candidate generation across Korean/English/Japanese
- embedding-based ranking for multilingual candidates
- review queue presentation with multilingual evidence

### Not allowed in v1

- cross-language automatic merge on embedding score alone

### Why

The product problem is inherently multilingual, so candidate generation must include cross-language cases.

But multilingual semantic similarity is still too risky to use as a blind auto-merge rule in the first release.

---

## Resolution Policy

### Auto-merge allowed only for narrow cases

Examples:

- exact stable external ID match
- identical normalized label plus same entity kind plus strong structural context
- exact handle/email/domain identity

### Review-needed cases

Examples:

- Korean/English/Japanese label variants
- similar project names without shared external key
- same person name across different organizations
- subproject/main-project ambiguity

### Reject cases

Examples:

- ontology class conflict
- disjoint relationship signatures
- evidence contradiction
- score driven only by weak semantic similarity

---

## Review Workflow

The system must support a minimal but real review loop.

### Review queue capabilities

For each candidate, the reviewer should be able to see:

- compared labels
- kind hints
- source records
- score breakdown
- related canonical neighbors
- why the candidate was generated

### Reviewer actions

- approve merge
- reject merge
- defer
- split previously merged entities

### Workflow guarantee

Every approved merge must be attributable to:

- a rule
- a system actor
- or a human reviewer

No silent identity rewrite.

---

## Projection Model

Canonical entities should feed the current MAMA systems through projection.

### Memory projection

Generate entity-aware memory artifacts from:

- canonical entity summaries
- timeline slices
- typed links
- reviewed resolution state

### Truth projection

`memory_truth` should become a projection target, not the identity authority.

However, in v1 the entity substrate should avoid writing into `memory_truth` during shadow mode if doing so would contaminate existing bootstrap or legacy read paths.

That means the initial bridge may need to route canonical recall through a dedicated entity-aware read path first, and only broaden `memory_truth` integration in a later phase.

### Dashboard / Wiki projection

- dashboard should consume canonical projects, linked people, and recent timeline events
- wiki should build project/person pages from canonical identity and timeline projection

### Agent-facing recall projection

`recallMemory()` should gradually consume:

- canonical entity summaries
- entity timeline evidence
- linked-entity context

instead of relying almost entirely on topic-shaped decision records

---

## Current `mama-core` Gaps

### Gap 1: no canonical entity domain model

Current memory types define scopes, memory kinds, and truth rows, but no entity ontology types.

Examples:

- no `EntityNode`
- no `EntityAlias`
- no `EntityObservation`
- no `EntityResolutionCandidate`
- no `EntityTimelineEvent`

### Gap 2: topic is overloaded as identity

Current save, truth, and graph flows still pivot on `topic`.

That makes topic useful for retrieval but too overloaded for canonical identity.

### Gap 3: no raw/observation split

The current memory path saves directly into decision/truth-oriented structures.

That skips the explicit observation layer required for safe resolution.

### Gap 4: no multilingual alias layer

Current overlap and slug logic are too ASCII-centric to function as a canonical multilingual label model.

### Gap 5: vector search is attached to decisions, not entity candidates

Current embeddings improve semantic memory recall, but they are not organized around alias clusters or entity resolution candidates.

### Gap 6: evolution engine is memory evolution, not identity resolution

`supersedes` and `builds_on` logic is useful, but it is solving memory-version evolution rather than canonical identity formation.

### Gap 7: provenance is too coarse

The current event system helps with auditing, but it does not yet track:

- extractor lineage
- score breakdown lineage
- merge review lineage
- reversible entity operations

---

## Migration Strategy

### Phase A: shadow entity substrate

Build the entity tables and processing path without replacing current memory writes.

### Phase B: one-source backfill

Backfill one real raw source through:

- raw -> observation -> normalization -> candidate -> review/projection

### Phase C: projection bridge

Project canonical entities into current truth and recall outputs.

### Phase D: review UI and APIs

Add minimal queue/list/detail/review actions.

### Phase E: `os-agent` consumption

Only after the entity substrate is stable should `os-agent` depend on it for same-view project/person reasoning.

---

## Risks

### False merge risk

Most serious failure.

Mitigation:

- narrow auto-merge
- ontology disjointness
- merge provenance
- reversible actions

### Candidate explosion

Mitigation:

- blocking
- source-local dedup
- top-N ranking
- confidence thresholding

### Projection inconsistency

Mitigation:

- shadow mode first
- projection versioning
- gradual read-path migration

### Overfitting to current architecture

Mitigation:

- treat current `mama-core` as migration substrate, not final shape
- introduce first-class entity modules instead of patching topic logic forever

---

## Recommended Implementation Boundary

The next branch should implement:

1. entity schema
2. observation schema
3. candidate generation and scoring
4. reviewable resolution workflow
5. projection bridge into current memory/truth

It should **not** attempt to finish:

- full same-view agent architecture
- full worker/auditor restructuring
- all downstream UI consumers

---

## Acceptance Criteria

This ontology architecture is considered successfully established when:

1. `mama-core` has first-class entity, alias, observation, candidate, link, and timeline models.
2. One real raw source can be backfilled through the full pipeline.
3. Korean, English, and Japanese alias candidates can be generated for the same target domain.
4. Auto-merge is limited to narrow structural cases.
5. Ambiguous cases land in a review queue with score and provenance evidence.
6. Current memory/truth APIs can consume entity-aware projection in at least one path.
7. Merge and split actions are attributable and reversible.

---

## Final Recommendation

MAMA should move to an **ontology-guided, provenance-backed, human-reviewed canonical entity substrate**.

Not because semantic-web vocabulary is fashionable, but because the product problem itself demands:

- durable identity
- multilingual alias handling
- safe ambiguity handling
- replayable evidence
- projection into multiple downstream agent surfaces

The correct architectural center is no longer:

- `topic`

It is:

- `canonical entity + observation provenance + reviewable resolution`

That is the substrate on which a usable `os-agent` can eventually stand.

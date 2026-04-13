<!-- /autoplan restore point: /Users/jeongjaehun/.gstack/projects/jungjaehoon-lifegamez-MAMA/codex-mama-entity-ontology-autoplan-restore-20260413-114956.md -->

# Entity Operations Viewer Design

## Status (2026-04-13)

**Reclassified as long-term roadmap.** This document describes an eventual
operator surface for the canonical entity substrate, but it is NOT the v1 plan.

After running `/autoplan` with CEO / Design / Eng / DX reviews (dual voices:
independent Claude subagent + Codex), the unanimous recommendation across
27 / 27 dimensions was REFRAME. See `## /autoplan Review (2026-04-13)` at the
bottom of this file for full findings, consensus tables, and decision audit
trail.

**Accepted direction:** ship a contextual **Provenance Drawer** first —
openable from Memory and Feed rows, showing raw → observation → candidate →
entity → decision with one correction action. Promote any piece of this
document to a top-level tab only after drawer-usage telemetry proves the need.

**What carries forward from this document into v1:** the first-class object
list (raw row, observation, candidate, entity, change event, affected
output), the 7 acceptance-criteria questions, and the cross-phase consensus
on wire-existing-first ordering. Everything else — 11-tab IA, continuous
orphan score, Integrity queue, structured rule DSL, three-pane workbenches —
is explicitly deferred.

**Blocker separated out:** Codex eng surfaced a shipped-code bug
(`entity-review-handler.ts:521` — approve is a no-op for actual canonical
entity merging; `:497` — merge action source/target entity IDs inserted as
null) that is being tracked as its own issue and will be fixed on a separate
branch. It is independent of the reframe above.

## Overview

MAMA now has the beginnings of a canonical entity substrate, but the current Viewer still exposes
mostly end-user and operator surfaces:

- Dashboard
- Feed
- Wiki
- Memory
- Logs
- Agents
- Settings

That is enough to inspect raw connector activity and final memory outputs, but it is not enough to
explain the full path between them.

The missing product surface is an operations-grade viewer that lets a user and an agent inspect:

1. where raw evidence came from
2. how it was transformed into entity observations
3. how candidates were generated and resolved
4. where human review changed the outcome
5. which downstream decisions became stale, orphaned, or in need of reprojection

This document defines that viewer architecture.

It does not replace the current tabs. It adds a new operational layer above the existing raw,
entity, and memory substrate.

## Problem Statement

The user wants to answer questions like:

- "Which Slack channel did this memory come from?"
- "How did this raw message become an entity observation?"
- "Why were these two channels or names linked together?"
- "Where did human judgment override the agent?"
- "Which prior decisions became stale after an entity was corrected?"

The current Viewer cannot answer those questions end-to-end because the information is split:

- Feed shows raw connector activity
- Memory shows decision outcomes
- Agents shows agent lifecycle
- Entity review and audit logic exists in code, but it is not yet exposed as a first-class runtime
  surface

The result is a trust gap:

- raw evidence is visible, but the transformation path is not
- entity state can exist, but its provenance is not inspectable as a flow
- human-in-the-loop corrections can happen, but their downstream impact is not clearly surfaced

## Design Goals

1. Preserve Feed as a raw browser for connector evidence.
2. Add a run-centric lineage surface that explains the full ingest pipeline.
3. Add a canonical entity surface that explains why an entity looks the way it does.
4. Add a review surface for human judgment and structured correction.
5. Add an integrity surface that detects orphan risk and queues repair work.
6. Keep raw evidence immutable and auditable.
7. Let users and agents inspect the same operational state.

## Non-Goals

- Replacing the current Feed tab with a processed activity dashboard
- Hiding raw evidence behind entity summaries
- Allowing unrestricted entity surgery in the first version
- Performing silent global rewrites of prior decisions after entity edits
- Merging all operational concerns into a single mega-tab

## Research Snapshot

Similar operational systems usually split the problem into distinct views instead of forcing one
screen to carry everything.

### 1. Lineage / transformation view

Data catalog and lineage systems expose upstream/downstream flow and transformation edges.

- OpenMetadata shows dataset and column lineage across sources and pipelines.
- DataHub shows lineage as a graph with schema- and transformation-aware detail.

These systems optimize for the question:
"Where did this thing come from, and how did it change?"

### 2. Golden record / canonical entity view

MDM systems expose a canonical record with source-backed provenance.

- Reltio shows the current profile alongside source records and crosswalks.
- Informatica MDM exposes merge review and golden-record perspectives.

These systems optimize for the question:
"Why does this canonical identity currently look like this?"

### 3. Human review / evaluation view

Human-in-the-loop systems provide review queues, annotation history, and auditability.

- Label Studio provides reviewer queues and decision trails.
- Arize Phoenix and Humanloop expose traces, annotations, and eval feedback.

These systems optimize for the question:
"Where should a human intervene, and what changed after they did?"

The recommended MAMA design follows the same pattern:

- raw evidence browser
- transformation lineage
- canonical entity detail
- human review workbench
- impact and repair queue

## Information Architecture

### Top-level Viewer structure

The recommended structure is:

- Dashboard
- Feed
- Lineage
- Entities
- Review
- Integrity
- Memory
- Wiki
- Logs
- Agents
- Settings

### Why this split

Each top-level area answers a different operator question:

- Feed: "What raw data was collected?"
- Lineage: "How was one ingest run processed?"
- Entities: "What is the current canonical entity state?"
- Review: "What needs human judgment or correction?"
- Integrity: "What downstream outputs were destabilized by structural changes?"
- Memory: "What final user-facing decisions or outputs exist?"

This is intentionally not a Feed-only expansion. Feed remains source-centric, while the other
surfaces are process-centric and outcome-centric.

## Feed

### Role

Feed is the raw browser.

It must remain focused on unprocessed connector evidence, not mixed with candidate review or memory
projection.

### Feed hierarchy

- connector
  - channel
    - raw rows
      - raw row detail

### Feed content

Each raw row should expose:

- source connector
- source channel
- author
- timestamp
- thread id when available
- text preview
- attachment metadata
- raw record id
- source-specific metadata

### Feed actions

Each raw row or channel should link outward:

- Open lineage run
- Open raw detail
- Open source entity matches when available

Feed should not host the full review experience. It should point to it.

## Lineage

### Role

Lineage is the run-centric operational console.

Its unit of inspection is an ingest run, not a connector or a final entity.

### Purpose

Given one ingest run, the user should be able to inspect:

- which raw rows were included
- which observations were extracted
- which candidates were generated
- which branch decisions were made
- where humans intervened
- which entities and outputs were affected

### Lineage layout

Recommended layout:

- left: run list and run filters
- center: pipeline stage timeline
- right: inspector pane

### Lineage stages

#### 1. Raw

Shows the raw rows included in the run.

#### 2. Observation Extraction

Shows extracted observations, dropped rows, and extraction failures.

Each observation includes:

- observation type
- surface form
- normalized form
- kind hint
- scope
- extractor version
- source raw record id

#### 3. Candidate Generation

Shows which observation pairs became candidates and why.

Each candidate includes:

- left and right refs
- total score
- structural score
- string score
- context score
- embedding score
- rule trace

This stage should also summarize blocked or discarded pairs so users can debug missing links.

#### 4. Resolution

Shows the machine branch outcome:

- auto-merge
- review-needed
- rejected

And the reason for that branch decision.

#### 5. Human Review

Shows any approve, reject, defer, label edit, alias edit, or note action attached to candidates or
entities originating from this run.

#### 6. Projection

Shows which canonical entities were updated and what downstream projections were touched.

#### 7. Memory Output

Shows downstream decisions or summaries created or marked stale by the run.

### Lineage actions

The Lineage screen is mostly read-oriented.

Primary actions:

- Open candidate review
- Open entity
- Open raw evidence
- Open affected memory output

Direct mutation should remain in Review or Entities.

## Review

### Role

Review is the human-in-the-loop workbench.

Its purpose is not only to approve or reject machine suggestions, but also to encode human-only
context that the system could not safely infer.

### Review layout

- left: pending queue
- center: candidate compare view
- right: action and correction panel

### Candidate compare view

For the selected candidate, show:

- left and right labels
- normalized forms
- observation types
- source connector and channel
- recent raw snippets
- related surface forms
- existing linked entities if any
- score breakdown
- rule trace

### Actions

The first version should allow:

- approve
- reject
- defer
- canonical label edit
- alias add/remove
- human note
- structured rule save

### Structured human knowledge

Human corrections must be stored as both:

- structured rule
- free-form note

The structured component is for reuse by future ranking, warnings, and review suggestions.
The note is for human context and auditability.

Examples of structured rules:

- equivalent_label
- canonical_label_preference
- do_not_merge_pair
- label_is_not_entity
- channel_name_is_team_not_project

### Review links

Every review item should provide:

- Open lineage context
- Open raw evidence
- Open entity

## Entities

### Role

Entities is the canonical-state explainer.

If Review answers "What should we do with this ambiguous candidate?",
Entities answers "Why does this canonical entity currently look this way?"

### Entity layout

- left: entity list and filters
- center: entity detail
- right: related actions and linked outputs

### Core sections

#### A. Provenance

Shows all source observations that support the entity.

Each row should link back to:

- source connector
- source channel
- raw record
- lineage run

#### B. Resolution History

Shows how the entity was formed:

- auto-merges
- human approvals
- rejections
- deferrals
- label changes
- alias changes

#### C. Linked Outputs

Shows downstream outputs depending on the entity:

- memory decisions
- wiki outputs
- dashboard summaries
- other future projections

#### D. Human Knowledge

Shows:

- human notes
- structured rules
- canonical naming preferences
- exceptions

#### E. Health

Shows:

- orphan risk
- stale linked decision count
- pending reprojection count
- last audit influence

### Entity actions

The first version should allow:

- edit canonical label
- add/remove alias
- add human note
- open lineage
- open linked review
- open linked outputs
- view impact

## Integrity

### Role

Integrity is the impact and repair queue.

It exists because entity changes can destabilize downstream outputs.

This screen should not merely list broken things. It should explain:

- what changed
- which outputs were affected
- how severe the effect is
- what repair actions are available

### Unit of work

The unit is a change event.

Examples:

- candidate approved
- candidate rejected
- entity merged
- entity split
- canonical label changed
- alias added or removed
- auto-merge completed

### Trigger policy

The agreed trigger set for Integrity includes all entity-structure changes:

- approve / reject / defer
- merge
- split
- auto-merge
- human label and alias corrections

### Layout

- left: change event list
- center: impact graph or impact list
- right: repair panel

### Impact model

Each affected output should carry:

- status
  - healthy
  - at_risk
  - orphaned
  - needs_reprojection
  - relinked
  - resolved
- orphan score
- explanation
- suggested action

### Orphan score

Orphan detection should be continuous, not binary.

Illustrative interpretation:

- 0.2: label-only drift
- 0.5: alias-shape drift
- 0.8: merge or split impact
- 1.0: reference target no longer semantically valid

This allows operators to prioritize the queue by impact severity.

### Repair actions

The first version should support:

- mark safe
- queue reprojection
- relink to entity
- supersede prior decision with reprojected output
- attach human explanation

Automatic overwrite of prior decisions is not recommended for v1.
Repair should be explicit, reviewable, and attributable.

## Memory

### Role

Memory remains the final user-facing output layer.

It shows what the system currently believes or has published as decisions and summaries.

### Memory and entity integration

Memory items should expose backward links to:

- source lineage run
- source entity
- source observations when appropriate
- integrity status

This allows the user to move from final output back to source provenance.

## End-to-End User Journey

The intended operator flow is:

1. Start at Feed to inspect raw evidence.
2. Open a Lineage run to inspect transformation stages.
3. Open Review when the machine produced ambiguous candidates.
4. Inspect Entities to understand the current canonical state.
5. Inspect Integrity to see which outputs became stale or orphaned.
6. Confirm final user-facing results in Memory.

This creates a complete operational chain:

raw evidence -> machine interpretation -> human judgment -> canonical structure -> downstream
impact -> final memory

## Data Model Requirements For The Viewer

The Viewer must treat the following as first-class inspectable objects:

- raw connector row
- ingest run
- entity observation
- resolution candidate
- review action
- canonical entity
- change event
- affected output
- downstream memory decision

Without these first-class objects, the UI cannot explain provenance or impact.

## V1 Scope Recommendation

To keep rollout practical, implement in this order:

1. Feed as a true raw browser
2. Lineage run detail
3. Review queue
4. Entity detail
5. Integrity queue

This order is intentional:

- users must trust raw evidence first
- then they must understand the transformation path
- only then can human review and repair become legible

## Operational Principles

1. Raw evidence is immutable.
2. Lineage is explanatory, not authoritative.
3. Review is the mutation workbench.
4. Entities are the canonical living record.
5. Integrity is the repair loop for downstream fallout.
6. Memory is the final projection, not the source of truth for identity.

## Acceptance Criteria

This design is satisfied when the Viewer can answer, for at least one real connector path:

1. Which raw row produced this observation?
2. Which observations produced this candidate?
3. Why did the system classify this pair as auto-merge or review-needed?
4. What did a human change during review?
5. Which entity was changed by that review?
6. Which downstream outputs became stale or orphaned?
7. Which decisions were reprojected or superseded?

## References

- [OpenMetadata lineage exploration](https://docs.open-metadata.org/how-to-guides/data-lineage/explore)
- [DataHub lineage documentation](https://docs.datahub.com/docs/generated/lineage/lineage-feature-guide)
- [Reltio sources perspective](https://docs.reltio.com/en/applications/hub/profiles-at-a-glance/profile-perspectives-tabs/profile-perspectives-navigation/sources-perspective)
- [Informatica merge review workflow](https://docs.informatica.com/content/dam/source/GUID-7/GUID-77412563-EB74-4CD9-BC03-570505C2C057/11/en/MDM_103_DataDirectorUserGuide_en.pdf)
- [Label Studio reviewer flow](https://docs.humansignal.com/guide/onboarding_reviewer)
- [Arize Phoenix annotations in the UI](https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/annotating-in-the-ui)
- [Humanloop prompt and trace comparison](https://humanloop.com/docs/guides/evals/comparing-prompts)

---

## /autoplan Review (2026-04-13)

This plan was run through `/autoplan` (CEO + Design + Eng + DX) with dual voices
(independent Claude subagent + Codex). Full findings below. The plan is kept as the
design record; follow-up work should apply the fixes rather than rewrite this file.

### Phase 1 — CEO (strategy & scope)

**Claude subagent — CEO** (independent, no prior context): **REFRAME.**
Plan is well-researched but directionally enterprise-cosplay for a single-user
local memory app. Key findings:

- **Premise gap [CRITICAL].** The plan asserts users need Review/Integrity/Lineage
  as peer top-level tabs, but cites no demand signal — no bug reports, no real
  orphan events, no usage data on candidate volume. If fewer than ~5 ambiguous
  candidates/week happen in real use, every new screen is a warehouse for empty
  tables.
- **Wrong problem framing [CRITICAL].** 10x reframe: build _one_ thing — a
  contextual "Provenance" drawer opened from Memory/Feed rows that shows raw →
  observation → candidate → entity → decision inline. Covers 6 of 7 acceptance
  criteria at 5% of the cost. Kill the 4 new top-level tabs until drawer
  telemetry proves they're needed.
- **6-month regret [HIGH].** 11 top-level tabs is already broken IA. Adding
  Lineage/Entities/Review/Integrity pushes nav into "I can't remember where
  anything is." Hard cap at 8 — new surfaces belong under a single
  Operations/Trust/Pipeline parent, or inline.
- **Alternatives dismissed without argument [CRITICAL].** Plan's "Non-Goals"
  explicitly forbids the simpler options ("merging all operational concerns
  into a single mega-tab") without defending the exclusion. Simpler ladder:
  (a) inline provenance drawer, (b) one "Pipeline" tab with sub-views,
  (c) defer Integrity entirely until a real orphan event is observed, (d)
  Review queue as a Dashboard widget, not a tab.
- **Enterprise cosplay [HIGH].** OpenMetadata/Reltio/Informatica/Label Studio
  exist because of 50+ sources, 100+ stewards, and compliance obligations.
  MAMA has 1 user, ~10 connectors, 0 compliance. Obsidian/Logseq/Raycast don't
  ship lineage tabs. Reframe around "personal memory debugger," not "data
  catalog."
- **V1 is a 4-month roadmap [CRITICAL].** Feed/Lineage/Review/Entities/Integrity
  as "V1" is not V1. Single-slice proof: ship the drawer first; gate tabs on
  drawer-usage telemetry.

**Codex — CEO:** **REFRAME.** "The provenance problem is real. The proposed IA
is wrong."

- **Premise:** plan assumes first-class data-model objects imply first-class
  navigation tabs. False. "Data model objects are not navigation objects."
- **Right problem:** not "make ingest inspectable via 4 tabs." 10x reframe is
  a contextual provenance/debug drawer on Memory rows, Feed rows, and Entity
  mentions. Start where trust breaks, not in a separate operator cockpit.
- **6-month regret:** "drifting into Informatica MDM for one person."
  Golden-record / integrity queue / impact graph / repair panel +
  11 top-level tabs = enterprise ceremony before proving single-user
  frequency. Likely fate: impressive screenshots, mostly unused in daily flows.
- **Right V1:** keep Feed, add provenance links, add one Memory/entity
  provenance drawer, add one Review queue only if real pending human decisions
  exist. Defer Integrity until real stale/orphan incidents appear in usage.
  "Integrity is not V1; it is a consequence of scale."
- **Competitive framing:** "MAMA is a personal memory debugger. The winning
  experience is not 'browse canonical entity operations'; it is 'I do not
  trust this memory, explain it and let me correct it in 30 seconds.'"
- **Verdict:** accidental enterprise cosplay. Build the trust loop first;
  everything else earns its tab later.

**CEO consensus table:**

```
CEO DUAL VOICES — CONSENSUS TABLE
════════════════════════════════════════════════════════════════════
  Dimension                             Claude   Codex    Consensus
  ──────────────────────────────────── ──────── ──────── ──────────
  1. Premises valid?                    NO       NO       CONFIRMED NO
  2. Right problem to solve?            NO       NO       CONFIRMED NO
  3. Scope calibration correct?         NO       NO       CONFIRMED NO
  4. Alternatives sufficiently explored? NO      NO       CONFIRMED NO
  5. 6-month trajectory sound?          NO       NO       CONFIRMED NO
  6. Competitive framing right?         NO       NO       CONFIRMED NO
════════════════════════════════════════════════════════════════════
Both voices: REFRAME. Same 10x reframe (provenance drawer on Memory rows).
```

### Phase 2 — Design (UI/UX)

**Claude subagent — Design:** **NEEDS_DESIGN_PASS.** Strong IA thinking, but
plan is a data-model document wearing a UI costume.

| #   | Dimension                        | Score | Finding                                                                                                                                                                                                |
| --- | -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Information hierarchy            | 3/10  | 11 top-level tabs past the ~7 ceiling; Memory (core product) drops from pos 4 → 7 behind 4 forensic tabs. Fix: group under a single Trust/Operations parent → 8 total.                                 |
| 2   | User journey clarity             | 4/10  | 6-step flow is forensic worst-case framed as routine. No happy path ("everything is healthy"), no celebratory empty states. Fix: default to Memory/Dashboard; Trust tab badges only when work pending. |
| 3   | Missing interaction states       | 2/10  | Near-total silence on loading/empty/error/no-perm/long-list/filter-empty/in-flight/optimistic/undo across all 4 new surfaces. Fix: states matrix table per surface × 10 states.                        |
| 4   | Responsive strategy              | 1/10  | Four three-pane workbenches on an app that ships a mobile bottom tab bar + "More" overflow — unshippable as spec'd. Fix: desktop 3-pane / tablet 2-pane / mobile single-pane stack navigation.         |
| 5   | Accessibility                    | 1/10  | Completely unaddressed. No keyboard nav, no focus rules, no ARIA for score breakdowns/rule traces/orphan scores, no touch targets. Fix: WCAG 2.2 AA as explicit acceptance criterion + keyboard spec.  |
| 6   | Consistency with existing viewer | 3/10  | Zero reference to existing modules — risks 4 reinventions of list+detail+inspector. Fix: audit `public/viewer/src/modules/`, enumerate reused components, build one `<Workbench>` shell.               |
| 7   | Specificity                      | 2/10  | "Three-pane layout" is the entire spec, four times. No component names, no state diagrams for rule-trace/impact-graph/score-breakdown. Fix: wireframes + state diagrams for riskiest views.            |

**Codex — Design:** **REFRAME.** Scores 2/10–5/10 across all 7 dimensions.
Independently reaches the same consolidation recommendation as Claude.

| #   | Dimension             | Codex Score | Key finding                                                                                                                                                                                                                                                                           |
| --- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Information hierarchy | 4/10        | 11-tab product demotes `Memory` from primary. Fix: one top-level `Operations` area with subviews Lineage/Entities/Review/Integrity. Keep Memory primary.                                                                                                                              |
| 2   | User journey          | 5/10        | 6-step flow is good forensic anatomy, too heavy as routine. Fix: define 3 primary task flows — "resolve candidate", "explain this memory", "repair stale output" — each with direct deep links.                                                                                       |
| 3   | Missing states        | 2/10        | Happy-path only. Fix: state matrix per surface covering pagination/virtualization, retry, permission copy, disabled actions, optimistic mutation rollback, undo toast rules.                                                                                                          |
| 4   | Responsive            | 3/10        | Three-pane doesn't translate to existing mobile bottom-tab shell + overflow. Fix: route-depth nav on mobile (list → detail → inspector as bottom sheet), persistent back/breadcrumb above bottom tab bar.                                                                             |
| 5   | Accessibility         | 3/10        | Fix: define keyboard/ARIA contract — `aria-current` nav, focus restore on pane changes, Escape closes overflow/inspectors, score breakdown as `<dl>` or table, rule trace as ordered steps/tree, orphan score with text threshold + non-color-only severity.                          |
| 6   | Consistency           | 4/10        | Reads like new workbenches rather than extensions. `overflowTabs` in `viewer.html:2044` is already hardcoded. Fix: shared nav registry + reusable workbench pattern based on existing tab shell, mobile tab classes, loading overlays, filter bars, and Memory split-pane behavior.   |
| 7   | Specificity           | 4/10        | Not "left/center/right" alone, but still not implementation-grade. Fix: per-surface screen contracts — entry points, row anatomy, empty/error/loading states, primary/secondary actions, exact fields, responsive variant, permission behavior, undo behavior, API/data dependencies. |

**Design consensus table:**

```
DESIGN DUAL VOICES — CONSENSUS TABLE
════════════════════════════════════════════════════════════════════
  Dimension                     Claude   Codex    Consensus
  ──────────────────────────── ──────── ──────── ──────────
  1. Information hierarchy      3/10     4/10     CONFIRMED FAIL
  2. User journey clarity       4/10     5/10     CONFIRMED FAIL
  3. Missing states             2/10     2/10     CONFIRMED FAIL
  4. Responsive                 1/10     3/10     CONFIRMED FAIL
  5. Accessibility              1/10     3/10     CONFIRMED FAIL
  6. Consistency w/ existing    3/10     4/10     CONFIRMED FAIL
  7. Specificity                2/10     4/10     CONFIRMED FAIL
════════════════════════════════════════════════════════════════════
Both voices: NEEDS_DESIGN_PASS/REFRAME. Independent agreement on
Operations parent + states matrix + responsive collapse rules.
```

### Phase 3 — Eng (architecture, tests, perf, security)

**Claude subagent — Eng:** **NEEDS_ARCHITECTURE_PASS.** Plan conflates wiring
work (~2 weeks) with greenfield substrate work (~6–8 weeks) under a single V1.

**Scope reality (the big miss):**

| Surface   | Status                                                                                                | Real work                                                     |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Feed      | Exists (`connector-feed.ts` 391 LOC)                                                                  | Minor: add outlinks. ~1 day.                                  |
| Review    | Backend ✅, frontend module ✅, **not wired into `viewer.html`**                                      | Wire tab + DOM. ~2–3 days.                                    |
| Entities  | Partial backend; **no `/api/entities/:id/detail`** route                                              | New route + module. Real work.                                |
| Integrity | **Nothing exists.** No `change_event`, no `affected_output`, no orphan scoring, no `/api/integrity/*` | Greenfield schema + engine + API + UI.                        |
| Lineage   | **Nothing exists.** No `run_id` flows through connector → observation → candidate today.              | Greenfield cross-package instrumentation + schema + API + UI. |

**Effort is roughly Feed 5% / Review 10% / Entities 25% / Integrity 30% /
Lineage 30%** — not equal-weight sections. Plan's V1 order
(Feed → Lineage → Review → Entity → Integrity) front-loads the hardest new
substrate before wiring the work that already exists, which inverts CLAUDE.md's
reuse-first rule.

**Data model gaps [CRITICAL]:**

| Object                     | DB today?                                      | Migration needed                                                                                           |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| raw connector row          | Yes — per-connector `raw.db` (separate sqlite) | Cross-DB join is non-trivial                                                                               |
| ingest run                 | **No**                                         | New `ingest_runs(id, connector, started_at, finished_at, status, stats_json)` + thread `run_id` everywhere |
| entity observation         | Yes (`entity_observations`)                    | Add `ingest_run_id` column                                                                                 |
| resolution candidate       | Yes (`entity_resolution_candidates`)           | Add `ingest_run_id` column                                                                                 |
| review action              | Yes (`entity_merge_actions`)                   | Add `ingest_run_id`, optional `structured_rule_json` (new)                                                 |
| canonical entity           | Yes (`entity_nodes`)                           | None                                                                                                       |
| change event               | **No**                                         | New `entity_change_events(id, kind, entity_id, actor_id, created_at, payload_json)`                        |
| affected output            | **No**                                         | New `entity_affected_outputs(change_event_id, output_kind, output_id, status, orphan_score, explanation)`  |
| downstream memory decision | Yes (`decisions`)                              | Back-link column or join table                                                                             |
| structured rule store      | **No**                                         | Entire new subsystem (ranking-layer input, not a note)                                                     |

**Ingest-run concept does not exist [CRITICAL].**
`polling-scheduler.ts` only persists `lastPollTime` to `poll-state.json`. There
is **no `run_id` flowing through** connector → raw.db → observation extraction
→ candidate generation → projection. Lineage cannot be "run-centric" without
cross-package plumbing sized in weeks — work the plan does not mention.

**Orphan score is a research spike [HIGH].** Plan's 0.2/0.5/0.8/1.0 interpretation
lists values without defining: inputs, function family, recompute trigger, cost
model, or embedding-distance proposal (despite MAMA already having 1024-d e5-large
embeddings on :3847). Fix: replace v1 with categorical enum
(healthy/at_risk/orphaned/needs_reprojection) derived from change-event kind;
defer continuous score to v2.

**Performance [HIGH].**

- `entity-review-handler.ts:289` — `handleListEntityCandidates` calls
  `summarizeCandidate` → `resolveRef` per row, classic N+1 (2 prepared-stmt
  calls × N rows). ~400 queries per list call at MAX_LIMIT=200. Fix with a
  single JOIN before Lineage joins evidence too.
- Lineage three-pane with 10k raw rows will OOM the viewer without pagination.
  Plan mandates "raw evidence is immutable" but defines no pagination contract
  for stages. Reuse the existing cursor model `(score_total, id)` from Review.
- Entity "Provenance" section needs pagination over observations — plan silent.
- Integrity impact graph must be pre-materialized, not computed on request.

**Security [HIGH].**

- `graph-api.ts` calls `isAuthenticated()` **per-route**, not via a prefix gate
  (see line 1226). Every new `/api/lineage/*` and `/api/integrity/*` route must
  explicitly gate — easy to forget on 10+ routes. Fix: add a prefix gate.
- Integrity mutation endpoints (`repair`, `supersede prior decision`) are the
  **highest-risk surface in MAMA** — they rewrite historical decisions.
  Plan is contradictory: §Integrity/Repair says "automatic overwrite not
  recommended for v1" but lists "supersede prior decision" in the same breath.
  Needs explicit approval chain + actor attribution (mirror
  `canonicalizeActorId` at entity-review-handler.ts:101) + append-only audit.
- Input validation: follow existing `readBody` 1 MB cap + `entity.candidate_stale`
  409 envelope pattern.
- No rate limiting on repair endpoints — entity-surgery loops are a
  denial-of-integrity vector.

**Test coverage gap:**

| New surface         | API tests           | Module tests                                                     |
| ------------------- | ------------------- | ---------------------------------------------------------------- |
| Feed links          | 0                   | 1                                                                |
| Review wiring       | 0 (handler covered) | 3 — list render, detail render, action dispatch (none exist yet) |
| Entity detail       | 4                   | 2                                                                |
| Lineage             | 6                   | 3                                                                |
| Integrity           | 6                   | 4                                                                |
| ingest_run plumbing | 3                   | —                                                                |

`public/viewer/tests/modules/` does not exist yet — `entity-review.ts` and
`entity-audit.ts` ship without tests, which is itself debt to call out.

**Correct incremental shipping order (reuse-first):**

1. Wire Review tab (no schema change) — 1 PR
2. Add Entity detail route + tab (no schema change) — 1 PR
3. Introduce `ingest_runs` table + instrumentation behind feature flag — 2 PRs
4. Ship Lineage read-only on top — 1 PR
5. Introduce `entity_change_events` + write-side instrumentation — 1 PR
6. Ship Integrity read-only — 1 PR
7. Ship repair mutations last, behind tier-3 auth — 1 PR

**Codex — Eng:** **NEEDS_ARCHITECTURE_PASS.** All of Claude's findings confirmed
with even more concrete file:line references. Two findings Claude missed:

- **🚨 Approve is a no-op for actual entity merging.** At
  `entity-review-handler.ts:521`, the `approve` action only inserts an
  `entity_merge_actions` row and updates candidate status — it does not
  actually merge canonical entities. Review decisions don't mutate the
  canonical graph. This is a **shipped-code bug**, not a plan concern.
  Independent fix required before Review becomes a mutation workbench.
- **Partial audit trail.** At `entity-review-handler.ts:497`,
  `source_entity_id`/`target_entity_id` are inserted as `null` on merge
  actions — so any future impact reconstruction based on merge actions will
  be blind to which entities were involved. Must be fixed before Integrity
  can depend on merge action rows.

- **Ingest-run plumbing absent.** `PollingScheduler.pollAll` at
  `polling-scheduler.ts:58` calls `onBatchExtract(classified)` without
  creating a run envelope. `raw-store.ts:24` has no run column. Observation
  drafts at `history-extractor.ts:42` and candidate types at
  `entities/types.ts:85` also lack run IDs. Lineage instrumentation must
  thread a `run_id` through connector → raw → observation → candidate.
- **Scope map** (with specific migrations):
  - Feed routes exist (`raw-store.ts:24`, `connector-feed-handler.ts:91`) but
    feed responses omit raw `source_id`/raw DB ref → "open lineage/raw detail"
    is not supported today.
  - Lineage is greenfield. Only candidates and entity audit routes exist at
    `graph-api.ts:2186`.
  - Review is partial wiring. Backend exists at `graph-api.ts:2186` +
    `entity-review-handler.ts:289`. Viewer module exists but **not imported**
    in `viewer.html:1927`.
  - Entities is mostly greenfield UI/API over existing tables
    (`026-create-canonical-entity-tables.sql`, `store.ts:126`). No
    `/api/entities/:id/detail` route exists.
  - Integrity is greenfield. Existing "audit" at
    `028-create-entity-audit-tables.sql` is benchmark-style, not a repair queue.
- **Data model:** plan's 5 new tables (`ingest_runs`,
  `entity_change_events`, `entity_affected_outputs`, `orphan_scores`,
  `structured_rules`) do not exist. Adjacent tables exist in
  `026-*.sql`, `027-create-entity-review-support.sql`, and `028-*.sql`.
  Options: new migrations for all 5, OR explicitly reuse
  `entity_timeline_events` plus new affected-output tables.
- **Orphan score confirmed research spike.** `audit-metrics.ts:42` only has
  aggregate `projection_fragmentation_rate`, no per-output dependency edge
  or semantic validity model. v1 can ship categorical enum +
  event-type severity; not a defensible continuous score.
- **Performance N+1 confirmed.** `summarizeCandidate` at
  `entity-review-handler.ts:339` with per-side `alias/observation/node`
  lookups → hundreds of queries at limit=200. Batch joins/CTEs required.
- **Security:** routes are double-gated (`graph-api.ts:1224` global +
  `2188` per-route) but there is **no role/capability split** — one bearer
  token can approve/reject/defer everything. No mutation rate limit.
- **V1 order:** "Do wire-existing-first. Current plan puts Lineage before
  its data model exists. Better: enrich Feed raw IDs → wire Review UI →
  expose minimal Entity detail → instrument ingest runs → build Lineage →
  Integrity/repair."

**Eng consensus table:**

```
ENG DUAL VOICES — CONSENSUS TABLE
════════════════════════════════════════════════════════════════════════
  Dimension                        Claude   Codex    Consensus
  ──────────────────────────────── ──────── ──────── ──────────────────
  1. Architecture sound?            NO       NO       CONFIRMED NO
  2. Test coverage sufficient?      NO       NO       CONFIRMED NO
  3. Performance risks addressed?   NO       NO       CONFIRMED NO (N+1)
  4. Security threats covered?      NO       NO       CONFIRMED NO
  5. Error paths handled?           NO       NO       CONFIRMED NO
  6. Deployment risk manageable?    NO       NO       CONFIRMED NO
════════════════════════════════════════════════════════════════════════
Both voices independently recommend wire-existing-first V1 order.

Codex-only critical findings (not in Claude subagent):
  - Approve is a no-op for canonical entity merge (entity-review-handler.ts:521)
  - source_entity_id/target_entity_id inserted null (entity-review-handler.ts:497)
```

### Phase 3.5 — DX (developer experience + agent API)

**Claude subagent — DX:** **NEEDS_DX_PASS.** Plan is half a product — describes
screens but skips the agent API surface (Goal 7 unfulfilled), skips migration
entirely (breaks existing users), and ships zero copy-pasteable examples.

| #   | Dimension           | Score | Finding                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TT-provenance       | 4/10  | Plan flows _forward_ (Feed → Memory), not _backward_ (Memory → Raw, the actual debug case). Fix: add "Memory → Raw in ≤3 clicks" acceptance criterion + mandatory outlink on every row.                                                                                                                                                                                                                  |
| 2   | Agent API surface   | 2/10  | Design Goal 7 asserts "users AND agents", but zero endpoints listed. Missing: `GET /api/ingest/runs[/:id]`, `GET /api/entities/:id[/provenance]`, `GET /api/integrity/events[/:id/affected]`, `POST /api/review/actions`, `GET /api/memory/:id/lineage`. No MCP tools either (`lineage_trace`, `entity_provenance`). Fix: add "Agent API Surface" section enumerating endpoints + MCP tools with shapes. |
| 3   | Naming consistency  | 5/10  | Terminology drift: `change event` collides with existing `memory_events` table; `supersede` collides with existing `supersedes` graph edge; `resolution candidate` collides with standalone `extractSaveCandidates`; `ingest run` / `lineage run` used interchangeably. Fix: glossary mapping new terms → existing tables; rename `change event` → `entity_change_event`.                                |
| 4   | Error messages      | 1/10  | Plan mentions "extraction failures / dropped rows / blocked pairs / orphan risk" but never specifies copy. No cause+fix+doc_link convention. Fix: Error Message Contract section with 3 worked examples.                                                                                                                                                                                                 |
| 5   | Docs                | 3/10  | No docs task in V1 scope. IA goes 7 → 11 tabs with zero discoverability story. No rule-trace tooltip requirement. Fix: `docs/viewer/operational-flow.md` deliverable + first-run empty states + rule-trace tooltip on every auto-merge badge.                                                                                                                                                            |
| 6   | Upgrade path        | 0/10  | Unmentioned. Pre-existing decisions in users' `mama-memory.db` have no `ingest_run_id`, no observations, no candidates — Lineage opens blank on them. Violates CLAUDE.md rule "existing decisions must remain valid." Fix: synthesize `legacy` run per pre-upgrade decision + "Pre-substrate decision — no lineage" empty state + migration script.                                                      |
| 7   | Copy-paste examples | 1/10  | Zero examples. Agent reading this plan cannot produce a single API call. Fix: for each of the 7 acceptance-criteria questions, include a curl + MCP tool + SQL example. Doubles as agent docs.                                                                                                                                                                                                           |
| 8   | TTHW                | 3/10  | Current plan TTHW for "which Slack message became this memory item" ≈ 2–5 min of tab hopping across 11 tabs — _worse_ than today. Fix: one-click "Trace" affordance (button + `cmd-k`) on every Memory row; target ≤15s from Viewer open to raw message visible.                                                                                                                                         |

**Codex — DX:** **NEEDS_DX_PASS.** Scores 0/10–6/10 across 8 dimensions.
Concrete MCP tool suggestions and error envelope contract.

| #   | Dimension           | Codex Score | Key finding                                                                                                                                                                                                                                                        |
| --- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | TT-provenance       | 6/10        | Right objects, click path not locked. Fix: `Memory item → observation/lineage stage → raw_items row` in ≤3 clicks with stable IDs (`memory_id`, `observation_id`, `source_raw_db_ref`, `source_raw_record_id`).                                                    |
| 2   | API/MCP surface     | 1/10        | Almost entirely UI IA. Fix: "Agent Contract" section listing REST + MCP: `memory.provenance.get`, `lineage.run.get`, `raw.row.get`, `entities.candidate.get`, `integrity.events.list` + curl and MCP inputs/outputs.                                               |
| 3   | Naming consistency  | 4/10        | `supersede` collides with existing decision/memory evolution vocabulary. Fix: reserve `supersedes` for decision/memory graph edges; call entity-impact items `entity_change_events` or `projection_repair_events`; glossary mapping product terms → storage terms. |
| 4   | Error messages      | 2/10        | Existing `candidate_stale` has `hint`/`doc_url` but not a shared contract. Fix: required envelope `{code, cause, fix, doc_link, context}` for `extraction_failed`, `candidate_pair_blocked`, `review_conflict`, `candidate_stale`, `reprojection_failed`.          |
| 5   | Docs                | 2/10        | References are research links, not deliverables. Fix: `docs/reference/entity-operations-api.md`, `docs/guides/viewer-lineage.md`, `docs/operations/entity-substrate-runbook.md` as V1 deliverables.                                                                |
| 6   | Upgrade path        | 2/10        | Fix: migration/backfill policy — mark legacy items `provenance_status=legacy_lineage_missing`, backfill only when evidence refs exist, show "lineage unavailable: created before entity substrate" empty state instead of fake links.                              |
| 7   | Copy-paste examples | 0/10        | 7 acceptance criteria are questions only. Fix: for each AC, add one curl + one MCP call + one SQLite query that proves the answer.                                                                                                                                 |
| 8   | TTHW                | 3/10        | No ≤15s benchmark or indexes. Fix: define timed task — from a Memory item, find "which Slack message became this memory item" in ≤15s using one-click raw evidence link + API fallback.                                                                            |

**DX consensus table:**

```
DX DUAL VOICES — CONSENSUS TABLE
════════════════════════════════════════════════════════════════════
  Dimension                     Claude   Codex    Consensus
  ──────────────────────────── ──────── ──────── ──────────
  1. TT-provenance              4/10     6/10     CONFIRMED FAIL
  2. Agent API surface          2/10     1/10     CONFIRMED FAIL
  3. Naming consistency         5/10     4/10     CONFIRMED FAIL
  4. Error messages             1/10     2/10     CONFIRMED FAIL
  5. Docs                       3/10     2/10     CONFIRMED FAIL
  6. Upgrade path               0/10     2/10     CONFIRMED FAIL
  7. Copy-paste examples        1/10     0/10     CONFIRMED FAIL
  8. TTHW                       3/10     3/10     CONFIRMED FAIL
════════════════════════════════════════════════════════════════════
Both voices: NEEDS_DX_PASS. Strong agreement on missing Agent Contract,
missing legacy migration, missing copy-paste examples.
```

### Cross-phase themes (high-confidence signals)

These concerns were flagged independently by 2+ phases' primary voices:

1. **Reuse-first violation.** Eng says plan inverts CLAUDE.md's reuse-first rule
   by front-loading greenfield substrate before wiring existing modules. CEO
   says plan ignores simpler ladder (drawer → sub-nav → tabs). Design says plan
   never references existing Viewer modules — risks 4 reinventions.
2. **IA inflation.** CEO flags 11 top-level tabs as 6-month regret. Design rates
   information hierarchy 3/10 for the same reason. DX rates TTHW 3/10 citing
   that 11 tabs make cognitive load worse than today.
3. **Missing demand signal.** CEO says premises are asserted without evidence
   (no bug reports, no orphan events). DX says no acceptance criterion for the
   actual user question ("which Slack message became this memory item").
4. **Plan is half a product.** Design says "data-model document wearing a UI
   costume." DX says "describes screens but skips API surface" (Goal 7).
   Both flag the absence of concrete specifications (wireframes, error copy,
   curl examples).
5. **Contradictions around repair.** Eng flags that §Integrity simultaneously
   forbids and allows "supersede prior decision." Design flags missing undo +
   permission model for destructive actions. Both want an explicit approval
   chain.

### Failure Modes Registry (consolidated)

| Mode                                | Phase        | Severity | Owner        |
| ----------------------------------- | ------------ | -------- | ------------ |
| Empty Integrity queue forever       | CEO          | CRITICAL | Product      |
| 11-tab IA regret                    | CEO + Design | HIGH     | Design       |
| Review tab already built, not wired | Eng          | MEDIUM   | Eng          |
| `ingest_run` does not exist         | Eng          | CRITICAL | Eng          |
| Orphan score hand-wavy              | Eng          | HIGH     | Eng          |
| N+1 in existing handler             | Eng          | HIGH     | Eng          |
| Pre-upgrade decisions orphaned      | DX           | HIGH     | Eng + DX     |
| No agent API enumerated             | DX           | HIGH     | Eng + DX     |
| Destructive action undo/perms       | Design       | HIGH     | Design + Eng |
| Enterprise-cosplay reframe risk     | CEO          | CRITICAL | Product      |

### Decision Audit Trail (/autoplan)

| #   | Phase  | Decision                                                                  | Classification | Principle | Rationale                                                                |
| --- | ------ | ------------------------------------------------------------------------- | -------------- | --------- | ------------------------------------------------------------------------ |
| 1   | Intake | Treat the plan as a review target, not a rewrite target                   | Mechanical     | P6        | User asked for a review, not a rewrite.                                  |
| 2   | CEO    | Accept that the substrate exists (PR #78) — do not challenge the merge    | Mechanical     | P6        | Already merged; irreversible at this stage.                              |
| 3   | CEO    | Do not auto-approve 11-tab IA; flag for user                              | Taste          | P5        | Both Claude and user's own checkpoint note the gap — surface at gate.    |
| 4   | CEO    | Recommend "drawer-first" 10x reframe as primary finding                   | Taste          | P1        | Single slice that proves the concept; covers 6 of 7 acceptance criteria. |
| 5   | CEO    | Flag enterprise-cosplay framing but do not kill the plan                  | Taste          | P6        | The substrate is real and useful; the UI framing is the debatable part.  |
| 6   | Design | Demand responsive + a11y as v1 acceptance criteria                        | Mechanical     | P1        | Unshippable without; no reasonable disagreement.                         |
| 7   | Design | Demand states matrix per surface                                          | Mechanical     | P1        | Completeness — every surface must specify loading/empty/error/etc.       |
| 8   | Design | Recommend `<Workbench>` shell component (not 4 bespoke layouts)           | Mechanical     | P4        | DRY — four reinventions of list+detail+inspector is rejectable by rule.  |
| 9   | Eng    | Split plan into Phase A (wire existing) + Phase B (new substrate)         | Taste          | P5        | Explicit over clever; flags for user since this restructures the plan.   |
| 10  | Eng    | Replace continuous orphan score with categorical enum in v1               | Taste          | P5        | Explicit over clever; defer research spike.                              |
| 11  | Eng    | Require `ingest_run` instrumentation as a separate PR before Lineage work | Mechanical     | P2        | Blast radius demands it — Lineage has no meaning without it.             |
| 12  | Eng    | Fix N+1 in `entity-review-handler.ts:289` before adding Lineage joins     | Mechanical     | P2        | Boil the lake — lineage will amplify the issue.                          |
| 13  | Eng    | Require prefix auth gate for `/api/lineage/*` and `/api/integrity/*`      | Mechanical     | P1        | Security — completeness over per-route gating.                           |
| 14  | Eng    | Require append-only audit trail + tier-3 auth for repair mutations        | Mechanical     | P1        | Highest-risk surface in MAMA.                                            |
| 15  | DX     | Demand migration strategy for pre-substrate decisions                     | Mechanical     | P1        | CLAUDE.md "existing decisions must remain valid" — non-negotiable.       |
| 16  | DX     | Demand Agent API surface section in the plan                              | Mechanical     | P1        | Design Goal 7 unfulfilled otherwise.                                     |
| 17  | DX     | Demand ≤3-click Memory → Raw acceptance criterion                         | Mechanical     | P1        | This IS the user's question per the plan itself.                         |
| 18  | DX     | Demand `cmd-k` "Trace" affordance                                         | Taste          | P5        | Reasonable people could disagree on the surface; flag at gate.           |

**Voice sources:** Claude subagent + Codex (`codex+subagent`) complete for all
four phases. Consensus is overwhelming — every phase, every dimension, both
voices. This is not a close call.

### Bonus finding — shipped-code bug (not a plan concern)

Codex eng surfaced an urgent finding in already-merged code that is NOT part
of this plan but blocks any work that depends on Review actually mutating
entities:

> `entity-review-handler.ts:521` — `approve` only inserts an
> `entity_merge_actions` row and updates candidate status. It does **not**
> actually merge canonical entities. Downstream code that assumes "approve
> means merged" is silently wrong.
>
> `entity-review-handler.ts:497` — `source_entity_id`/`target_entity_id` are
> inserted as `null` on merge actions, so impact reconstruction based on
> merge action history is blind to entity provenance.

This should be tracked as its own bug, separate from the viewer design plan.
Recommendation: open a dedicated issue "entity review approve does not merge"
and fix before any Integrity work depends on merge-action rows.

### Final /autoplan verdict

**REFRAME (both CEO voices) + NEEDS_ARCHITECTURE_PASS (both Eng voices) +
NEEDS_DESIGN_PASS/REFRAME (both Design voices) + NEEDS_DX_PASS (both DX
voices).**

The unanimous recommendation across all 8 independent reviews is:

1. **Kill the 4 new top-level tabs** in V1. Do not add Lineage/Entities/
   Review/Integrity as peer tabs to Dashboard/Feed/Memory.
2. **Ship a "Provenance drawer" first** — a contextual panel openable from
   Memory rows, Feed rows, and Entity mentions that shows raw → observation
   → candidate → entity → decision with one correction action.
3. **If a dedicated surface is later needed**, collapse it into a single
   `Operations` parent tab with subviews, not 4 peer tabs.
4. **Wire-existing-first ordering**: Review tab (wire existing module) →
   Entity detail route → `ingest_runs` instrumentation → Lineage → Integrity
   (read-only) → repair mutations (last, tier-3 auth).
5. **Defer Integrity continuous score** to v2; ship categorical enum first.
6. **Mandatory deliverables before any v1 code ships:** states matrix,
   responsive collapse rules, A11y contract, Agent Contract (REST + MCP),
   legacy-decision migration policy, error envelope, copy-paste examples.
7. **Fix the shipped Review approve no-op bug** as a blocker before any
   work depends on merge-action rows.

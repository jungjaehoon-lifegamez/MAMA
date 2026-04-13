# Entity Operations Viewer Design

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

# OS Agent And Canonical Entity Memory Roadmap Design

## Overview

MAMA should stop treating the current `feat/v019-agent-management` branch as the place to solve every architectural problem at once.

That branch already contains useful foundations for:

- agent visibility and management surfaces
- validation session infrastructure
- system-agent wiring
- viewer page-context primitives

But it does **not** yet reflect the architecture we now want:

- `os-agent` as the single user-facing main agent
- `auditor` as a verification and analysis role, not the hot-path orchestrator
- functional specialist workers instead of entity-specific worker silos
- canonical entity memory as the substrate under every agent workflow

This roadmap freezes the current branch to a mergeable foundation, then moves the real architectural shift into a fresh branch built on updated `main`.

## Problem Statement

Two different system models are currently mixed together:

1. A legacy MAMA OS role model:
   - `viewer -> os_agent`
   - messenger sources -> `chat_bot`
   - one main `AgentLoop`

2. A newer managed-agent model:
   - `conductor` as an orchestration center
   - system agents exposed in the viewer
   - validation and activity around delegation

The result is structurally unstable:

- the user does not clearly talk to one stable main agent
- `conductor` exists, but it is not the right public frontdoor
- viewer context exists, but it is weaker than the SmartStore-style same-view pattern
- memory is still mostly topic-centric when the real product problem is canonical entity resolution

The most important gap is not the agent loop by itself. The deeper gap is that MAMA still lacks a first-class canonical entity layer for:

- multilingual project aliases
- person identity aliases
- project/person relationships across sources
- entity-owned timelines
- reversible merge and review flows

Without that substrate, a stronger main agent just becomes a more articulate agent that is still grounded on the wrong unit of memory.

## Strategic Decision

MAMA should adopt this target operating model:

### 1. `os-agent` becomes the single frontdoor

The user always talks to `os-agent`, regardless of viewer, webchat, or messenger source.

`os-agent` is:

- user-facing
- page-aware
- same-view
- allowed to directly navigate, read, and operate the UI
- allowed to directly delegate to workers when specialized execution is needed

### 2. `auditor` replaces `conductor`

`conductor` is renamed conceptually and eventually in code to `auditor`.

`auditor` is:

- not the default execution router
- not the mandatory middle hop for every request
- responsible for audit, comparison, regression analysis, recommendation, and explanation

It is invoked:

- manually by the user or `os-agent`
- periodically by code-driven background audit loops

### 3. Workers are functional specialists

Workers are organized by function, not by entity type.

Recommended long-term worker set:

- `resolver`
- `linker`
- `historian`
- `memory-writer`
- domain executors like `wiki-agent`, `dashboard-agent`, `memory`, `developer`, `reviewer`

### 4. Canonical entity memory comes before richer orchestration

The next major architecture branch should prioritize:

- raw data capture
- observation extraction
- canonical entity resolution
- relationship linking
- entity timeline projection
- memory projection into current MAMA recall/truth systems

The order matters:

1. canonical entity substrate
2. same-view `os-agent` vertical slice
3. worker specialization
4. auditor-driven review and TODO loops

## Why The Current Branch Should Be Closed First

The current branch already changes dozens of files and mixes:

- agent-management UI
- validation sessions
- system-agent wiring
- conductor-oriented behavior

If canonical entity memory is added on top of this branch, the branch stops being reviewable. The diff becomes both:

- too wide
- architecturally inconsistent

The correct move is:

1. narrow the branch scope
2. merge the useful foundations
3. cut a fresh branch for canonical entity memory

This preserves existing work while giving the next stage a clean narrative.

## Architectural Principles

### Foundation First

Do not force canonical entity memory into the current branch.

### Canonical IDs Over Topics

`topic` remains useful for memory search and decision evolution, but it must stop being the primary identity key for projects and people.

### Same-View Before Fancy Autonomy

The main agent must be able to see, navigate, and manipulate the same UI state the user sees before it is expanded into deeper orchestration.

### Reviewable Merges

Low-confidence identity merges must not silently rewrite truth. They must be:

- reviewable
- reversible
- attributable

### Projection, Not Rewrite

Existing MAMA memory assets should be preserved and reused as projections:

- decisions
- truth snapshots
- graph expansion
- recall bundles

The new entity layer should sit beneath them, not replace them wholesale.

## Target Architecture

```text
User
  -> os-agent
      -> direct UI read / navigate / operate
      -> direct worker delegation
      -> auditor invocation when deep verification is needed

Data Sources
  -> raw records
  -> observations
  -> canonical entity resolution
  -> relationship graph
  -> entity timelines
  -> projection into MAMA memory + truth + recall

Background Code
  -> periodic validation / audit
  -> alerts
  -> agent-owned TODO creation

Auditor
  -> compare
  -> explain
  -> detect regressions
  -> recommend next action
```

## Roadmap

### Phase 0: Freeze And Merge The Current Branch

Purpose:

- keep the current branch mergeable
- preserve validation and agent-management groundwork
- avoid scope creep into entity-layer work

Keep in scope:

- agent-management foundations
- validation session foundations
- viewer page-context plumbing
- system-agent visibility groundwork
- agent cleanup that reduces user-facing confusion in the current viewer and config
- one minimal `os-agent` page-context/navigation proof in the current viewer
- docs that redefine the next architecture

Explicitly out of scope:

- canonical entity layer
- multilingual alias resolution
- project/person merge engine
- entity timelines
- large-scale worker refactor
- full `conductor -> auditor` code rename across the whole tree

Branch outcome:

- merged as a foundation PR, not as the final architecture

### Phase 1: Build Canonical Entity Memory In A Fresh Branch

Purpose:

- make MAMA memory understand real-world entities instead of only topic strings

Core deliverables:

- `entity_nodes`
- `entity_aliases`
- `entity_links`
- `entity_resolution_candidates`
- `entity_timeline_events`
- review queue for low-confidence merges

This phase should adapt current connector ingest and history extraction into:

```text
raw -> observation -> resolution -> projection
```

### Phase 2: Rebuild `os-agent` As A Same-View Main Agent

Purpose:

- make `os-agent` the real frontdoor

Core deliverables:

- `os-agent` exposed as a first-class system agent in the Agents tab
- route + selected item + page data + available action context
- stronger navigation contract
- one end-to-end page-aware vertical slice proven in the viewer

### Phase 3: Functional Specialist Worker Pipeline

Purpose:

- make complex workflows composable without stuffing everything into one agent

Core deliverables:

- `resolver`
- `linker`
- `historian`
- `memory-writer`
- worker invocation contract from `os-agent`

### Phase 4: Auditor And Agent-Owned TODO Loops

Purpose:

- add review, drift detection, and guided maintenance

Core deliverables:

- `auditor` role formalized
- periodic code-driven audits
- agent-owned TODO creation
- manual deep audit entrypoints

## Current Branch Definition Of Done

The current branch is ready to PR when all of the following are true:

1. It is described as a foundation branch, not the final architecture.
2. Validation and agent-management changes still build and test cleanly.
3. No canonical entity layer work is mixed into the branch.
4. The branch includes roadmap and transition docs that explain the next step.
5. Agent cleanup has reduced dead or confusing system/worker presentation in the current branch.
6. At least one minimal `os-agent` page-context/navigation workflow has been manually verified in the viewer.
7. The next branch can start from merged `main` without needing to re-litigate architecture.

## Next Branch Definition Of Done

The next branch should not try to finish the whole product shift.

Its success criteria are:

1. canonical entity data model exists
2. raw/observation/resolution/projection pipeline exists
3. alias and merge review flow exists
4. at least one source can backfill into canonical entities
5. current MAMA memory can consume projected entity-aware results

## Naming Decisions

### Public Main Agent

- final name: `os-agent`

### Audit Agent

- replacement for `conductor`: `auditor`

### Functional Specialists

- `resolver`
- `linker`
- `historian`
- `memory-writer`

## Immediate Recommendation

Do not widen `feat/v019-agent-management` any further.

Use it to merge the foundations already built.

Then start the next branch with the real priority:

**canonical entity memory first, same-view main agent second.**

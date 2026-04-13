# Provenance Drawer v1 — Design

## Status

**Active v1 spec.** This document supersedes
`2026-04-13-entity-operations-viewer-design.md` as the concrete plan for the
first shipped iteration of entity-aware operator tooling. The older document
is retained as a long-term roadmap; its full `/autoplan` review is the direct
source of this spec's shape.

## Why this exists

The `/autoplan` review (CEO + Design + Eng + DX, dual voices) unanimously
recommended killing the 4 new top-level tabs (Lineage / Entities / Review /
Integrity) and shipping a contextual drawer first. The reasoning, in one
line: **data-model objects are not navigation objects.** The user's real
question is "why is this memory here?" — not "show me the ingest pipeline
as a standing workspace."

This drawer is the minimum surface that answers that question.

## Problem statement

When a user sees a surprising or wrong item in Memory (or reads a raw row in
Feed), they currently cannot answer:

- which raw connector row produced this?
- how did it become an entity observation?
- which entity did it resolve to?
- was there human review, or did it auto-merge?
- what other memory items share the same entity?

The backing data exists (`entity_observations`, `entity_resolution_candidates`,
`entity_nodes`, `entity_merge_actions`, `entity_timeline_events`,
`decisions`), but there is no read path that crosses all of them from a
single row.

## Goals

1. From any Memory item or Feed raw row, the user reaches the originating
   raw evidence in ≤ 3 clicks.
2. The drawer is read-only. No mutation actions in v1.
3. No new top-level tabs. No changes to the sidebar or mobile bottom bar.
4. Reuse existing Viewer shell patterns (filter bar, loading overlay,
   split-pane) — do not invent a new component system.
5. One HTTP round-trip per drawer open. No N+1 fan-out in the frontend.
6. Every surface has loading, empty, error, and "legacy pre-substrate"
   states explicitly specified.
7. Agent-accessible: every piece of information visible in the drawer is
   also readable via a documented REST endpoint.

## Non-goals (explicit)

- No entity merge, split, alias edit, or label edit (blocked by issue #79
  anyway — `mergeEntities()` is unimplemented in `mama-core`).
- No Review queue, Integrity queue, Lineage run console, or Entity list tab.
- No continuous orphan score. No `entity_change_events` table. No
  `entity_affected_outputs` table. No `ingest_runs` table. None of these
  are introduced by this spec.
- No structured-rule DSL. No `do_not_merge_pair`. No
  `canonical_label_preference`. No human-knowledge store.
- No desktop/mobile responsive rewrite. Drawer must work within existing
  Viewer shell constraints.
- No v1 telemetry on usage. That arrives in v1.1 before any tab promotion
  decision.

## Entry points

The drawer is reachable from exactly two places in v1:

1. **Memory tab — decision row.** Add a small "Trace" icon button at the
   end of each decision row in the Memory tab list. Clicking opens the
   drawer with `?memoryId=…`. Keyboard: `t` on the focused row.
2. **Feed tab — raw row.** Add a "Trace" icon button at the end of each
   raw row in `connector-feed.ts`. Clicking opens the drawer with
   `?rawId=…&connector=…`. Keyboard: `t` on the focused row.

Nothing else gets a "Trace" button in v1. No dashboard widgets, no wiki,
no agents tab. If this drawer earns its keep, we add more entry points
in v1.1.

## Drawer structure

The drawer is a right-side panel overlaying the current tab. It does not
replace the tab. Closing the drawer returns to the previous scroll
position. Escape closes. Outside click closes. `?` opens a keyboard-help
popover.

### Sections (top to bottom)

```
┌────────────────────────────────────────────────┐
│ Trace                             [×] close     │
├────────────────────────────────────────────────┤
│ Source                                          │
│   connector · channel · author · timestamp     │
│   "Open raw row"  "Open channel"                │
├────────────────────────────────────────────────┤
│ Observation                                     │
│   surface form → normalized form                │
│   kind hint · extractor version                 │
│   (empty state: "no observation extracted")     │
├────────────────────────────────────────────────┤
│ Entity                                          │
│   preferred label · kind · scope                │
│   resolved via: [auto-merge / human review /    │
│                  direct create]                 │
│   score breakdown (read-only, collapsed)        │
│   "Show other memories that cite this entity"   │
├────────────────────────────────────────────────┤
│ Memory impact                                   │
│   N other decisions cite this entity            │
│   (list, capped at 10, "view all" link         │
│    only if count > 10)                         │
└────────────────────────────────────────────────┘
```

The drawer opens in two modes depending on entry point:

- **Memory mode** (from a decision row): sections render top→bottom.
  Focus lands on the "Source" section so the user immediately sees
  where it came from.
- **Raw mode** (from a Feed row): sections render top→bottom. Focus
  lands on the "Observation" section because the user already knows
  the source; they are asking "was this extracted?"

Sections collapse gracefully when data is missing. There is no "no data"
blank screen — every case has text.

## Data model (nothing new)

This spec introduces **zero new tables and zero schema migrations.** It
reads from tables that already exist:

- `decisions` (memory items) — resolved by `memoryId`
- `entity_observations` — resolved by `(connector, raw_record_id)` and by
  `entity_node_id`
- `entity_nodes` (+ `merged_into` chain walking via existing
  `projection.ts:16`) — resolved by observation
- `entity_resolution_candidates` + `entity_merge_actions` — resolved by
  `entity_node_id` for the "resolved via" line
- raw connector DBs at `~/.mama/connectors/<name>/raw.db` — resolved by
  `(connector, raw_record_id)` through `raw-store.ts`

The **one plumbing gap this spec does introduce:** observations must carry
a back-reference to the originating raw row. Today, `history-extractor.ts:42`
builds observation drafts with raw refs, but the end-to-end path from a
decision back to its raw row is not wired. This is addressed by (a)
persisting the raw ref on observation insert, and (b) persisting a
`entity_observation_id` link on decision rows that originated from entity
extraction. Both are additive columns on existing tables. Migration file:
`packages/mama-core/db/migrations/029-provenance-drawer-backlinks.sql`
(TBD).

## API surface (agent-accessible)

One endpoint is added. No MCP tool changes in v1.

### `GET /api/provenance/:kind/:id`

`kind` is `memory` or `raw`. Returns the full drawer payload in one
response. Shape:

```jsonc
{
  "source": {
    "connector": "slack",
    "channel": "proj-x",
    "author": "jh",
    "timestamp": "2026-04-11T02:14:00Z",
    "raw_record_id": "slack_T_...",
    "raw_snippet": "..."
  },
  "observation": {
    "id": "obs_...",
    "surface_form": "Proj X launch",
    "normalized_form": "proj x launch",
    "kind_hint": "project",
    "extractor_version": "v0.3",
    "status": "extracted"
  },
  "entity": {
    "id": "ent_...",
    "preferred_label": "Project X",
    "kind": "project",
    "scope": { "kind": "project", "id": "proj-x" },
    "resolved_via": "auto_merge",
    "merge_action_id": null,
    "score_breakdown": { "structural": 0.8, "string": 0.7, ... }
  },
  "memory_impact": {
    "decision_count": 14,
    "recent_decisions": [ /* up to 10 */ ]
  },
  "legacy": false
}
```

**`legacy: true`** is the explicit signal for pre-substrate decisions —
the response still returns the memory item with `observation: null,
entity: null, memory_impact: null` and a `legacy_reason` string. The
frontend renders the "Pre-substrate memory — no lineage available"
empty state and offers a link to `docs/operations/entity-substrate-runbook.md`.

Error envelope follows the existing
`{ code, message, hint, doc_url }` contract (see
`entity-review-handler.ts:6`).

Auth is gated via the same `isAuthenticated()` middleware used by
`/api/entities/*` (`graph-api.ts:1224`). No new auth code.

## State matrix

| State                      | Source                                                  | Observation                         | Entity                                                               | Memory impact     |
| -------------------------- | ------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- | ----------------- |
| Loading                    | skeleton rows                                           | skeleton rows                       | skeleton rows                                                        | skeleton rows     |
| Happy path                 | full row                                                | full row                            | full row + badge                                                     | count + 10 rows   |
| Legacy (pre-substrate)     | full row                                                | "no lineage available"              | hidden                                                               | hidden            |
| Extraction dropped row     | full row                                                | "row was not extracted: `<reason>`" | hidden                                                               | hidden            |
| Entity not yet resolved    | full row                                                | full row                            | "pending resolution"                                                 | hidden            |
| Entity merged (tombstoned) | full row                                                | full row                            | follows `merged_into` chain, shows target, "(merged from ...)" badge | count from target |
| Raw DB missing             | "raw source unavailable: `<connector>` raw DB not open" | hidden                              | hidden                                                               | hidden            |
| 404                        | empty page + "item not found" + back button             |                                     |                                                                      |                   |
| Auth required              | hand off to `auth-middleware` redirect                  |                                     |                                                                      |                   |

## Responsive

- **Desktop (≥ 1024 px):** drawer is a 480-px right rail overlaying the
  current tab content. Backdrop dims tab content.
- **Tablet (768 – 1024 px):** drawer is a 60 %-width right rail. Same
  behavior.
- **Mobile (< 768 px):** drawer is a full-screen modal with a persistent
  top back button. Bottom tab bar hides while drawer is open. Swipe-down
  gesture closes.

No three-pane layouts. No collapsible inspectors. The drawer is one
scrollable column everywhere.

## Accessibility

- Focus moves into the drawer on open. First focusable element is the
  close button.
- Focus returns to the "Trace" button that triggered the drawer on close.
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at
  the "Trace" header.
- Escape closes. Tab cycles within the drawer (focus trap).
- Score breakdown renders as a definition list `<dl>` with spoken labels:
  "structural similarity: 0.8 out of 1.0". No color-only severity.
- Keyboard shortcut: `t` on a focused Memory or Feed row opens the drawer.
  `?` in the drawer opens the keyboard-help popover.
- Touch targets on mobile ≥ 44 px for close, "Open raw row", "Open channel",
  "Show other memories that cite this entity".

WCAG 2.2 AA is an acceptance criterion.

## Error contract

Every error response body must carry
`{ code, message, hint, doc_url, context }`. Codes introduced in v1:

- `provenance.memory_not_found` — memory item does not exist
- `provenance.raw_not_found` — raw row not found in any open connector raw DB
- `provenance.connector_db_unavailable` — connector raw DB is not open
- `provenance.legacy_lineage_missing` — item exists but predates the substrate
- `provenance.observation_extraction_failed` — upstream extractor dropped the row

`doc_url` points at `docs/operations/entity-substrate-runbook.md#<anchor>`.

## Implementation ordering

1. **Schema migration** `029-provenance-drawer-backlinks.sql` — add
   `entity_observations.source_raw_connector`,
   `entity_observations.source_raw_record_id`, and
   `decisions.entity_observation_id` nullable columns. Backfill is
   explicitly not attempted — existing rows stay null and render as
   `legacy: true`.
2. **Write-path plumbing** — `history-extractor.ts` persists raw ref on
   observation insert; whichever pipeline turns observations into
   decisions persists the observation link.
3. **Read handler** — new file
   `packages/standalone/src/api/provenance-handler.ts` implementing
   `GET /api/provenance/:kind/:id`. Single-query join where possible;
   at most 3 round trips to the DB (decision / observation+entity /
   impact count).
4. **API client** — add `ApiClient.getProvenance(kind, id)` in
   `packages/standalone/public/viewer/src/utils/api.ts`.
5. **Viewer module** — new file
   `packages/standalone/public/viewer/src/modules/provenance-drawer.ts`.
   Consumes the shell's existing overlay component (reuse whatever
   `settings.ts` or `memory.ts` use for modal chrome).
6. **Integration** — two call sites: Memory tab decision row + Feed tab
   raw row.
7. **Tests** — happy path, legacy, raw-db-missing, 404 for both modes.
   A11y smoke test: drawer opens, focus trap works, escape closes,
   focus returns.

No step in this list requires touching `entity-review.ts`,
`entity-audit.ts`, `graph.ts`, `/api/entities/candidates`, or the
canonical merge routine that doesn't exist yet (#79).

## Acceptance criteria

This spec is satisfied when the Viewer can answer, **within 15 seconds
of a cold session open**:

1. From a Memory decision: which raw row produced this? (≤ 3 clicks)
2. From a Feed raw row: was this extracted, and if so into which entity?
   (≤ 2 clicks)
3. From either: which other memories cite the same entity? (1 additional
   click)
4. For pre-substrate decisions: the user sees an explicit "no lineage
   available" state with a link to the runbook — never a broken page or
   fake link.
5. For an AI agent: the same information is reachable via a single
   documented `GET` request with a stable response shape.

## What earns a v1.1 promotion

The drawer is a test, not an end state. Telemetry (added in v1.1) should
measure:

- drawer opens per session
- most-common entry point (Memory vs Feed)
- which section users scroll to / dwell on
- how often the "other memories" link is clicked
- how often legacy states are hit

If the drawer is opened frequently and users consistently drill into a
specific section, that section becomes a candidate for a dedicated
surface (tab or sub-view under a single `Operations` parent). If the
drawer is opened rarely, the 4-tab plan from the long-term roadmap is
falsified and we close it.

## Open questions for implementer

1. Where exactly does the entity-extraction pipeline write `decisions`
   rows today? The back-link column needs to be populated at that write
   site, and it may live in `history-extractor.ts`, `memory/api.ts`,
   or somewhere between. This spec assumes the integrator finds it.
2. Can `recall-bridge.ts`'s existing `merged_into`-aware join be reused
   in the provenance read path, or does the drawer need its own join?
3. Should the "Show other memories" list be filtered by current scope
   (project/channel) or global? Default: global, with a filter chip.

These do not block the spec; they are decisions the first implementation
PR must make and record in its PR description.

## References

- `/autoplan` review findings at the bottom of
  `docs/superpowers/specs/2026-04-13-entity-operations-viewer-design.md`
- Existing error envelope pattern: `entity-review-handler.ts:6`
- Existing `merged_into` chain walking: `projection.ts:16`,
  `recall-bridge.ts:75`
- Existing raw storage: `raw-store.ts:24`,
  `connector-feed-handler.ts:91`
- Existing auth gate: `graph-api.ts:1224`
- Blocker surfaced during review (tracked separately, does not block
  this spec): issue #79 — canonical entity merging is unimplemented in
  `mama-core`.

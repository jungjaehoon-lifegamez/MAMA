# Canonical Entity Merge — Design Pass

## Status

**Design only.** This document resolves the two policy questions that block
issue #79 (`entity-review-handler.ts:521` approve is a no-op, and
`mergeEntities()` is unimplemented end-to-end in `mama-core`). Implementation
lands in a separate PR after review.

## Why now

Surfaced during the `/autoplan` review of the entity operations viewer
(2026-04-13). Codex eng caught that `approve` only writes an
`entity_merge_actions` row and flips candidate status — it never mutates the
canonical graph. Deeper review showed `merged_into` is read in
`projection.ts:16` and `recall-bridge.ts:75`, but **zero write sites** set
it anywhere in the repo. The schema anticipates merges; the write path is
missing.

Any meaningful Review UI work, and any future Integrity / lineage work,
depends on this being real. It also blocks the provenance drawer v1 in a
subtle way: the drawer's "Entity merged (tombstoned)" state requires the
`merged_into` chain to actually be populated.

## Scope

This document decides:

1. **Policy A — Observation/alias repointing.** When entity B is merged into
   entity A, do we re-point `entity_observations.entity_node_id` and
   `entity_aliases.entity_node_id` to A, or do we leave them pointing at B
   and rely on `merged_into` chain walking at read time?
2. **Policy B — Rollback / transaction semantics.** If the merge write
   fails partway through, does the candidate revert to `pending`, or does
   it enter an error state the user must manually resolve?

It does **not** decide:

- Winner selection (target vs source). That's a separate preference per
  candidate — out of scope here, picked by the caller.
- Split, alias edit, label edit — those are different mutations with
  different semantics.
- Structured-rule storage (do_not_merge_pair, canonical_label_preference).
  Explicitly deferred until there's demand.

## Policy A — Repointing vs chain walking

### Option A1 — Write-time repointing

On merge, update every `entity_observations.entity_node_id = B` and every
`entity_aliases.entity_node_id = B` to point at `A`. Set
`B.merged_into = A`, `B.status = 'merged'`. Future reads against A see all
observations directly.

**Pros:**

- Read path is simple. Recall, projection, and the provenance drawer can
  join on `entity_node_id` without walking a chain.
- Impact queries ("which decisions cite entity A?") return the right
  answer even if someone forgot to chain-walk.
- N+1 risk on read drops, which matters for the drawer's "Memory impact"
  section that counts citing decisions.

**Cons:**

- Merge is an O(observations + aliases + timeline_events) write.
  Potentially expensive for long-lived entities.
- History is harder to inspect post-merge. "Which observations originally
  cited B?" requires reading `entity_merge_actions.evidence_json` instead
  of a direct query.
- If we ever want to **un-merge**, repointing is a one-way door. Chain
  walking is reversible by clearing `merged_into`.

### Option A2 — Read-time chain walking (current design intent)

On merge, set `B.merged_into = A`, `B.status = 'merged'`, and nothing else.
Observations and aliases keep pointing at B. Read paths walk the
`merged_into` chain (as `projection.ts` and `recall-bridge.ts` already do).

**Pros:**

- Merge is O(1) writes — one entity row update plus the merge action row.
- Un-merge is a single column reset. History of which observations cited
  which raw entity is preserved naturally.
- Matches the existing read-side code; no new joins needed in the drawer.

**Cons:**

- Every read path that queries observations or aliases by `entity_node_id`
  must join or filter through `merged_into`. If any consumer forgets, the
  answer is silently wrong.
- Impact queries require a recursive CTE or a two-step lookup. SQLite's
  recursive CTE is fine but uglier than a direct join.
- The provenance drawer's "Memory impact" count has to chase chains,
  which increases N+1 risk on wide entities.

### Recommendation: A2 with a helper view

Pick **A2 (read-time chain walking)** for v1, and introduce a SQL view or
a single helper function in `mama-core/src/entities/store.ts` that every
consumer uses:

```ts
function resolveCanonicalEntityId(adapter, id): string {
  // walks merged_into with cycle detection, returns terminal id
}
```

All reads route through this helper. Consumers that need it in SQL get a
view:

```sql
CREATE VIEW IF NOT EXISTS canonical_entity_observations AS
  SELECT o.*, coalesce_merged_chain(n.id) AS canonical_entity_id
  FROM entity_observations o
  JOIN entity_nodes n ON n.id = o.entity_node_id;
```

(SQLite doesn't have a real `coalesce_merged_chain` function — the view
would use a recursive CTE. The point is there is ONE join pattern, not
many.)

Why A2:

- Matches the code that already exists (`projection.ts`, `recall-bridge.ts`
  already walk the chain).
- Un-merge is cheap and possible. This matters because the review
  experience is "we made a mistake, undo the merge" and any v1 that makes
  un-merge hard will be hated.
- The N+1 risk is real but bounded. The drawer's "Memory impact" section
  can cap the recursive CTE depth at 4 (anyone making merge chains deeper
  than 4 has bigger problems) and the existing query planner handles the
  rest.

Migration: add a single helper function in `store.ts`, update the
existing `recall-bridge.ts` and `projection.ts` call sites to use it, add
SQL tests that verify chain walking returns the terminal node.

## Policy B — Rollback / transaction semantics

### Option B1 — Hard transaction, candidate stays pending on failure

Wrap the full merge in a single SQLite transaction:

1. INSERT `entity_merge_actions` row with source/target IDs populated
2. UPDATE `B.merged_into = A`, `B.status = 'merged'`
3. INSERT `entity_timeline_events` row
4. UPDATE `entity_resolution_candidates.status = 'resolved'`

If any step fails, the entire transaction rolls back. The candidate stays
`pending`. The user retries from the Review UI.

**Pros:**

- Atomic. No half-merged state ever exists.
- User can retry cleanly.
- Matches the existing `persistDecision` wrapper at
  `entity-review-handler.ts:532` (already uses `adapter.transaction`).

**Cons:**

- Transactions holding multiple table writes can be slow on `better-sqlite3`
  under heavy concurrent reads. Not a current concern (single-user local
  DB), could matter later.
- Hides the error from any downstream consumer that was watching the
  merge_actions table.

### Option B2 — Per-step with error state

Each step is its own write. If step 2 fails after step 1 succeeded, the
candidate enters a new `error_merge_partial` status. The user manually
resolves via a repair action.

**Pros:**

- Surfaces partial failures explicitly.
- Merge action row acts as an audit trail even on failure.

**Cons:**

- Introduces a new candidate status and a new repair UI — neither of which
  exists in v1.
- The schema requires migration to add the status.
- Debuggability is worse, not better: "why is this candidate in
  `error_merge_partial`" without a good repair surface is just confusion.

### Recommendation: B1 (hard transaction)

Pick **B1**. It's what the existing handler is already structured for
(`adapter.transaction` is already in use at line 532), and the "partial
failure with repair UI" world doesn't exist yet in v1. If we ever need
partial-failure visibility, the merge action row still gets inserted
atomically with the rest, so post-hoc forensics are possible via the
append-only `entity_merge_actions` table.

One addition: on transaction rollback, emit a structured log line
(`[entity.merge] transaction rollback: <reason>`) and return an error
envelope `{ code: "entity.merge_failed", ... }` so the UI can distinguish
"your click did nothing" from "server error unrelated to your click".

## What the implementation PR looks like

Once these two policies are accepted, the implementation PR is small:

1. **New function** `mergeEntityNodes(adapter, sourceId, targetId, actor, reason)`
   in `packages/mama-core/src/entities/store.ts` or new
   `packages/mama-core/src/entities/merge.ts`. Validates refs exist,
   same kind, same scope. Wraps the 4 writes above in
   `adapter.transaction`. Returns the merge action id.
2. **New helper** `resolveCanonicalEntityId(adapter, id)` in `store.ts`.
   Used by projection and recall bridges.
3. **Handler update** at `entity-review-handler.ts:407`. Before calling
   `persistDecision`, resolve candidate refs to owning entity IDs. Pass
   those to `mergeEntityNodes`. Populate the merge action row's
   source/target IDs from the resolved values (fixes the null bug at
   line 497 in the same change).
4. **Migration** none required. `merged_into` column already exists.
5. **Tests** in `packages/standalone/tests/api/entity-review-handler.test.ts`:
   - approve populates source/target entity IDs
   - after approve, source entity has `merged_into = target`
   - after approve, recall returns one entity, not two
   - approve on already-merged source is idempotent or returns a
     409 `entity.already_merged`
   - transaction failure at any step leaves no mutation behind
6. **Regression test** in `packages/mama-core/tests/entities/projection.test.ts`:
   chain walking with depth > 1 still resolves correctly.

Total surface area: one new function, one new helper, two edits to the
handler, two test files. No schema migration. No new API routes.

## Risks

- **Bulk merges.** If someone approves 100 candidates in a row, each
  transaction is its own round trip. Not a v1 problem but worth noting
  for future batch UX.
- **Concurrent approve.** Two tabs approving the same candidate: second
  one hits `entity_resolution_candidates.status != 'pending'` and gets
  the existing stale envelope. Safe.
- **Merge cycles.** Policy A2 relies on `merged_into` chain walking, which
  already has cycle detection at `projection.ts:17`. The new
  `resolveCanonicalEntityId` helper must reuse that logic, not reinvent it.
- **Scope mismatch.** If the caller passes entities with different scopes,
  merge must reject with `entity.merge_scope_mismatch`. Cross-scope merges
  are a product decision outside v1.

## Open questions for implementation PR

1. Where exactly does the handler resolve `candidate.left_ref` and
   `candidate.right_ref` to entity IDs today? The refs are observation
   refs, so resolution goes through `entity_observations.entity_node_id`.
   The PR must either share this logic with `resolveRef` at
   `entity-review-handler.ts:201` or refactor it out.
2. Should the timeline event include the merge evidence snapshot
   (`rule_trace`, score breakdown), or just the merge action id? Default:
   just the id — the action row holds the evidence.
3. For scope: do we reject cross-scope merges outright, or allow "widen
   to global" as a side effect? Default: reject in v1. Revisit when
   there's a real case.

These do not block the design decision. They are PR-time decisions the
implementer records in the PR description.

## References

- Issue #79 — tracking issue for the bug and this design
- `packages/standalone/src/api/entity-review-handler.ts:407,497,521,532` —
  current handler
- `packages/mama-core/src/entities/projection.ts:16` — existing chain walker
- `packages/mama-core/src/entities/recall-bridge.ts:75` — existing
  merged-filter join
- `packages/mama-core/db/migrations/026-create-canonical-entity-tables.sql`
  — where `merged_into` column lives
- `/autoplan` review section in
  `docs/superpowers/specs/2026-04-13-entity-operations-viewer-design.md`
  — context for why this surfaced now
- Provenance drawer v1 spec
  (`2026-04-13-provenance-drawer-v1-design.md`) — dependency on
  chain-walking being consistent

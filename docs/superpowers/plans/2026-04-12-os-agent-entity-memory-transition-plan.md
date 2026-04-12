# OS Agent And Canonical Entity Memory Transition Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `feat/v019-agent-management` as a mergeable foundation, then start a fresh branch that builds canonical entity memory before deeper `os-agent` orchestration changes.

**Architecture:** Treat the current branch as infrastructure stabilization only. Do not force canonical entity work into it. After merge, build a new MAMA entity layer beneath existing memory/graph systems, then reconnect `os-agent`, workers, and `auditor` on top of that substrate.

**Tech Stack:** JavaScript/TypeScript, `mama-core` SQLite persistence, standalone API/viewer modules, existing memory truth/graph systems, Vitest.

---

## File Map

### Create

- `docs/superpowers/specs/2026-04-12-os-agent-entity-memory-roadmap-design.md`
  High-level roadmap and architecture reset.
- `docs/superpowers/plans/2026-04-12-os-agent-entity-memory-transition-plan.md`
  This transition plan.
- `packages/mama-core/src/entities/types.ts`
  Canonical entity, alias, link, and timeline domain types.
- `packages/mama-core/src/entities/store.ts`
  SQLite persistence for entity nodes, aliases, links, candidates, and timeline events.
- `packages/mama-core/src/entities/resolution-engine.ts`
  Alias clustering and confidence-based canonicalization rules.
- `packages/mama-core/src/entities/projection.ts`
  Projection from canonical entities into existing memory/truth structures.
- `packages/mama-core/tests/entities/store.test.ts`
  Persistence coverage for the new entity layer.
- `packages/mama-core/tests/entities/resolution-engine.test.ts`
  Alias and merge confidence coverage.
- `packages/mama-core/tests/entities/projection.test.ts`
  Projection coverage into current memory systems.

### Modify

- `packages/mama-core/src/memory/api.ts`
  Consume canonical entity projection instead of relying only on topic-centric saves.
- `packages/mama-core/src/memory/truth-store.ts`
  Accept projected entity-aware truth rows.
- `packages/standalone/src/cli/runtime/connector-init.ts`
  Change connector ingest from direct `saveMemory()` writes into raw/observation/resolution/projection flow.
- `packages/standalone/src/memory/history-extractor.ts`
  Emit observations instead of assuming project/work-unit strings are the canonical truth.
- `packages/standalone/src/gateways/message-router.ts`
  Future `os-agent` frontdoor wiring once canonical entity memory exists.
- `packages/standalone/src/api/graph-api.ts`
  Expose entity review and TODO surfaces after the new layer is live.
- `packages/standalone/public/viewer/src/utils/ui-commands.ts`
  Strengthen page-aware command contracts after entity layer foundations are in place.
- `packages/standalone/public/viewer/src/modules/agents.ts`
  Later system-agent presentation changes (`os-agent`, `auditor`) after the substrate lands.

### Existing Assets To Reuse

- `packages/mama-core/src/memory/api.ts`
  Existing save/recall/truth entrypoints and search behavior.
- `packages/mama-core/src/memory/truth-store.ts`
  Current truth projection patterns.
- `packages/mama-core/src/memory/evolution-engine.ts`
  Current conservative evolution logic, adapted for projections rather than identity.
- `packages/standalone/src/memory/history-extractor.ts`
  Existing 3-pass truth/activity/spoke ingestion structure.
- `packages/standalone/src/validation/*`
  Useful agent validation infrastructure that should remain independent of entity-layer work.

---

## Chunk 1: Freeze And Merge The Current Branch

### Task 1: Narrow the current branch scope in docs and handoff notes

**Files:**

- Create: `docs/superpowers/specs/2026-04-12-os-agent-entity-memory-roadmap-design.md`
- Create: `docs/superpowers/plans/2026-04-12-os-agent-entity-memory-transition-plan.md`

- [ ] **Step 1: Confirm the branch narrative**

Write docs that explicitly state:

- `feat/v019-agent-management` is a foundation branch
- it should not absorb canonical entity memory work
- the next architecture starts in a fresh branch from merged `main`

- [ ] **Step 2: Review current branch diff and scope**

Run:

```bash
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected:

- current branch scope is broad but understandable as foundation work
- no new entity-layer files are mixed into the branch

- [ ] **Step 3: Commit the roadmap docs**

```bash
git add docs/superpowers/specs/2026-04-12-os-agent-entity-memory-roadmap-design.md docs/superpowers/plans/2026-04-12-os-agent-entity-memory-transition-plan.md
git commit -m "docs: add os-agent and entity-memory transition roadmap"
```

### Task 2: Verify the current branch before opening a PR

**Files:**

- Modify only if verification reveals blockers

- [ ] **Step 1: Run targeted branch verification**

Run:

```bash
pnpm --dir ./packages/standalone build
pnpm test
```

Expected:

- build exit code `0`
- root test exit code `0`

- [ ] **Step 2: Clean up the current agent roster enough for a foundation PR**

Review the current user-facing agent roster and remove or clearly demote dead/confusing entries that would make the PR misleading.

Minimum outcomes:

- worker/system agent presentation is less noisy than the current mixed legacy state
- obviously dead Agent Swarm leftovers are not presented as active product direction
- the PR narrative matches what the UI and config actually show

- [ ] **Step 3: Prove one minimal `os-agent` viewer workflow**

Manually verify at least one same-view foundation flow in the current branch:

- the viewer reports current page context
- the agent can read that context
- the viewer can accept and execute one navigation command
- the resulting page state can be observed again

This is **not** the full `os-agent` architecture. It is only a foundation proof that the page-context/navigation seam is alive before merge.

- [ ] **Step 4: Review working tree cleanliness**

Run:

```bash
git status --short --branch
```

Expected:

- only intentional doc changes or known generated-file noise remain

- [ ] **Step 5: Open the PR with the right narrative**

PR summary must say:

- this PR merges agent-management and validation foundations
- it includes agent cleanup and a minimal `os-agent` page-context/navigation proof
- it does **not** claim to finish `os-agent`/canonical entity architecture
- the next branch will implement canonical entity memory first

- [ ] **Step 6: Merge only after review**

Merge after code review and user approval. Do not expand scope during review.

---

## Chunk 2: Prepare The Fresh Branch From Merged Main

### Task 3: Create the next branch and checkpoint the handoff

**Files:**

- No product files yet

- [ ] **Step 1: Update local main after merge**

Run:

```bash
git checkout main
git pull --ff-only
```

Expected:

- `main` includes the merged foundation PR

- [ ] **Step 2: Create the next branch**

Run:

```bash
git checkout -b codex/mama-entity-layer
```

Expected:

- fresh branch starts from merged `main`

- [ ] **Step 3: Save a checkpoint or handoff note**

Record:

- current roadmap decision
- why entity layer comes before richer orchestration
- which current-branch work is intentionally deferred

---

## Chunk 3: Build Canonical Entity Persistence

### Task 4: Define entity-layer domain types and failing tests

**Files:**

- Create: `packages/mama-core/src/entities/types.ts`
- Create: `packages/mama-core/tests/entities/store.test.ts`
- Create: `packages/mama-core/tests/entities/resolution-engine.test.ts`

- [ ] **Step 1: Write failing tests for core entities**

Cover:

- canonical entity node creation
- alias attachment
- relationship link persistence
- resolution candidate review state
- timeline event persistence

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/store.test.ts tests/entities/resolution-engine.test.ts
```

Expected:

- FAIL because entity files do not exist yet

- [ ] **Step 3: Implement `entities/types.ts`**

Add:

- `EntityKind`
- `EntityNode`
- `EntityAlias`
- `EntityLink`
- `EntityResolutionCandidate`
- `EntityTimelineEvent`

- [ ] **Step 4: Run tests to verify partial progress**

Run the same command and confirm type/import errors are resolved while store tests still fail.

### Task 5: Implement entity SQLite store

**Files:**

- Create: `packages/mama-core/src/entities/store.ts`
- Modify: `packages/mama-core/src/db-manager.ts`
- Test: `packages/mama-core/tests/entities/store.test.ts`

- [ ] **Step 1: Write failing persistence expectations**

Add tests for:

- `entity_nodes`
- `entity_aliases`
- `entity_links`
- `entity_resolution_candidates`
- `entity_timeline_events`

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/store.test.ts
```

Expected:

- FAIL because tables/store functions are missing

- [ ] **Step 3: Implement `store.ts` and table initialization**

Add CRUD for:

- entity node create/update/list
- alias attach/list
- link attach/list
- candidate create/review
- timeline event append/list

- [ ] **Step 4: Wire table init into DB bootstrap**

Update `db-manager.ts` migrations/init path so entity tables are created with normal startup.

- [ ] **Step 5: Run tests to verify pass**

Run the same `vitest` command and expect PASS.

---

## Chunk 4: Convert Ingest Into Raw -> Observation -> Resolution -> Projection

### Task 6: Change connector ingest to produce observations first

**Files:**

- Modify: `packages/standalone/src/cli/runtime/connector-init.ts`
- Modify: `packages/standalone/src/memory/history-extractor.ts`
- Create: `packages/mama-core/src/entities/observation.ts`
- Test: `packages/mama-core/tests/entities/projection.test.ts`

- [ ] **Step 1: Write failing tests for observation extraction**

Cover:

- project alias observations
- person alias observations
- project/person relationship hints
- work-unit and event timestamps

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/projection.test.ts
```

Expected:

- FAIL because observation pipeline does not exist

- [ ] **Step 3: Implement observation records**

Do **not** save connector items directly into `saveMemory()` as the first move.

Instead emit:

- raw source record id
- extracted observation kind
- candidate aliases
- relation hints
- timestamps
- provenance metadata

- [ ] **Step 4: Keep old memory projection disabled or best-effort behind a flag until resolution exists**

Avoid double-writing inconsistent canonical state during migration.

### Task 7: Add resolution engine and review-needed outcomes

**Files:**

- Create: `packages/mama-core/src/entities/resolution-engine.ts`
- Test: `packages/mama-core/tests/entities/resolution-engine.test.ts`

- [ ] **Step 1: Write failing resolution tests**

Cover:

- exact alias normalization
- multilingual similarity candidate grouping
- high-confidence auto merge
- medium-confidence review-needed
- low-confidence keep-separate

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/resolution-engine.test.ts
```

Expected:

- FAIL because the resolution engine does not exist

- [ ] **Step 3: Implement conservative resolution**

Rules:

- deterministic normalization first
- embedding similarity second
- no silent medium-confidence merges
- every merge remains reversible

- [ ] **Step 4: Run tests to verify pass**

Expect PASS.

### Task 8: Project canonical entities back into current memory systems

**Files:**

- Create: `packages/mama-core/src/entities/projection.ts`
- Modify: `packages/mama-core/src/memory/api.ts`
- Modify: `packages/mama-core/src/memory/truth-store.ts`
- Test: `packages/mama-core/tests/entities/projection.test.ts`

- [ ] **Step 1: Write failing projection tests**

Cover:

- canonical project/person data becomes searchable via current recall paths
- truth projection reflects canonical summaries
- topic-centric decision history still works after projection

- [ ] **Step 2: Run tests to verify failure**

Run the projection test file and confirm failure.

- [ ] **Step 3: Implement projection**

The new entity layer should enrich current memory systems, not replace them outright.

- [ ] **Step 4: Run tests to verify pass**

Expect PASS.

---

## Chunk 5: Rebuild The `os-agent` Vertical Slice On Top Of Entity Memory

### Task 9: Promote `os-agent` into a first-class system agent

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify: `packages/standalone/src/cli/config/types.ts`

- [ ] **Step 1: Write failing UI/runtime expectations**

Cover:

- `os-agent` appears in the Agents tab
- it is editable like other agents, with safety rails
- it is not hidden behind source-role mapping only

- [ ] **Step 2: Implement first-class visibility**

Separate:

- agent identity
- source permission profile

Do not treat `os-agent` as only a role alias anymore.

- [ ] **Step 3: Verify manually**

Run the viewer and confirm `os-agent` is visible and configurable.

### Task 10: Upgrade viewer page context to SmartStore-style same-view state

**Files:**

- Modify: `packages/standalone/public/viewer/src/utils/ui-commands.ts`
- Modify: `packages/standalone/public/viewer/src/modules/agents.ts`
- Modify/add additional viewer modules as needed
- Modify: `packages/standalone/src/api/ui-command-handler.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`

- [ ] **Step 1: Write failing contract tests or targeted assertions**

Cover:

- `currentRoute`
- `selectedItem`
- `pageData`
- future `availableActions`

- [ ] **Step 2: Implement centralized page reporting**

Do not rely only on ad-hoc per-module summaries. Add a stronger shared page-context contract.

- [ ] **Step 3: Verify one end-to-end slice**

Example:

- user asks to inspect an agent
- `os-agent` navigates to the agent page
- reads the same page context the user sees
- responds based on that state

---

## Chunk 6: Add Functional Specialists And Auditor Workflow

### Task 11: Introduce functional specialist worker contracts

**Files:**

- Modify: `packages/standalone/src/agent/os-agent-capabilities.md`
- Modify worker configs/personas as needed

- [ ] **Step 1: Define worker responsibilities**

Add contracts for:

- `resolver`
- `linker`
- `historian`
- `memory-writer`

- [ ] **Step 2: Make `os-agent` the delegating manager**

`os-agent` decides whether to:

- handle directly
- call one worker
- fan out to multiple workers

### Task 12: Recast `conductor` into `auditor`

**Files:**

- Modify: `packages/standalone/src/multi-agent/conductor-persona.ts`
- Rename/migrate later after compatibility planning

- [ ] **Step 1: Update role definition in docs and prompts**

The role is:

- observer
- comparer
- explainer
- recommendation engine

not the mandatory hot-path orchestrator.

- [ ] **Step 2: Add code-driven periodic audit outputs**

Periodic audits should create:

- validation records
- alerts
- agent-owned TODOs

but should not silently execute risky remediation.

---

## Final Verification

### Task 13: Verify transition readiness and branch hygiene

**Files:**

- Modify as needed from previous tasks

- [ ] **Step 1: Re-run current-branch foundation verification before PR**

```bash
pnpm --dir ./packages/standalone build
pnpm test
```

- [ ] **Step 2: Re-run next-branch targeted entity tests during implementation**

```bash
pnpm --dir ./packages/mama-core exec vitest run tests/entities/store.test.ts tests/entities/resolution-engine.test.ts tests/entities/projection.test.ts
```

- [ ] **Step 3: Run full regression once the entity layer vertical slice lands**

```bash
pnpm test
```

- [ ] **Step 4: Manually verify the first same-view `os-agent` workflow**

Proof required:

- user and agent see the same page state
- the agent can navigate
- the agent can read contextual data
- the agent can delegate with canonical-entity context

---

Plan complete and saved to `docs/superpowers/plans/2026-04-12-os-agent-entity-memory-transition-plan.md`. Ready to execute?

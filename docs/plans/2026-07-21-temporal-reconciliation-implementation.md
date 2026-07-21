# Temporal Reconciliation Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED: Complete the A1 plan and its review gate first. Then use
> `superpowers:subagent-driven-development` task-by-task, `superpowers:test-driven-development` for
> every behavior change, and `superpowers:verification-before-completion` before release claims.

**Goal:** Turn an exact due-time crossing or due date into bounded durable work that reads fresh
evidence, atomically records a valid task judgment, and completes only when that effect is proven.

**Architecture:** A focused temporal migration extends the native task ledger with revision and
occurrence state plus generation/effect tables. `TemporalReconcileScheduler` deterministically
selects due candidates and atomically creates a generation plus its first workorder. A dedicated
Code-Act worker receives host-built `TemporalWorkContext`; only `task_temporal_reconcile` can commit
its task effect, receipt, no-update note, generation disposition, and workorder completion in one
transaction. The consumer treats that atomic terminal state as authoritative before any retry.

**Tech Stack:** TypeScript, SQLite transactions and migrations, Vitest with real in-memory ledgers,
existing WorkOrderConsumer, AgentLoop/Code-Act, Express task API, React task board.

**Design reference:**
`docs/plans/2026-07-21-operator-action-control-loop-design.md`. When this plan and the design differ,
stop and amend the reviewed design; do not silently weaken its atomicity, trusted-context, or source
boundaries.

---

## Task 1: Add focused temporal schema migration and row types

**Files:**

- Create: `packages/standalone/src/db/migrations/operator-task-temporal.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Create: `packages/standalone/tests/operator/operator-task-temporal-migration.test.ts`

### Step 1: Write failing fresh/upgrade/idempotency migration tests

Using real in-memory SQLite plus a legacy table fixture, prove:

- fresh `TaskLedger` construction creates all eight task columns from the design;
- it creates `operator_temporal_generations` and immutable `operator_temporal_effects` with required
  uniqueness, foreign/reference ids, dispositions, and lookup indexes;
- upgrading a pre-temporal DB preserves every existing task row without rewriting its values;
- running migration twice is safe;
- two `TaskLedger` constructors against the same file cannot interleave the legacy copy-swap and
  temporal column creation or lose a temporal column/index;
- legacy scheduled rows retain epoch 0 until a real scheduling mutation; no blind backfill occurs.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/operator/operator-task-temporal-migration.test.ts
```

Expected: fails because the columns/tables do not exist.

### Step 2: Implement a guarded migration module

Export one idempotent migration function accepting the project `SQLiteDatabase`. It must not start
or commit its own transaction. `TaskLedger.upgradeSchema()` calls it inside the existing
`BEGIN IMMEDIATE` only after the legacy `failed`-status copy-swap has finished and before that outer
transaction recreates indexes and commits. Use guarded `ALTER TABLE` operations, then create:

- `operator_temporal_generations` keyed by stable generation key;
- `operator_temporal_effects` keyed by `workorder_attempt_id` and never updated after insert;
- indexes for active task/epoch lookup, check-time selection, attempt lookup, and task occurrence
  history.

Do not add an `attempts` column to generations. `payload.attempts` remains the sole retry counter.

### Step 3: Wire migration and typed row projections

Extend `TABLE_COLUMNS_SQL` so fresh creates and any legacy rebuild already contain the eight fields.
Invoke the focused migration from the serialized `upgradeSchema()` boundary at the exact point
described above; never call it before the copy-swap and never nest a second transaction. Extend
task/row types with:

```text
dueAt, deadlineOffsetMinutes, revision, temporalEpoch,
temporalReconciledOccurrenceKey, lastTemporalCheckedAt,
nextTemporalCheckAt, lastTemporalAttemptId
```

Add typed generation/effect record interfaces. Keep system workorder records distinct from owner
task revision semantics.

### Step 4: Run focused tests and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/operator-task-temporal-migration.test.ts \
  tests/operator/task-ledger.test.ts
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/db/migrations/operator-task-temporal.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/tests/operator/operator-task-temporal-migration.test.ts
git commit -m "feat(standalone): migrate temporal task ledger schema"
```

---

## Task 2: Centralize exact-time normalization and revision/epoch rules

**Files:**

- Create: `packages/standalone/src/operator/task-temporal.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/tests/operator/task-ledger.test.ts`
- Create: `packages/standalone/tests/operator/task-temporal.test.ts`

### Step 1: Write exhaustive failing normalization tests

Cover:

- RFC 3339 with `Z` and numeric offsets; reject offset-free, invalid, and overflow values;
- derive `deadline` from the input's explicit local date and capture offset minutes;
- reject conflicting `due_at` and `deadline` in one write;
- update only `deadline` clears exact precision but retains captured offset;
- clear only `due_at` preserves date and offset;
- clear `deadline` clears due time, offset, and markers;
- scheduled create starts `revision=1, temporalEpoch=1`; unscheduled starts epoch 0;
- real update increments revision exactly once; no-op preserves revision and `updatedAt`;
- due/deadline change and terminal-to-open reopen increment epoch and clear temporal markers;
- non-temporal field update increments revision but not epoch;
- duplicate source-event upsert follows the same one-increment/no-op contract.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/task-temporal.test.ts \
  tests/operator/task-ledger.test.ts
```

Expected: failures on missing helpers and legacy mutation behavior.

### Step 2: Implement pure normalization and occurrence helpers

In `task-temporal.ts`, add typed helpers for:

- parsing/normalizing exact due input;
- current epoch-qualified occurrence key;
- exact/date check boundary using captured offset or injected boot time zone;
- owner lifecycle open/closed checks;
- bounded reason/evidence strings.

No title parsing and no connector access belongs in this module.

### Step 3: Route every owner mutation through one ledger boundary

Refactor `create`, `update`, and source upsert so one transaction computes the normalized before/after
row, detects a true persisted change, increments `revision` once, and increments `temporal_epoch`
only under the reviewed rules. A no-op must not update `updated_at`.

When an owner mutation changes occurrence/epoch or reopens a terminal task, call a ledger helper in
the same transaction to:

- mark old active generations `superseded`;
- cancel their pending/in-progress workorder rows with bounded `workorder_superseded` reason.

The helper will be fully exercised after generation support is added; keep it a no-op when no rows
exist.

### Step 4: Run focused tests and typecheck

Run the Step 1 command, then:

```bash
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/task-temporal.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/tests/operator/task-temporal.test.ts \
  packages/standalone/tests/operator/task-ledger.test.ts
git commit -m "feat(standalone): normalize temporal owner task mutations"
```

---

## Task 3: Add derived temporal state to ledger and HTTP/gateway surfaces

**Files:**

- Modify: `packages/standalone/src/operator/task-temporal.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/src/api/operator-tasks-handler.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`
- Modify: `packages/standalone/tests/api/operator-tasks-handler.test.ts`
- Modify: `packages/standalone/tests/agent/task-tools.test.ts`
- Modify: `packages/standalone/tests/code-act/host-bridge.test.ts`

### Step 1: Write failing API/tool contract tests

Inject clock and daemon IANA time zone and cover all seven derived states, including `due_at == now`,
captured-offset date boundaries, and legacy date-only local-zone boundaries. Prove HTTP and gateway:

- accept exact timestamps only with explicit offset;
- return normalized `due_at` plus revision/epoch/check fields and `temporal_state`;
- preserve legacy `deadline` payload compatibility;
- reject conflicting or offset-free inputs with typed errors;
- apply the same no-op revision contract.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/api/operator-tasks-handler.test.ts \
  tests/agent/task-tools.test.ts \
  tests/code-act/host-bridge.test.ts
```

### Step 2: Implement one derived-state function

Return exactly one of:

```text
closed, exact_upcoming, exact_overdue,
date_upcoming, date_due, date_overdue, unscheduled
```

The equality boundary is overdue for exact instants. Keep workflow status unchanged.

### Step 3: Extend HTTP and gateway schemas

Accept `due_at` as RFC 3339 string/null and map it only through TaskLedger normalization. Serialize
the bounded temporal projection. Update tool registry and Code-Act host bridge definitions; generate
`src/agent/gateway-tools.md` through the normal build script rather than hand-editing it.

### Step 4: Run focused tests, generator/build, and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/task-temporal.test.ts \
  tests/api/operator-tasks-handler.test.ts \
  tests/agent/task-tools.test.ts \
  tests/code-act/host-bridge.test.ts
pnpm --dir packages/standalone build
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/task-temporal.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/api/operator-tasks-handler.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/src/agent/tool-registry.ts \
  packages/standalone/src/agent/code-act/host-bridge.ts \
  packages/standalone/src/agent/gateway-tools.md \
  packages/standalone/tests/api/operator-tasks-handler.test.ts \
  packages/standalone/tests/agent/task-tools.test.ts \
  packages/standalone/tests/code-act/host-bridge.test.ts
git commit -m "feat(standalone): expose exact task due times"
```

---

## Task 4: Implement generation ownership and atomic enqueue/retry primitives

**Files:**

- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/src/operator/workorder-publishers.ts`
- Modify: `packages/standalone/src/operator/workorder-consumer.ts`
- Modify: `packages/standalone/tests/operator/workorder-publishers.test.ts`
- Modify: `packages/standalone/tests/operator/workorder-consumer.test.ts`
- Create: `packages/standalone/tests/operator/temporal-generations.test.ts`

### Step 1: Write failing generation transaction tests

Prove:

- first enqueue creates `active` generation and pending system row atomically;
- duplicate stable key does not create another generation/open row;
- initial and deferred check keys differ;
- retry reuses the same generation key, creates a fresh row id, increments only
  `payload.attempts`, and updates `last_workorder_id` atomically;
- normal publisher input cannot set `attempts`;
- generic board/wiki/memory enqueue also rejects caller-supplied `attempts`, while internal retries
  still increment the stored counter exactly once;
- exhaustion makes the generation terminal and scanner-visible lookup cannot rearm it;
- reschedule-away-and-back and reopen use new epochs;
- superseding cancels old open rows and rejects old generation ownership.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-generations.test.ts \
  tests/operator/workorder-publishers.test.ts
```

### Step 2: Add `temporal` kind and bounded payload

Extend `WORKORDER_KINDS`, `WorkOrderKind`, publisher payload validation, and retry budgets with
`temporal`. Payload contains only generation key, task id, epoch, occurrence, check instant, source
identifiers, and ledger-written attempts. Do not copy connector bodies.

Set `WORKORDER_MAX_ATTEMPTS.temporal = 3` in `workorder-consumer.ts` and add a focused assertion so
the exhaustive `Record<WorkOrderKind, number>` remains intentional.

### Step 3: Add explicit ledger transaction methods

Create narrow methods such as:

- `enqueueTemporalGeneration(input)`;
- `loadTemporalWorkContext(attemptId)`;
- `requeueTemporalWorkOrder(attemptId, reason)`;
- `exhaustTemporalWorkOrder(attemptId, reason)`;
- `supersedeTemporalGenerations(taskId, currentEpoch, excludeGenerationKey?)`.

Each method validates row state, generation disposition, attempt ownership, payload match, and open
row uniqueness within one SQLite transaction. Do not expose generic arbitrary generation updates.

Split the current enqueue path into a public normal enqueue that always initializes attempts to 1
and rejects any caller-provided `input.attempts`, plus a private/internal insert primitive that can
accept a ledger-computed attempts value. Generic `requeueWorkOrder()` and temporal retry transactions
must use only that internal primitive. Change `validateWorkOrderPayload()` to reject `attempts` from
all normal publishers; do not retain today's “allowed everywhere” exception.

### Step 4: Run focused tests and typecheck

Run the Step 1 command plus:

```bash
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/operator/workorder-publishers.ts \
  packages/standalone/src/operator/workorder-consumer.ts \
  packages/standalone/tests/operator/temporal-generations.test.ts \
  packages/standalone/tests/operator/workorder-publishers.test.ts \
  packages/standalone/tests/operator/workorder-consumer.test.ts
git commit -m "feat(standalone): add temporal workorder generations"
```

---

## Task 5: Build the deterministic temporal scanner

**Files:**

- Create: `packages/standalone/src/operator/temporal-reconcile.ts`
- Create: `packages/standalone/tests/operator/temporal-reconcile.test.ts`

### Step 1: Write failing pure candidate-selection tests

Inject `now`, IANA zone, and caps. Cover one millisecond before/equal/after exact due, due deferred
checks, date-only today/overdue, closed/finalized tasks, active/terminal generations, offset-derived
date boundaries, and ordering. Assert per tick:

- exact/deferred high-priority candidates first, max 4;
- date-only activation max 1 at normal priority;
- stop when 10 temporal workorders are open;
- repeated ticks create no duplicate;
- boot scan and interval scan use the same candidate logic.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/operator/temporal-reconcile.test.ts
```

### Step 2: Implement pure selection and stable key builders

Keep selection and generation-key creation exportable and side-effect free. Query only bounded task
and generation fields. Use due/deferred check before date backlog.

### Step 3: Implement scheduler lifecycle

`TemporalReconcileScheduler` gets ledger port, injected clock/zone, timer functions, caps, and logger.
`tick()` uses `enqueueTemporalGeneration()` only; it never changes lifecycle status or final markers.
`start()` rejects double start, uses 60 seconds by default, and `stop()` prevents DB-close races.

### Step 4: Run tests and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-reconcile.test.ts \
  tests/operator/temporal-generations.test.ts
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/temporal-reconcile.ts \
  packages/standalone/tests/operator/temporal-reconcile.test.ts
git commit -m "feat(standalone): schedule due task reconciliation"
```

---

## Task 6: Implement the atomic temporal effect transaction

**Files:**

- Create: `packages/standalone/src/operator/temporal-effect.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Create: `packages/standalone/tests/operator/temporal-effect.test.ts`

### Step 1: Write failing transaction invariant tests

Use real SQLite and cover all outcome rows from the design table:

- `resolved` requires an actual owner status or due change;
- `final_no_update` requires reason plus evidence summary;
- `deferred` requires a strictly future check and forbids lifecycle/due changes;
- invalid/no-op input writes nothing;
- trusted task/generation/epoch/occurrence/check/attempt mismatch rejects;
- stale revision rejects;
- workorder must be `in_progress`, generation `active`, and owned by this attempt;
- success atomically writes exactly one task revision, old-occurrence marker or future check,
  `last_temporal_checked_at = now`, `last_temporal_attempt_id = context.attemptId`, immutable receipt,
  exact-scope no-update where required, terminal generation disposition, and
  `in_progress -> done`;
- rescheduling finalizes the old occurrence and supersedes every other older generation but not its
  own resolved generation;
- rollback at any validation/write failure leaves every table unchanged;
- a second call for the same attempt cannot alter the immutable receipt.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/operator/temporal-effect.test.ts
```

### Step 2: Define narrow model input and trusted host context types

In `temporal-effect.ts`, define the discriminated model input and a separate `TemporalWorkContext`
containing task id, generation key, epoch, occurrence, check, attempt id, and captured revision.
Only TaskLedger may construct context from claimed payload plus matching generation/task rows.

### Step 3: Implement one public atomic ledger method

Expose a method accepting `(TemporalWorkContext, TemporalReconcileInput, now)`. Perform all
validation and changes in one DB transaction. Derive the no-update scope in host code as
`temporal:<task-id>:<occurrence-key>:<check-at>`. Return only a bounded receipt projection.

Every successful outcome, including `final_no_update` and `deferred`, stamps
`last_temporal_checked_at` from the injected transaction clock and `last_temporal_attempt_id` from
trusted context in the same single revision update. Failure/rollback must leave both unchanged.

Do not call the existing external no-update writer outside the transaction; reuse/extract its SQL
storage primitive so the note shares the same commit.

### Step 4: Run focused tests and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-effect.test.ts \
  tests/operator/task-ledger.test.ts
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/temporal-effect.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/tests/operator/temporal-effect.test.ts
git commit -m "feat(standalone): commit verified temporal effects atomically"
```

---

## Task 7: Expose the dedicated mutation under trusted TemporalWorkContext

**Files:**

- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/agent/task-tools.test.ts`
- Modify: `packages/standalone/tests/contract/reactive-envelope-tool-path.test.ts`
- Create: `packages/standalone/tests/agent/temporal-work-context.test.ts`

### Step 1: Write failing authority and stale-context tests

Prove:

- `task_temporal_reconcile` is unavailable without trusted context;
- model fields cannot provide/override task id, attempt id, epoch, occurrence, generation, or check;
- valid context plus narrow input commits and returns receipt;
- stale/superseded context returns `workorder_superseded` or a typed conflict;
- reads remain allowed after supersession;
- every write-capable function available to the temporal role, including `report_publish`, rechecks
  active attempt ownership and is denied after supersession;
- temporal `report_publish` accepts only the host-derived `pipeline` slot and rejects every other or
  custom slot before calling the live publisher;
- nested Code-Act retains the exact trusted context.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/agent/temporal-work-context.test.ts \
  tests/agent/task-tools.test.ts
```

### Step 2: Add trusted context without fallback widening

Add optional `temporalWorkContext` to `GatewayToolExecutionContext`/`AgentLoopOptions` and active
executor context. Update `buildAgentToolExecutionContext()` in `agent-loop.ts` to copy the field and
include it in its non-empty check. Propagate it through nested Code-Act contexts. Never merge it from
fallback state into an unrelated turn and never read it from tool input.

In the workorder `runOptionsFor` callback, call `TaskLedger.loadTemporalWorkContext(wo.id)` only for
the claimed temporal row, fail the run if payload/generation/task validation does not match, and
attach the resulting context to host-built run options. Add a context-builder test that proves the
field reaches gateway execution and is absent from non-temporal runs.

### Step 3: Register and execute the narrow tool

Add `task_temporal_reconcile` to the tool-name union, registry, host bridge, and executor switch.
Validate only the documented model input; pass trusted context separately into the ledger atomic
method.

Add a centralized pre-write guard that asks TaskLedger whether the temporal attempt is still active.
Apply it to every write-capable tool reachable by the temporal role. Keep read-only tools available.

For report publication, enforce the concrete affected-slot contract as `pipeline` only when
`TemporalWorkContext` is present. This is a host-side key whitelist applied before the global
publisher. `agent_notices` is read-only in this codebase; there is no model-callable owner-notice
write to expose. Owner escalation remains the consumer's host-only `noticeOwner`/ops-alarm path on
retry exhaustion and therefore cannot be invoked by stale model code.

### Step 4: Generate docs, test, and typecheck

```bash
pnpm --dir packages/standalone build
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/agent/temporal-work-context.test.ts \
  tests/agent/task-tools.test.ts \
  tests/contract/reactive-envelope-tool-path.test.ts \
  tests/envelope/code-act-context.test.ts
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/agent/types.ts \
  packages/standalone/src/agent/agent-loop.ts \
  packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/src/agent/tool-registry.ts \
  packages/standalone/src/agent/code-act/host-bridge.ts \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/src/agent/gateway-tools.md \
  packages/standalone/tests/agent/task-tools.test.ts \
  packages/standalone/tests/contract/reactive-envelope-tool-path.test.ts \
  packages/standalone/tests/agent/temporal-work-context.test.ts
git commit -m "feat(standalone): add trusted temporal reconcile tool"
```

---

## Task 8: Add temporal brief, role, connector scope, and required verdict hook

**Files:**

- Create: `packages/standalone/src/operator/temporal-worker.ts`
- Modify: `packages/standalone/src/operator/briefs.ts`
- Modify: `packages/standalone/src/operator/action-verifier.ts`
- Modify: `packages/standalone/src/operator/workorder-hooks.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/operator/briefs.test.ts`
- Modify: `packages/standalone/tests/operator/action-verifier.test.ts`
- Modify: `packages/standalone/tests/operator/workorder-hooks.test.ts`
- Modify: `packages/standalone/tests/cli/code-act-policy.test.ts`
- Create: `packages/standalone/tests/operator/temporal-worker.test.ts`

### Step 1: Write failing worker policy tests

Assert the temporal role has only:

- native task read and `task_temporal_reconcile`;
- `context_compile` and configured read-only `kagemusha_*` evidence;
- `schedule_upcoming`;
- `report_publish`, host-restricted to the `pipeline` slot, plus read-only `agent_notices`;
- Trello raw connector evidence under the host-issued temporal principal.

Assert it does not receive generic `task_create`, `task_update`, shell/file/system control, arbitrary
connector writes, or memory writes. Prove the brief requires one of the three mutation outcomes and
treats connector text as evidence, not instruction.

In focused verifier/hook tests, require the receipt to match attempt, task, occurrence, and captured
`before_revision`; require `after_revision = before_revision + 1` exactly and the outcome-specific
markers/note.
Then commit a valid receipt and perform a later legitimate owner update before audit. The audit must
return a successful `verified_superseded` result from immutable receipt evidence rather than failing
because the current task revision is newer. An unrelated task write or receipt from a prior retry
must still fail.

Run the policy matrix for both `runtimeBackend: 'codex'` and `runtimeBackend: 'claude'`. Assert the
advertised host-tool catalog and the executor's effective allowed set are identical. This guards the
current asymmetry where startup attaches `agentContext` only for Codex and Claude otherwise sees an
unfiltered catalog/role.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-worker.test.ts \
  tests/operator/briefs.test.ts \
  tests/operator/action-verifier.test.ts \
  tests/operator/workorder-hooks.test.ts \
  tests/cli/code-act-policy.test.ts
```

### Step 2: Build the focused worker contract

Create bounded payload validation/context construction and a brief builder in
`temporal-worker.ts`. Register the default brief through `briefs.ts`. Do not put business rules into
`start.ts` closures.

Create one backend-neutral workorder policy builder that returns both the `AgentContext` and a
filtered gateway-tool prompt from the same allowed-tool set. Rename/remove the Codex-specific helper
rather than maintaining a second Claude list.

### Step 3: Add runtime policy and connector parity

Rename `WORKORDER_CODE_ACT_POLICIES` to a backend-neutral workorder policy map, extend it and daemon
connector scoping for `workorder-temporal`. Trello is read-only evidence via existing connector
plumbing. Kagemusha remains read-only project truth.

Attach the resulting `agentContext` and filtered system tool catalog for both Claude and Codex runs.
Codex may still use native host-tool injection and Claude its existing outer transport, but both must
reach the same role enforcement and see the same inner functions. A missing backend-neutral role is
a boot/run failure, never an allow-all fallback.

Implement receipt auditing in `action-verifier.ts` and compose/register it from
`workorder-hooks.ts`, matching the existing verification ownership boundary. Register that temporal
completion hook with `verdictRequired: true` in runtime wiring. It reads the immutable receipt and
task/generation invariants and returns typed complete/fail; it never writes task markers.

If the current task revision still equals the receipt's `after_revision`, verify its current
outcome-specific state. If a legitimate later writer has advanced it, accept the immutable receipt
as `verified_superseded` only after proving `after_revision = before_revision + 1` plus its
attempt/occurrence invariants; the next scanner tick owns the newer epoch/state. The same exact
one-revision rule applies during boot recovery when the in-memory snapshot is unavailable.

### Step 4: Run focused tests and typecheck

Run the Step 1 command plus:

```bash
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/temporal-worker.ts \
  packages/standalone/src/operator/briefs.ts \
  packages/standalone/src/operator/action-verifier.ts \
  packages/standalone/src/operator/workorder-hooks.ts \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/tests/operator/temporal-worker.test.ts \
  packages/standalone/tests/operator/briefs.test.ts \
  packages/standalone/tests/operator/action-verifier.test.ts \
  packages/standalone/tests/operator/workorder-hooks.test.ts \
  packages/standalone/tests/cli/code-act-policy.test.ts
git commit -m "feat(standalone): add temporal workorder role"
```

---

## Task 9: Make atomic completion authoritative in the consumer

**Files:**

- Modify: `packages/standalone/src/operator/workorder-consumer.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/tests/operator/workorder-consumer.test.ts`
- Create: `packages/standalone/tests/operator/temporal-workorder-recovery.test.ts`

### Step 1: Write failing completion/race/recovery tests

Cover:

- atomic effect marks row done; malformed marker, runner rejection, or audit throw cannot requeue;
- runner explanation/report-only/empty/missing verdict while row remains `in_progress` fails and
  retries;
- before every temporal failure/requeue and normal completion, authoritative row+receipt is read;
- state-read failure mutates nothing, enqueues in-memory unresolved effect, blocks new claims, and
  succeeds after recheck;
- crash before effect has stale in-progress with no receipt and retries normally;
- crash after effect sees done+receipt and performs no recovery/model rerun;
- superseded generation produces event only, consumes no retry, and raises no alarm;
- attempt three sets generation exhausted atomically and scanner cannot create a fourth.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-workorder-recovery.test.ts \
  tests/operator/workorder-consumer.test.ts
```

### Step 2: Add a narrow authoritative-effect ledger port

Extend `WorkOrderLedgerPort` only with typed methods required to inspect temporal attempt state and
perform temporal failure/requeue/exhaustion transactions. Existing kind paths remain unchanged.

### Step 3: Implement temporal terminal-state arbitration

On runner error, audit error, negative/missing verdict, and normal return:

1. re-read row, generation, and receipt;
2. if done+valid receipt, emit/log completion and do not mutate;
3. if superseded/cancelled, emit superseded and stop without alarm;
4. if still in progress, apply required verdict or temporal failure transaction;
5. if the read throws, mutate nothing and put attempt in an in-memory unresolved queue processed
   before the next claim.

Do not infer effect success from a tool trace or response marker.

### Step 4: Run focused tests and typecheck

Run the Step 1 command plus:

```bash
pnpm --dir packages/standalone typecheck
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/workorder-consumer.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/tests/operator/workorder-consumer.test.ts \
  packages/standalone/tests/operator/temporal-workorder-recovery.test.ts
git commit -m "feat(standalone): arbitrate temporal completion from receipts"
```

---

## Task 10: Wire feature validation and scheduler lifecycle through a focused factory

**Files:**

- Create: `packages/standalone/src/operator/temporal-runtime.ts`
- Modify: `packages/standalone/src/operator/task-ledger.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Create: `packages/standalone/tests/operator/temporal-runtime.test.ts`
- Modify: `packages/standalone/tests/operator/temporal-generations.test.ts`
- Modify: `packages/standalone/tests/cli/code-act-policy.test.ts`

### Step 1: Write failing boot/lifecycle tests

Prove:

- default/off creates no temporal timer or role registration;
- `MAMA_TEMPORAL_RECONCILE=on` with Stage-2 not `on` fails before any timer starts;
- an incompatible backend/tool transport fails before timers start;
- boot with temporal off or Stage-2 off/shadow atomically cancels every open temporal row before the
  generic consumer can claim/recover it while keeping its generation durably resumable;
- a later valid on-mode atomically creates one replacement row for each paused active generation,
  preserves its last stored attempts count, and never creates a parallel row;
- `on -> off`, `on -> shadow`, and `off -> on` restart sequences neither execute work while disabled
  nor strand an active generation;
- a stale in-progress temporal row is paused before generic stale recovery when disabled, but follows
  the normal retry budget when enabled;
- valid on-mode resumes paused generations, performs stale recovery, runs the boot temporal scan,
  then starts the interval in that order;
- shutdown awaits scanner/consumer and closes in safe order;
- only one scanner timer/PID path is constructed per daemon start.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-runtime.test.ts \
  tests/cli/code-act-policy.test.ts
```

### Step 2: Implement feature resolution and capability validation

In `temporal-runtime.ts`, parse only `off|on`, default off, validate Stage-2 and effective tool
capability, capture daemon IANA zone once, and construct scheduler/hook lifecycle. Return explicit
`boot()`/`stop()` methods to `start.ts`.

Add ledger transactions for the operational rollback state:

- `pauseActiveTemporalWork(reason)` cancels pending/in-progress temporal rows but leaves their
  generation `active`; this is a control-plane pause, not a business `superseded` outcome;
- `resumePausedTemporalWork()` finds an active generation with no open row, reads the attempts count
  from its last cancelled row, and inserts exactly one pending replacement without incrementing the
  counter.

Run pause before generic Stage-2 cleanup/recovery whenever temporal is off or Stage-2 is off/shadow.
Run resume only after feature/backend validation succeeds and before stale-claim recovery/boot scan.
The existing fixed generation dispositions remain unchanged; `active` is the durable resumable state.

### Step 3: Keep `start.ts` declarative

Wire the factory, host dependencies, brief/policy registration, and lifecycle calls. Do not add
candidate SQL, transaction code, or verification decisions to `start.ts`.

### Step 4: Run focused tests, typecheck, and build

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/temporal-runtime.test.ts \
  tests/operator/temporal-reconcile.test.ts \
  tests/cli/code-act-policy.test.ts
pnpm --dir packages/standalone typecheck
pnpm --dir packages/standalone build
```

### Step 5: Commit

```bash
git add packages/standalone/src/operator/temporal-runtime.ts \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/tests/operator/temporal-runtime.test.ts \
  packages/standalone/tests/operator/temporal-generations.test.ts \
  packages/standalone/tests/cli/code-act-policy.test.ts
git commit -m "feat(standalone): wire temporal reconciliation runtime"
```

---

## Task 11: Project temporal state on the board and correct report language

**Files:**

- Create: `packages/standalone/ui/src/lib/task-temporal.ts`
- Modify: `packages/standalone/ui/src/api/client.ts`
- Modify: `packages/standalone/ui/src/components/TaskRow.tsx`
- Modify: `packages/standalone/ui/src/pages/Tasks.tsx`
- Create: `packages/standalone/tests/ui/task-temporal.test.ts`
- Modify: `packages/standalone/src/operator/board-slot-instructions.ts`
- Modify: `packages/standalone/src/operator/board-reconcile.ts`
- Modify: `packages/standalone/src/operator/worker-run.ts`
- Modify: `packages/standalone/src/multi-agent/dashboard-agent-persona.ts`
- Modify: corresponding focused prompt tests

### Step 1: Write failing projection and wording tests

Assert exact overdue is rendered as a separate temporal badge/fact while lifecycle status remains
unchanged. Cover closed, upcoming, due, overdue, and unscheduled states. Prompt tests must distinguish:

- temporal fact (“overdue since ...”);
- workflow judgment (“blocked”, “done”, etc.);
- system condition (“reconciliation retrying/authority unavailable”).

They must forbid guessing completion from calendar disappearance or copying Trello/Kagemusha status.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/ui/task-temporal.test.ts \
  tests/operator/board-reconcile.test.ts \
  tests/operator/worker-run.test.ts \
  tests/multi-agent/system-agent-unification.test.ts
```

### Step 2: Implement UI projection from API temporal state

Use the server-derived state as the canonical category and format exact time locally for display.
Do not infer workflow status or mutate tasks from the UI helper.

### Step 3: Update board/report guidance

Teach workers to capture `due_at` only from trusted, unambiguous time+zone evidence and otherwise
retain date-only precision. Preserve the three-store boundary.

### Step 4: Run focused tests and UI build

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/ui/task-temporal.test.ts \
  tests/operator/board-reconcile.test.ts \
  tests/operator/worker-run.test.ts \
  tests/multi-agent/system-agent-unification.test.ts
pnpm --dir packages/standalone build
```

### Step 5: Commit

```bash
git add packages/standalone/ui/src/lib/task-temporal.ts \
  packages/standalone/ui/src/api/client.ts \
  packages/standalone/ui/src/components/TaskRow.tsx \
  packages/standalone/ui/src/pages/Tasks.tsx \
  packages/standalone/tests/ui/task-temporal.test.ts \
  packages/standalone/src/operator/board-slot-instructions.ts \
  packages/standalone/src/operator/board-reconcile.ts \
  packages/standalone/src/operator/worker-run.ts \
  packages/standalone/src/multi-agent/dashboard-agent-persona.ts \
  packages/standalone/tests/operator/board-reconcile.test.ts \
  packages/standalone/tests/operator/worker-run.test.ts \
  packages/standalone/tests/multi-agent/system-agent-unification.test.ts
git commit -m "feat(standalone): show temporal task state on board"
```

---

## Task 12: Prove the 14:00 vertical slice and failure matrix

**Files:**

- Create: `packages/standalone/tests/operator/temporal-workorder-integration.test.ts`
- Modify focused source/tests only when the integration test exposes a real contract gap

### Step 1: Write the end-to-end in-memory integration harness

Use real `TaskLedger`, scheduler, consumer, gateway executor, and atomic mutation; fake only model
response/evidence transport and clock. Cover:

1. create at 13:50 with 14:00 due; no work before 14:00;
2. at exactly 14:00 enqueue exactly one generation/order;
3. evidence-backed status update writes receipt and completes;
4. explanation-only/report-only/empty/denied attempts fail verification and retry;
5. reschedule to 15:00 creates a new epoch/occurrence and old late write is denied without alarm;
6. deferred result schedules a distinct future generation;
7. restart before transaction retries without duplicate; restart after transaction does not rerun;
8. due-today date-only enrichment may add explicit due only from unambiguous evidence;
9. three failures exhaust and repeated scans never create attempt four;
10. backlog caps protect exact/deferred work.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/operator/temporal-workorder-integration.test.ts
```

Expected initially: fail at the first uncovered integration gap; fix only the narrow owning module,
add a focused regression assertion there, and rerun until green.

### Step 2: Run the complete temporal focused suite

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/operator-task-temporal-migration.test.ts \
  tests/operator/task-temporal.test.ts \
  tests/operator/temporal-generations.test.ts \
  tests/operator/temporal-reconcile.test.ts \
  tests/operator/temporal-effect.test.ts \
  tests/operator/temporal-worker.test.ts \
  tests/operator/temporal-workorder-recovery.test.ts \
  tests/operator/temporal-runtime.test.ts \
  tests/operator/temporal-workorder-integration.test.ts \
  tests/agent/temporal-work-context.test.ts \
  tests/ui/task-temporal.test.ts
```

### Step 3: Commit

```bash
git add packages/standalone/tests/operator/temporal-workorder-integration.test.ts \
  packages/standalone/src packages/standalone/tests
git commit -m "test(standalone): cover temporal reconciliation vertical slice"
```

Before committing, inspect `git diff --cached --name-only` and unstage any unrelated file; the broad
path in the command is only for files intentionally changed while closing integration gaps.

---

## Task 13: Update documentation and configuration reference

**Files:**

- Modify: `packages/standalone/README.md`
- Modify: `docs/explanation/architecture.md`
- Modify: `docs/guides/standalone-setup.md`
- Modify: `docs/reference/api.md`
- Modify: `docs/reference/configuration-options.md`

### Step 1: Document the exact contracts

Document:

- `due_at` validation/normalization and legacy date-only compatibility;
- derived temporal states separate from lifecycle;
- `MAMA_TEMPORAL_RECONCILE=off|on`, default off, and Stage-2/backend prerequisites;
- one-minute scan, caps, retry budget, stale recovery, exhaustion, and deferred checks;
- trusted atomic mutation and observable failure behavior;
- Trello evidence, Kagemusha read-only project truth, native ledger owner truth.

Do not promise direct Trello writes, automatic lifecycle guesses, exactly-once external alarms, or
Release B owner-message enforcement.

### Step 2: Run documentation consistency searches

```bash
rg -n "due_at|temporal_state|MAMA_TEMPORAL_RECONCILE|temporal workorder" \
  packages/standalone/README.md docs packages/standalone/src/operator
rg -n "Trello|Kagemusha|native.*ledger" \
  packages/standalone/README.md docs/explanation docs/guides docs/reference
```

Manually reconcile conflicting claims and verify all new environment variables and API fields appear
in their reference pages.

### Step 3: Commit

```bash
git add packages/standalone/README.md \
  docs/explanation/architecture.md \
  docs/guides/standalone-setup.md \
  docs/reference/api.md \
  docs/reference/configuration-options.md
git commit -m "docs: document temporal reconciliation"
```

---

## Task 14: Full verification, security review, and controlled canary

**Files:**

- Modify only files required by verified findings

### Step 1: Run static and full automated verification

```bash
pnpm --dir packages/standalone typecheck
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone test
pnpm --dir packages/standalone build
pnpm typecheck
pnpm test
pnpm build
```

Every command must exit 0. Preserve the repository's single-fork Vitest configuration.

### Step 2: Run independent review gates

Use `superpowers:requesting-code-review` for the full A2 diff and the project security review skill
for these trust boundaries:

- model cannot supply/override TemporalWorkContext or attempt id;
- stale/superseded workers cannot perform any write-capable gateway call;
- receipt/workorder/generation/task commit is truly one transaction;
- no raw connector body, full prompt, token, personal data, or full model output reaches logs;
- feature-on incompatibility fails before timers start;
- no existing workorder kind accidentally receives strict verdict semantics.

Resolve all findings, rerun focused tests for each fix, then rerun Step 1.

### Step 3: Commit review fixes

Use one bounded commit per coherent finding, for example:

```bash
git commit -m "fix(standalone): reject stale temporal gateway writes"
```

Never combine generated artifacts or unrelated user changes without inspecting the staged diff.

### Step 4: Build and restart one local daemon instance

With the user's already-approved local runtime scope:

1. build the final standalone package;
2. stop the existing daemon gracefully;
3. start exactly one instance with Stage-2 on and temporal feature first off;
4. verify health and a single PID;
5. enable the temporal feature for the canary only after capability validation succeeds.

Record commands, exit codes, PID count, health output, and timestamps. Never print tokens, connector
payloads, full prompts, or private task text.

### Step 5: Run a disposable near-term canary

Create a clearly disposable native owner task with an exact due time a few minutes ahead. Observe:

- one generation and workorder at the boundary;
- correlated attempt id in bounded audit details;
- scoped evidence access;
- atomic receipt/task/generation/workorder completion;
- board overdue rendering before judgment;
- cleanup through normal task cancellation, not destructive DB editing.

Repeat with an intentionally denied envelope and verify retry plus bounded alarm. Inspect daemon logs
for secret/private-data leakage and single-PID health. If any safety check fails, disable
`MAMA_TEMPORAL_RECONCILE` and keep the code unreleased until fixed.

### Step 6: Final release gate

Only after automated verification, reviews, and canary pass, continue with the repository's approved
PR/review/merge/release/deploy workflow. Release A2 remains feature-off by default; production
cutover is an explicit configuration action after deployment health is confirmed.

# Board Claim Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse owner-event Board bursts into one pending full repair by making the existing system workorder `due_at` a claim-not-before boundary.

**Architecture:** `TaskLedger` adds one generic readiness predicate to its existing serial claim query. `OwnerEventBoardRefreshLedger` remains the sole owner of the twenty-minute Board window, pending payload widening, promotion, and empty-row cancellation; API routes only select whether an existing pending repair remains delayed or becomes ready now. No new service, worker, timer, queue, table, column, or hash is introduced.

**Tech Stack:** TypeScript, better-sqlite3 through `src/sqlite.ts`, Vitest, pnpm workspaces.

**Spec:** `docs/development/runtime-overhead-canary-remediation-design.md`

## Global Constraints

- Preserve TG-03, TG-04, TG-05, and TG-06 behavior from `docs/development/kagemusha-telegram-parity.md`.
- Reuse `operator_tasks.due_at`; do not add a migration or schema field.
- The fixed owner-event Board claim window is exactly `20 * 60 * 1000` milliseconds.
- The first accepted intent fixes the deadline; later intents may widen the pending generation but may not extend the deadline.
- Manual forced Board work remains immediate and uniquely keyed.
- Owner tasks and Temporal `due_at` behavior remain unchanged.
- Tests remain single-fork; do not enable parallel Vitest workers.
- Use no nested Codex CLI process.

---

## File map

| File                                                                      | Responsibility                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/standalone/src/operator/task-ledger.ts`                         | Generic claim eligibility for system workorders              |
| `packages/standalone/src/operator/owner-event-board-refresh.ts`           | Fixed window, payload widening, promotion, cancellation      |
| `packages/standalone/src/cli/runtime/api-routes-init.ts`                  | Existing boot/follow-up/scheduled route selection            |
| `packages/standalone/tests/operator/task-ledger.test.ts`                  | Ready-row selection regressions                              |
| `packages/standalone/tests/operator/owner-event-board-refresh.test.ts`    | Durable window and generation state transitions              |
| `packages/standalone/tests/cli/start-board-refresh-gate.test.ts`          | Owner request behavior at the real start handler             |
| `packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts` | Boot, schedule, terminal follow-up, and forced-repair wiring |
| `docs/development/kagemusha-telegram-parity.md`                           | TG-05/TG-06 evidence after implementation                    |

### Task 1: Make system workorder claims honor existing `due_at`

**Files:**

- Modify: `packages/standalone/src/operator/task-ledger.ts:3226-3259`
- Test: `packages/standalone/tests/operator/task-ledger.test.ts:518-541`

**Interfaces:**

- Consumes: `TaskLedgerOptions.now: () => number` and existing `operator_tasks.due_at`.
- Produces: unchanged `claimNextWorkOrder(): WorkOrderRecord | null`, now selecting only `due_at IS NULL OR due_at <= now()`.

- [ ] **Step 1: Write the failing readiness tests**

```ts
it('skips a future high-priority row without blocking a ready lower-priority row', () => {
  const delayed = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: 'board:delayed',
    input: {},
    priority: 'high',
  });
  const ready = ledger.enqueueWorkOrder({
    workKind: 'wiki',
    idempotencyKey: 'wiki:ready',
    input: {},
    priority: 'normal',
  });
  db.prepare(`UPDATE operator_tasks SET due_at = ? WHERE id = ?`).run(now + 1_000, delayed.id);

  expect(ledger.claimNextWorkOrder()?.id).toBe(ready.id);
  expect(ledger.claimNextWorkOrder()).toBeNull();
  now += 1_000;
  expect(ledger.claimNextWorkOrder()?.id).toBe(delayed.id);
});

it('claims a system row exactly at due_at', () => {
  const row = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: 'board:due',
    input: {},
  });
  db.prepare(`UPDATE operator_tasks SET due_at = ? WHERE id = ?`).run(now, row.id);
  expect(ledger.claimNextWorkOrder()?.id).toBe(row.id);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @jungjaehoon/mama-os exec vitest run tests/operator/task-ledger.test.ts
```

Expected: the future high-priority Board row is claimed before the ready Wiki row.

- [ ] **Step 3: Add the minimal claim predicate**

```ts
const claimAt = this.now();
const row = this.db
  .prepare(
    `SELECT * FROM operator_tasks
     WHERE kind = 'system' AND status = 'pending'
       AND source_channel IN (${KNOWN_WORKORDER_CHANNELS_SQL})
       AND (due_at IS NULL OR due_at <= ?)
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC,
              id ASC
     LIMIT 1`
  )
  .get(...KNOWN_WORKORDER_CHANNELS, claimAt) as TaskRow | undefined;
```

Use the same `claimAt` for `updated_at` so one claim has one clock observation.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run the Task 1 command. Expected: PASS with existing priority, future-version, retry, and Temporal cases unchanged.

- [ ] **Step 5: Commit the independently useful claim behavior**

```bash
git add packages/standalone/src/operator/task-ledger.ts packages/standalone/tests/operator/task-ledger.test.ts
git commit -m "fix(operator): honor system workorder due time"
```

### Task 2: Give owner-event Board repairs one fixed durable window

**Files:**

- Modify: `packages/standalone/src/operator/owner-event-board-refresh.ts:1-247`
- Test: `packages/standalone/tests/operator/owner-event-board-refresh.test.ts:1-220`

**Interfaces:**

- Consumes: existing `BoardWorkOrderPort.enqueueWorkOrder()` and `boardRepairKey()`.
- Produces: `OWNER_EVENT_BOARD_CLAIM_WINDOW_MS`, plus `attachPendingToWorkOrder(workOrderId: number, options?: { readyNow?: boolean }): number`.
- Preserves: `accept()`, `markVerified()`, `consumePostTerminalFollowup()`, and acceptance record shapes.

- [ ] **Step 1: Write failing fixed-window and widening tests**

```ts
it('fixes due_at on the first intent and widens only the pending payload', () => {
  const first = ledger.accept({
    batchId: enqueueBatch(['evt-1']),
    eventIds: ['evt-1'],
    repair: { repairGeneration: 11, noUpdateScope: 'full:11' },
  });
  const firstRow = db
    .prepare(`SELECT due_at FROM operator_tasks WHERE id = ?`)
    .get(first.workOrderId) as {
    due_at: number | null;
  };
  expect(firstRow.due_at).toBe(1_201_000);

  now = 61_000;
  ledger.accept({
    batchId: enqueueBatch(['evt-2']),
    eventIds: ['evt-2'],
    repair: { repairGeneration: 12, noUpdateScope: 'full:12' },
  });
  const pending = tasks.findWorkOrderByOccurrence('board', boardRepairKey());
  expect(pending?.payload).toMatchObject({ repairGeneration: 12, noUpdateScope: 'full:12' });
  const widenedRow = db
    .prepare(`SELECT due_at FROM operator_tasks WHERE id = ?`)
    .get(first.workOrderId) as {
    due_at: number | null;
  };
  expect(widenedRow.due_at).toBe(1_201_000);
});

it('does not mutate an in-progress repair and delays one post-terminal replacement', () => {
  const first = ledger.accept({
    batchId: enqueueBatch(['evt-1']),
    eventIds: ['evt-1'],
    repair: { repairGeneration: 20, noUpdateScope: 'full:20' },
  });
  now = 1_201_000;
  expect(tasks.claimNextWorkOrder()?.id).toBe(first.workOrderId);
  ledger.accept({
    batchId: enqueueBatch(['evt-2']),
    eventIds: ['evt-2'],
    repair: { repairGeneration: 21, noUpdateScope: 'full:21' },
  });
  expect(tasks.findWorkOrderByOccurrence('board', boardRepairKey())?.payload.repairGeneration).toBe(
    20
  );
});
```

Add the cancellation case:

```ts
it('cancels an empty delayed repair after another verified full run applies its intents', () => {
  const accepted = ledger.accept({
    batchId: enqueueBatch(['evt-applied-elsewhere']),
    eventIds: ['evt-applied-elsewhere'],
    repair: { repairGeneration: 30, noUpdateScope: 'full:30' },
  });

  expect(ledger.markVerified(accepted.workOrderId, 30)).toEqual({
    applied: 1,
    followupPending: false,
  });
  const row = db
    .prepare(`SELECT status FROM operator_tasks WHERE id = ?`)
    .get(accepted.workOrderId) as {
    status: string;
  };
  expect(row.status).toBe('cancelled');
  now = 1_201_000;
  expect(tasks.claimNextWorkOrder()).toBeNull();
});
```

- [ ] **Step 2: Run the owner-event ledger test and confirm RED**

```bash
pnpm --filter @jungjaehoon/mama-os exec vitest run tests/operator/owner-event-board-refresh.test.ts
```

Expected: `due_at` is null, the pending payload remains at the first generation, and the empty delayed row remains pending.

- [ ] **Step 3: Implement the fixed window inside the existing ledger**

```ts
export const OWNER_EVENT_BOARD_CLAIM_WINDOW_MS = 20 * 60 * 1000;

export interface AttachPendingBoardWorkOptions {
  readyNow?: boolean;
}
```

Replace `accept()`'s deferred wrapper with explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. After inserting the exact intent, call a private binding helper that:

```ts
const generation = this.maxPendingGeneration();
const currentGeneration = Number.isSafeInteger(publisherPayload.repairGeneration)
  ? (publisherPayload.repairGeneration as number)
  : generation;
const repairGeneration = Math.max(currentGeneration, generation);
const dueAt = options.readyNow ? now : (row.due_at ?? now + OWNER_EVENT_BOARD_CLAIM_WINDOW_MS);
const payload = {
  ...JSON.parse(row.payload),
  repairGeneration,
  noUpdateScope: boardFullNoUpdateScope(repairGeneration),
};
validateWorkOrderPayload('board', payload);
```

Only update `payload`, `due_at`, and `updated_at` when the workorder is still `pending`. Reattach unapplied intent rows to the replacement ID in the same transaction. If the row is already `in_progress`, leave its payload and due time immutable.

Wrap public `attachPendingToWorkOrder()` in its own `BEGIN IMMEDIATE` transaction and call the same private helper. In `markVerified()`, update applicable intents and cancel only a pending `boardRepairKey()` row for which no unapplied intent remains:

```sql
UPDATE operator_tasks
   SET status = 'cancelled', latest_event = ?, updated_at = ?
 WHERE kind = 'system'
   AND source_channel = 'workorder:board'
   AND source_event_id = ?
   AND status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM owner_event_board_refresh_intents intent
      WHERE intent.workorder_id = operator_tasks.id AND intent.applied_at IS NULL
   )
```

- [ ] **Step 4: Run the ledger tests and confirm GREEN**

Run the Task 2 command. Expected: fixed deadline, widened generation, in-progress immutability, cancellation, retry identity, rollback, and retention cases all PASS.

- [ ] **Step 5: Commit the Board window state machine**

```bash
git add packages/standalone/src/operator/owner-event-board-refresh.ts packages/standalone/tests/operator/owner-event-board-refresh.test.ts
git commit -m "fix(operator): coalesce owner Board repairs before claim"
```

### Task 3: Wire boot, schedule, and terminal follow-up to the same pending row

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts:544-647`
- Modify: `packages/standalone/tests/cli/start-board-refresh-gate.test.ts:139-173`
- Modify: `packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts:320-455,630-880`

**Interfaces:**

- Consumes: `attachPendingToWorkOrder(workOrderId, { readyNow })` from Task 2.
- Produces: no new public runtime interface.
- Preserves: `requestBoardRepair(): void`, manual `/api/report/agent-refresh`, and existing timer cadence.

- [ ] **Step 1: Make the owner-handler test assert real delayed execution**

Change the harness clock to a mutable `now`, accept twenty intents, and assert:

```ts
expect(ctx.taskLedger.claimNextWorkOrder()).toBeNull();
ctx.setNow(20 * 60 * 1000 + 1_000);
expect(ctx.taskLedger.claimNextWorkOrder()?.payload).toMatchObject({
  mode: 'full',
  force: false,
  repairGeneration: 220,
  noUpdateScope: 'full:220',
});
```

This replaces the obsolete expectation that generation 201 claims immediately.

- [ ] **Step 2: Add RED API-route cases**

In `api-routes-init-reconcile.test.ts`, pin these existing paths:

```ts
// Boot recovery preserves the delayed row.
await vi.advanceTimersByTimeAsync(10_000);
expect(ledger.claimNextWorkOrder()).toBeNull();

// The normal scheduled tick promotes the same row rather than inserting another.
await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
expect(ledger.countPendingWorkOrders()).toBe(1);
expect(ledger.claimNextWorkOrder()?.id).toBe(accepted.workOrderId);
```

For a verified forced full repair, assert the attached delayed repair is cancelled and the next claim is null. For a late intent accepted during an in-progress run, assert terminal follow-up creates one new delayed row and it remains unclaimable until its own deadline.

- [ ] **Step 3: Run the two runtime tests and confirm RED**

```bash
pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/cli/start-board-refresh-gate.test.ts \
  tests/cli/runtime/api-routes-init-reconcile.test.ts
```

Expected: the current handler claims immediately and the scheduled route does not explicitly promote the delayed row.

- [ ] **Step 4: Make the minimal route change**

Keep `runDashboardAgent()` and the existing timers. After enqueue, when unapplied owner-event intents exist and the chosen occurrence is `boardRepairKey()`, call:

```ts
ownerEventBoardRefreshLedger?.attachPendingToWorkOrder(workOrder.id, {
  readyNow: !opts?.acceptedIntent,
});
```

`acceptedIntent: true` covers boot recovery and post-terminal follow-up, so those calls preserve/start the fixed window. A normal scheduled call uses `readyNow: true`, promoting the same pending row. Do not add a timer or polling loop.

- [ ] **Step 5: Run the runtime tests and confirm GREEN**

Run the Task 3 command. Expected: all existing boot, flag-off, forced, no-update, late-intent, and schedule cases PASS with updated delayed assertions.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add \
  packages/standalone/src/cli/runtime/api-routes-init.ts \
  packages/standalone/tests/cli/start-board-refresh-gate.test.ts \
  packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts
git commit -m "fix(runtime): promote delayed Board repair on schedule"
```

### Task 4: Verify PR-A and update parity evidence

**Files:**

- Modify: `docs/development/kagemusha-telegram-parity.md`

**Interfaces:**

- Consumes: completed Tasks 1-3.
- Produces: reviewable PR-A branch with TG-05/TG-06 evidence and no unrelated changes.

- [ ] **Step 1: Run focused tests together**

```bash
pnpm --filter @jungjaehoon/mama-os exec vitest run \
  tests/operator/task-ledger.test.ts \
  tests/operator/owner-event-board-refresh.test.ts \
  tests/cli/start-board-refresh-gate.test.ts \
  tests/cli/runtime/api-routes-init-reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package verification**

```bash
pnpm --filter @jungjaehoon/mama-os typecheck
pnpm --filter @jungjaehoon/mama-os build
pnpm --filter @jungjaehoon/mama-os test
```

Expected: all commands exit 0 under the repository's single-fork Vitest configuration.

- [ ] **Step 3: Update parity evidence with observed test names**

Add this evidence paragraph using the final test names from Tasks 1-3:

```markdown
- **TG-05/TG-06 Board claim-window evidence — 2026-08-26:** Owner-event bursts retain every exact
  batch intent while sharing one pending non-force repair whose existing `operator_tasks.due_at`
  blocks claim for twenty minutes. Tests `fixes due_at on the first intent and widens only the
pending payload`, `skips a future high-priority row without blocking a ready lower-priority row`,
  and `TG-06 promotes one delayed owner-event repair on the normal schedule` pin pre-claim
  generation widening, fixed-deadline preservation, ready lower-priority selection, scheduled
  promotion, in-progress immutability, and
  verified-generation-only application. This is code/test evidence; production cost remains gated
  by the post-release canary.
```

- [ ] **Step 4: Run formatting and bounded diff checks**

```bash
pnpm exec prettier --check \
  packages/standalone/src/operator/task-ledger.ts \
  packages/standalone/src/operator/owner-event-board-refresh.ts \
  packages/standalone/src/cli/runtime/api-routes-init.ts \
  packages/standalone/tests/operator/task-ledger.test.ts \
  packages/standalone/tests/operator/owner-event-board-refresh.test.ts \
  packages/standalone/tests/cli/start-board-refresh-gate.test.ts \
  packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts \
  docs/development/kagemusha-telegram-parity.md
git diff --check
git diff --stat main...HEAD
```

Expected: formatting and diff checks pass; the stat contains only the listed files.

- [ ] **Step 5: Commit evidence and hand off to code review**

```bash
git add docs/development/kagemusha-telegram-parity.md
git commit -m "docs: record Board claim-window parity evidence"
```

Do not bump a version or release from PR-A. Run the pre-landing review, clear all actionable findings, create the PR, clear CI and PR review comments, and merge before starting PR-B.

# Owner-Event Board Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace event-by-event forced Board full runs with one receipt-backed non-force repair plus at most one post-terminal follow-up obligation.

**Architecture:** Add one `OwnerEventBoardRefreshLedger` on the existing operator SQLite connection. It atomically binds each exact owner-event batch to the existing shared Board workorder, records verified application by repair generation, and exposes a run-local post-terminal follow-up signal. Keep `BoardRefreshGate`, `boardRepairKey()`, TaskLedger, effect verification, and OwnerEventLoop as the authorities they already are.

**Tech Stack:** TypeScript, better-sqlite3 through `SQLiteDatabase`, Vitest single-fork configuration, pnpm workspace, launchd runtime.

**Spec:** `docs/development/runtime-overhead-reduction-design.md`

## Global Constraints

- Preserve TG-03, TG-04, TG-05, and TG-06; update `docs/development/kagemusha-telegram-parity.md` with PR-A evidence.
- Preserve sender, role, envelope, scope, destination, path, idempotency, and durable receipt checks.
- Never derive batch identity, event IDs, repair generation, force, or idempotency key from model input.
- Manual owner Board refresh remains `mode: 'full', force: true` with a unique manual key.
- Owner-event Board refresh is `mode: 'full', force: false` with the shared `boardRepairKey()`.
- `BoardRefreshGate` is always constructed; `MAMA_BOARD_RECONCILE` controls only the delta reconcile scheduler.
- Do not add a model session, worker, queue, external dependency, append-only telemetry table, or fallback data path.
- New SQLite schema is additive and fail-loud; keep Vitest in its current single-fork configuration.
- Do not edit the three parked skip-worktree Viewer files.

---

## File Map

| File                                                                      | Responsibility                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/standalone/src/db/migrations/owner-event-board-refresh.ts`      | Additive intent table/index migration                       |
| `packages/standalone/src/operator/owner-event-board-refresh.ts`           | Durable batch-to-workorder ledger and post-terminal signal  |
| `packages/standalone/tests/operator/owner-event-board-refresh.test.ts`    | DDL, atomicity, duplicate/burst, cleanup, generation tests  |
| `packages/standalone/src/agent/types.ts`                                  | Closed `WorkOrderRequestOrigin` host contract               |
| `packages/standalone/src/agent/gateway-tool-executor.ts`                  | Derive origin from trusted execution state                  |
| `packages/standalone/src/cli/commands/start.ts`                           | Construct and wire ledger/gate, receipt recovery, nudge ref |
| `packages/standalone/src/operator/workorder-hooks.ts`                     | Apply intents only after verified full repair               |
| `packages/standalone/src/cli/runtime/api-routes-init.ts`                  | Always-on full gate and terminal-safe repair nudge          |
| `packages/standalone/tests/cli/start-board-refresh-gate.test.ts`          | Manual/owner-event request matrix                           |
| `packages/standalone/tests/agent/gateway-tool-executor.test.ts`           | Trusted origin and forged-input cases                       |
| `packages/standalone/tests/operator/workorder-hooks.test.ts`              | Verified-only generation application                        |
| `packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts` | Flag, nudge, no-hot-loop, boot cases                        |
| `packages/standalone/tests/cli/owner-event-wiring.test.ts`                | Production assembly pin                                     |
| `docs/development/kagemusha-telegram-parity.md`                           | TG evidence                                                 |

---

### Task 1: Durable Owner-Event Board Refresh Ledger

**Files:**

- Create: `packages/standalone/src/db/migrations/owner-event-board-refresh.ts`
- Create: `packages/standalone/src/operator/owner-event-board-refresh.ts`
- Create: `packages/standalone/tests/operator/owner-event-board-refresh.test.ts`

**Interfaces:**

- Consumes: `SQLiteDatabase`, `TaskLedger.enqueueWorkOrder()`, `boardRepairKey()`, `FullRepairCapture`.
- Migration produces `applyOwnerEventBoardRefreshMigration(db: SQLiteDatabase): void`; the ledger
  constructor invokes it after TaskLedger and OwnerEventInbox have created the referenced parent tables.
- Produces:

```ts
export interface OwnerEventBoardRefreshAcceptance {
  batchId: number;
  batchKey: string;
  repairGeneration: number;
  workOrderId: number;
  appliedAt: number | null;
}

export class OwnerEventBoardRefreshLedger {
  constructor(db: SQLiteDatabase, taskLedger: BoardWorkOrderPort, clock?: () => number);
  maxPendingGeneration(): number | null;
  accept(input: {
    batchId: number;
    eventIds: readonly string[];
    repair: FullRepairCapture;
  }): OwnerEventBoardRefreshAcceptance;
  findAcceptance(batchId: number): OwnerEventBoardRefreshAcceptance | null;
  attachPendingToWorkOrder(workOrderId: number): number;
  markVerified(
    workOrderId: number,
    capturedGeneration: number
  ): {
    applied: number;
    followupPending: boolean;
  };
  consumePostTerminalFollowup(workOrderId: number): boolean;
}
```

- [ ] **Step 1: Write failing acceptance and duplicate tests**

```ts
it('atomically binds one exact batch to one shared non-force Board workorder', () => {
  const accepted = ledger.accept({
    batchId: 1,
    eventIds: ['evt-b', 'evt-a'],
    repair: { repairGeneration: 11, noUpdateScope: 'full:11' },
  });
  expect(accepted).toMatchObject({ batchId: 1, repairGeneration: 11, appliedAt: null });
  expect(enqueued).toEqual([
    expect.objectContaining({
      workKind: 'board',
      idempotencyKey: 'board:full:repair',
      input: expect.objectContaining({ mode: 'full', force: false, repairGeneration: 11 }),
    }),
  ]);
});

it('returns the same acceptance for the same batch without enqueueing again', () => {
  const first = ledger.accept(input);
  expect(ledger.accept(input)).toEqual(first);
  expect(enqueued).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm --dir packages/standalone exec vitest run tests/operator/owner-event-board-refresh.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the additive migration and atomic accept**

```sql
CREATE TABLE IF NOT EXISTS owner_event_board_refresh_intents (
  batch_id INTEGER PRIMARY KEY REFERENCES owner_event_inbox(id) ON DELETE CASCADE,
  batch_key TEXT NOT NULL UNIQUE,
  repair_generation INTEGER NOT NULL CHECK (repair_generation >= 0),
  workorder_id INTEGER NOT NULL REFERENCES operator_tasks(id),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_event_board_refresh_pending
  ON owner_event_board_refresh_intents(repair_generation, batch_id)
  WHERE applied_at IS NULL;
```

Validate the batch ID, event IDs, generation, and scope. In one `db.transaction()` callback: return a matching existing row, otherwise call `taskLedger.enqueueWorkOrder()` and insert the intent with that workorder ID. Conflicting reuse of a batch ID or batch key throws.

Add a source-wiring assertion in `owner-event-wiring.test.ts` during Task 4 so daemon boot must construct
the ledger, whose constructor invokes the migration after both referenced parent tables exist.

- [ ] **Step 4: Add burst, rollback, cleanup, and generation tests**

```ts
it('coalesces twenty batches onto one open workorder', () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    ledger.accept({
      batchId: index + 1,
      eventIds: [`evt-${index + 1}`],
      repair: { repairGeneration: 20 + index, noUpdateScope: `full:${20 + index}` },
    })
  );
  expect(new Set(rows.map((row) => row.workOrderId)).size).toBe(1);
});

it('applies only captured generations and emits one follow-up signal', () => {
  expect(ledger.markVerified(workOrderId, 25)).toEqual({ applied: 6, followupPending: true });
  expect(ledger.consumePostTerminalFollowup(workOrderId)).toBe(true);
  expect(ledger.consumePostTerminalFollowup(workOrderId)).toBe(false);
});
```

Also assert rollback leaves neither new task nor intent, FK cleanup removes the intent, `maxPendingGeneration()` ignores applied rows, `attachPendingToWorkOrder()` changes only pending rows, and no `markVerified()` means no follow-up signal.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run Step 2. Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/standalone/src/db/migrations/owner-event-board-refresh.ts packages/standalone/src/operator/owner-event-board-refresh.ts packages/standalone/tests/operator/owner-event-board-refresh.test.ts
git commit -m "feat(standalone): add durable owner-event board intents"
```

---

### Task 2: Host-Bound Origin and Request Coalescing

**Files:**

- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Modify: `packages/standalone/tests/cli/start-board-refresh-gate.test.ts`

**Interfaces:**

- Consumes: `OwnerEventEffectAuthority.batchId`, trusted `causeEventIds`, ledger `accept()`.
- Produces:

```ts
export type WorkOrderRequestOrigin =
  | { kind: 'owner_manual' }
  | { kind: 'owner_event'; batchId: number; eventIds: readonly string[] };
```

- [ ] **Step 1: Write failing origin tests**

```ts
expect(handler).toHaveBeenCalledWith('board', {
  kind: 'owner_event',
  batchId: 42,
  eventIds: ['evt-1'],
});
```

Assert chat produces `owner_manual`, model-supplied identity fields are ignored, and `source: 'owner-event'` without host `ownerEventEffects` plus non-empty causes fails closed.

- [ ] **Step 2: Run gateway and handler tests and verify RED**

```bash
pnpm --dir packages/standalone exec vitest run tests/agent/gateway-tool-executor.test.ts tests/cli/start-board-refresh-gate.test.ts
```

Expected: FAIL on the old handler signature and forced owner-event payload.

- [ ] **Step 3: Derive the closed origin from trusted execution state**

Owner-event origin requires:

```ts
state.source === 'owner-event' &&
  Number.isSafeInteger(state.ownerEventEffects?.batchId) &&
  state.ownerEventEffects!.batchId > 0 &&
  Array.isArray(state.causeEventIds) &&
  state.causeEventIds.length > 0;
```

Never read origin from tool input. Pass `owner_manual` for other admitted owner requests.

- [ ] **Step 4: Route only owner-event Board through the ledger**

```ts
const generation = deps.boardRefreshGate.markChannelDirty(OWNER_BOARD_FULL_REPAIR_CHANNEL);
const repair = deps.boardRefreshGate.captureFullRepair();
deps.ownerEventBoardRefreshLedger.accept({
  batchId: origin.batchId,
  eventIds: origin.eventIds,
  repair: { ...repair, repairGeneration: generation },
});
```

Use one captured generation. Manual Board, Wiki, and memory-curation keep their existing keys; Wiki/memory take host event IDs from `origin.eventIds`.

- [ ] **Step 5: Add behavior regressions and verify GREEN**

Assert 20 requests yield 20 intents/one non-force task, same-batch retry yields no task, manual remains forced, missing ledger fails without old-path fallback, and Wiki/memory permanent keys are unchanged. Run Step 2 plus Task 1 test. Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/standalone/src/agent/types.ts packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/cli/commands/start.ts packages/standalone/tests/agent/gateway-tool-executor.test.ts packages/standalone/tests/cli/start-board-refresh-gate.test.ts
git commit -m "fix(standalone): coalesce owner-event board requests"
```

---

### Task 3: Verified Application and Post-Terminal Follow-Up

**Files:**

- Modify: `packages/standalone/src/operator/workorder-hooks.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/operator/workorder-hooks.test.ts`
- Modify: `packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts`

**Interfaces:**

- Consumes: ledger `markVerified()`, `attachPendingToWorkOrder()`, `consumePostTerminalFollowup()`.
- Produces: `ApiRoutesHandle.requestBoardRepair(): void`.

- [ ] **Step 1: Write failing verified-only hook tests**

```ts
it('marks intents only after a verified full repair', () => {
  applyBoardRefreshVerdict(workOrder, true, { disposition: 'complete' }, gate, intents);
  expect(intents.markVerified).toHaveBeenCalledWith(workOrder.id, 12);
});

it('does not mark intents after unverified or failed results', () => {
  applyBoardRefreshVerdict(workOrder, false, { disposition: 'complete' }, gate, intents);
  expect(intents.markVerified).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing terminal-order route tests**

Assert accepted-intent nudge bypasses only watermark skip, never sets force, attaches pending rows to the returned task, runs after current task terminal, and unverified/failed/exhausted events never nudge.

- [ ] **Step 3: Run hook/route tests and verify RED**

```bash
pnpm --dir packages/standalone exec vitest run tests/operator/workorder-hooks.test.ts tests/cli/runtime/api-routes-init-reconcile.test.ts
```

Expected: FAIL because no intent port or nudge exists.

- [ ] **Step 4: Implement verified application and terminal nudge**

Change `runDashboardAgent` options to `{ force?: boolean; acceptedIntent?: boolean }`. `acceptedIntent` requires a pending intent, bypasses only `delta.enqueue === false`, uses `boardRepairKey()` without force, and calls `attachPendingToWorkOrder(newId)`. Make `enqueueWorkOrderOrThrow()` return the workorder.

Expose:

```ts
return {
  requestBoardRepair: () => runDashboardAgent({ acceptedIntent: true }),
  stop: () => {
    if (boardBootTimeout) clearTimeout(boardBootTimeout);
    boardBootTimeout = null;
    if (boardInterval) clearInterval(boardInterval);
    boardInterval = null;
    boardReconcileScheduler?.stop();
    boardReconcileScheduler = null;
  },
};
```

In WorkOrderConsumer `onEvent`, consume the ledger set only for `complete` Board events, then call `boardRepairNudge.current?.()`. Assign the ref from `apiRoutesHandle.requestBoardRepair` before consumer boot recovery/start.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run Step 3 plus Task 1 test. Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/standalone/src/operator/workorder-hooks.ts packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/src/cli/commands/start.ts packages/standalone/tests/operator/workorder-hooks.test.ts packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts
git commit -m "fix(standalone): schedule verified board follow-ups"
```

---

### Task 4: Boot Recovery, Terminal Receipt, and Flag Semantics

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/tests/cli/owner-event-wiring.test.ts`
- Modify: `packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts`
- Modify: `packages/standalone/tests/cli/start-board-refresh-gate.test.ts`

**Interfaces:**

- Consumes: `maxPendingGeneration()`, `findAcceptance(batchId)`, always-on gate.
- Produces: exact batch terminal recovery without another model run.

- [ ] **Step 1: Write failing production-wiring tests**

```ts
expect(startSource).toContain('new OwnerEventBoardRefreshLedger(operatorDb, taskLedger)');
expect(startSource).toContain('ownerEventBoardRefreshLedger.findAcceptance(batch.id)');
expect(startSource).not.toContain(
  "process.env.MAMA_BOARD_RECONCILE === '1' ? new BoardRefreshGate() : null"
);
```

Also prove persisted acceptance wins before model execution and after runner error.

- [ ] **Step 2: Run wiring/config tests and verify RED**

```bash
pnpm --dir packages/standalone exec vitest run tests/cli/owner-event-wiring.test.ts tests/cli/start-board-refresh-gate.test.ts tests/cli/runtime/api-routes-init-reconcile.test.ts
```

Expected: FAIL on conditional gate construction and exact-key-only recovery.

- [ ] **Step 3: Reorder boot construction and make the gate unconditional**

```ts
const taskLedger = new TaskLedger(operatorDb);
const ownerEventInbox = new OwnerEventInbox(operatorDb);
const ownerEventBoardRefreshLedger = new OwnerEventBoardRefreshLedger(operatorDb, taskLedger);
const initialBoardGeneration = Math.max(
  Date.now(),
  (ownerEventBoardRefreshLedger.maxPendingGeneration() ?? -1) + 1
);
const boardRefreshGate = new BoardRefreshGate({ initialGeneration: initialBoardGeneration });
```

Keep the env flag only around `ReconcileScheduler` and its explicit reconcile route.

- [ ] **Step 4: Add exact batch terminal recovery**

```ts
const boardAcceptance = ownerEventBoardRefreshLedger.findAcceptance(batch.id);
if (boardAcceptance) {
  return { status: 'delegated' as const, tools: ['workorder_request'] };
}
```

Keep external effects, Wiki, memory-curation, and exact no-update lookup unchanged.

- [ ] **Step 5: Add boot and flag matrix assertions and verify GREEN**

Assert pending intents seed a greater boot generation and reattach to one boot repair, no pending intent preserves normal boot behavior, flag off disables only delta reconcile, and no owner-event path sets force. Run Step 2 plus ledger/hook tests. Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/standalone/src/cli/commands/start.ts packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/tests/cli/owner-event-wiring.test.ts packages/standalone/tests/cli/start-board-refresh-gate.test.ts packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts
git commit -m "fix(standalone): recover owner-event board acceptance"
```

---

### Task 5: Documentation and Verification Gate

**Files:**

- Modify: `docs/development/kagemusha-telegram-parity.md`
- Modify: `docs/development/runtime-overhead-reduction-design.md`

**Interfaces:**

- Consumes: committed PR-A code/test evidence.
- Produces: TG evidence and exact verification record.

- [ ] **Step 1: Record TG evidence without claiming live behavior**

Add a dated section stating: TG-03/TG-04 preserve the agent's workorder choice; TG-05 keeps the fresh owner-event run and coalesces only downstream Board work; TG-06 atomically binds exact batch acceptance, recovers it after crash, and follows verified generations. Status: `CODE GREEN; release and real-event canary pending`.

- [ ] **Step 2: Run focused PR-A tests**

```bash
pnpm --dir packages/standalone exec vitest run \
  tests/operator/owner-event-board-refresh.test.ts \
  tests/operator/workorder-hooks.test.ts \
  tests/cli/start-board-refresh-gate.test.ts \
  tests/cli/runtime/api-routes-init-reconcile.test.ts \
  tests/cli/owner-event-wiring.test.ts \
  tests/agent/gateway-tool-executor.test.ts \
  tests/operator/owner-event-loop.test.ts \
  tests/operator/owner-event-outcome.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 3: Run package and root gates**

```bash
pnpm --dir packages/standalone typecheck
pnpm --dir packages/standalone build
pnpm --dir packages/standalone test
pnpm typecheck
pnpm build
pnpm test
```

Expected: every command exits 0.

- [ ] **Step 4: Run changed-file format and whitespace gates**

```bash
pnpm exec prettier --check docs/development/kagemusha-telegram-parity.md docs/development/runtime-overhead-reduction-design.md packages/standalone/src/db/migrations/owner-event-board-refresh.ts packages/standalone/src/operator/owner-event-board-refresh.ts packages/standalone/src/operator/workorder-hooks.ts packages/standalone/src/agent/types.ts packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/cli/commands/start.ts packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/tests/operator/owner-event-board-refresh.test.ts packages/standalone/tests/operator/workorder-hooks.test.ts packages/standalone/tests/agent/gateway-tool-executor.test.ts packages/standalone/tests/cli/start-board-refresh-gate.test.ts packages/standalone/tests/cli/runtime/api-routes-init-reconcile.test.ts packages/standalone/tests/cli/owner-event-wiring.test.ts
git diff --check
```

Expected: exit 0. Report unrelated root format debt separately.

- [ ] **Step 5: Commit evidence**

```bash
git add docs/development/kagemusha-telegram-parity.md docs/development/runtime-overhead-reduction-design.md
git commit -m "docs: record owner-event board coalescing evidence"
```

- [ ] **Step 6: Run the diff-scoped review gate**

Invoke `review` before `ship`. Fix every P0-P3 finding with a RED→GREEN regression, rerun affected focused suites, and commit coherent corrections. Create the PR only after the review log is CLEAN.

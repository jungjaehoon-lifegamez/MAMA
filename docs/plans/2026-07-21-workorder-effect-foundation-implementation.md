# Workorder Effect Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` to execute
> this plan task-by-task, and use `superpowers:test-driven-development` for every behavior change.

**Goal:** Add an opt-in blocking workorder completion verdict and propagate a host-issued
workorder-attempt identity through AgentLoop, Code-Act, and gateway audit without changing the
completion semantics of existing board, wiki, or memory-curation workorders.

**Architecture:** `WorkOrderConsumer` owns the generic verdict contract. A required hook may return
only a typed complete/fail result; permissive hooks retain today's observe-only behavior. The
claimed system row id enters `AgentLoopOptions` through host-built run options, is copied into the
trusted gateway execution context, survives nested Code-Act execution, and is written to existing
activity JSON. No schema migration and no production `verdictRequired: true` registration are part
of A1.

**Tech Stack:** TypeScript, Vitest, SQLite-backed integration fixtures, existing AgentLoop and
Code-Act host bridge.

**Design reference:**
`docs/plans/2026-07-21-operator-action-control-loop-design.md` sections “Delivery decomposition”,
“Scoped action verification”, “Completion, retry, and crash recovery”, and “Release A1 ownership”.

---

## Task 1: Define and enforce the opt-in completion verdict

**Files:**

- Modify: `packages/standalone/src/operator/workorder-consumer.ts`
- Modify: `packages/standalone/tests/operator/workorder-consumer.test.ts`

### Step 1: Write failing consumer contract tests

Add an `AC #7: opt-in blocking effect verdict` section using the real in-memory `TaskLedger`.
Cover these cases:

1. `verdictRequired: true` plus `{ disposition: 'complete' }` completes the row.
2. `verdictRequired: true` plus `{ disposition: 'fail', reason: 'effect-missing' }` follows the
   normal failure/requeue policy.
3. `verdictRequired: true` plus a missing `after` hook fails with `effect-verdict-missing`.
4. `verdictRequired: true` plus an `after` hook returning `undefined` fails with
   `effect-verdict-missing`.
5. `verdictRequired: true` plus a thrown/rejected `after` hook fails with a bounded
   `after-hook:` reason.
6. Malformed verdict objects and `{ disposition: 'fail', reason: '' }` fail with bounded,
   deterministic `effect-verdict-invalid` reasons rather than passing an arbitrary value to logs or
   alarms.
7. Async `before` is awaited before the runner starts, and async `after` is awaited before any
   completion transition.
8. The existing permissive hook test still logs an exception and completes.
9. A permissive hook returning a fail-shaped value also retains pre-A1 semantics and completes; the
   new verdict is authoritative only when `verdictRequired: true`.

Use a wiki synthetic order for the requeue assertion because it has a two-attempt budget. Do not
register a required hook in runtime code.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run tests/operator/workorder-consumer.test.ts
```

Expected: new tests fail because `WorkOrderHook` has no verdict contract and `runOne()` always
completes after a successful runner response.

### Step 2: Add the typed hook result

In `workorder-consumer.ts`, introduce:

```ts
export type WorkOrderEffectVerdict =
  | { disposition: 'complete' }
  | { disposition: 'fail'; reason: string };
```

Change the hook contract to:

```ts
export interface WorkOrderHook {
  before?: (wo: WorkOrderRecord) => unknown | Promise<unknown>;
  after?: (
    wo: WorkOrderRecord,
    response: string,
    beforeState: unknown
  ) => WorkOrderEffectVerdict | void | Promise<WorkOrderEffectVerdict | void>;
  verdictRequired?: boolean;
}
```

Await `before` and `after` so the A2 verifier can use durable reads without another contract
change.

### Step 3: Implement compatibility-preserving verdict handling

After the runner returns:

- If `verdictRequired` is false/absent, keep existing semantics: a missing result or thrown
  after-hook is logged, and the row completes. Ignore even a fail-shaped returned value so A1 does
  not silently opt an existing kind into blocking semantics.
- If `verdictRequired` is true:
  - missing hook/result calls `handleFailure(wo, 'effect-verdict-missing')`;
  - `{ disposition: 'fail' }` calls `handleFailure()` with a bounded non-empty reason;
  - a thrown hook calls `handleFailure(wo, 'after-hook: ...')`;
  - only `{ disposition: 'complete' }` reaches `completeWorkOrder()`.
- Reject malformed runtime verdict values, including a blank/oversized fail reason, with a bounded
  `effect-verdict-invalid` reason even though TypeScript callers cannot normally construct them.

Keep response-head logging bounded and do not log the entire model response or hook state.

### Step 4: Run the focused tests

Run the command from Step 1.

Expected: all consumer tests pass, including the pre-existing observe-only hook behavior.

### Step 5: Commit

```bash
git add packages/standalone/src/operator/workorder-consumer.ts packages/standalone/tests/operator/workorder-consumer.test.ts
git commit -m "feat(standalone): add opt-in workorder effect verdict"
```

---

## Task 2: Carry the claimed attempt id through AgentLoop

**Files:**

- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/operator/worker-run.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/contract/reactive-envelope-tool-path.test.ts`
- Modify: `packages/standalone/tests/cli/code-act-parent-model-run.test.ts`
- Modify: `packages/standalone/tests/operator/worker-run.test.ts`
- Create: `packages/standalone/tests/operator/workorder-attempt-context.test.ts`

### Step 1: Write failing trusted-context propagation tests

Extend the AgentLoop context-builder coverage to assert that
`workorderAttemptId: 148` in `AgentLoopOptions` appears in the resulting
`GatewayToolExecutionContext`. Also assert that it is absent when not host-supplied.

Extend the parent/nested Code-Act context test so the outer and nested execution contexts retain
the same attempt id.

Add a `worker-run.test.ts` case that supplies the id through `runOptions` and asserts the generic
runner receives it after worker-run adds identity/default options. This protects the current
`Record<string, unknown>` merge/cast seam.

In the new integration test, use a real in-memory `TaskLedger` and `WorkOrderConsumer`. Enqueue and
claim through `tick()`, build run options from the callback's claimed `wo.id`, pass through the real
`workerRun`, and have the fake runner delegate the received options to
`buildAgentToolExecutionContext()`. Assert the final trusted gateway context contains exactly the
claimed row id. This is the acceptance path:

```text
claim -> runOptionsFor -> workerRun -> AgentLoop context builder
```

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/contract/reactive-envelope-tool-path.test.ts \
  tests/cli/code-act-parent-model-run.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/workorder-attempt-context.test.ts
```

Expected: type checking/test compilation fails because the context fields do not exist.

### Step 2: Add host-owned types and builder propagation

Add `workorderAttemptId?: number` to `GatewayToolExecutionContext` and `AgentLoopOptions`. Document
that it is host-issued from a claimed system row and must never be parsed from model tool input.

Update `buildAgentToolExecutionContext()` in `agent-loop.ts` so its non-empty check and returned
object preserve the field. Keep `withExecutionSurface()` spread behavior unchanged.

Add a typed helper in `worker-run.ts` that attaches the host-issued attempt id to otherwise resolved
worker options, and make the start wiring use that helper. This gives the runtime boundary a focused
unit seam instead of relying on an unchecked property added inside the large start closure.

### Step 3: Inject the claimed row id at the runtime boundary

In the existing `WorkOrderConsumer` `runOptionsFor` callback in `start.ts`, add:

```ts
workorderAttemptId: wo.id;
```

through the typed worker-run helper after the row has been claimed. Do not add the id to workorder
payloads, brief text, prompt input, or gateway tool schemas.

### Step 4: Run focused tests and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/contract/reactive-envelope-tool-path.test.ts \
  tests/cli/code-act-parent-model-run.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/workorder-attempt-context.test.ts \
  tests/operator/workorder-consumer.test.ts
pnpm --dir packages/standalone typecheck
```

Expected: all pass.

### Step 5: Commit

```bash
git add packages/standalone/src/agent/types.ts \
  packages/standalone/src/agent/agent-loop.ts \
  packages/standalone/src/operator/worker-run.ts \
  packages/standalone/src/cli/commands/start.ts \
  packages/standalone/tests/contract/reactive-envelope-tool-path.test.ts \
  packages/standalone/tests/cli/code-act-parent-model-run.test.ts \
  packages/standalone/tests/operator/worker-run.test.ts \
  packages/standalone/tests/operator/workorder-attempt-context.test.ts
git commit -m "feat(standalone): propagate workorder attempt context"
```

---

## Task 3: Preserve attempt identity across gateway and Code-Act execution

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/tests/envelope/code-act-context.test.ts`
- Create: `packages/standalone/tests/envelope/workorder-attempt-audit.test.ts`

### Step 1: Add failing gateway-context and activity-audit tests

In `code-act-context.test.ts`, add a case that starts a gateway execution with
`workorderAttemptId: 148`, enters nested Code-Act, and captures the context passed to its inner tool.
Assert exact identity retention.

In the new audit test, use the real in-memory activity store/executor seam already used by
`memory-provenance-context.test.ts`. Execute a harmless allowed tool under a context containing a
workorder attempt id, read the persisted activity row, parse `details`, and assert:

```ts
expect(details.workorder_attempt_id).toBe(148);
expect(typeof row.gateway_call_id).toBe('string');
```

Also test a normal interactive call to prove the details field omits the key rather than writing
`null` or inventing an id.

Add adversarial calls whose model tool input contains both `workorderAttemptId: 999` and
`workorder_attempt_id: 999`:

- without trusted context, audit details must omit the field;
- with trusted context `148`, audit details must contain `148`, never `999`.

Put a unique sensitive sentinel in a harmless input field and assert the serialized activity
`details` does not contain it. This proves the audit addition does not accidentally persist tool
payload, prompt, connector, task, or personal content.

Run:

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/envelope/code-act-context.test.ts \
  tests/envelope/workorder-attempt-audit.test.ts
```

Expected: assertions fail because the active executor context and audit details omit the id.

### Step 2: Preserve the id in executor context normalization

Add the optional field to `ActiveGatewayExecutionContext`. Update:

- `normalizeExecutionContext()`;
- fallback/merge handling;
- nested Code-Act `GatewayToolExecutionContext` construction.

Use only the existing trusted execution context. Never read a similarly named field from
`GatewayToolInput`. Treat the active per-call value like `reportPublisherOverride`: never widen it
from fallback execution state into an unrelated call.

### Step 3: Add the attempt id to existing JSON audit details

At gateway activity recording, conditionally add:

```ts
...(ctx?.workorderAttemptId !== undefined
  ? { workorder_attempt_id: ctx.workorderAttemptId }
  : {})
```

beside existing tool-call provenance. Do not add an activity schema column or include prompt,
connector, task, or personal content.

### Step 4: Run focused tests and typecheck

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/envelope/code-act-context.test.ts \
  tests/envelope/workorder-attempt-audit.test.ts \
  tests/envelope/memory-provenance-context.test.ts
pnpm --dir packages/standalone typecheck
```

Expected: all pass.

### Step 5: Commit

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts \
  packages/standalone/tests/envelope/code-act-context.test.ts \
  packages/standalone/tests/envelope/workorder-attempt-audit.test.ts
git commit -m "feat(standalone): audit workorder attempt identity"
```

---

## Task 4: Prove A1 backward compatibility and document the internal contract

**Files:**

- Modify: `packages/standalone/README.md`
- Modify: `docs/explanation/architecture.md`
- Modify: `docs/plans/2026-07-21-workorder-effect-foundation-implementation.md` only if execution
  reveals a plan correction

### Step 1: Document only what A1 enables

Add a short internal architecture note stating:

- claimed workorder rows receive a host-only attempt id;
- kinds may opt into a typed blocking completion verdict;
- A1 does not opt existing kinds into strict completion and does not enable temporal scanning;
- gateway audit stores only the numeric attempt id in existing details JSON.

Do not claim temporal behavior, Trello writes, or strict board verification.

### Step 2: Run the complete A1 verification set

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone exec vitest run \
  tests/operator/workorder-consumer.test.ts \
  tests/operator/workorder-hooks.test.ts \
  tests/contract/reactive-envelope-tool-path.test.ts \
  tests/cli/code-act-parent-model-run.test.ts \
  tests/operator/worker-run.test.ts \
  tests/operator/workorder-attempt-context.test.ts \
  tests/envelope/code-act-context.test.ts \
  tests/envelope/workorder-attempt-audit.test.ts \
  tests/envelope/memory-provenance-context.test.ts
pnpm --dir packages/standalone typecheck
pnpm --dir packages/standalone build
```

Expected: all commands exit 0. Confirm with a source search that no production hook registers
`verdictRequired: true`:

```bash
rg -n "verdictRequired:\\s*true" packages/standalone/src
```

Expected: no matches.

### Step 3: Run the full standalone suite

```bash
MAMA_FORCE_TIER_3=true pnpm --dir packages/standalone test
```

Expected: exit 0 under the repository's single-fork Vitest configuration.

### Step 4: Commit documentation

```bash
git add packages/standalone/README.md docs/explanation/architecture.md
git commit -m "docs: describe workorder effect foundation"
```

### Step 5: A1 review gate

Use `superpowers:requesting-code-review` against the A1 base commit. Resolve all correctness,
security, compatibility, and test findings before starting A2. In particular, reviewers must verify
that model input cannot select the attempt id and that existing kinds still complete under their old
observe-only hooks.

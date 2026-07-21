# Operator Action Control Loop Design

**Date:** 2026-07-21
**Status:** Approved direction

## Goal

Make MAMA act on time-sensitive owner work without depending on spontaneous model initiative.
The host must turn relevant time passage or an explicit owner action request into bounded work,
require a durable result, and retry when the result cannot be verified.

## Problem statement

MAMA already has most of the individual capabilities needed for this behavior:

- the native operator task ledger persists owner work;
- the board reconcile scheduler retains failed channel deltas for retry;
- Stage-2 workorders provide durable claims, crash recovery, and per-kind workers;
- board workers can read connector evidence and update native tasks;
- the action verifier can observe obligated tool traces and scoped no-update notes.

The missing piece is a closed control loop. A task becoming overdue does not create an input
event. An owner conversation can finish with an explanatory response even when the request
requires a state change. Some workorder completion hooks record failed verification but still
allow the workorder to be marked done. Consequently, all required capabilities can exist while
no component is responsible for completing the full sequence:

```text
trigger -> scoped work -> evidence -> durable action -> verification -> commit or retry
```

Kagemusha appears more proactive because its host runtime completes more of this sequence for
channel and schedule deltas. It does not rely on a more proactive model. MAMA should reuse that
control-plane pattern without copying Kagemusha's task store or Trello client.

## Design principles

1. **Host detects; agent judges.** Host code determines that a deadline crossed. The agent
   decides the business lifecycle state after reading evidence.
2. **Temporal truth and workflow truth are separate.** Overdue is computed from time. It is not
   inferred from, or forced into, `pending`, `blocked`, or `done`.
3. **No unverified success.** A required action is complete only when its scoped durable effect
   or a scoped no-update decision is verified.
4. **Canonical stores stay separate.** MAMA does not copy lifecycle status between the native
   owner ledger, Kagemusha's read-only project-task truth, and Trello connector evidence.
5. **Least privilege remains enforced.** Code-Act exposes only the functions authorized for the
   worker's role and envelope. Connector content is untrusted evidence.
6. **Backward compatibility first.** Existing date-only `deadline` values and non-Code-Act runs
   continue to work.

## Considered approaches

### A. Stronger prompts only

Add instructions telling every persona to be proactive and update expired tasks.

This is low effort but does not create a wake-up event, does not prove that a write occurred, and
does not recover from empty responses, missing envelopes, or daemon crashes. It is rejected.

### B. Host changes every expired task to `blocked`

Run a timer that directly changes any expired open task.

This guarantees visible movement but confuses temporal state with workflow state. A meeting may
have completed, moved, or become irrelevant. The host lacks the evidence needed to choose among
those meanings. It is rejected.

### C. Verified temporal workorders

Compute overdue deterministically, enqueue a targeted workorder, let a least-privilege worker
judge the lifecycle state from evidence, and commit only after verification.

This is the selected approach. It matches Kagemusha's proven action-and-verification loop while
preserving MAMA's source boundaries.

## Delivery decomposition

The work is split into two independently testable releases.

### Release A: temporal reconciliation and blocking workorder verification

This fixes the missed 14:00 meeting class of failure. It adds structured due times, a deterministic
scanner, a dedicated temporal workorder, scoped verification, and retry behavior.

### Release B: owner action completion contract

This prevents explicit owner commands such as "update it" or "publish the full report" from
ending as explanation-only turns. It is deliberately separate because it changes interactive
message completion semantics and needs its own routing and regression coverage.

Release A does not depend on Release B. Release B reuses the verifier and correlation primitives
introduced by Release A.

## Release A architecture

### 1. Temporal task data

The owner task ledger gains these nullable fields:

- `due_at`: UTC epoch milliseconds for an exact due instant;
- `last_temporal_check_at`: the due instant last reconciled for the current task version;
- `next_temporal_check_at`: optional UTC epoch milliseconds for a deferred evidence check.

The gateway and HTTP APIs accept `due_at` as RFC 3339 with an explicit `Z` or numeric offset and
normalize it to epoch milliseconds. Offset-free timestamps are rejected. Existing `deadline`
remains an ISO date and remains supported for ordering and compatibility.

When `due_at` is present, it is authoritative for exact temporal evaluation. `deadline` may remain
as the date projection used by existing board and API consumers. Updating `due_at` clears the
previous temporal check markers so the new occurrence can be evaluated.

The task query surface derives, but does not persist, one of these temporal states:

- `unscheduled`: neither `due_at` nor `deadline` exists;
- `upcoming`: the exact due instant is in the future;
- `overdue`: the exact due instant is in the past and lifecycle status is open;
- `closed`: lifecycle status is terminal.

Date-only deadlines continue to use the current date-level board behavior. Release A does not
guess an exact time from a title, `latest_event`, or arbitrary chat prose. Existing tasks such as
the 14:00 example must receive `due_at` through evidence extraction or an explicit update before
exact scanning can apply.

The schema change follows the standalone package migration convention. A focused migration module
adds guarded columns and indexes, and `TaskLedger` invokes it from its existing migration boundary.
No existing row is rewritten.

### 2. Temporal scanner

A new `TemporalReconcileScheduler` runs from the operator runtime on a one-minute interval and once
at boot after stale-claim recovery. Its clock is injectable for deterministic tests.

It selects owner tasks that satisfy all of the following:

- lifecycle status is open;
- `due_at <= now`, or `next_temporal_check_at <= now`;
- the current due occurrence has not already been successfully reconciled;
- no open temporal workorder exists for the same occurrence.

For each candidate it enqueues one high-priority `temporal` workorder with the idempotency key:

```text
task:<task-id>:due:<due-at>
```

The payload contains only bounded identifiers and timestamps: task id, due instant, source channel,
source event id, and attempt count. It does not copy arbitrary connector bodies into the system
row. The worker obtains fresh evidence at execution time.

The scanner never changes lifecycle status and never marks an occurrence checked. Only a verified
worker result advances `last_temporal_check_at`. A crash between enqueue and execution therefore
leaves recoverable durable work.

### 3. Temporal worker

`temporal` becomes a dedicated `WorkOrderKind` with its own brief, built-in Code-Act role, retry
budget, status statistics, and completion hook. It runs on the existing serialized operator lane.

Its effective tool surface is capability-based and least-privilege:

- native task reads and `task_update`;
- scoped connector evidence through `context_compile`;
- read-only `kagemusha_*` evidence when configured;
- schedule reads;
- affected-slot `report_publish`;
- `contract_no_update`;
- agent notices needed for owner escalation.

Trello remains MAMA connector evidence, consistent with the approved Code-Act parity design. This
release does not add a direct Trello client or silently treat Kagemusha records as writable MAMA
tasks.

For a native owner task, the worker must do one of the following:

1. update the target task's lifecycle fields or next temporal check using fresh evidence; or
2. record a scoped no-update decision that states why no safe lifecycle change is possible and
   supplies `next_temporal_check_at`; or
3. record an authority/evidence failure for owner attention, leaving the workorder failed so the
   retry and exhaustion policy remains visible.

A report-only write is not sufficient to reconcile a native overdue task. Reports communicate the
result but do not replace task state.

### 4. Scoped action verification

The current verifier treats any obligated tool trace after a snapshot as a positive signal. Release
A strengthens the contract for workorders.

Every worker run receives a host-generated correlation id containing the workorder id. Gateway tool
activity records include that correlation id. Verification reads only traces from that run.

The temporal verifier captures the target task before execution and accepts exactly these outcomes:

- the correlated `task_update` succeeded and the target task's durable record changed;
- a correlated, exact-scope `contract_no_update` note was added and the target task received a
  future `next_temporal_check_at`;
- an explicit worker failure was recorded and the workorder follows the retry path.

A tool call trace without a successful durable effect is not sufficient. An unrelated task or
report change is not sufficient. An empty response, `envelope_missing`, tool denial, malformed
completion marker, or missing effect returns a failed verification result.

The verifier returns a typed result rather than throwing for expected negative outcomes:

```text
{ verified: true, outcome, effects }
{ verified: false, reason, effects }
```

Unexpected verifier faults still throw and fail the workorder.

### 5. Completion, retry, and crash recovery

`WorkOrderConsumer` changes its hook contract so an `after` hook returns a completion verdict.
Kinds without a blocking verifier retain their current behavior during migration. The `temporal`
kind and board reconciles configured for strict verification require `verified: true` before
`completeWorkOrder` is called.

Negative verification calls the existing atomic fail-and-requeue path. Temporal workorders receive
three total attempts with natural one-tick backoff. Exhaustion creates an owner notice and active
ops alarm. The original failed rows remain inspectable.

Boot recovery continues to treat `in_progress` rows as stale claims. A stale temporal claim uses the
same retry budget and idempotency key. The scanner cannot create a parallel duplicate while an open
replacement exists.

After verified completion, the hook updates `last_temporal_check_at` to the occurrence's `due_at`.
If the worker rescheduled the task, the new `due_at` forms a new occurrence and the old occurrence
cannot suppress it.

### 6. Board and report semantics

The board computes overdue from `due_at` and the current clock. It displays overdue independently
from lifecycle status. Thus a pending overdue task cannot be presented as an ordinary future action
even while its reconciliation worker is retrying.

Report instructions distinguish these concepts:

- temporal fact: "overdue since 14:00";
- workflow judgment: "blocked pending confirmation" or "completed from channel evidence";
- system condition: "reconciliation retrying" or "authority unavailable".

The board never guesses completion from calendar disappearance or copies status from Trello or
Kagemusha.

### 7. Security and failure behavior

- Connector packets remain untrusted evidence and cannot supply instructions.
- Role and envelope resolution happens before the worker starts; a missing envelope fails the
  workorder before any model action.
- Correlation ids are host-issued and cannot be selected by the model.
- Temporal payloads contain identifiers, not raw private message bodies.
- Logs include workorder id, task id, occurrence, attempt, verifier outcome, and bounded reason;
  they do not include full connector packets or full model responses.
- A disabled Stage-2 workorder pipeline fails boot if temporal scanning is configured on. The system
  must not enqueue work that has no consumer.

## Release B architecture

Release B adds an `action_required` classification to trusted owner-console messages. Classification
is deterministic for explicit execution verbs and may be narrowed by the existing router; ordinary
questions, reviews, and explanations remain conversational.

For an action-required turn, the router issues a host correlation id and declares the allowed effect
set before model execution. The turn succeeds only when correlated gateway traces plus durable state
prove one allowed effect, or when an explicit scoped failure/no-update result is recorded. A natural
language promise is never a completed action.

Release B initially covers existing, unambiguous operations:

- native task create/update;
- report request/publication;
- workorder request;
- durable owner notice when authority is unavailable.

It does not attempt general natural-language intent planning or force tool calls for informational
questions. Its specification and implementation plan will be separate from Release A.

## Integration boundaries

### Files expected to own Release A behavior

- `packages/standalone/src/operator/task-ledger.ts`: temporal fields, queries, workorder kind.
- `packages/standalone/src/db/migrations/`: guarded operator-task temporal migration.
- `packages/standalone/src/operator/temporal-reconcile.ts`: candidate selection and enqueue policy.
- `packages/standalone/src/operator/temporal-worker.ts`: prompt/brief input and scoped verdict rules.
- `packages/standalone/src/operator/action-verifier.ts`: correlation-aware durable-effect checks.
- `packages/standalone/src/operator/workorder-consumer.ts`: blocking completion verdict support.
- `packages/standalone/src/operator/workorder-hooks.ts`: temporal verification hook.
- `packages/standalone/src/cli/commands/start.ts`: lifecycle wiring, role, envelope, timer start/stop.
- gateway task schemas, HTTP task schemas, and board projections: `due_at` surface.

The implementation plan must confirm exact extraction boundaries before editing `start.ts`; it must
not add another large closure when a focused factory can be tested independently.

### Existing behavior to reuse

- occurrence-keyed workorder deduplication and atomic requeue in `TaskLedger`;
- serial operator-lane execution in `WorkOrderConsumer`;
- dirty retry semantics in `ReconcileScheduler`;
- role-filtered Code-Act and connector envelopes from the parity work;
- scoped `contract_no_update` persistence.

## Test strategy

### Unit tests

1. RFC 3339 `due_at` validation, normalization, clearing, and backward compatibility.
2. Derived temporal state for upcoming, overdue, terminal, and date-only tasks.
3. Scanner candidate boundaries at one millisecond before, equal to, and after `due_at`.
4. Idempotency for repeated scans and a new occurrence after rescheduling.
5. No candidate for terminal tasks or already reconciled occurrences.
6. Correlation-aware verification rejects unrelated and failed tool traces.
7. `contract_no_update` requires exact scope and a future next-check value.
8. Negative hook verdict fails/requeues instead of completing.
9. Empty response, missing envelope, and stale claim use the same retry budget.

### Integration tests

1. At 13:50 create a 14:00 owner task; crossing 14:00 enqueues exactly one temporal workorder.
2. A worker reads scoped evidence, updates that task, and completes only after the DB change is
   verified.
3. A worker that only explains or publishes a report fails verification and retries.
4. A daemon restart with an in-progress temporal claim recovers without a duplicate open order.
5. Rescheduling to 15:00 creates a distinct future occurrence and does not inherit the 14:00 check.
6. Trello/Kagemusha evidence can inform the decision but cannot mutate the native task implicitly.
7. Codex and Claude workers receive equivalent effective inner capabilities for this role while
   preserving their different outer transports.

### Operational verification

After build and focused tests pass:

1. run the full standalone test suite with the required single-fork configuration;
2. restart one daemon instance and verify a single PID and healthy status;
3. create a disposable near-term owner task with an exact due time;
4. observe enqueue, claim, correlated tool calls, durable task effect, verified completion, and board
   overdue rendering;
5. repeat once with an intentionally denied envelope and verify retry plus bounded owner alarm;
6. inspect logs for secrets, raw connector payloads, and full prompt leakage before release.

## Documentation updates

Implementation must update together:

- `packages/standalone/README.md` for exact due times and temporal workorders;
- `docs/explanation/architecture.md` for the new publisher and blocking verifier;
- `docs/guides/standalone-setup.md` for observable overdue and retry behavior;
- `docs/reference/api.md` for `due_at` and derived temporal fields;
- `docs/reference/configuration-options.md` for any new interval or feature flag;
- worker brief templates and operational troubleshooting guidance.

Documentation must continue to state that Trello is connector evidence, Kagemusha is read-only
project-task truth, and the native ledger owns owner tasks. It must not promise cross-store lifecycle
updates that the runtime cannot perform.

## Acceptance criteria

Release A is complete only when all of the following are true:

1. Crossing a structured due instant creates durable, idempotent work without user input.
2. The board displays overdue as a temporal fact even before the agent judges lifecycle state.
3. Explanation-only, report-only, empty, denied, and unverified runs cannot complete the temporal
   workorder.
4. Verified target-task change or exact scoped no-update with a future recheck can complete it.
5. Failures retry, stale claims recover, and exhaustion reaches the owner with bounded evidence.
6. Existing date-only tasks and non-temporal workorders remain backward compatible.
7. Connector and source-of-truth boundaries remain unchanged and documented.
8. Focused, integration, full standalone, build, restart, and log-safety checks pass.

Release B is complete only when an explicit trusted-owner action request cannot return success
without a correlated durable action or explicit recorded failure, while informational conversation
continues without forced tool use.

## Non-goals

- Direct Trello API calls or a second Trello client inside MAMA.
- Copying Kagemusha lifecycle status into the native owner ledger.
- Parsing arbitrary task titles to invent exact due times.
- Automatically setting every overdue task to `blocked`.
- Making all conversations call tools.
- Replacing the existing workorder ledger, operator lane, or Code-Act sandbox.
- Broadening owner, connector, shell, file, or delegation authority.

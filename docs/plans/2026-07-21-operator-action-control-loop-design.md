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

The work is split into independently testable delivery units.

### Release A1: workorder effect foundation

This adds a typed blocking completion verdict and a host-owned per-attempt execution identity. It
does not add temporal schema, tools, receipts, or a new workorder kind. Existing board, wiki, and
memory-curation hooks keep their current completion semantics. Strict board verification is not part
of this release.

### Release A2: temporal vertical slice

This fixes the missed 14:00 meeting class of failure. It adds the temporal schema, atomic task
effect and receipt, deterministic scanner, dedicated workorder, board projection, and retry behavior
on top of A1.

### Release B: owner action completion contract

This prevents explicit owner commands such as "update it" or "publish the full report" from
ending as explanation-only turns. It is deliberately separate because it changes interactive
message completion semantics and needs its own routing and regression coverage.

Release A2 depends on A1. Release B is separate from A2 and reuses the per-attempt execution and
effect-verification primitives introduced by A1.

Each delivery unit receives a separate implementation plan and review gate. A1 must land and pass
backward-compatibility tests before A2 starts; Release B is not included in either A plan.

## Release A architecture

### 1. Temporal task data

The owner task ledger gains these fields:

- `due_at`: nullable UTC epoch milliseconds for an exact due instant;
- `deadline_offset_minutes`: nullable offset captured from an exact-time input and retained when
  exact precision is cleared; legacy date-only rows use the daemon-local time zone;
- `revision`: monotonically increasing integer, incremented only by a real field change;
- `temporal_epoch`: monotonically increasing occurrence sequence; due/deadline changes and
  terminal-to-open reopening increment it even when a previous due value is restored;
- `temporal_reconciled_occurrence_key`: the exact-time or date-only occurrence that reached a final
  verified judgment (`epoch:<n>:due:<epoch-ms>` or `epoch:<n>:date:<YYYY-MM-DD>`);
- `last_temporal_checked_at`: wall-clock time of the latest verified temporal judgment;
- `next_temporal_check_at`: optional UTC instant for a deferred evidence check;
- `last_temporal_attempt_id`: the system workorder row id that last applied a temporal effect.

The gateway and HTTP APIs accept `due_at` as RFC 3339 with an explicit `Z` or numeric offset and
normalize it to epoch milliseconds. Offset-free timestamps are rejected. Existing `deadline`
remains an ISO date and remains supported for ordering and compatibility.

When `due_at` is present, it is authoritative for exact temporal evaluation. `deadline` remains the
date projection used by existing board and API consumers. The two fields follow one normalization
contract:

- creating or updating `due_at` derives `deadline` from the RFC 3339 input's explicit local date;
- creating or updating `due_at` also stores its explicit numeric UTC offset in
  `deadline_offset_minutes` (`Z` is zero);
- supplying both values requires that date to match, otherwise the write is rejected;
- updating only `deadline` on a task with `due_at` deliberately clears exact-time precision and all
  temporal markers while retaining the captured offset;
- clearing only `due_at` preserves `deadline` and its captured offset but clears temporal markers;
- clearing `deadline` clears the exact time, captured offset, and all temporal markers;
- changing `due_at` or `deadline` increments `temporal_epoch` and clears final and deferred markers
  for the new occurrence; a newly created scheduled task starts at epoch 1 and an unscheduled task
  starts at epoch 0.
- reopening `done` or `cancelled` to an open status clears final and deferred markers so the current
  occurrence is evaluated again and increments `temporal_epoch`.

The specialized temporal transaction is the one exception to the last rule: when it reschedules a
task, it first validates the old occurrence, applies the normalized new due time, and then records
the old occurrence as reconciled. Because the current occurrence key now comes from the new due
time, the old marker cannot suppress the future scan.

Occurrence keys always include the epoch, for example `epoch:3:due:<epoch-ms>` or
`epoch:4:date:<YYYY-MM-DD>`. Restoring an old due value or reopening a closed task therefore creates
a new stable identity rather than colliding with a terminal or exhausted generation from the past.

The same TaskLedger transaction that increments `temporal_epoch` marks every `active` generation for
an older epoch as `superseded` and cancels its open system rows with a bounded reason. An in-flight
worker then observes a cancelled row and cannot apply an effect or enter retry/exhaustion. It emits a
superseded event without an owner alarm. This applies to external due/deadline changes and
terminal-to-open reopening. A rescheduling temporal effect excludes its own generation, finalizes it
as `resolved`, and supersedes any other older active generation in the same transaction.

No consumer independently synchronizes the fields; all gateway and HTTP writes go through this one
TaskLedger normalization boundary.

Every mutation of an owner task, including legacy `update`, source-event upsert, HTTP, gateway, and
the temporal mutation, increments `revision` in the same transaction when and only when at least one
persisted value changes. Owner task creation starts at revision 1. A no-op update neither increments
the revision nor updates `updated_at`. System workorder rows do not participate in owner-task
optimistic concurrency.

The task query surface derives, but does not persist, exactly one of these temporal states. Date
comparisons use `deadline_offset_minutes` when present. Legacy rows without an offset use the
daemon-local IANA time zone captured once at boot through
`Intl.DateTimeFormat().resolvedOptions().timeZone`; tests inject it explicitly:

- `closed`: lifecycle status is `done` or `cancelled`;
- `exact_upcoming`: an open task has `due_at > now`;
- `exact_overdue`: an open task has `due_at <= now`;
- `date_upcoming`: an open date-only task has `deadline > today`;
- `date_due`: an open date-only task has `deadline = today`;
- `date_overdue`: an open date-only task has `deadline < today`;
- `unscheduled`: an open task has neither field.

The concrete open lifecycle statuses are `pending`, `in_progress`, `review`, and `blocked`.
`failed` is system-workorder-only and cannot occur on an owner task.

Host code never parses a title to invent an exact time. Ongoing task creation and reconciliation
must populate `due_at` when trusted source evidence contains an unambiguous time and zone. On
feature activation and then daily, the scanner also sends due-today and overdue date-only tasks
through the temporal worker. That worker may use the task and source evidence to enrich an explicit
time. If no safe exact time exists, it leaves the task date-only and records a bounded deferred or
final date-level judgment. This gives existing tasks such as the 14:00 example a migration path
without a blind host parser.

The migration also creates two tables:

- immutable `operator_temporal_effects`, keyed by workorder attempt id, recording task id,
  generation, occurrence, outcome, before/after revision, changed field names, bounded reason, next
  check, and creation time;
- `operator_temporal_generations`, keyed by the stable generation key, recording task id,
  temporal epoch, occurrence, check time, disposition (`active`, `resolved`, `final_no_update`,
  `deferred`, `exhausted`, or `superseded`), last workorder id, bounded reason, and timestamps.

The task change, scoped no-update note when applicable, effect receipt, terminal generation
disposition, and the current temporal workorder's `in_progress -> done` transition commit in one
SQLite transaction. Enqueue atomically creates the generation as `active` and its first system row,
so neither can become visible alone. A focused migration module adds guarded columns, these tables,
and indexes, and `TaskLedger` invokes it from its existing migration boundary. No existing task row
is rewritten.

### 2. Temporal scanner

A new `TemporalReconcileScheduler` runs from the operator runtime on a one-minute interval and once
at boot after stale-claim recovery. Its clock is injectable for deterministic tests.

It selects exact-time owner tasks that satisfy all of the following:

- lifecycle status is open;
- `due_at <= now` with no deferred check, or `next_temporal_check_at <= now`;
- `temporal_reconciled_occurrence_key` differs from the current occurrence key;
- no temporal generation row exists for the same stable generation key.

It also selects date-only open tasks when `deadline <= today`, the final marker differs from the
current epoch-qualified date occurrence key, a deferred check is absent or due, and no generation
row exists for that check generation. The initial activation scan includes existing rows;
subsequent scans rely on the same marker and idempotency rules rather than a separate backfill code
path.

For each candidate it enqueues one `temporal` workorder with the idempotency key:

```text
task:<task-id>:epoch:<temporal-epoch>:due:<due-at>:check:<check-at>
```

For an initial exact-time check, `check-at` equals `due-at`. For a deferred check it equals the
persisted `next_temporal_check_at`. Date-only generations use
`task:<task-id>:epoch:<temporal-epoch>:date:<deadline>:check:<check-at>`. Their initial `check-at`
is the UTC epoch of that date's start under `deadline_offset_minutes` when present, otherwise under
the boot-captured daemon time zone. A future recheck therefore never collides with the completed
workorder that scheduled it.

The stable generation key is also the workorder `idempotencyKey` for every retry. Existing failed
rows can coexist because the current partial unique index excludes terminal rows; at most one open
system row exists for the key. The generation table, not historical workorder existence, decides
whether the scanner may create a generation. `resolved`, `final_no_update`, `deferred`, and
`exhausted`, and `superseded` generations are terminal and are never recreated. A deferred
outcome's future check uses a new generation key.

The payload contains only bounded identifiers and timestamps: stable generation key, task id,
temporal epoch, occurrence key, check instant, source channel, source event id, and attempt count. It
does not copy arbitrary connector bodies into the system row. The worker obtains fresh evidence at
execution time. Claim-time validation requires the payload to match the generation row before the
host builds trusted execution context.

The scanner never changes lifecycle status or reconciliation markers. A final verified effect sets
`temporal_reconciled_occurrence_key` and clears `next_temporal_check_at`. A verified defer effect
sets a future `next_temporal_check_at` but deliberately does not set the final occurrence marker. A
crash between enqueue and execution therefore leaves recoverable durable work, while a deferred
check remains eligible in its new generation.

Each one-minute tick enqueues at most four exact-time or due deferred generations at high priority
and at most one date-only activation generation at normal priority. It stops enqueueing while ten
temporal workorders are open. Exact and deferred checks are selected before date-only activation
rows. This bounds legacy catch-up and prevents it from monopolizing the serialized operator lane.

### 3. Temporal worker

`temporal` becomes a dedicated `WorkOrderKind` with its own brief, built-in Code-Act role, retry
budget, status statistics, and completion hook. It runs on the existing serialized operator lane.

Its effective tool surface is capability-based and least-privilege:

- native task reads and the dedicated `task_temporal_reconcile` mutation;
- scoped connector evidence through `context_compile`;
- read-only `kagemusha_*` evidence when configured;
- schedule reads;
- affected-slot `report_publish`;
- agent notices needed for owner escalation.

Trello remains MAMA connector evidence, consistent with the approved Code-Act parity design. This
release does not add a direct Trello client or silently treat Kagemusha records as writable MAMA
tasks.

For a native owner task, the worker must call `task_temporal_reconcile` with one of three outcomes:

1. `resolved`: change `status` or `due_at` using fresh evidence and finalize the old occurrence; or
2. `final_no_update`: prove from fresh evidence that the current task fields remain correct, record
   an exact-scope reason, and finalize the occurrence without changing workflow fields; or
3. `deferred`: keep workflow fields unchanged, provide a non-empty reason, and schedule a strictly
   future `next_temporal_check_at`. The host atomically writes the exact-scope no-update note and
   the task check markers.

Changing only `next_temporal_check_at` is not a valid `resolved` effect. A `deferred` effect cannot
change lifecycle fields. `final_no_update` requires a non-empty evidence summary in addition to its
reason and is invalid when evidence is merely absent or inaccessible. Authority or evidence errors
that cannot justify a future check leave the workorder failed so retry and exhaustion remain visible.

The tool input is deliberately narrow:

```text
task_temporal_reconcile({
  expected_revision,
  outcome: 'resolved' | 'final_no_update' | 'deferred',
  status?,
  due_at?,
  reason,
  evidence_summary?,
  next_temporal_check_at?
})
```

`reason` is required for every outcome. Task id, temporal epoch, occurrence key, generation key,
check instant, and attempt id are absent from model input. They come only from a host-built
`TemporalWorkContext` derived from the claimed system row and matching generation record. The exact
no-update scope is host-derived as
`temporal:<task-id>:<occurrence-key>:<check-at>` and cannot be selected by the model. The TaskLedger
transaction applies these rules:

| Outcome           | Required business effect           | Final marker               | Next check          | No-update note       |
| ----------------- | ---------------------------------- | -------------------------- | ------------------- | -------------------- |
| `resolved`        | Actual `status` or `due_at` change | Set to expected occurrence | Cleared             | No                   |
| `final_no_update` | Evidence-backed no workflow change | Set to expected occurrence | Cleared             | Exact scope, atomic  |
| `deferred`        | No workflow or due change          | Unchanged                  | Required and future | Exact scope, atomic  |
| Invalid/no-op     | None                               | None                       | None                | Transaction rejected |

`status` may transition only among valid owner-task states; `failed` remains forbidden. Changing
`due_at` uses the normalization rules in section 1. A successful result returns a bounded projection
of the immutable effect receipt.

A report-only write is not sufficient to reconcile a native overdue task. Reports communicate the
result but do not replace task state.

### 4. Scoped action verification

The current verifier treats any obligated tool trace after a snapshot as a positive signal. Release
A1 adds a stricter, opt-in effect contract used only by the temporal kind initially.

Every claimed system row is one unique attempt: atomic requeue creates a fresh row id. The host puts
that row id in `GatewayToolExecutionContext.workorderAttemptId`; model input cannot set or override
it. Gateway activity stores it in the existing JSON `details` field alongside the per-tool
`gateway_call_id`, so no agent-activity schema migration is required. The temporal mutation reads
the attempt id only from trusted execution context and stamps it into the target task transaction.

The temporal mutation is the authoritative verifier: it validates the expected task snapshot and
outcome invariants before its transaction can mark the workorder done. The post-run verifier audits
that committed result and accepts exactly these outcomes:

- an immutable effect receipt exists for the current workorder row id and names the expected task
  and occurrence; its
  `before_revision` equals the captured revision, and its `after_revision` is greater;
- the receipt's changed fields and task markers at `after_revision` satisfy the selected outcome's
  invariants above;
- for `final_no_update` and `deferred`, an exact-scope no-update note was inserted in the same
  transaction;
- an explicit worker failure was recorded and the workorder follows the retry path.

`task_temporal_reconcile` uses the model-supplied `expected_revision` plus trusted
`TemporalWorkContext`. In one transaction it requires: the attempt row is still `in_progress`; its
idempotency key equals the context generation key; that generation is `active` and names this attempt
as its last workorder; and the task id, temporal epoch, and current occurrence equal the context. It
rejects stale inputs, no-op patches, mismatched generations, invalid status transitions, and fields
not allowed by the selected outcome. This makes the receipt causally attributable to the current
attempt; an unrelated concurrent write cannot satisfy verification. A tool trace without the receipt
is not sufficient. An unrelated task or report change, empty response, `envelope_missing`, tool
denial, or missing effect returns a failed verification result.

The textual completion marker is audit guidance, not an authority boundary. A malformed or missing
marker fails an attempt only when no valid atomic effect committed. It can never undo or requeue a
workorder already completed by a valid temporal effect transaction.

When `TemporalWorkContext` is present, the gateway executor performs the same active-attempt guard
before every write-capable function, including report publication and owner notices. After
supersession, reads may finish but writes return `workorder_superseded`. This prevents an old worker
from publishing a stale report after its task mutation has already been denied.

A successful temporal transaction increments `revision` exactly once. During a live run the receipt's
`before_revision` must equal the captured revision. During boot recovery, where the in-memory
snapshot no longer exists, the immutable receipt plus task attempt stamp is authoritative and the
verifier requires `after_revision = before_revision + 1` and all outcome invariants.

If another legitimate writer advances the task beyond the receipt's `after_revision` before the
post-run audit, the immutable receipt remains proof that this attempt committed. The audit does not
require the current task to equal the receipt snapshot; it records `verified_superseded`. The
scanner evaluates the task's current epoch, occurrence, and markers on its next tick, so a newer due
time or reopened state creates new work without rerunning the superseded attempt.

The verifier returns a typed result rather than throwing for expected negative outcomes:

```text
{ verified: true, outcome, effects }
{ verified: false, reason, effects }
```

Unexpected verifier faults still throw and fail the workorder.

### 5. Completion, retry, and crash recovery

`WorkOrderConsumer` changes its hook contract so an `after` hook returns
`{ disposition: 'complete' }` or `{ disposition: 'fail', reason }`. A missing verdict remains
compatible for existing kinds during A1. The `temporal` registration sets `verdictRequired: true`;
a missing or negative verdict goes through failure handling only when the workorder is still
`in_progress`. Strict board verification is explicitly deferred to a separate design.

Before every temporal failure or requeue transition—including runner rejection and a thrown post-run
audit—the consumer re-reads the system row and immutable receipt. A row already atomically marked
`done` by `task_temporal_reconcile` is authoritative: the consumer emits/logs completion and never
calls failure handling. An unexpected receipt-audit fault after atomic completion is observability
failure only. If the authoritative state re-read itself fails, the consumer performs no lifecycle
mutation, raises an ops fault, and keeps that row in an in-memory unresolved-effects queue checked
before new claims on the next tick; boot recovery covers a process crash. It never guesses that the
effect was absent.

The same state read happens on the normal return path. A temporal row already `done` is not passed to
`completeWorkOrder` a second time. If it remains `in_progress`, the required hook verdict decides
whether to fail/requeue; explanation-only completion therefore cannot succeed.

Negative verification calls the existing atomic fail-and-requeue path. `payload.attempts` is the
single persisted retry counter and is writable only by TaskLedger: normal enqueue sets it to 1 and
atomic requeue increments it. Temporal workorders receive three total attempts. Because `tick()`
drains only the pending count captured at tick start, a replacement first becomes eligible on the
next 60-second consumer tick; no additional exponential backoff is implied.

Temporal failure handling also updates the generation row in the same transaction. A requeue keeps
the disposition `active`, records the fresh workorder id, and reuses the same stable generation key;
only the replacement workorder payload stores the incremented attempt count. Attempt-three
exhaustion sets disposition `exhausted` before the open
workorder disappears. The scanner never recreates an exhausted generation. A later reschedule,
reopen, or deferred check has a different generation key; an explicit manual rearm is outside this
release.

Before requeue, failure handling also requires the generation to remain `active` and owned by this
attempt. A `superseded` generation or cancelled workorder is terminal for that attempt: it emits a
superseded event and never consumes retry budget or raises an exhaustion alarm.

Exhaustion marks the final row failed with the bounded reason and emits one in-process event. The
failed row is the durable owner-visible record consumed by workorder status and subsequent operator
reports. The existing notice queue and ops alarm remain best-effort and are deduped in-process by
task occurrence; external delivery is not claimed as exactly-once. Original failed rows remain
inspectable.

Because effect receipt and workorder completion share a transaction, boot cannot observe an
`in_progress` temporal row with a committed receipt. Every stale `in_progress` temporal row is a
pre-effect crash and uses the same retry budget; the replacement receives a new row id and attempt
identity. A `done` row with a receipt needs no recovery. The scanner cannot create a parallel
duplicate while an active generation owns an open replacement.

The dedicated temporal mutation, not the completion hook, writes task markers atomically with the
business effect. If it reschedules the task, the final marker records the old occurrence while the
new `due_at` forms a different occurrence key, so the old marker cannot suppress it.

The workorder state table is fixed:

| Condition                          | Existing row             | Generation disposition  | Replacement                         | External result                        |
| ---------------------------------- | ------------------------ | ----------------------- | ----------------------------------- | -------------------------------------- |
| Claim                              | `pending -> in_progress` | `active`                | None                                | Worker starts                          |
| Verified effect transaction        | `in_progress -> done`    | Effect outcome          | None                                | Receipt + completion event             |
| Negative verdict, attempts below 3 | `in_progress -> failed`  | `active`                | Fresh pending row, attempts + 1     | Retry next tick                        |
| Negative verdict, attempt 3        | `in_progress -> failed`  | `exhausted`             | None                                | Durable failed row + best-effort alarm |
| Owner supersedes old epoch         | Open row -> `cancelled`  | `superseded`            | None                                | Superseded event, no alarm             |
| Crash before effect transaction    | Recovered as failed      | `active` or `exhausted` | Fresh pending row if budget remains | Stale-claim event                      |
| Crash after effect transaction     | Already `done`           | Effect outcome          | None                                | No recovery or model rerun             |

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
- Workorder attempt ids are host-issued and cannot be selected by the model.
- Temporal payloads contain identifiers, not raw private message bodies.
- Logs include workorder id, task id, occurrence, attempt, verifier outcome, and bounded reason;
  they do not include full connector packets or full model responses.
- `MAMA_TEMPORAL_RECONCILE=off|on` defaults to `off` for the first release. When set to `on`, boot
  requires `MAMA_STAGE2_WORKORDERS=on` and a backend transport capable of exposing the temporal
  role's effective host tools; otherwise boot fails before timers start. Unrelated non-Code-Act runs
  remain unchanged. Production cutover explicitly enables both flags after canary verification.

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

### Release A1 ownership

| Unit                      | Files                                                                   | Public contract and focused proof                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Required hook verdict     | `operator/workorder-consumer.ts`                                        | Optional `verdictRequired`; required hooks must return complete/fail; focused consumer tests prove legacy kinds remain permissive |
| Attempt execution context | `agent/types.ts`, `operator/worker-run.ts`, workorder run-option wiring | Host-only `workorderAttemptId` reaches every nested gateway call and cannot be supplied by model input                            |
| Attempt audit             | `agent/gateway-tool-executor.ts`                                        | Existing activity `details` records workorder attempt id beside per-tool call id; focused audit test                              |

A1 has no migration and introduces no production registration with `verdictRequired: true`. Its
acceptance scenario registers a required hook in a consumer test, proves a missing/negative verdict
fails and requeues, then proves existing board/wiki/memory tests are unchanged.

### Release A2 ownership

| Unit                   | Files                                                                                          | Public contract and focused proof                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Temporal schema/effect | `operator/task-ledger.ts`, focused `db/migrations/` module                                     | Revisioned owner mutations, generation/effect tables, atomic `task_temporal_reconcile`   |
| Candidate scheduler    | new `operator/temporal-reconcile.ts`                                                           | Pure candidate ordering, stable generation keys, caps, enqueue and stop lifecycle        |
| Worker contract        | new `operator/temporal-worker.ts`, brief template                                              | Bounded evidence prompt and three valid effect outcomes                                  |
| Effect audit/guard     | `operator/action-verifier.ts`, `operator/workorder-hooks.ts`, `operator/workorder-consumer.ts` | Receipt audit plus authoritative done-state guard before any temporal failure transition |
| Gateway/API            | `agent/gateway-tool-executor.ts`, task registry/host bridge, HTTP task handler                 | Temporal mutation tool plus normalized `due_at` and derived read fields                  |
| Runtime wiring         | `cli/commands/start.ts` through a focused factory                                              | Feature validation, role/envelope, boot recovery, timer start/stop                       |
| Projection/extraction  | board task projection and reconcile/task guidance                                              | Overdue display and explicit-evidence exact-time capture                                 |

The implementation plan must resolve these table entries to exact paths and line-level steps before
editing. In particular, it must not add another large closure to `start.ts` when a focused factory
can be tested independently.

### Existing behavior to reuse

- occurrence-keyed workorder deduplication and atomic requeue in `TaskLedger`;
- serial operator-lane execution in `WorkOrderConsumer`;
- dirty retry semantics in `ReconcileScheduler`;
- role-filtered Code-Act and connector envelopes from the parity work;
- scoped no-update persistence, now written atomically by the temporal mutation for defer outcomes.

Release A does not change the existing board verifier from observe-only to blocking. That migration
is adjacent but not required for the temporal acceptance criteria and must receive a separate spec.

## Test strategy

### Unit tests

1. RFC 3339 `due_at` validation, date synchronization, clearing, and backward compatibility.
2. Every owner mutation path advances revision exactly once for a real change and never for a no-op.
3. Exhaustive derived temporal state, including `due_at == now`, captured offsets, and every legacy
   date-only relation.
4. Scanner candidate boundaries at one millisecond before, equal to, and after `due_at`.
5. Initial and deferred check-generation keys do not collide; rescheduling away and back or reopening
   increments the epoch and creates a new occurrence.
6. Rescheduling/reopening supersedes prior active generations, cancels their open rows, and produces
   no retry or alarm from an in-flight old worker.
7. Terminal and exhausted generations are never re-enqueued; retry rows reuse one generation key.
8. Candidate caps prioritize exact/deferred work and bound date-only activation work.
9. The temporal mutation binds trusted attempt/generation/task/epoch/check context and rejects stale
   revisions, superseded rows, wrong occurrences, no-ops, and invalid fields.
10. A superseded temporal context can finish reads but every write-capable gateway function is
    denied with `workorder_superseded`.
11. Attempt-receipt verification rejects unrelated task writes and previous retry attempts while
    accepting a valid effect superseded by a later legitimate update.
12. `final_no_update` requires exact scope and evidence summary and finalizes the generation.
13. Deferred outcomes atomically require exact scope, reason, and a future next-check value without
    setting the final occurrence marker.
14. Missing, negative, and thrown required hook verdicts fail/requeue instead of completing.
15. Empty response, missing envelope, and stale claim use the same ledger-managed retry counter.
16. Runner, malformed marker, or post-run audit failure after an atomic effect cannot requeue or overwrite its terminal
    generation; a stale in-progress row has no receipt and follows normal retry.
17. An authoritative state-read fault mutates nothing and blocks new claims until its queued recheck
    resolves.
18. Offset-bearing date-only tasks use the same boundary for selection and generation keys.
19. Feature flag and Stage-2/backend compatibility validation fail before timers start.

### Integration tests

1. At 13:50 create a 14:00 owner task; crossing 14:00 enqueues exactly one temporal workorder.
2. A worker reads scoped evidence, updates that task, and completes only after the DB change is
   verified.
3. A worker that only explains or publishes a report fails verification and retries.
4. A daemon restart before the effect transaction recovers the in-progress claim without a
   duplicate; a restart after it observes an already-done row and receipt.
5. Rescheduling to 15:00 creates a distinct future occurrence and does not inherit the 14:00 check.
6. Rescheduling while the 14:00 worker runs supersedes that generation; its late mutation is denied
   without retry or alarm.
7. A deferred 14:00 check schedules and executes its distinct future check generation.
8. A due-today date-only task is sent for evidence enrichment; explicit time evidence produces
   `due_at`, while ambiguous evidence remains date-only with a bounded judgment.
9. Three failed attempts mark the generation exhausted and repeated scanner ticks create no fourth
   attempt.
10. A large date-only backlog never exceeds the configured per-tick and open-work caps.
11. Trello/Kagemusha evidence can inform the decision but cannot mutate the native task implicitly.
12. Codex and Claude workers receive equivalent effective inner capabilities for this role while
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
- `docs/explanation/architecture.md` for the temporal scanner and blocking verifier;
- `docs/guides/standalone-setup.md` for observable overdue and retry behavior;
- `docs/reference/api.md` for `due_at` and derived temporal fields;
- `docs/reference/configuration-options.md` for any new interval or feature flag;
- worker brief templates and operational troubleshooting guidance.

Documentation must continue to state that Trello is connector evidence, Kagemusha is read-only
project-task truth, and the native ledger owns owner tasks. It must not promise cross-store lifecycle
updates that the runtime cannot perform.

## Acceptance criteria

Release A1 is complete when a synthetic required hook can block workorder completion, the claimed
row id reaches nested gateway audit as trusted context, and every existing workorder kind retains its
pre-A1 semantics. A1 does not enable temporal behavior by itself.

Release A2 is complete only when all of the following are true:

1. Crossing a structured due instant creates durable, idempotent work without user input.
2. The board displays overdue as a temporal fact even before the agent judges lifecycle state.
3. Explanation-only, report-only, empty, denied, and unverified runs cannot complete the temporal
   workorder.
4. A verified `resolved`, evidence-backed `final_no_update`, or atomic `deferred` effect can complete
   it; deferred checks use a distinct future generation.
5. Failures retry, stale claims recover, exhaustion is terminal for its generation, and the failed
   row remains owner-visible with bounded evidence.
6. Scheduling changes and reopen operations supersede old generations atomically; late old workers
   cannot mutate the new occurrence, retry, or alarm.
7. Existing date-only tasks enter bounded evidence reconciliation without invented exact times, and
   non-temporal workorders remain backward compatible.
8. Connector and source-of-truth boundaries remain unchanged and documented.
9. Date-only activation work is bounded and cannot starve current exact-time work.
10. Focused, integration, full standalone, build, restart, and log-safety checks pass.

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

# MAMA Runtime Overhead Canary Remediation

> **Status:** PR #238 merged, v0.39.2 release candidate, new 24-hour live canary pending
>
> **Date:** 2026-08-26
>
> **Scope:** v0.39.0 live-canary follow-up for owner-event Board cost and Telegram delivery
> observability
>
> **Parity:** TG-03, TG-04, TG-05, TG-06

## 1. Why v0.39.0 did not clear

The safety contracts worked. The cost and observability contracts did not.

The first live window produced thirteen actual owner-event batches. Eight batches created durable
Board intents. Seven non-force Board repairs completed for those eight intents and consumed
3,760,273 authoritative `agent_activity.workorder_complete.tokens_used`. The saved eight-intent
baseline is 2,881,994 tokens, so the new path was 30.5% more expensive per Board-delegated batch.
Even when every one of the thirteen owner-event batches is used as the denominator, the reduction
was only 19.7%, far below the required 60%.

The same window showed why:

- connector batches arrived at an observed five-minute cadence;
- an owner-event judgment took 28 to 338 seconds before creating its Board intent;
- a fresh Board repair took roughly five to eight minutes;
- `OwnerEventBoardRefreshLedger.accept()` enqueued immediately;
- `WorkOrderConsumer` claimed the pending row on its next 60-second tick;
- a later intent could attach to an in-progress workorder, but could not widen its captured
  generation, so verified completion scheduled another repair.

Coalescing therefore happened only when several model judgments happened to finish while one
workorder was open. It did not coalesce the actual arrival burst. The current unit test proves that
twenty intents can share one open row, but intentionally verifies that generations beyond the
captured value become follow-up work. It does not model claim timing or the measured cadence.

Telegram effects also reached `confirmed`, but the durable owner-event row stored only `chatId`
and transport `variant`; confirmation stored `null`. The Telegram delivery ledger retained a
payload hash for some sends, never the body. A retry with different wording was intentionally
treated as the already-confirmed effect. This prevents a duplicate send but cannot prove what was
sent, whether the body was truncated, or whether internal metadata leaked.

No real post-cutover Temporal generation was observed. The v0.39.0 Temporal breaker remains code
green and operationally unproven.

## 2. Goals

1. Coalesce the measured five-minute owner-event stream before a Board worker claims the repair.
2. Keep exact batch acceptance immediate and durable.
3. Preserve one non-force Board repair per bounded claim window, with at most one later bounded
   window for intents accepted after claim.
4. Persist the exact owner-event Telegram payload and a local delivered receipt for the same
   semantic delivery identity.
5. Reject a retry that changes the payload behind an already-reserved delivery identity.
6. Preserve sender, role, envelope, scope, destination, path, idempotency, mutation-terminal, and
   receipt-first recovery boundaries.
7. Clear the change only with real owner-event and Temporal traffic plus a fresh 24-hour canary.

## 3. NOT in scope

- Removing or weakening validation.
- Reusing a model session for owner-event or Board work.
- Hard-coding which owner events must request Board work.
- Delaying direct Telegram feedback to the owner.
- Changing manual forced Board refreshes or the 30-minute scheduled repair contract.
- Retaining Telegram bodies longer than their owning owner-event inbox row.
- Inferring or backfilling payloads for legacy confirmed effects.
- Adding UI, browser, or synthetic canary traffic.
- Implementing the still-separate audit-retention or daemon-log-rotation slices.

## 4. What already exists

| Need                                | Existing authority                                  | Decision                                               |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Open workorder dedupe               | `TaskLedger` partial unique occurrence index        | Reuse `boardRepairKey()`                               |
| Workorder eligibility time          | `operator_tasks.due_at`                             | Reuse only for `kind='system'` claim-not-before        |
| Exact owner-event batch acceptance  | `OwnerEventBoardRefreshLedger`                      | Extend the existing transaction, no new coordinator    |
| Captured Board generation           | `BoardRefreshGate` and `applyBoardRefreshVerdict()` | Widen only while pending; keep in-progress immutable   |
| Post-terminal repair obligation     | `postTerminalFollowups`                             | Keep one delayed follow-up, no new timer               |
| External effect reservation         | `OwnerEventEffectLedger`                            | Version the existing JSON intent and result            |
| Telegram target/payload idempotency | `TelegramMessageLedger`                             | Reuse its current delivery identity and delivered row  |
| Telegram path containment           | `resolvePrivateWorkspaceFile()`                     | Keep unchanged; do not add byte snapshots or file hash |
| Owner-event retention               | inbox cleanup triggers                              | Derived body and receipt expire with the inbox row     |

## 5. Approaches considered

### A. Durable bounded claim window plus exact delivery receipt, selected

Persist a not-before time on an owner-event Board workorder. Exact intents continue to commit
immediately, while the consumer cannot claim the workorder for twenty minutes. Intents accepted
before claim widen the pending workorder's captured generation atomically. Telegram effects bind
and retain their exact canonical payload and a matching delivered receipt.

Applying a fixed twenty-minute window to the observed eight intent timestamps produces two repair
windows instead of seven. At the observed mean of 537,182 tokens per repair, the projected cost is
1,074,364 tokens, a 62.7% reduction from the saved eight-intent baseline. This is a projection, not
release evidence; the post-release canary must remeasure it.

### B. Wait only for the existing 30-minute scheduled repair

This has the lowest model cost but makes owner-event Board freshness depend entirely on scheduler
phase. A batch arriving just after the scheduled tick may wait almost thirty minutes before claim,
then another five to eight minutes for execution. It also blurs owner-event acceptance and scheduled
repair ownership.

### C. Widen only pending generations without delaying claim

This is the smallest code change, but it does not address the observed serialization. Most intents
were accepted after the previous repair had already started or finished, so the measured path would
still create almost one repair per Board-delegated event.

## 6. Board claim-window contract

```text
owner-event judgment chooses Board
  -> exact intent + shared pending workorder commit
  -> system due_at blocks claim for 20 minutes
       -> later accepted intent widens pending generation
       -> scheduled full tick promotes the same row to ready
  -> consumer claims one ready row
  -> verified generation applies exact intents
       -> no newer intent: terminal
       -> newer in-progress intent: one new delayed follow-up
```

### 6.1 Reuse the existing queue row

Do not add another queue table, timer, worker, service, or schema column. `operator_tasks` already
has nullable `due_at`. Its meaning is discriminated by `kind`:

- `kind='owner'`: existing user-visible task due time;
- `kind='system'`: earliest time the internal workorder may be claimed.

`claimNextWorkOrder()` filters before priority ordering:

```sql
kind = 'system' AND status = 'pending' AND (due_at IS NULL OR due_at <= now)
```

A deferred high-priority Board row therefore does not block a ready Wiki, memory-curation, or
Temporal row. Manual, boot, and non-owner-event workorders continue to use `due_at = NULL`
unless they are attaching pending owner-event intents. A scheduled full tick that finds the same
open `boardRepairKey()` row promotes that pending row to `due_at = now`; an owner-event
window cannot push an already-due scheduled repair later.

The existing status index already narrows claims to pending rows. Do not add another index until
the query is measured as a bottleneck. Existing Temporal triggers restrict their `due_at` behavior
to `kind='owner'`, so workorder availability does not enter owner-task reconciliation or the Viewer
task contract.

### 6.2 Fixed twenty-minute window

The first owner-event Board acceptance creates the shared non-force repair with:

```text
due_at = accepted_at + 20 minutes
```

The window is fixed from the first accepted intent. It is not extended indefinitely. Twenty
minutes is derived from the measured five-minute source cadence: a steady stream can place about
five accepted generations in one window, while the maximum Board freshness remains below the
existing thirty-minute scheduled interval before execution time is added.

The constants live in `owner-event-board-refresh.ts`, not environment configuration:

```ts
OWNER_EVENT_BOARD_CLAIM_WINDOW_MS = 20 * 60_000;
```

This is a product cost/freshness contract, not a tuning flag. A rollback to v0.39.0 may claim an
existing delayed row early because the old binary ignores the additive column; that weakens cost
coalescing only and does not duplicate or lose accepted intents.

### 6.3 Pending generation widening

In the same `BEGIN IMMEDIATE` transaction that inserts a new exact intent:

1. `enqueueWorkOrder()` creates or returns the shared `boardRepairKey()` row.
2. If the row is `pending`, the ledger atomically widens its payload to the greater of the current
   captured `repairGeneration` and the maximum accepted generation, with matching
   `noUpdateScope`. It never lowers a restart- or schedule-seeded generation.
3. The first row's `due_at` is preserved. A later intent cannot move the deadline.
4. The exact intent binds to that workorder and commits.

The update is conditional on `status='pending'`. An in-progress workorder is immutable. A later
intent may temporarily point at it, remains unapplied after the current captured generation, and
is reattached to one new delayed workorder after terminal commit through the existing follow-up
signal.

The worker sees only the final pending payload at claim. Verified completion can therefore apply
every generation accepted before claim in one run.

### 6.4 Recovery

- A daemon restart preserves `due_at`; boot does not create an immediate duplicate.
- A stale in-progress workorder follows the existing fail/recovery policy. Unapplied intents create
  one new delayed repair.
- A scheduled full tick atomically promotes an existing delayed pending repair to ready and widens
  it to the current captured generation. It does not enqueue a second row.
- A different verified full repair may apply every generation while the delayed row is still
  pending. The intent ledger then cancels that now-empty pending row in the same transaction, so it
  cannot run later with no obligation.
- A transaction failure rolls back the workorder, generation widening, and exact intent together.
- Unverified, failed, and exhausted repairs keep intents unapplied and do not hot-loop.
- Manual `force=true` repair remains a unique immediate occurrence and may run before the delayed
  owner-event repair. Its verified captured generation may apply pending intents only through the
  existing generation verifier; it does not rewrite their workorder identity.

## 7. Telegram payload and receipt contract

```text
validated telegram_send input
  -> canonical {target, variant, body/caption, path/emotion, deliveryId}
  -> owner effect begin(transmitting, exact intent)
  -> existing Telegram gateway + message ledger
       -> mismatch: reject
       -> unknown: reconcile only
       -> delivered: local ledger receipt
  -> owner effect confirm(deliveryId, payloadIdentity, deliveredAt)
```

### 7.1 Canonical intent

Normalize and validate before reserving an owner-event Telegram effect. Persist versioned intent
V1 in `owner_event_effects.intent_json`:

```ts
interface OwnerEventTelegramIntentV1 {
  version: 1;
  chatId: string;
  variant: 'text' | 'file' | 'image' | 'sticker';
  deliveryId: string;
  message: string | null;
  filePath: string | null;
  stickerEmotion: string | null;
}
```

- Text retains the exact transmitted Unicode body.
- File/image retains the resolved private-workspace path and exact caption, matching the existing
  Telegram message-ledger identity. Existing path containment remains the byte-access boundary.
- Sticker retains the normalized emotion.
- Do not add a second payload-hash algorithm or claim byte-level file attestation. Exact retry
  comparison uses the normalized intent fields already stored in this row.
- Empty or whitespace-only text is rejected before reservation.
- File containment and regular-file validation happen before reservation through the existing
  private-workspace resolver.

Owner-event rows already retain source connector text and are deleted with the inbox retention
trigger. The derived outbound body follows that same bounded lifetime and is never logged.

### 7.2 Exact retry identity

`OwnerEventEffectLedger.begin()` still owns pending-before-send. When a row exists, the executor
compares the stored canonical intent with the newly normalized intent:

- exact match plus `transmitting/unknown` returns reconcile-only;
- exact match plus `confirmed` returns the stored receipt without sending;
- any normalized intent or delivery identity mismatch fails closed. File/image identity remains the
  existing resolved path plus caption; no byte hash is introduced.

The old test that treats rephrased text as the same successful effect becomes a RED mismatch test.

### 7.3 Delivered receipt

After the awaited Telegram gateway call succeeds, confirm with versioned result V1:

```ts
interface OwnerEventTelegramReceiptV1 {
  version: 1;
  deliveryId: string;
  variant: 'text' | 'file' | 'image' | 'sticker';
  payloadIdentity: string;
  state: 'delivered';
  confirmedAt: number;
}
```

The gateway's existing message ledger marks `delivered` only after every API call or chunk has
returned. Add one narrow read method on the existing Telegram gateway that returns the persisted
ledger state and `payloadIdentity` for an exact delivery ID and actual transport variant. This is a
method on the existing gateway, not a new receipt service or ledger. The executor calls it after the
awaited send and stores the returned identity. Image-to-file fallback records the actual delivered
variant. The effect row carries the exact body for inspection, while the Telegram ledger and effect
result carry the same identity for the direct join. No chat ID or user text enters logs.

A failure after reservation remains `unknown`, preserving current receipt-first recovery. Telegram
409, provider rejection, and transport ambiguity keep their existing classification. If the send
returns but the existing gateway ledger receipt cannot be read or validated, the executor also
marks the effect `unknown`; it never converts missing local proof into confirmation or another send.

### 7.4 Legacy rows

Existing rows whose intent has no `version` remain authoritative proof that the effect must never
be replayed. A confirmed legacy row returns success and is classified by the canary as
payload-unobservable from its missing version; no new tool-result field or log line is added. It is
never re-sent. No body or receipt is
inferred from model history. A transmitting/unknown legacy row stays reconcile-only and pages
through the existing path.

## 8. Code organization

Keep both PRs inside existing modules. Add no class, service, worker, timer, queue, or hash module.

### PR-A: Board claim window

| Module                                                 | Change                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `operator/task-ledger.ts`                              | Filter system claims by `due_at`; preserve ready priority ordering     |
| `operator/owner-event-board-refresh.ts`                | Set fixed delay, widen pending generation, promote/cancel pending rows |
| `cli/runtime/api-routes-init.ts`                       | Scheduled promotion and delayed terminal follow-up                     |
| `cli/commands/start.ts`                                | Keep terminal receipt and boot wiring on the existing ledger           |
| Existing TaskLedger, owner-event, CLI, and route tests | RED cadence, race, recovery, promotion, cancellation cases             |

The intent ledger owns all SQL that changes its attached Board workorder. `TaskLedger` owns only
the generic ready-row claim predicate. Do not duplicate the twenty-minute rule in `start.ts` or
`api-routes-init.ts`.

### PR-B: Telegram observation receipt

| Module                                              | Change                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `operator/owner-event-effects.ts`                   | Versioned intent/result types and pure exact-intent comparison       |
| `agent/gateway-tool-executor.ts`                    | Normalize once, reserve, send, read existing ledger receipt, confirm |
| `gateways/telegram.ts`                              | One narrow read method for an existing outbound delivery row         |
| `cli/runtime/gateway-init.ts`                       | Preserve delivery ID, active-turn methods, and receipt read          |
| Existing owner-effect, executor, and Telegram tests | RED exact payload, retry, fallback, legacy, missing-receipt cases    |

Keep normalization and version parsing out of the already-large gateway executor. The executor
orchestrates existing boundaries; pure intent construction and compatibility checks live beside
`OwnerEventEffectLedger`.

Inline comments should include two small ASCII state diagrams:

- `owner-event-board-refresh.ts`: pending window -> claim -> verified/follow-up transitions;
- `gateway-tool-executor.ts`: reserve -> send -> receipt -> confirm/unknown precedence.

## 9. Safety and parity

- **TG-03/TG-04:** MAMA still chooses whether to request Board or Telegram work. The host controls
  batching and exact external-send identity, never the model's tool sequence.
- **TG-05:** owner-event and Board model sessions remain fresh. The claim window removes model runs
  rather than accumulating session context.
- **TG-06:** exact batch intent commits before ACK, only verified generations apply, exact payload
  identity survives restart, and delivered receipt remains the completion authority.
- sender and role classification are unchanged;
- envelope, scope, destination, and path checks remain fail-closed;
- mutation terminal and unknown outcomes still take precedence over retries;
- no secret, chat ID, raw source text, or outbound body is added to logs or public telemetry.

## 10. TDD plan

```text
CODE PATH COVERAGE
==================
[+] Owner-event Board acceptance
    |-- [RED ***] first intent -> delayed shared row + exact receipt
    |-- [RED ***] later pending intent -> widen generation, preserve due_at
    |-- [RED ***] accept wins claim race -> widened row claimed once
    |-- [RED ***] claim wins race -> immutable run + one delayed follow-up
    `-- [RED ***] transaction failure -> no task, no intent, dirt retained

[+] Workorder claim and completion
    |-- [RED ***] before due_at -> skip without blocking ready lower priority work
    |-- [RED ***] at/after due_at -> atomic pending -> in_progress claim
    |-- [RED ***] scheduled tick -> promote same pending row, no duplicate
    |-- [RED ***] verified full -> apply captured generations
    |-- [RED ***] other verified full -> cancel empty delayed row
    `-- [RED ***] unverified/failed -> retain obligation, no hot loop

[+] Owner-event Telegram send
    |-- [RED ***] text/file/image/sticker -> exact versioned intent before send
    |-- [RED ***] same confirmed intent -> receipt replay, zero transport calls
    |-- [RED ***] changed intent -> fail closed, zero transport calls
    |-- [RED ***] transport ambiguity -> unknown, zero automatic resend
    |-- [RED ***] missing ledger receipt after send -> unknown, no false confirm
    |-- [RED ***] image rejection -> file fallback + actual variant receipt
    |-- [RED ***] production adapter -> forwards delivery ID + active-turn + receipt read
    `-- [RED ***] legacy confirmed/unknown -> no replay, no inferred payload

USER FLOW COVERAGE
==================
[+] [->EVAL] five-minute owner-event stream
    |-- [RED ***] ten accepted Board intents -> at most three repairs
    |-- [RED ***] exact batch ACK before delayed execution
    `-- [LIVE] >=60% token reduction on real traffic

[+] [->EVAL] visible Telegram feedback
    |-- [RED ***] exact Unicode/multi-chunk body + matching delivered identity
    |-- [RED ***] no duplicate on exact retry
    `-- [LIVE] no truncation or internal metadata in real payload

[+] [->EVAL] Temporal parity
    `-- [LIVE] real host-bound receipt or one-run deterministic breaker

PLANNED UNIT/INTEGRATION COVERAGE: 23/23 paths (100%)
LIVE-ONLY EVIDENCE: 3 canary assertions
```

### Board RED tests

1. Ten owner-event Board intents accepted at five-minute intervals produce two delayed workorders,
   not ten immediate repairs.
2. A pending workorder is unclaimable before its system `due_at` and claimable after it.
3. A deferred high-priority Board row does not block a ready lower-priority workorder.
4. Every intent accepted before claim widens the pending payload generation and exact no-update
   scope atomically.
5. At the accept/claim race, accept-first widens the pending payload and claim-first leaves the
   in-progress payload immutable; the latter creates one delayed post-terminal repair.
6. An intent accepted after claim cannot mutate the in-progress payload and creates one delayed
   post-terminal repair.
7. Another verified full repair cancels a delayed pending row after applying all of its intents.
8. Restart preserves the delay and exact intent bindings.
9. Manual forced and scheduled repairs remain immediate and preserve their existing keys.
10. Existing owner-task `due_at`, Temporal scans, and Viewer task projection remain unchanged for
    `kind='owner'`.
11. An intent transaction failure rolls back both the delayed task mutation and exact batch row.

### Telegram RED tests

1. Exact Unicode text and delivery identity are retained before send.
2. Rephrased retry text for the same host key is rejected and never reported as the prior success.
3. A confirmed effect stores a delivered receipt whose payload identity matches the Telegram
   message ledger.
4. Long multi-chunk text retains one exact payload and one delivered receipt.
5. File/image intent binds the existing resolved path, caption, and variant without adding a new
   byte-snapshot contract.
6. Sticker intent binds normalized emotion.
7. Legacy confirmed rows are never replayed and remain explicitly unobservable.
8. Missing or malformed local delivery receipt after a returned send leaves the effect unknown and
   does not resend.
9. Image-to-file fallback stores the actual delivered variant and matching ledger identity.
10. Inbox retention cleanup removes the retained body and receipt with the effect row.
11. Logs and public telemetry contain only identity-free counts/hashes, never the retained body.
12. Internal metadata is absent from the persisted canary payload in a real post-release event; unit
    tests pin only the structural inspection surface, not model quality.
13. The production gateway adapter forwards every Telegram delivery identity, active-turn method,
    and receipt read instead of reducing the real gateway to an unreceipted mock-shaped surface.

## 11. Production failure modes

| Failure                                         | Handling                                                     | Test | Operator/user surface              |
| ----------------------------------------------- | ------------------------------------------------------------ | ---- | ---------------------------------- |
| Accept and claim race                           | `BEGIN IMMEDIATE` serializes; loser follows next valid state | Yes  | One run or one delayed follow-up   |
| Intent insert or pending payload update fails   | One transaction rolls back; gate dirt remains                | Yes  | Retry with bounded error           |
| Deferred high-priority row exists               | Ready-row filter lets other work proceed                     | Yes  | No Wiki/Temporal starvation        |
| Scheduled tick meets delayed owner repair       | Promote same row and widen generation                        | Yes  | Scheduled freshness preserved      |
| Manual repair applies delayed obligations       | Cancel empty pending row                                     | Yes  | No later zero-obligation run       |
| Daemon restarts before claim                    | Persisted `due_at` and exact intents survive                 | Yes  | Same delayed repair resumes        |
| Telegram retry changes body/target/variant      | Exact stored intent mismatch rejects                         | Yes  | Clear tool failure, no second send |
| Telegram send outcome is ambiguous              | Effect remains unknown and reconcile-only                    | Yes  | Existing alarm/recovery path       |
| Send returns but durable ledger receipt missing | Mark unknown; never infer confirmation or resend             | Yes  | Observability alarm, no duplicate  |
| Legacy confirmed effect lacks body              | Never replay; canary labels unobservable                     | Yes  | No false quality claim             |
| Inbox retention deletes effect                  | Existing cleanup removes derived payload and receipt         | Yes  | Bounded local retention            |

Critical silent gaps after planned tests: 0.

### Regression gates

- focused owner-event ledger, TaskLedger, consumer, API-route, gateway executor, Telegram gateway,
  and parity tests;
- standalone typecheck, build, and full tests;
- root typecheck, build, and tests;
- changed-file Prettier and `git diff --check`;
- Kagemusha TG-03/TG-04/TG-05/TG-06 evidence update.

## 12. Performance budget

- Current production has about 4,220 operator task rows. The existing status index narrows claim
  candidates before the `due_at` filter; pending rows are bounded by one serial consumer. Do not
  add an index unless post-change query timing proves the current scan material.
- Each accepted Board intent adds no new row beyond the existing intent and workorder records. A
  pending window performs one small payload/`due_at` update in the existing transaction.
- No file copy, content hash, background timer, or extra polling query is introduced.
- Exact Telegram text or caption is stored once in the existing effect JSON and deleted with the
  retained inbox row. It is not copied into tool traces, agent activity, or daemon logs.
- Normal owner and non-owner lanes pay no new model or hashing cost. The intended saving comes only
  from reducing fresh full-Board model runs.
- The twenty-minute wait is an explicit freshness tradeoff. Direct Telegram feedback remains
  immediate, manual Board refresh remains immediate, and a scheduled tick can promote the row.

## 13. Workstream order

| Lane | Modules                                         | Depends on      |
| ---- | ----------------------------------------------- | --------------- |
| A    | operator ledger, TaskLedger, CLI runtime, tests | Approved design |
| B    | owner effect, gateway executor, Telegram, tests | Approved design |
| C    | parity docs, release, local runtime, canary     | A and B merged  |

Lanes A and B have no required source-file overlap and are technically parallelizable. Execute them
sequentially anyway: PR-A establishes the queue contract, PR-B rebases on current main, and both
touch the same parity/release evidence. This keeps review and rollback attribution clear. Lane C
starts only after both are merged.

## 14. Release and canary

Ship the Board claim-window contract and Telegram payload receipt in separate PRs from the same
reviewed design, then one patch release. Board queue timing and external-send persistence are
separate failure domains and require separate rollback points.

After install and a single launchd restart, reset the cutover time and require:

1. at least ten actual owner-event Board intents;
2. no more than three Board repairs for the measured ten-intent five-minute stream;
3. at least 60% Board token reduction against the intent-count-scaled baseline,
   `7,204,986 * actualIntentCount / 20`;
4. exact batch acceptance and verified-generation application with no false ACK;
5. every new Telegram effect joined to its exact local body, existing ledger payload identity, and
   delivered receipt;
6. no duplicate delivery, truncation, Code-Act/internal metadata exposure, Telegram 409, or
   provider finish error;
7. one real Temporal generation completing with a host-bound `context_compile` receipt, or an
   actual deterministic repeated failure stopping at three equal fingerprints and one model run;
8. twenty-four clean hours after the new cutover.

If actual traffic is absent, the canary waits. Synthetic messages, connector events, workorders,
Telegram UI, browser, and Computer Use remain forbidden.

## 15. Rollback

- Reinstall v0.39.0 and restart the single launchd service.
- No schema column is added. v0.39.0 already understands `due_at` and merely ignores it while
  claiming system workorders, so rollback may run a delayed row early but cannot lose an intent.
- New V1 effect rows remain confirmed and are never replayed. v0.39.0 reads their `chatId` and
  `variant` fields and ignores additional JSON keys; result JSON remains optional.
- No destructive down migration is required.

## 16. Eng review completion summary

- Step 0 Scope Challenge: scope reduced. Removed the proposed schema column, migration class,
  file snapshot, byte hash, duplicate hash module, and speculative index. A final consistency pass
  also removed the two residual hash requirements from retry and canary criteria.
- Architecture Review: 4 issues found, 4 resolved. Scheduled promotion, accept/claim ordering,
  empty delayed work, and missing post-send receipt now have explicit state transitions.
- Code Quality Review: 2 issues found, 2 resolved. Existing modules own the behavior; the gateway
  executor keeps orchestration only.
- Test Review: coverage diagram produced, 23/23 planned code paths covered, 8 missing regression
  cases added to the RED plan.
- Performance Review: 2 issues found, 2 resolved. No new timer, poller, file I/O, hash path, or
  unmeasured index remains.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0. Existing audit-retention and documentation debt remain separate.
- Failure modes: 11 reviewed, 0 critical silent gaps.
- Outside voice: skipped. The user requested gstack review, not a second model review.
- Parallelization: 2 independent source lanes, intentionally executed sequentially for review and
  rollback clarity.
- Lake Score: 7/7 review recommendations chose the complete minimal option.

## GSTACK REVIEW REPORT

| Review        | Trigger                | Why                             | Runs | Status | Findings                                               |
| ------------- | ---------------------- | ------------------------------- | ---: | ------ | ------------------------------------------------------ |
| CEO Review    | `/plan-ceo-review`     | Scope & strategy                |    0 | -      | Backend cost correction; not required                  |
| Codex Review  | collaboration subagent | Independent second opinion      |    0 | -      | Not requested                                          |
| Eng Review    | `/plan-eng-review`     | Architecture & tests (required) |    1 | CLEAR  | 16 issues/gaps reviewed, 0 unresolved, 0 critical gaps |
| Design Review | `/plan-design-review`  | UI/UX gaps                      |    0 | -      | No UI change                                           |
| DX Review     | `/plan-devex-review`   | Developer experience gaps       |    0 | -      | No public API/SDK change                               |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED, ready to write the implementation plan.

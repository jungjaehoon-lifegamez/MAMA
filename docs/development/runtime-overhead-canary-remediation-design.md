# MAMA Runtime Overhead Canary Remediation

> **Status:** Direction A approved, written-spec review pending
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

## 3. Non-goals

- Removing or weakening validation.
- Reusing a model session for owner-event or Board work.
- Hard-coding which owner events must request Board work.
- Delaying direct Telegram feedback to the owner.
- Changing manual forced Board refreshes or the 30-minute scheduled repair contract.
- Retaining Telegram bodies longer than their owning owner-event inbox row.
- Inferring or backfilling payloads for legacy confirmed effects.
- Adding UI, browser, or synthetic canary traffic.
- Implementing the still-separate audit-retention or daemon-log-rotation slices.

## 4. Approaches considered

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

## 5. Board claim-window contract

### 5.1 Dedicated queue availability column

Add an additive nullable column to `operator_tasks`:

```sql
available_at INTEGER CHECK (available_at IS NULL OR available_at >= 0)
```

`available_at` is queue metadata for `kind='system'` workorders. It is not an owner deadline and
must not reuse `due_at`, whose meaning belongs to owner-task Temporal reconciliation. Add a partial
claim index over open system rows ordered by availability, priority, and id.

`EnqueueWorkOrderInput` gains an optional host-only `availableAt`. It is stored in the column and
never copied into the model-visible workorder payload.

`claimNextWorkOrder()` filters before priority ordering:

```sql
status = 'pending' AND (available_at IS NULL OR available_at <= now)
```

A deferred high-priority Board row therefore does not block a ready Wiki, memory-curation, or
Temporal row. Manual, boot, and non-owner-event workorders continue to use `available_at = NULL`
unless they are attaching pending owner-event intents. A scheduled full tick that finds the same
open `boardRepairKey()` row promotes that pending row to `available_at = now`; an owner-event
window cannot push an already-due scheduled repair later.

### 5.2 Fixed twenty-minute window

The first owner-event Board acceptance creates the shared non-force repair with:

```text
available_at = accepted_at + 20 minutes
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

### 5.3 Pending generation widening

In the same `BEGIN IMMEDIATE` transaction that inserts a new exact intent:

1. `enqueueWorkOrder()` creates or returns the shared `boardRepairKey()` row.
2. If the row is `pending`, the ledger atomically updates its payload to the maximum accepted
   `repairGeneration` and matching `noUpdateScope`.
3. The first row's `available_at` is preserved. A later intent cannot move the deadline.
4. The exact intent binds to that workorder and commits.

The update is conditional on `status='pending'`. An in-progress workorder is immutable. A later
intent may temporarily point at it, remains unapplied after the current captured generation, and
is reattached to one new delayed workorder after terminal commit through the existing follow-up
signal.

The worker sees only the final pending payload at claim. Verified completion can therefore apply
every generation accepted before claim in one run.

### 5.4 Recovery

- A daemon restart preserves `available_at`; boot does not create an immediate duplicate.
- A stale in-progress workorder follows the existing fail/recovery policy. Unapplied intents create
  one new delayed repair.
- A scheduled full tick atomically promotes an existing delayed pending repair to ready and widens
  it to the current captured generation. It does not enqueue a second row.
- A transaction failure rolls back the workorder, generation widening, and exact intent together.
- Unverified, failed, and exhausted repairs keep intents unapplied and do not hot-loop.
- Manual `force=true` repair remains a unique immediate occurrence and may run before the delayed
  owner-event repair. Its verified captured generation may apply pending intents only through the
  existing generation verifier; it does not rewrite their workorder identity.

## 6. Telegram payload and receipt contract

### 6.1 Canonical intent

Normalize and validate before reserving an owner-event Telegram effect. Persist versioned intent
V1 in `owner_event_effects.intent_json`:

```ts
interface OwnerEventTelegramIntentV1 {
  version: 1;
  chatId: string;
  variant: 'text' | 'file' | 'image' | 'sticker';
  deliveryId: string;
  message: string | null;
  file: { path: string; sha256: string } | null;
  stickerEmotion: string | null;
  payloadSha256: string;
}
```

- Text retains the exact transmitted Unicode body.
- File/image uses the resolved private-workspace path plus a content hash and exact caption.
- Sticker retains the normalized emotion.
- `payloadSha256` hashes a canonical JSON tuple of every semantic field except itself.
- Empty or whitespace-only text is rejected before reservation.
- File containment and regular-file validation happen before reservation. The content hash binds a
  retry to the bytes, not only to a pathname.

Owner-event rows already retain source connector text and are deleted with the inbox retention
trigger. The derived outbound body follows that same bounded lifetime and is never logged.

### 6.2 Exact retry identity

`OwnerEventEffectLedger.begin()` still owns pending-before-send. When a row exists, the executor
compares the stored canonical intent with the newly normalized intent:

- exact match plus `transmitting/unknown` returns reconcile-only;
- exact match plus `confirmed` returns the stored receipt without sending;
- any payload, target, variant, file hash, or delivery identity mismatch fails closed.

The old test that treats rephrased text as the same successful effect becomes a RED mismatch test.

### 6.3 Delivered receipt

After the awaited Telegram gateway call succeeds, confirm with versioned result V1:

```ts
interface OwnerEventTelegramReceiptV1 {
  version: 1;
  deliveryId: string;
  intentPayloadSha256: string;
  deliveryLedgerKey: string;
  deliveryPayloadIdentity: string;
  state: 'delivered';
  confirmedAt: number;
}
```

The gateway's existing message ledger marks `delivered` only after every API call or chunk has
returned. Add a narrow read-only receipt method that resolves the gateway-owned ledger key,
`payloadIdentity`, state, and update time for the exact `deliveryId` and transport variant. The
effect result stores those returned fields next to the canonical intent hash. File/image ledger
identity may use different inputs from the canonical effect hash, so equality is never inferred;
the stored ledger key is used for the direct join. No chat ID or user text enters logs.

A failure after reservation remains `unknown`, preserving current receipt-first recovery. Telegram
409, provider rejection, and transport ambiguity keep their existing classification.

### 6.4 Legacy rows

Existing rows whose intent has no `version` remain authoritative for no-replay. A confirmed legacy
row returns success with an explicit local `legacy_payload_unobserved` classification and is never
re-sent. No body or receipt is inferred from model history. A transmitting/unknown legacy row stays
reconcile-only and pages through the existing path.

## 7. Safety and parity

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

## 8. TDD plan

### Board RED tests

1. Ten owner-event Board intents accepted at five-minute intervals produce two delayed workorders,
   not ten immediate repairs.
2. A pending workorder is unclaimable before `available_at` and claimable after it.
3. A deferred high-priority Board row does not block a ready lower-priority workorder.
4. Every intent accepted before claim widens the pending payload generation and exact no-update
   scope atomically.
5. An intent accepted after claim cannot mutate the in-progress payload and creates one delayed
   post-terminal repair.
6. Restart preserves the delay and exact intent bindings.
7. Manual forced and scheduled repairs remain immediate and preserve their existing keys.
8. Migration failure is fail-loud and rollback preserves existing database bytes.

### Telegram RED tests

1. Exact Unicode text, delivery identity, and payload hash are retained before send.
2. Rephrased retry text for the same host key is rejected and never reported as the prior success.
3. A confirmed effect stores a delivered receipt whose ledger key and payload identity match the
   Telegram message ledger, while retaining the separate canonical intent hash.
4. Long multi-chunk text retains one exact payload and one delivered receipt.
5. File/image intent binds resolved path, bytes, caption, and variant; changed bytes fail closed.
6. Sticker intent binds normalized emotion.
7. Legacy confirmed rows remain no-replay and explicitly unobservable.
8. Internal metadata is absent from the persisted canary payload in a real post-release event; unit
   tests pin only the structural inspection surface, not model quality.

### Regression gates

- focused owner-event ledger, TaskLedger, consumer, API-route, gateway executor, Telegram gateway,
  and parity tests;
- standalone typecheck, build, and full tests;
- root typecheck, build, and tests;
- changed-file Prettier and `git diff --check`;
- Kagemusha TG-03/TG-04/TG-05/TG-06 evidence update.

## 9. Release and canary

Ship the Board claim-window contract and Telegram payload receipt in separate PRs from the same
reviewed design, then one patch release. Board queue timing and external-send persistence are
separate failure domains and require separate rollback points.

After install and a single launchd restart, reset the cutover time and require:

1. at least ten actual owner-event Board intents;
2. no more than three Board repairs for the measured ten-intent five-minute stream;
3. at least 60% Board token reduction against 7,204,986 tokens per twenty baseline intents;
4. exact batch acceptance and verified-generation application with no false ACK;
5. every new Telegram effect joined to exact local body, delivery identity, payload hash, and
   delivered receipt;
6. no duplicate delivery, truncation, Code-Act/internal metadata exposure, Telegram 409, or
   provider finish error;
7. one real Temporal generation completing with a host-bound `context_compile` receipt, or an
   actual deterministic repeated failure stopping at three equal fingerprints and one model run;
8. twenty-four clean hours after the new cutover.

If actual traffic is absent, the canary waits. Synthetic messages, connector events, workorders,
Telegram UI, browser, and Computer Use remain forbidden.

## 10. Rollback

- Reinstall v0.39.0 and restart the single launchd service.
- The additive `available_at` column is ignored by v0.39.0.
- New V1 effect rows remain confirmed and no-replay. v0.39.0 reads their `chatId` and `variant`
  fields and ignores additional JSON keys; result JSON remains optional.
- No destructive down migration is required.

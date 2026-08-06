# Telegram Owner-Report Context Inbox Design

**Date:** 2026-08-03

**Status:** Implemented (PR #222, 2026-08-06) with adversarial-review fixes; operational Telegram verification pending

**Parity scenarios:** TG-05, TG-06

## Problem

MAMA keeps Telegram user turns in a per-chat model session, but owner reports are generated in the
isolated `operator:report` lane and sent directly through Telegram. The current full-report path
creates one target-bound carry after sending, while digest creates none. The owner can therefore
reply to a report that the chat model has never seen.

The current full-report carry also has a confirmed-send/persist gap: carry persistence errors are
swallowed, after which the trigger loop can clear its pending delivery. That is a context-loss bug.

The role system is outside this phase. The conversation boundary remains `source + channelId`, and
Kagemusha stays a configured user-private connector.

## Evidence and scope

This design follows the current production path:

- `operator/operator-trigger-loop.ts` persists the exact prepared report, target, occurrence,
  delivery ID, and payload identity before delivery, then clears it after
  `SituationReporter.deliverPrepared()` returns.
- `operator/situation-report.ts` sends first, records trigger use, and swallows full-report carry
  persistence failures. Digest has no carry callback.
- `operator/report-carry-delivery.ts` separates Telegram send from the full-only carry callback.
- `gateways/telegram.ts` already gives delivery-ID-bound report text a durable chunk-progress ledger.
- `gateways/message-router.ts` stores provisional streaming text in the same history used by fresh
  sessions, then persists the final response and acknowledges carry in separate operations.

TG-05 requires durable per-chat continuation and bounded fresh-session restoration. TG-06 requires
digest, scheduled full, and on-demand full owner reports to use the same safe delivery path without
hard-coding Kagemusha's tool order into host orchestration.

## Goals

- Make each successfully delivered owner report available as bounded context to the next verified
  turn in that exact Telegram owner chat.
- Preserve the isolated, fresh report session and the per-chat user session.
- Remove the confirmed-send/context-persist loss window.
- Make final turn persistence and report-context consumption one atomic SQLite commit.
- Survive daemon restart, delivery retry, backend session replacement, and concurrent report append.
- Keep exact report text durable while strictly bounding model prompt projection.
- Reuse the existing prepared report, target binding, delivery identity, per-chat queue, and Telegram
  delivery ledger.

## Non-goals

- Per-user owner/admin/member/guest roles or message audiences.
- Per-user private lanes inside one Telegram group.
- Sharing one model session between report generation and user conversation.
- A generic detached-message ledger for cron results, watchdog/ops pages, security alerts, memory-save
  confirmations, Discord, Slack, or future gateways.
- Recording active-turn assistant replies as report context.
- Reworking report composition, Kagemusha connector policy, or agent tool freedom.
- Closing pre-existing Telegram inbound-response delivery windows; this phase defines when report
  evidence becomes durable model context, not a new transaction across the Telegram API.

The generic detached producers above keep their current delivery semantics. They can be migrated in
a later phase only if a real continuity requirement is demonstrated. This follows the parity rule not
to expand TG-05/TG-06 work with unrelated findings.

## Decisions

### 1. One production boundary for all owner-report modes

Digest, scheduled full, and on-demand full use one artifact-bearing port:

```ts
interface ReportDeliveryPort {
  deliverPrepared(report: PendingReportDelivery): Promise<ReportDeliveryOutcome>;
}

type ReportDeliveryOutcome =
  | { status: 'delivered' }
  | { status: 'retry_scheduled'; nextAttemptAt: string }
  | { status: 'definite_rejection'; reason: string }
  | { status: 'cancelled'; reason: string };
```

`PendingReportDelivery` is already the retry-stable occurrence artifact. Its existing `deliveryId`,
exact Telegram target, mode/occurrence, text, provenance, and `payloadIdentity` are the only accepted
identity. The coordinator does not mint a replacement UUID.

`SituationReporter` remains responsible for composition and returns `PreparedSituationReport`; it no
longer delivers through `OutputSink.send(text, deliveryId)`. `OperatorTriggerLoop` attaches the
persisted occurrence, target, and payload identity, then passes its complete `PendingReportDelivery`
directly to `ReportDeliveryPort`. No adapter reconstructs mode, occurrence, target, provenance, or
payload identity from text and delivery ID.

The old `OutputSink` report-delivery use and `persistLastFullReport` callback are removed from
production assembly; they may remain only in V2 compatibility tests and cannot run beside the new
port. Startup wiring tests prove that all three modes use the same coordinator instance, configured
owner target, and store.

Other calls to `TelegramGateway.sendMessage()` are outside this report-only boundary. A structural
test allowlists the report coordinator as the sole `sendSystemMessage()` caller for owner reports so
a later report path cannot bypass it.

### 2. Reserve context before external delivery

`deliverPrepared()` performs this state machine:

1. Verify the prepared payload identity and require its target to equal the configured, verified
   Telegram owner-report target.
2. In the messenger SQLite database, reserve capacity and idempotently insert the exact report as
   `prepared_retryable` before any Telegram API call.
3. Through a narrow `TelegramReportDeliveryControl` port, claim a target/payload-bound delivery entry
   and persist a pin against TTL/count pruning before the API call.
4. Ask that port to send the pinned entry. It returns a typed `confirmed`, `retryable`, or
   `definite_rejection` outcome using the gateway's existing private error classification.
5. On `confirmed`, atomically transition the SQLite row to `delivered` with its delivery time.
6. Idempotently release the pin and return `delivered` only after step 5 commits.

The control port is intentionally smaller than exposing the Telegram ledger:

```ts
interface TelegramReportDeliveryControl {
  claimAndPin(binding: ReportDeliveryBinding): Promise<ReportDeliveryLease>;
  sendPinned(lease: ReportDeliveryLease): Promise<TypedTelegramDeliveryOutcome>;
  releasePin(deliveryId: string): Promise<void>;
  reconcilePins(nonterminalIds: string[], terminalIds: string[]): Promise<void>;
}
```

The persisted pin is added to the Telegram-ledger schema. `claimAndPin()` creates it before the first
send. At startup the coordinator derives truth from all SQLite report rows: every nonterminal row is
pinned, while every `delivered` or `cancelled` row is idempotently unpinned. Recovery treats an
already-delivered SQLite row as success without sending, so a crash after step 5 and before step 6
converges and cannot leave a permanent pin.

On restart, recovery replays `prepared_retryable` rows with the same delivery ID. An existing
confirmed Telegram ledger entry makes the send a no-op, then recovery completes step 5. If a crash
occurs in Telegram's existing ambiguous per-chunk acceptance window, at-least-once recovery may
duplicate that uncertain chunk, but the context row cannot be lost.

The trigger loop retains `PendingReportDelivery`. It advances scheduler success, records trigger
credit, and removes the pending file only for `delivered`. It retains the file for `retry_scheduled`
and `definite_rejection`. For `cancelled`, it removes the file without scheduler success or trigger
credit and records the cancellation audit. A crash after SQLite cancellation but before file cleanup
replays the same artifact; the coordinator returns `cancelled` again and cleanup converges. No report
caller may swallow coordinator persistence failure and report success.

There is exactly one delivery executor. The pending file owns composition only until the coordinator
idempotently accepts its artifact into SQLite. After acceptance, the trigger loop never calls Telegram;
it submits/observes the delivery ID and waits for coordinator status. The coordinator recovery worker
claims a SQLite attempt lease with compare-and-swap fields `attempt_owner` and `lease_until`; its
in-process immediate path uses the same lease. A live lease excludes both another worker and another
tick, while an expired lease is recoverable after restart. Thus trigger replay and startup recovery
can race only to the same idempotent accept/status read, never to two sends.

Cancellation is serialized by the same event-row CAS. It is permitted only from
`prepared_definite_rejection`, where no delivery attempt lease is live. The trigger loop observes the
terminal `cancelled` status on its awaited result or next tick and idempotently removes the pending
file. SQLite remains authoritative if notification or file cleanup is interrupted.

### 3. Permanent rejection has an explicit terminal protocol

The event states are `prepared_retryable`, `prepared_definite_rejection`, `delivered`, and
`cancelled`.

- Transport/429/5xx and ambiguous acceptance remain retryable with durable attempt count,
  `next_attempt_at`, and backoff of 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours capped.
- A definite Telegram non-acceptance moves to `prepared_definite_rejection` and is not automatically
  retried after restart.
- After correcting conditions for the same immutable target, such as unblocking the bot, an explicit
  operator action may reactivate the same delivery ID. A changed target requires safe cancellation of
  the proven-unaccepted occurrence and composition of a new occurrence with a new delivery ID.
- Cancellation is allowed only when the Telegram ledger proves definite non-acceptance. It records a
  reason and operator time, releases live capacity, and retains the target/payload identity tombstone.
- Ambiguous or confirmed acceptance can never be cancelled or discarded as unseen.

### 4. SQLite is the single report-context authority

The messenger SQLite database gains migration-owned tables.

`telegram_report_context_events` contains:

- atomically allocated monotonic `seq` primary key;
- unique `delivery_id`, exact owner target, mode, occurrence JSON, and provenance JSON;
- exact `text` and existing `payload_identity`;
- state, created/delivered timestamps, retry fields, and optional consumption identity;
- context disposition `pending | consumed_turn | operator_archived` for delivered rows;
- a compact immutable tombstone after eligible exact data is pruned.

`telegram_report_context_receipts` contains:

- globally unique `source_message_ref` (`telegram:<channelId>:<messageId>`), not chat-local message ID;
- messenger session ID, ordered selected delivery IDs, projection version/text/hash;
- final-response SHA-256 and commit timestamp.

Delivery identity is immutable. The event/receipt tables, not copied text in
`messenger_sessions.context`, are authoritative for pending projection and fresh-session restoration.

Receipt projection text is bounded separately: at most 1,000 text-bearing receipts or 96 MiB per
target, and 4,000 receipts or 384 MiB global. These bytes participate in pre-send compaction. Projection
text is retained for every receipt whose final turn remains within the session's stored 1,000-turn
window. When that turn ages out, the same SQLite transaction compacts the receipt to IDs, projection
hash, response hash, and commit time. Compact receipt/event identity tombstones are retained for up to
365 days with a 100,000-row global cap. No tombstone younger than Telegram's seven-day replay window is
pruned; beyond that floor, the oldest terminal tombstones are removed first when the count cap applies.

### 5. Projection V1 is fully deterministic and bounded

All character limits use Unicode code points, with no Unicode or newline normalization. The
implementation counts and captures head/tail code points in one pass; it must not allocate an
`Array.from()` copy of an up-to-64-MiB report. Hashes are lowercase hexadecimal SHA-256 over the exact
UTF-8 bytes of the specified string.

Initial limits are:

- live capacity per owner target: 2,048 prepared-or-unconsumed reports and 64 MiB of their exact UTF-8
  text;
- retained exact capacity: 8,192 reports or 256 MiB per target, and 32,768 reports or 1 GiB global;
- one rendered event: 8,000 code points;
- one combined turn block: 24,000 code points and 32 events.

Before reservation, the store compacts the oldest consumed exact records to immutable identity
tombstones until retained limits fit. Prepared and pending-context records are never automatically
compacted, expired, or pruned; only the explicit `operator_archived` protocol below may retire an
already-delivered pending projection. The default 15-minute digest cadence takes more than 21 days to
fill the 2,048-row live limit even without a single owner turn; byte pressure may fill it sooner for
unusually large reports.

At 80% live usage the operator UI/status API exposes a persistent warning. A local authenticated
two-step operator action can list delivered-pending sequence, mode, time, bytes, and hashes, then
explicitly mark a selected through-sequence `operator_archived` using a short-lived confirmation
token. It never applies to prepared, ambiguous, or undelivered rows and is not Telegram cancellation.
The action stores the exact Projection V1 text, actor, reason, and archive time in the audit tombstone,
removes those rows from pending projection and live capacity, and excludes them from automatic fresh
restore because the operator explicitly chose not to show them to the model. It is never automatic.

If live data alone reaches a limit, a new report fails before Telegram send, the on-demand API returns
`capacity_full`, and the trigger loop reports the blocked state in UI/status and logs rather than
claiming success. This report-only backpressure cannot block unrelated security or gateway delivery.

For each event, let `deliveryHash` be lowercase SHA-256 of the delivery ID's UTF-8 bytes. Projection
V1 uses the literal source label `telegram-owner-report:<deliveryHash>` and this exact event grammar:

```text
[owner report seq=<seq> mode=<mode> delivered_at=<ISO> delivery_sha256=<deliveryHash>]
<wrapUntrustedContent("telegram-owner-report:<deliveryHash>", body)>
```

The angle-bracketed expression above means the exact string currently returned by
`wrapUntrustedContent()`, not literal angle brackets. The header and wrapped string are joined by one
LF. Any change to that helper's bytes requires a new projection version.

If the complete rendered event is at most 8,000 code points, the body is exact. Otherwise the body is
the first 3,000 and last 3,000 code points of exact text separated by this exact LF-delimited marker:

```text
[... omitted <N> Unicode code points; exact_text_sha256=<SHA-256 of exact UTF-8 text> ...]
```

Embedded `<<<END-UNTRUSTED-CONTENT>>>` text is neutralized only by `wrapUntrustedContent()`; no other
escaping occurs. The event cap includes header, wrapper, body, and separators.

Selection uses monotonic `seq`, never timestamps:

1. Reserve enough of the combined budget for the oldest pending complete rendered event when the
   whole backlog does not fit.
2. Fill the remaining budget with the newest complete suffix that fits.
3. De-duplicate the anchor if it is already in the suffix.
4. Render selected events oldest to newest inside the exact outer grammar below.
5. When events remain unselected, include
   `[... <N> pending owner reports omitted by turn budget ...]` in the combined budget.

The canonical non-empty combined block is:

```text
<recent_owner_reports projection="v1">
<item-1><LF><LF><item-2>...<LF><LF><item-N>
</recent_owner_reports>
```

Each item is either one complete rendered event or the exact gap marker. There are exactly two LFs
between items and one LF after the opening tag and before the closing tag. A single event has no
double-LF separator. An empty selection emits the empty string and no tags. The gap marker occupies
its chronological gap between the oldest anchor and newest suffix; if there is no anchor, it precedes
the suffix.

The 24,000-code-point cap includes outer tags, every separator, and the gap marker. The 32-event cap
includes the anchor but not the gap marker. `projection_hash` is SHA-256 over the exact UTF-8 bytes of
this complete combined block. Only its exact ordered selected IDs may be consumed. Concurrent later
appends and cap-excluded events remain pending.

### 6. Durable turns and report consumption finalize atomically

`ConversationTurn` gains backward-compatible optional fields:

- `sourceMessageRef`;
- `state: provisional | final`;
- `finalResponseSha256`.

Legacy turns without `state` are treated as final. A new Telegram user turn stores its globally unique
`sourceMessageRef` and starts as provisional. Streaming flush updates only that exact provisional turn;
fresh-session formatting excludes provisional turns.

After the model returns, `SessionStore.finalizeTurnWithReportReceipt()` uses the shared SQLite
connection for one transaction:

1. validate the exact target/session/source-message reference and provisional turn;
2. write the final assistant response, response SHA-256, and `state = final`;
3. insert the receipt with exact ordered IDs, Projection V1 text/hash, and response hash;
4. mark only those delivered events consumed by that source-message reference.

Exact replay of the same source-message reference, final response hash, IDs, and projection hash is a
no-op. Any differing response or snapshot is a conflict. A crash before the transaction leaves the
turn provisional and events pending; a crash after it leaves both final and consumed. Channel history
is a derived record written idempotently after this commit and is not a startup authority.

The existing Telegram inbound-response presenter still delivers/retries the assistant reply after
the router returns. “Consumed” here means the report and final response are durably part of the model
conversation. It does not claim the separate Telegram API response delivery is in the same SQLite
transaction; that pre-existing delivery path is explicitly outside this phase.

### 7. Fresh backend sessions restore from receipts, not copied user text

For a continued backend session, the current turn receives only the selected unconsumed report block
before the user-authored text.

For an actually new or replacement Claude, Codex, or Cline conversation, startup formatting selects
the same recent final messenger turns it already restores. It loads receipts by those turns'
`sourceMessageRef` and emits their already-committed Projection V1 text in a separate
`<recent_owner_report_history>` block, grouped in messenger-turn order and ordered by event `seq`
inside each group. Receipts whose turn is provisional, missing, or outside the selected history window
are excluded.

The complete startup report-history block is capped at 48,000 Unicode code points, 64 events, and five
normal receipts. Candidate normal receipts follow the stored final-turn array order. The builder takes
the newest complete receipt suffix that fits, then renders it oldest to newest; it never slices a
receipt projection. The outer tags, group headers, receipt projection text, and separators all count
toward 48,000. A legacy V2 restoration record is merged by `(consumedAt ?? deliveredAt, deliveryId)`,
with legacy before a normal turn on an equal timestamp, and competes under the same aggregate cap.

The exact outer tags are `<recent_owner_report_history projection="v1">` and
`</recent_owner_report_history>`, with one LF after/before them and two LFs between groups. A normal
group is `[before_turn source_message_ref_sha256=<lowercase SHA-256 of UTF-8 sourceMessageRef>]`, one
LF, then its exact receipt projection text. A legacy group is
`[legacy_v2_consumed delivery_sha256=<lowercase delivery-ID hash> consumed_at=<ISO>]`, one LF, then its
stored legacy projection. An empty selection emits no history tags.

Unconsumed reports are excluded from startup history because the current user prompt carries their
pending snapshot. Receipt projection text follows the explicit receipt bounds in Decision 4, so fresh
restore does not depend on an exact event body that was later compacted.

The history block is emitted only in the initial prompt of an actual new backend conversation.
Successful resume must not emit it. Existing initial creation and `freshSessionSystemPrompt` reset
paths share one builder; adapters must distinguish successful resume from replacement rather than
using daemon-local `SessionPool` presence alone.

Thus a report consumed in backend session A is not pending, but its committed bounded projection
appears once when session B is created. It is absent from B's continuation turns and is never copied
into stored user text.

### 8. V2 carry migration has exact mappings and one owner

The inbox store constructor solely migrates `~/.mama/operator/last-full-report.json` under existing
file coordination.

V2 maps as follows:

- `kind/mode = full`;
- target, delivery ID, delivery time, exact text, and provenance copy byte-for-byte;
- let `provenanceTuple` be `['available', modelRunId]` or `['unavailable', reason]`; legacy payload
  identity is lowercase SHA-256 of the UTF-8 bytes of `JSON.stringify(['legacy-report-carry-v2',
deliveryId, source, channelId, deliveredAt, text, provenanceTuple])`;
- an unconsumed record becomes `delivered` and pending even if the old 24-hour TTL elapsed;
- a consumed record becomes a target-scoped `legacy_v2_consumed` restoration record with its old
  consumed time and channel key plus nullable source-message/session fields; it is not a normal receipt
  and does not invent a Telegram turn;
- its stored restoration text is the exact old `buildReportCarryPrefix()` output and remains eligible
  for fresh-session history for 30 days after `consumedAt`, subject to the same receipt projection
  row/byte caps in Decision 4;
- `legacy_projection_hash` is lowercase SHA-256 over that exact UTF-8 output. The output must execute
  the legacy JavaScript UTF-16 `String.slice(0, 700)` algorithm, including a surrogate split at the
  boundary; Projection V1 code-point rules do not apply.

A consumed V2 restoration record counts as one text-bearing receipt for per-target/global capacity.
Under receipt-cap pressure, legacy records older than Telegram's seven-day replay floor compact first,
oldest `(consumedAt, deliveryId)` first; otherwise they compact exactly at 30 days. Compaction retains
the legacy payload/projection hashes and identity tombstone but removes restoration text.

If a richer pending full-report artifact later replays the same delivery ID, the store accepts it only
when target, mode, exact text, and provenance match the migrated record. It then records the current
payload identity as an alias; any semantic mismatch is quarantined as an identity conflict.

Migration transactionally inserts/idempotently verifies the row, commits SQLite, then atomically
renames the source to `.migrated`. A crash before commit changes nothing. A crash after commit but
before rename replays an identity-equal no-op and retries the rename. Invalid/unscoped legacy files are
quarantined and never injected. No component reads or writes V2 afterward.

## Turn data flow

1. The isolated operator lane persists a `PendingReportDelivery` with stable identity.
2. The coordinator validates it and reserves a report-context row.
3. Telegram idempotently delivers the exact target-bound report.
4. The coordinator marks it delivered; only then can trigger/scheduler state advance.
5. A user message enters the same-chat queue and passes owner-console verification.
6. `MessageRouter` snapshots and prepends a bounded Projection V1 block.
7. The model responds.
8. One SQLite transaction finalizes the exact provisional turn, receipt, and consumption marks.
9. The existing Telegram response presenter delivers the assistant response.

## Security boundary

- The report target must equal the configured verified owner-report chat before reservation or send.
- Inbox lookup occurs only after the Telegram owner-console trust check.
- One chat cannot peek, restore, or consume another target's report.
- Report text is wrapped as untrusted historical data, never instructions or tool authority.
- Report context grants no tools, connectors, roles, or mutation authority.
- Kagemusha metadata remains available only through the existing private connector policy.

## Verification

Focused tests must cite TG-05/TG-06 and prove:

- Digest, scheduled full, and on-demand full share the coordinator, store, configured target, prepared
  identity, and production wiring; the old full-only callback cannot double-record.
- The trigger loop passes the complete persisted artifact through `ReportDeliveryPort`; no
  `send(text, deliveryId)` reconstruction path remains.
- Continued text and multimodal owner turns receive a new digest exactly once.
- Session A consumes a report; actual replacement session B restores its committed projection once;
  successful resume and B continuation do not replay it.
- A report target differing from the configured verified owner target is rejected before reservation.
- Fault injection before reservation, before send, after confirmed send/before delivered transition,
  after delivered commit/before unpin, during cancellation cleanup, during provisional stream flush,
  before final transaction, and after final transaction preserves the specified state.
- Telegram-ledger pinning prevents a confirmed report tombstone from expiring while SQLite remains
  nonterminal; startup reconciliation pins every nonterminal row and unpins every terminal row.
- Definite rejection, retry backoff, manual reactivation, safe cancellation, restart, and capacity
  recovery follow the terminal protocol.
- Structured coordinator outcomes make scheduler success and trigger credit `delivered`-only; pending
  file cleanup for `delivered` and `cancelled` converges after a crash.
- Concurrent trigger submission, immediate execution, startup recovery, expired attempt lease, and
  cancellation notification prove one coordinator CAS lease owns every Telegram send.
- Monotonic sequence orders concurrent reports; exact snapshot consumption leaves later appends pending.
- Projection V1 fixed vectors cover emoji, combining characters, CRLF, embedded untrusted end markers,
  an oversized report, complete empty/single/multiple render grammar, oldest-anchor/newest-suffix
  selection, exact cap accounting, lowercase digest encoding, and hash bytes.
- Same-turn exact replay is idempotent; a different final response or projection conflicts; provisional
  turns never enter fresh history.
- Live and retained row/byte bounds prune only consumed exact data and reject before external send when
  unseen data alone is full; 80% warning, status listing, explicit archive, `capacity_full`, receipt
  compaction, and tombstone GC obey their numeric limits.
- Two-step `operator_archived` applies only to already-delivered pending rows, preserves its audit
  projection/identity, releases live context capacity, and never aliases Telegram cancellation.
- V2 unconsumed, consumed, expired-unseen, pending-artifact overlap, identity conflict, and crash after
  commit/before rename follow the exact mapping, including seven-day/30-day legacy restoration GC and
  a UTF-16 surrogate at the old 700-unit cut.
- `docs/development/kagemusha-telegram-parity.md` evidence/status is updated with implementation and
  operational results.

The operational TG-05 test sends a digest containing a distinctive statement, then asks
“왜 그렇게 말했지?” in the same owner chat. The reply must identify the delivered statement. The next
continued turn must not receive it again. After forcing an actual backend replacement, startup history
must restore its committed projection without duplicating it in the first user prompt.

## Deferred phase

A later phase may generalize this report-only inbox to other detached Telegram producers or add
principal IDs, role/audience labels, and private group lanes. Those are deliberately not prerequisites
for repairing the current owner-report continuity gap.

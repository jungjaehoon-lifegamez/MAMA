# Telegram Owner State Isolation Design

**Date:** 2026-08-02
**Status:** Approved approach, written specification
**Scope:** MAMA OS standalone Telegram owner console and operator workers

## Decision

Implement the narrow, evidence-backed architecture instead of introducing a universal
conversation ledger.

The active Telegram model session already preserves same-process continuity, while report,
conductor, and chat execution intentionally use separate lanes and stores. The observed failure
comes from three independent state leaks:

1. Kagemusha is advertised as a general MAMA connector and is embedded in generic role, brief,
   report, and worker policy.
2. Structured external task lifecycle evidence can update `latest_event` without requiring an
   explicit, verifiable native-status decision.
3. The latest delivered full report is a global, unacknowledged prefix injected into every future
   owner turn.

The fix therefore introduces three bounded components: a private connector policy bundle, a
host-bound lifecycle reconciliation receipt, and a per-chat one-shot report carry.

## Goals

- A MAMA installation that has never configured Kagemusha must not advertise its name, tools,
  recipes, API surface, or connector catalog entry.
- An installation that already has `connectors.json.kagemusha.enabled=true` keeps the private
  connector and its complete owner/operator capabilities.
- A connector event may change a native task lifecycle only when structured metadata resolves to
  exactly one native task and the board worker records an explicit apply-or-retain decision.
- A delivered full report may reach the intended owner model context once, but never another chat,
  never after expiry, and never on every subsequent turn.
- Preserve TG-01 ordered delivery, TG-05 continuation prompt behavior, and TG-06 durable report
  composition/delivery recovery.

## Non-goals

- Do not merge Telegram, report, and conductor sessions into one model session or transcript.
- Do not add a universal conversation event ledger.
- Do not infer lifecycle from free-form chat text, title similarity, card disappearance, elapsed
  time, or an arbitrary Trello list name.
- Do not hard-code an agent's tool-call order. The host supplies safe primitives and evidence; the
  agent still judges whether a verified lifecycle candidate should be applied or retained.
- Do not rewrite the Kagemusha connector or the report outbox.

## 1. Private connector policy

### Public discovery boundary

Split the connector catalog into public connectors and configured private connectors.

- Remove `kagemusha` from the public connector list used by `mama connector list`, unknown-name
  help, and the API connector catalog.
- Keep a private connector registry entry so an existing local
  `connectors.json.kagemusha.enabled=true` installation continues to load it.
- Surface a private connector in CLI/API status only when it already exists in that installation's
  local configuration. A fresh installation therefore has no Kagemusha discovery path.
- `connector remove` may disable a configured private connector; `connector add kagemusha` is not
  offered as a public product capability.

This changes discovery, not source availability. The adapter remains in the repository for this
owner's deployment and backward compatibility.

### Capability projection

Create one connector-policy module that owns the Kagemusha tool bundle and prompt overlay. Every
runtime surface resolves its effective tools as:

```
generic role tools
+ tools for locally enabled connector bundles
- tools for disabled private connector bundles, even if an old generated config still lists them
```

The resolver is used by:

- Telegram `owner_console` role projection;
- default/custom wildcard OS roles, unbound legacy `/api/code-act`, generic multi-agent prompts, and
  final gateway executor authorization (private tools are denied on these ineligible principals);
- context-keyed Code-Act, where the trusted registry `agentContext.roleName` preserves an eligible
  owner/work-order/report principal instead of the API transport deciding capability;
- board, memory-curation, and temporal worker policies;
- the scheduled/on-demand operator report policy;
- reactive envelope raw-connector scope and all four direct Kagemusha reader mappings.

The existing connector configuration is read before the message router is created. Capability
projection follows the locally configured enabled set; a configured connector whose runtime
initialization later fails remains visible to its owner but every call fails loudly. An absent or
disabled private connector always fails closed and is never projected.

Load and validate `connectors.json` once at boot, then reuse that immutable result for connector
initialization, envelope scope, role/tool projection, CLI/API discovery, and prompt overlays. The
private-policy fingerprint participates in the TG-05 session policy fingerprint so enabling or
disabling the bundle rotates a stale backend session instead of continuing with the old grant.

### Prompt and local-brief isolation

- Remove Kagemusha recipes and store-canonicity text from generic defaults.
- Replace generic `task_list`, memory-scope, report tool-call, and board instructions with
  source-neutral wording.
- When Kagemusha is enabled, append a connector-specific overlay containing its progressive query
  recipe, status vocabulary, and read-only boundary.
- Existing owner/worker briefs are user-owned and are not overwritten. Before injecting one into a
  run, remove only the known legacy managed Kagemusha stanza; then append the current connector
  overlay when enabled. When disabled, lines in the user-owned Lessons section that explicitly
  name the private connector are withheld from the model prompt but remain untouched on disk.
- Gate the Kagemusha-specific API route on the configured private connector.

Security continues to be enforced by both role projection and the envelope. Merely registering a
tool in the host registry never makes it callable.

## 2. Safe lifecycle reconciliation

### Trusted candidate construction

Extend a board-reconcile work order with host-authored `bindingCandidates` and
`lifecycleCandidates`. Candidates are built from `eventIds`, never from the human-readable
`deltaLines`.

For each event, the host:

1. reads the exact `connector_event_index` record;
2. validates connector, source type, structured metadata, and stable external item identity;
3. resolves only an already receipted task/external-item binding for that exact stable item;
4. treats the task's recorded `source_event_id` and attributed batch `source_event_ids` only as
   discovery hints, never as proof of the exact pair;
5. constructs a bipartite event↔task hint graph and requires both endpoint degrees to be one,
   with direct/effect hints agreeing whenever both exist; and
6. maps only a connector lifecycle vocabulary that has an explicit adapter.

`connector_event_index` rows use stable connector/source identity and are updated in place. A
content-changing upsert must therefore receive a fresh per-partition `operator_ingest_seq` so the
delta cursor observes it and a fresh connector-wide `operator_observation_seq` so lifecycle
watermarks remain ordered across channel moves. Byte-identical re-upserts retain both values;
partition sequence numbers are never compared across channels.

At work-order enqueue, copy the exact observation into the operator-owned payload: event and
external identities, channel partition, content hash, source timestamp, both operator sequences,
parsed lifecycle fields, task/binding revisions, and bounded evidence summary. The summary is a
fixed host template of validated task ID, status, and timestamp and contains no raw connector prose.
The candidate ID hashes this immutable
snapshot. That persisted snapshot, not a later reread of the mutable cross-DB row, is the authority
for the attempt. A newer connector update receives another sequence and work order; revision and
last-observation watermarks supersede an older candidate rather than allowing state regression.

Add `operator_task_external_bindings` and binding-receipt storage for the verified association.
Batch attribution is too broad to establish an exact pair: the same host `causeEventIds` can be
attached to every task changed during a multi-event reconcile. It therefore establishes candidate
eligibility only.

The host may issue a binding candidate containing one exact task/external-item pair when the task's
structured source hint selects an event from its attributed host batch and that event resolves to
a stable item. A separate board-only `task_external_bind` primitive accepts only the opaque
candidate ID, `bind | decline`, a reason, and the expected task revision. It never accepts raw task
or external IDs. `bind` atomically records the exact pair and an auditable receipt; `decline`
records only the receipt. Unique constraints reject a task or external item already bound to a
different active pair.
A task whose revision changed after binding-candidate construction records a `superseded` receipt
and no binding.

Lifecycle candidates are generated only from a previously committed `bind` receipt, never from a
binding candidate in the same work order. A newly bound item can therefore affect lifecycle only
on a later reconcile, avoiding a hard-coded bind-then-mutate sequence. Existing tasks are not
automatically backfilled: legacy `source_event_id` and batch-attribution values remain unbound
until this explicit decision is receipted. There is no title, prose, or temporal-proximity
fallback.

The initial private Kagemusha adapter maps:

| External status          | Proposed native status |
| ------------------------ | ---------------------- |
| `pending`                | `pending`              |
| `in_progress`            | `in_progress`          |
| `review`                 | `review`               |
| `done`, `completed`      | `done`                 |
| `cancelled`, `dismissed` | `cancelled`            |

Unknown values produce no actionable candidate. Trello card/list evidence remains readable context,
but no list-name-to-status mapping is added because board list names are arbitrary. Missing cards
remain `historical_only`, never completion evidence.

Each candidate carries the bounded fields appropriate to its type: a stable candidate ID, event
ID, connector/external reference, task ID, task revision, and evidence summary; lifecycle
candidates additionally carry the observed external status and host-proposed native status.
Unknown fields and agent-authored candidates are rejected by the work-order payload validator.

### Host-bound decision tools

Add `task_external_bind` as described above and `task_lifecycle_reconcile`, both callable only in a
board reconcile run with their respective host-issued candidate context. For a lifecycle decision,
the agent submits:

- `candidate_id`;
- `decision: "apply" | "retain"`;
- a reason; and
- the expected task revision.

The host revalidates the candidate, verified binding, and revision. It never accepts a task ID,
source status, or target status invented by the model.

- `apply` invokes the canonical transaction-aware `TaskLedger` transition primitive rather than
  issuing a raw status update. The primitive performs the existing enum and revision checks,
  updates the host-bound `status` and `latest_event`, preserves terminal/open temporal-generation
  reset and supersession behavior, and records the normal attributed effect ledger entry.
- `retain` leaves workflow fields unchanged and records why the native state should not follow the
  external state.
- A task that advanced after candidate construction records a `superseded` receipt instead of
  overwriting newer work.
- Ambiguous, unmatched, malformed, or stale evidence cannot reach the mutation path.

If the current public `TaskLedger.update` transaction boundary cannot share a transaction with the
receipt insert, extract its mutation invariants into an internal transaction-scoped primitive and
have both public update and lifecycle reconciliation call it. The task mutation, temporal
generation changes, attributed effect, and lifecycle receipt must commit or roll back together.

Generic `task_update` remains available for ordinary native-board maintenance, but the board brief
forbids using it to project external lifecycle. External lifecycle decisions go through the bound
tool only.

The brief is not the enforcement boundary. During a candidate-bearing board attempt, host
execution context prevents generic `task_update` from changing `status` or `latest_event` on any
candidate task. Other native-board fields and tasks remain maintainable. The guard uses the
trusted work-order attempt ID and durable payload, so direct and nested Code-Act paths enforce the
same rule.

### Durable receipts and completion gate

Add a standalone operator-DB migration for binding and lifecycle receipts. Both name the work-order
attempt, candidate/event/task identities, decision, before/after revision or binding state, reason,
and timestamp. A binding receipt and binding row commit in one transaction; a lifecycle receipt
and all task/temporal/effect mutations commit in one transaction.

Register the board completion hook with `verdictRequired: true`; its `after` function always
returns an explicit verdict:

- full board and reconcile runs without binding or lifecycle candidates preserve their existing
  completion behavior;
- a reconcile with binding candidates requires a matching `bound`, `declined`, or `superseded`
  receipt, and each lifecycle candidate requires `applied`, `retained`, or `superseded`;
- a missing/mismatched receipt fails loudly instead of allowing `latest_event`-only drift to count
  as success.

Calls are idempotent by candidate identity across work-order attempts. Receipt candidate IDs are
unique and candidate construction suppresses already-receipted snapshots; decline and retain
consume the exact observation, while a changed snapshot produces a new ID. A retry observes the
prior committed receipt and does not duplicate a status change. Receipt inspection is also the authority when the runner, hook, or
tool transport reports an error and when boot recovery encounters a stale claimed work order:

- a complete valid receipt set wins over a later transport error and completes without replay;
- a partial receipt set is an unknown mixed outcome and fails loudly without automatic replay;
- `MCP_RESULT_MISSING`, interrupted-mutation, and other ambiguous terminal classifications retain
  the existing no-replay rule; and
- one bounded retry is allowed only when durable inspection finds zero candidate receipts and a
  closed positive whitelist was minted by the consumer before it called `runWithContent()` (the
  candidate before-hook or run-options branch). Once the runner is called, its current contract
  cannot prove whether model/tool execution began, so every rejection, missing verdict, and generic
  runner error defaults to no replay.

The absence of a receipt alone is not permission to retry an ambiguous run. Preserve the current
one-attempt policy for ordinary full-board and reconcile work; this narrow arbitration does not
increase their retry budget or weaken TG-06 unknown-mutation handling.

At startup, stale candidate-bearing board claims must rehydrate the trusted candidates and run
this same complete/partial/zero-receipt arbitration before ordinary `handleFailure`. A complete
receipt set finalizes the work order without replay; a partial set fails loudly without replay;
zero receipts fail without replay because live pre-model retry authority does not survive a crash.
This closes the crash window between atomic receipt commit and the separate work-order completion
write without inventing boot-time replay authority.

## 3. One-shot, chat-scoped report carry

Replace the unversioned `last-full-report.json` record with a versioned state containing:

- the existing text, delivered timestamp, and model-run provenance;
- the TG-06 delivery ID;
- target `{ source: "telegram", channelId }`;
- optional consumed timestamp and consuming channel key.

The report remains persisted only after Telegram confirms delivery. The pending report outbox,
exact-text replay, schedule advancement, and delivery deduplication are unchanged. Full-report
model-run provenance is captured when composition finishes and stored with the pending delivery,
so a restart before successful send does not degrade replayed carry provenance to
`no_run_handle`. Legacy pending records without provenance remain replayable and are labeled
`legacy_record`.

Persisting a delivered carry is idempotent by delivery ID. Re-delivery of the same ID preserves
the original delivery timestamp and any consumed state; a new callback timestamp is ignored and it
may never revive an acknowledged carry. The same ID with different text, target, or provenance
fails loudly instead of overwriting audit history. Only a new delivery ID replaces the current
carry.

At the start of an owner turn, the router peeks the carry for that exact Telegram chat. It injects
the bounded untrusted prefix only when all conditions hold:

- state version and shape are valid;
- source and channel match;
- the report is not consumed; and
- delivery is no older than 24 hours.

After a successful model turn, the router requires either final streaming flush or fallback
assistant append to return `true`; only then does it acknowledge the exact delivery ID with
compare-and-set semantics. Throws and a `false`/`false` persistence result leave the carry
unconsumed so the next turn may retry. A concurrent newer report cannot be acknowledged
accidentally.

Legacy unscoped records continue to parse for diagnostics but are non-actionable: without a target
chat they cannot be injected safely. The next delivered full report replaces them with v2 state.
Expired or already consumed state stays on disk for audit but contributes no prompt text.

## 4. Data flow

### Owner message

1. Resolve verified Telegram owner role.
2. Project generic tools plus locally enabled private connector bundles.
3. Peek report carry by `telegram:<chatId>`.
4. Run the existing TG-05 new/continue session path.
5. Persist the assistant turn.
6. Acknowledge the exact report carry when one was injected.

### Connector lifecycle delta

1. Connector writes structured event metadata to `connector_event_index`.
2. Trigger loop emits the existing channel delta and trusted event IDs.
3. Reconcile publisher derives host-authored binding and lifecycle candidates.
4. Board worker freely gathers and judges, but resolves binding and lifecycle candidates through
   their opaque candidate-bound tools.
5. Atomic receipts prove each bind/decline or apply/retain outcome before work-order completion.

### Full report

1. Existing reporter composes and persists pending exact text.
2. Existing Telegram TG-01 queue delivers it with the existing TG-06 delivery ID.
3. Successful delivery persists v2 report carry for the configured report chat.
4. Only that chat's next successful owner turn consumes it.

## 5. Failure and recovery behavior

- Connector configuration load errors fail closed for private capabilities and remain loud.
- A tool present in an old `config.yaml` role is stripped when its private connector is disabled.
- A private-policy change rotates the TG-05 session fingerprint; the new session receives exactly
  the new projected grant and prompt.
- Binding or lifecycle candidate construction errors do not silently map text; they produce no
  candidate plus a bounded diagnostic and leave the ordinary reconcile evidence path intact. Only
  a database read outage retries the batch; one malformed event cannot poison its channel.
- Binding/lifecycle receipt or mutation transaction failure fails the tool and the required
  completion verdict. No partial receipt, binding, or status update is accepted.
- A complete committed candidate receipt set is authoritative even if the worker result is lost;
  partial or ambiguous outcomes are surfaced for inspection and never automatically replayed.
- Report-carry write/ack failures remain derived-state warnings and do not retract an already
  delivered Telegram report. A failed ack may retry the same carry on the next turn; it cannot
  cross chats or survive the 24-hour bound.
- TG-06 pending exact-text replay remains authoritative across daemon restart.
- TG-06 replay preserves the composed report provenance, and same-ID redelivery cannot reset an
  already consumed carry.

## 6. Verification contract

### Private connector isolation

- Public CLI/API catalogs omit Kagemusha on a fresh configuration.
- A preconfigured private connector remains loadable, removable, and visible to that installation.
- Disabled/absent connector: owner, board, memory, temporal, report prompts and projected tool
  definitions contain no Kagemusha name or tool.
- Default/custom wildcard OS, unbound legacy Code-Act, generic multi-agent, and executor paths
  neither advertise nor execute any Kagemusha reader; context-keyed Code-Act preserves only the
  trusted owner/work-order/report principal, and all four readers are mapped to envelope connector
  scope.
- Enabled connector: all four Kagemusha reads are callable on the intended owner/operator surfaces,
  and envelope scope includes `kagemusha`.
- Old generated roles/briefs cannot reintroduce the connector when disabled.

### Lifecycle receipts

- Structured Kagemusha status maps to the expected native proposal.
- Exact one-to-one receipted binding is required; an agent-authored `source_event_id`, broad batch
  attribution, and title-only, missing, conflicting, duplicate, or malformed correlations cannot
  mutate.
- Binding tests cover multi-event batches, bind, decline, duplicate-pair rejection, stale revision,
  no same-work-order lifecycle promotion, and the absence of automatic legacy backfill.
- Connector-index tests prove content-changing stable-row upserts receive fresh partition and
  connector-wide sequences while byte-identical upserts do not, including an equal-timestamp channel
  move; candidate tests prove the persisted content-hash snapshot is the attempt authority.
- Apply, retain, superseded, idempotent replay, stale revision, transaction rollback, and missing
  receipt cases are covered.
- Apply exercises the same terminal/open temporal-generation and effect-attribution invariants as
  ordinary `TaskLedger.update`.
- Completion-after-result-loss, partial receipts, zero-receipt pre-mutation failure, and ambiguous
  post-mutation terminal classifications cover receipt-authoritative retry arbitration.
- Boot recovery covers a crash after all candidate receipts commit but before work-order
  completion, plus partial- and zero-receipt stale claims; boot zero never replays.
- A `latest_event`-only generic update does not satisfy a lifecycle-candidate work order.
- Candidate-target `task_update(status/latest_event)` is rejected before mutation on direct and
  nested tool paths, while unrelated native maintenance remains allowed.
- Trello disappearance and arbitrary list names never auto-complete a native task.

### Report carry and Telegram parity

- TG-01: overlapping owner turn and external report retain per-chat ordered presentation.
- TG-05: same model session still receives no full system/context prompt reinjection; the one-shot
  carry is user-message context only.
- TG-06: scheduled and on-demand reports retain the same owner capabilities, exact pending replay,
  visible delivery, and success-only schedule advancement.
- Carry tests cover one injection, acknowledgement, no second injection, failed-turn retry,
  target-chat isolation, 24-hour expiry, newer-report compare-and-set safety, corrupt state, and
  legacy unscoped state.
- Pending-report and carry tests cover provenance across restart, legacy pending provenance, and
  same-delivery-ID replay after acknowledgement without carry revival.

The parity artifact must be updated with the new TG-01/TG-05/TG-06 evidence paths and statuses.

## 7. Delivery workflow

1. Write failing contract tests first for each of the three components.
2. Implement private connector policy and prompt/catalog projection.
3. Implement lifecycle candidate binding, migration, tool, receipts, and required verification.
4. Implement report carry v2 and router acknowledgement.
5. Run focused suites, standalone typecheck/build, the full standalone suite, then repository-wide
   test/build gates.
6. Request independent subagent reviews for security/boundary correctness, lifecycle integrity,
   and TG parity. Fix findings and repeat verification before PR/release work.

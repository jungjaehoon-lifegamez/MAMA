# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- **Every chat ingress now classifies the sender before privileged work.** Telegram, Slack, and
  Discord divert external senders before model turns, session creation, prompt-history injection,
  attachment download, tool execution, or model-derived outbound sends, except for the addressed
  Telegram group messages admitted to the isolated public lane below. Non-owner history is excluded
  from owner prompts. Slack and Discord add `owner_user_id`; leaving it unset fails closed.
- **Telegram group non-owners now have a limited conversation lane.** This intentional behavior
  change admits an addressed group message only to the isolated, memory-free, tool-free public
  lane and returns its reply to the same group; it does not grant owner-console authority.
- **Gateway plugins must declare `apiVersion: 2`.** Older plugin API versions are rejected at load
  time; this is a breaking compatibility change for third-party gateway plugins.

## mama-os [0.34.1] - 2026-08-12

### Fixed

- **Transient model-capacity errors are named, not anonymized.** Board
  workers fail ~23% on live, dominated by "Selected model is at capacity"
  (an upstream Anthropic 529-class blip). It arrives as a thrown CLI error,
  which the in-band transport detector never saw, so it landed as an
  anonymous sha256 digest and hard-failed 12 board workorders downstream
  ("candidate receipt set is empty"). `classifyTransientModelError` now
  names the thrown upstream classes (model-at-capacity / rate-limited /
  upstream-5xx) through the same path as an in-band 529 - the operator
  reads a class, not a digest. Candidates are re-offered next batch, so
  nothing is permanently lost.

## mama-os [0.34.0] - 2026-08-08

### Added

- **`/viewer` is MAMA's one web console, defaulting to Operator.** Information architecture is
  Operator (Board | Tasks | Triggers), Knowledge (Memory | Wiki), System (Runtime | Connectors |
  Logs). Hash routing (`#operator/board`, `?task=<id>` / `?trigger=<id>` with positive-integer
  validation and legacy-alias support) makes every destination deep-linkable; browser
  back/forward restores the active screen and selection. Mobile gets a three-group bottom bar
  plus a horizontal sub-view chip row (≥44px targets).
- **Bounded task evidence drawer.** Tasks open a detail drawer built only from serialized
  operator fields (status, schedule, source channel, latest event) — no raw-message API exists
  in the client, pinned by mutation-tested import barriers. Trigger provenance is explicitly
  labeled as configuration provenance. A dropped deep-link (task outside the current filter)
  shows an honest notice and clears the hash instead of failing silently.
- **Authoritative runtime status.** New authenticated read-only `GET /api/runtime/status`
  serves daemon-injected backend/model/uptime/health/connector state through a
  field-enumerating serializer (credential-leak tested). System views render truthful
  boot-time captions instead of the legacy Agents registry.

### Changed

- **Viewer-brand token unification.** The operator surface adopts the MAMA palette (yellow
  `#ffce00` accents with near-black text, lavender secondary, warm off-white surfaces); all
  interactive pairings verified WCAG AA (`--color-agent-strong #7d5b00`). Light-only v1.
- **Logs is polling-only.** The unsupported WebSocket subscription control is gone.
- **Service worker cache `mama-viewer-v2`.** `/api` + `/ws` bypass is pinned by test; the
  operator bundle is network-first so future releases reach installed PWAs.

### Removed

- **The temporary `/ui` route (404, no redirect), Viewer Chat, Feed, Agents, and the Settings
  tab.** Config editing (messenger tokens, agent/skill/role forms, cron UI, token budget)
  leaves the web console entirely — CLI and config files are the only write path; no
  credential-shaped input renders in any DOM. Legacy modules and their tests were deleted
  (net −10k lines); docs swept `/ui` → `/viewer` repo-wide. Persisted history, `/ws`,
  `/api/sessions`, and `/api/cron` remain untouched pending consumer audits.

### Security

- `sanitizeReportHtml` is fail-closed in DOM-less environments (previously returned dirty
  input via DOMPurify's documented no-DOM fallback) and is pinned by regression tests.
  DOMPurify remains the deliberate single render-side XSS layer for agent-authored slot HTML
  (owner risk decision; the retired `/ui` document's CSP did not migrate).

## mama-os [0.33.0] - 2026-08-06

### Added

- **Delivered owner reports become durable model context (TG-05/TG-06).** Digest, scheduled full,
  and on-demand full reports flow through ONE delivery coordinator: SQLite reservation before any
  Telegram send, a pinned confirmed-send ledger proof that cannot expire while the row is
  nonterminal, CAS attempt leases so exactly one executor sends, and typed
  retry/rejection/cancellation/capacity outcomes. Scheduler success and trigger credit advance
  only on `delivered`.
- **A verified owner turn consumes pending reports exactly once.** A bounded deterministic
  Projection V1 block is prepended to the owner's message; the final turn, its consumption
  receipt, and the consumed marks commit in one SQLite transaction. An actual backend replacement
  restores committed projections; successful resume never replays them.
- **Operator recovery surface for parked deliveries.** A definite Telegram rejection is never
  retried automatically; `/api/operator/report-delivery/{reactivate,cancel}` (plus a status
  reader) are the explicit recovery path.

### Changed

- **The legacy one-shot V2 report carry is retired.** `last-full-report.json` migrates one time
  into the report-context store (exact legacy prefix bytes preserved, consumed records restore as
  bounded history for 30 days) and no component reads or writes V2 afterward.

### Fixed

- **The confirmed-send/context-persist loss window is closed.** Carry persistence failures were
  previously swallowed after a successful send; report context is now reserved durably BEFORE the
  send and consumption is atomic with final-turn persistence.
- **Telegram 429/5xx can no longer permanently silence owner reporting.** Only definite 4xx
  non-acceptance parks a report; rate limits and server errors stay retryable with durable
  1m-to-12h backoff that the attempt lease actually honors.

## mama-os [0.32.3] - 2026-08-03

### Fixed

- **Operator trigger maintenance no longer drains Claude usage while idle or failing.** Successful
  author windows are consumed once, failed author and review calls use durable 6-to-24-hour
  backoff, missed intervals collapse into one maintenance pass, and review work advances from a
  persistent watermark.
- **Trigger authoring and review stay within fixed provider budgets.** MAMA pins the configured
  model, uses tool-free non-persistent Claude sessions, preserves the newest bounded evidence, and
  caps both new and legacy trigger fields before the final provider boundary.
- **Stopping MAMA now cancels and drains trigger-loop provider work.** Shutdown aborts active
  author and reviewer calls, waits for the running loop, and prevents deferred review or report
  legs from restarting work or recording false provider failures.

## mama-os [0.32.2] - 2026-08-02

### Added

- **Cline is a first-class MAMA backend alongside Claude and Codex.** The standalone runtime uses
  Cline's official Hub API, persists routed sessions, projects role-scoped native tools and the
  shared Code-Act gateway, and keeps compaction under the selected model runtime (TG-03, TG-04,
  TG-05).

### Fixed

- **Cline provider failures remain actionable without leaking provider payloads.** Hosted quota
  exhaustion now reports a bounded `rate_limit` classification and retry hint instead of being
  mistaken for context overflow, while raw transport errors and provider details are redacted.
- **Timeouts and shutdown cannot replay ambiguous mutations.** Route ownership, mutation
  settlement, session quarantine, capacity admission, and bounded runtime disposal preserve
  already-started side effects and force a full policy rebuild before the next turn (TG-05,
  TG-06).
- **Managed Cline tools follow the same authority boundary as the other backends.** Native tool
  projection is role-aware, explicit managed permissions remain separate from narrowed Code-Act
  roles, and the owner role no longer gains a wildcard bypass (TG-04).

## mama-os [0.32.1] / mama-core [2.1.2] - 2026-08-02

### Fixed

- **Telegram owner turns no longer inherit stale or cross-chat report state.** Report carry is
  target-bound and one-shot, historical carry records are quarantined before upgrade, and the
  Telegram delivery ledger binds every replay claim to the exact chat and payload (TG-01, TG-05).
- **Kagemusha remains a user-private connector.** Signed envelopes expose its capability only to
  configured owner/report surfaces; generic, wiki, legacy-unbound, and other-user contexts cannot
  discover or inherit the private connector (TG-05).
- **External lifecycle evidence updates native tasks exactly once.** Immutable candidates,
  transactionally committed receipts, mixed-version writer recovery, and production BLOB hash
  normalization preserve authoritative status changes without replay across restarts (TG-06).

## mama-os [0.32.0] - 2026-07-31

### Added

- **A persistent Claude process now follows the principal of its active run.** Each process
  generation receives a fresh opaque context key, and Code-Act reacquires the exact trusted
  Telegram or operator context across the MCP and local HTTP boundaries without rebuilding
  identity from request fields.

### Fixed

- **A completed Code-Act mutation is never replayed after a transport interruption.** Paired MCP
  exchanges survive close, error, protocol-failure, and missing-result paths; terminal outcomes
  remain non-retryable, the affected process generation is retired, and oversized results retain
  bounded terminal and audit evidence.
- **Operator report audits now reflect only trusted nested Code-Act executions.** Successful host
  gathers remain visible even when a later nested call fails, validation failures are recorded,
  and similarly named tools from other MCP servers cannot forge report evidence.

## mama-os [0.31.5] - 2026-07-31

### Fixed

- **A scope denial teaches the grammar it enforces.** Named denials
  (v0.31.3) showed the remaining class is the model guessing scope ids
  (dropped connector prefixes, global:global, user:<email>). The denial
  now lists the allowed keys and says omitting scopes reads the full
  allowance; the tool catalog teaches the same. Observability only.

## mama-os [0.31.4] - 2026-07-31

### Fixed

- **An Anthropic outage can no longer impersonate a report.** The claude
  CLI prints API failures as response text ('API Error: 529 Overloaded
  ...'); a board run was marked COMPLETED with that text as its response
  and the 'content' reached the owner channel. An error-shaped response
  head is now classified model-transport-error at the consumer boundary:
  the workorder fails into the retry policy, nothing completes, nothing
  is delivered. Content that merely quotes an error is not flagged.

## mama-os [0.31.3] - 2026-07-31

### Fixed

- **A scope denial names the scopes it denied.** 84 post-mirror denials in
  one live window were undiagnosable from a message with no ids; the
  violation now lists up to three denied `kind:id` keys (observability
  only, no enforcement change).

## mama-core [2.1.1] - 2026-07-31

### Fixed

- **Migration 043 renumbered to 061 - the retired chain's ledger ceiling
  swallowed it.** Live DBs carry schema_version rows 44-60 from a retired
  2026-05/06 migration chain that shared the ledger table; the runner skips
  any file numbered at or below MAX(version), so 043 shipped in 2.1.0 and
  silently never applied. 043-060 is a documented dead zone pinned by the
  migration-chain test: new core migrations number 061+.

## mama-core [2.1.0] - 2026-07-31

### Added

- **`tool_traces.failure_code`** (migration 043, re-issued as 061 in 2.1.1):
  failed tool traces carry the thrower's structured code - carried, never
  invented.

## mama-os [0.31.2] - 2026-07-31

### Fixed

- **Memory reads follow the channel grant - the dominant compile failure is
  fixed at its root.** `memory_scope_out_of_scope` (2,700+ envelope
  violations/morning: conductor chat 1,945 + temporal workers 802) was
  deterministic: envelopes carry identity scopes while retrieval asks for
  the real channels memories are stored under. One rule now governs READS
  at the enforcement layer - a run allowed to read a channel's raw events
  may recall the memories extracted from it (`mirrorReadScopes`, computed
  against the LIVE grant at check time; a connector the envelope already
  narrows keeps its per-channel isolation). Envelopes stay identity-only:
  raw narrowing and `mama_save`'s permanent write binding are unchanged,
  and a context packet's mirror-widened scopes are intersected with the
  envelope before they can back a save. Three-round adversarial review
  (two BLOCK verdicts fixed, empirically probed) before merge.

## mama-os [0.31.1] - 2026-07-31

### Fixed

- **Watchdog no longer flaps on long runs.** The leg beat lived inside
  tick(), but the interval handler skips tick() while a run is consuming -
  so every workorder run longer than 2x the cadence paged the owner
  "silent" and then "recovered" on finish, one telegram flap per long run
  (caught on day 1 of the S2 measurement window). The interval now beats
  unconditionally: a consumer mid-run is alive, not silent. Same fix
  applied to the trigger loop's identical latent pattern.

## mama-os [0.31.0] - 2026-07-31

S2 Evidence Transposition (PR #216) - the system can now say what caused each
change, why each failure failed, and which scheduled leg went silent.
Requires @jungjaehoon/mama-core 2.1.1 (tool-trace `failure_code`, migration 061 -
renumbered past the retired-chain ledger ceiling; 2.1.0's 043 never applied live).

### Added

- **Causes are wired, not relabeled.** The conductor hands its inbox batch
  (`causeEventIds`) to every run, so judgment-borne board changes are born
  attributed. `cause_kind` (`event | owner_message | clock | card_transition`)
  lands on the effect ledger with a cross-shape CHECK trigger and a
  discriminator backfill; `changes_read` surfaces it. On duplicate delivery
  the HOST batch outranks the agent-supplied `source_event_id` (forgeable).
  Delegated board workorders dedupe on a batch-deterministic occurrence key.
- **Failures carry the thrower's code.** `tool_traces.failure_code` records
  the structured code already emitted at the failure choke - carried, never
  invented (the generic TOOL_ERROR wrapper stays NULL). The dominant digest
  now has a name: `memory_scope_out_of_scope` x1882 was 52% of
  context_compile failures - a scope-issuance problem, not a compile problem.
- **A silent leg pages the owner - after sunrise.** Every scheduled leg
  declares its cadence and beats on tick; an independent watchdog timer
  (outside the trigger loop it watches) pages past 2x cadence, defers through
  quiet hours (23-08), suppresses duplicates across restarts, and reports
  recovery once. Boot counts as a beat, so a restart never pages for the
  outage it just recovered from.
- **Report parity rubric checked in** (`docs/development/report-parity-rubric.md`):
  the six-item board/delta/cause/schedule/delivery/honesty comparison; 6/6
  three days running hands report authority to the conductor leg.

### Changed

- **Temporal freshness is a receipt, not a gate.** Live measurement decided
  each precondition: 94% of reconcile rejections came from packets carrying
  only recalled memories, so the HOST now seeds the compile with the bound
  source's channel/event (strictly additive - only when the run's envelope
  grants that connector), and a stale-but-source-backed packet COMMITS with
  `packet_created_at` receipted instead of being rejected.

## mama-os [0.30.1] - 2026-07-30

### Fixed

- **Owner chat's Trello reads died 100% - reads are no longer gated.** The
  07-28 code-act transport switch moved the main persona's tool calls onto
  the api-code-act envelope, whose per-principal filter (#199) stripped
  trello: 07-28 175 ok/0 fail → 07-29 224/49 → 07-30 0/107, every one
  `connector_out_of_scope`. The workaround's cost was real: the board
  drifted 3 weeks undetected (7 delivered items shown overdue). The filter
  contradicted the standing rules - enforcement only for irreversible sends;
  answers read direct - and Kagemusha's proven model (reads free, actions
  receipted, sends confirmed). `scopeDaemonRawConnectors` is deleted; every
  daemon envelope keeps `allowed_destinations: []` as the real gate, per-tool
  enforcement is unchanged, and every read lands in tool traces.

## mama-os [0.30.0] - 2026-07-30

S1 Conductor Foundations (PR #215) - the first sprint of the stateful-operator
redesign. Everything ships behind `conductor.enabled` (default **false**); the
inbox records shadow-mode data either way.

### Added

- **Durable conductor inbox.** Drained channel batches persist to
  `conductor_inbox` BEFORE the delta cursor commits - a crash between the two
  redelivers, and per-event dedupe absorbs the duplicate (including PARTIAL
  redelivery under a different batch boundary). Claims are leases; retry and
  lease-replay share one 5-attempt poison cap; acked (7d), stale-pending (7d)
  and dedupe (30d) rows all have bounded retention; a dead batch is loud.
- **Conductor session lifecycle.** One long-lived judgment session on its own
  `session:conductor:main` lane - the lane comes from the session key's FIRST
  segment, and tests pin that axis, because `operator:conductor` would have
  landed on the global operator lane where Stage-2 workers serialize. Recycle
  on age (6h) / turns (400) / tokens (150k, below the pool's own 160k drop) /
  idle (25min, below the pool's 30min drop) / suspicion; every fresh session
  owes the board one re-ground before its first judgment, and a failed run
  does not consume it. Fresh turns go through agent-loop's sanctioned
  `freshSession` reset - `resumeSession` alone cannot express "start over".
- **Board re-ground builder.** What `task_list` shows, newest-first, bounded
  per status with an honest `(+N more open)` total; titles sanitized against
  close-marker forgery.
- **Conductor runner.** Consumes the inbox up to 8 batches per tick, never
  awaits a worker from its model turn, acks only successful judgments. Batch
  lines enter the prompt only through `wrapUntrustedContent` under the
  evidence instruction; runs carry a dedicated conductor policy (no sends, no
  memory writes, no compile, no raw connectors) and a per-run envelope,
  mirroring the report lane.
- **Boot wiring behind `conductor.enabled` (default false).** Claude backend
  pinned in S1; budgets validated loudly at boot (a zero tickMs would have
  spun the event loop); shutdown awaits an in-flight tick before the operator
  DB closes.

### Changed

- **The report gathers the native board.** The full-report gather instructs
  `task_list`; all four `kagemusha_*` tools become granted-but-silent (the
  owner's personal deployment only). Lane-wiring pins both the flip and that
  no instruction line contains `kagemusha_` - MAMA presupposes no Kagemusha.
- **`os_get_config` masking descends arrays** and masks non-string sensitive
  scalars - a token inside `multi_agent.agents[]` escaped the only redaction
  layer the tool has.

### Removed

- **28 verified-dead gateway tools** (zero dispatches over the full trace
  history, no instructing brief): `browser_*` (10), `agent_*` (6),
  `viewer_*` (3), bot ops (6), `pr_review_threads`, `mama_add`,
  `mama_ingest`. Registry 78 → 50; catalog -15%. Kept on TG-03/04 contract
  evidence despite zero calls: the send surface, `create_fb_overlay`,
  `mama_load_checkpoint`, `mama_provenance`, `task_external_correlation`.
  Downstream swept: executor cases, host-bridge descriptors/tiers, dead
  boot wiring, the conductor-persona injector (it wrote culled-tool
  instructions into user personas every boot), stale prompt text (a new pin
  test keeps code-act instructions honest against the registry), the
  browser-tool module and its `playwright` dependency.

## mama-os [0.29.2] - 2026-07-30

### Fixed

- **The trigger author had been dead for two days, and 0.29.1's diagnostics named why on
  their first live failure.** The call is a bare `claude -p`, so it inherited `effortLevel`
  from the user's settings - `xhigh` - while the daemon exports `MAX_THINKING_TOKENS=0`
  (set 2026-07-27 to stop empty thinking blocks corrupting chat transcripts). The pair is a
  hard API 400: _"output_config.effort 'xhigh' is not supported when thinking is disabled."_
  Measured: 46 failures against 8 successes on 07-28, then 34 against ZERO on 07-29.
  Reproduced three ways - bare shell succeeds, daemon env 400s, `--effort high` succeeds.
  The chat path already passed `--effort` and `--setting-sources`; this was the only bare
  call site, which is exactly why chat survived the same environment and the author did not.
  The earlier prompt-size hypothesis was wrong; that reduction stands on its own as a cost fix.

- **A temporal worker failure reported a fingerprint instead of a cause.** Five consecutive
  live failures logged only `temporal-worker-failure;sha256=...;length=31`, so an upstream
  outage could not be told from a bug here. The hashing itself is correct and stays - a
  runner error can carry connector evidence, and logs, notices, sends, events and the ledger
  row must never contain its text. The log now carries a label from a CLOSED table of failure
  shapes (`upstream-5xx`, `timeout`, `rate-limited`, ...); nothing is copied out of the error,
  and an unmatched failure reads `unclassified`, which carries exactly what the digest did.
  Also fixed: a deferred arbitration parked the digest, so every recheck after a deferral had
  already lost the cause.

- **The channel-key backfill could redeliver an entire partition.** Rows live in SQLite and
  delta cursors in a JSON file, so no transaction spans them; the script committed the rekey
  first and wrote cursors after. A crash between the two left `drainNew` with no cursor for
  the new key - it starts from 0 and redelivers everything, and re-running does not heal it
  because the plan finds no old keys left to carry. Cursors now go first (a stall, which a
  re-run DOES heal), a failed rekey restores the pre-image, and the write is atomic so a
  crash mid-write cannot leave an unparseable file that sends every partition back to 0.

### Removed

- **`GET /api/multi-agent/delegations` and `recentDelegations`,** which could only ever answer
  "nothing". The handler read an accessor no caller supplied, from a `swarm_tasks` table
  nothing in the repo wrote; verified empty on the live daemon before removal. Route, handler,
  both accessors, the `SwarmTask` and `DelegationHistoryEntry` types, the boot-time table, the
  viewer's type field and the API reference entry are gone.

## mama-os [0.29.1] - 2026-07-30

### Fixed

- **The trigger author could not say why it failed.** 193 failures across the log recorded
  nothing but the 240 KB command line that produced them: the executor destructured
  `{ stdout }` and dropped Node's `stderr`, `code` and `signal`, while Node's own message
  embeds the whole argv. Reproducing the exact failing prompt by hand succeeded on the first
  try, so the cause is intermittent and was never captured. Now captured: exit code, the tail
  of stderr AND of stdout (the CLI reports API errors on stdout, so an empty stderr is not an
  absent cause), and whether the process was killed. The argv stays out.
- **No timeout on that call, where a healthy one takes ~41s.** The author pass is step 3 of a
  tick and the scheduled report is step 5, so a hung call there does not merely lose
  authoring - it silently drops that tick's owner report. Bounded at 240s.

### Changed

- **The author prompt no longer feeds itself.** It embedded every active trigger's full
  `memoryQuery` so the model could avoid proposing variants, but that job is decided by
  keywords. Measured live: 162 active triggers, memoryQuery averaging 1,261 characters,
  231 KB of prompt at $1.33 and 126,667 cache-creation tokens per call, every 30 minutes -
  and growing with every trigger the pass authored. Existing triggers now carry keywords in
  full and their query as a 160-character gist: **231 KB -> 57 KB**, dedup unaffected.

## mama-os [0.29.0] / mama-core [2.0.0] / mcp-server [1.15.0] / plugin [1.11.0] - 2026-07-29

The release is one idea in two halves: **a run must be able to name what caused its durable
effects, and the system must measure what a run DID rather than believe what it SAID.**
Everything that could not be shown to run was deleted.

### BREAKING — mama-core 2.0.0

Nine subpaths were removed from the exports map, along with the modules behind them:
`./memory-inject`, `./cases/corrections`, `./cases/live-state`, `./cases/membership-matcher`,
`./cases/merge-split`, `./cases/role-inference`, `./cases/sqlite-transaction`,
`./cases/target-ref`, `./cases/tombstone-sweeper`.

`cases/` was a 9,226-line "case-first substrate" written over two days in April and never
called since. Transitive closure from its four live entry points — `caseTimelineRange`, which
backs the advertised `case_timeline_range` MCP tool, and three wiki-page search functions —
reached 5 of its 17 files. The other 12 are gone, along with 91 further exports across
`entities/`, `search/`, `memory/` and `provenance/` that no file in any package referenced.

**Migrations stay.** A table already created on a live install cannot be un-created by
deleting the code that read it, so the schema and its tests are untouched. If you imported
any subpath above, that code was calling something nothing else in this repo called; there is
no drop-in replacement.

### Added

- **Effect ledger** (`evidence/effects.ts`) — one table, `evidence_effects`. A `cause_state`
  CHECK forbids "attributed with no cause" AND "unattributed with a cause", so coverage
  cannot be computed from a numerator and denominator that disagree.
- **Bounded runs** — a per-channel reconcile work order carries its delta batch, and every
  durable change the run makes inherits it without the agent restating anything. Replayed
  over 617 live batches, attribution went from 0% to 100%. `board:full` carries no batch and
  its changes stay honestly unattributed.
- **`changes_read`** — what this system durably changed since a given point, with coverage
  counts and an explicit `returned`/`total` so one page cannot be described as the whole. The
  full report now leads with it.
- **`mama_provenance`** + provenance resolver — what a memory rests on. A citation must not
  out-read reading: the same channel grant bounds both, pinned by a differential test.
- **`task_external_correlation`** — correlate a work item against external sources.
- **Channel grant** (`mama-core/context-compile/channel-grant.ts`) — ONE rule deciding which
  `(connector, channel)` pairs a run may read, compiled to a boolean and to a SQL clause that
  are held equal by a differential test.
- **Per-lane run verification** — a work order reaching `done` proves only that the agent
  returned a response. Each lane's claim is now reconciled against completed traces of its
  obligated tools since a run-bound snapshot. Observe, never block.
- **`scripts/backfill-channel-keys.ts`** — repairs channel keys stored as display names.
  Dry-run by default, refuses under a live daemon, `VACUUM INTO` backup, and it carries the
  delta cursors with the re-key so nothing is redelivered as news.

### Fixed

- **Channel identity.** Six of seven connectors wrote a display NAME where the config carried
  an ID, and every downstream reader compared against the config KEY — so 0 of 30,671 indexed
  rows were readable. Keys are now canonicalised at write time, before anything durable.
- **The report audit told the owner a falsehood every run.** Every full report logged "agent
  executed NO gateway gather tools — task-board substance NOT verified" while the same run's
  traces showed `kagemusha_tasks` and `task_list` executing. Four layers: four granted reads
  missing from the classification; a name compared as `code_act` when the transport emits
  `mcp__code-act__code_act`; a prose result shape; and the payload sitting one level down
  inside the tool result. Live after the fix: nine gather tools and two writes, named.
- **Lanes believed their own prose.** The wiki hook chose between two log lines by testing
  whether the agent's text contained `NO_UPDATE`; the promotion hook took its saved count from
  a regex over the agent's own sentence and woke the wiki compiler on it.
- **Evidence is what has already happened.** The raw reader's window now ends at now unless
  the caller names a later end — 2,762 live rows are future-dated, one in 2056, and they were
  owning the top of the page.
- **Scope binding had never bound anything.** `bindConfiguredScope` required a config field
  that 0 of 39 channels declare. What made it invisible was a one-off backfill that stopped
  on 2026-05-20; every event after that date is unscoped. Raw visibility is decided by the
  grant now, which reads the key the row already carries.

### Removed

Roughly 72,000 lines across four packages, each verified by deletion plus a full test run
rather than by reading:

- `src/multi-agent/` swarm, council, delegation and task-continuation — the delegate path was
  wired zero times across the whole log history, while sitting at 100% statement coverage.
- 11 `src/onboarding/` phase modules; `delegation-executor`; `mcp-executor`.
- mcp-server: `link-tools` (mentioned once in the repo, under "Additional tools (legacy)"),
  `hook-metrics`, `transparency-banner`.
- claude-code-plugin: all of `src/commands/` and `src/tools/`, and all of `src/core/` except
  `hook-features.js` — the markdown commands never shelled out to any of it. 150 of its 328
  tests covered code no hook reaches.
- 25 exported functions in standalone and 7 in memorybench with no caller anywhere.

`delegate` remains in the tool registry and is NOT dispatchable; `tests/cli/lane-wiring.test.ts`
now pins that every lane's instructions, grants and audit classification agree.

### Notes

The deletion measurements were wrong three times before they were right — a computed
`import(\`./${name}/index.js\`)` made every connector look dead, an ESM miscount made 21 used
symbols look dead, and a test utility was classified as dead for being used only by tests.
Each was caught by deleting and running, never by reading. The same is true of the review that
preceded this release: every critical finding was in code added on this branch.

## [0.28.6] / mama-core [1.9.0] / mama-os [0.28.6] - 2026-07-27

### Fixed — claude-backend chat and report resilience

- **Corrupt-transcript self-heal** — a session whose stored transcript carries an empty content
  block (e.g. an empty thinking block persisted by the CLI) bricked the chat with API 400 on
  every subsequent message; the error now joins the session-reset allowlist and retries on a
  fresh session automatically.
- **Report body recovery** — scheduled full reports on the text-gateway path no longer die on
  "empty report response" when the composed body lives in an earlier assistant turn; it is
  recovered from history with a loud log.
- **Report excerpts carry authors** — owner reports quoted channel lines as "(sender unclear)"
  because window excerpts dropped the event author; the author now rides each excerpt.
- **Outer Code-Act defaults on only for the codex backend** — the claude main chat is
  persona-locked with no Code-Act transport; its instructions pointed at a tool that cannot
  exist there. Explicit per-agent `useCodeAct` config still wins.

## [0.28.5] / mama-core [1.9.0] / mama-os [0.28.5] - 2026-07-27

### Changed

- **Built-in role models default to `claude-sonnet-5`** — os_agent, chat_bot, and
  owner_console move from `claude-sonnet-4-6` so claude-backend deployments run the current
  model without hand-copying role definitions into config (config role entries replace
  builtins wholesale).

## [0.28.4] / mama-core [1.9.0] / mama-os [0.28.4] - 2026-07-24

### Added

- **`trello_kanban` bulk snapshot** — one live call returns every open card grouped by
  board+list with labels and assignee names, the right tool for whole-project reports
  (replaces a per-card search fan-out).

### Fixed

- **Trello read latency** — boards are fetched in parallel into a 45-second in-process
  snapshot; repeated `trello_search` calls within a report turn reuse one snapshot instead of
  re-scanning every board serially (~2m40s of Trello time in a report turn drops to ~2s).

## [0.28.3] / mama-core [1.9.0] / mama-os [0.28.3] - 2026-07-24

### Fixed

- **trello_search matches CJK card names** — Trello's `/search` tokenizes on word boundaries
  and returned nothing for CJK substrings and underscore compounds. The tool now fills its
  results from a per-board open-card scan with local substring matching, resolving assignee
  rosters only for boards that matched.

## [0.28.2] / mama-core [1.9.0] / mama-os [0.28.2] - 2026-07-24

### Added

- **Live Trello read tools** — `trello_search` and `trello_card` answer current-state card
  questions by reading the live board at question time (current list, labels such as the
  revision round and artist, assignee names, due, checklists), the same pattern as the
  `kagemusha_*` truth reads. The connector change log remains the delta/trigger source and no
  longer serves state questions — the root fix for the projection-loss bug class.

### Fixed

- **First-sight Trello items stamped at observation time** — a fresh install (or poll-state
  reset) no longer emits cards with years-old activity timestamps that sink below every
  retrieval window; the card's own activity time moves to `metadata.lastActivityAt`.

## [0.28.1] / mama-core [1.9.0] / mama-os [0.28.1] - 2026-07-24

### Added

- **Trello labels + assignees in the raw store** — the Trello poller now ingests card labels
  and resolves member ids to display names, so "who owns this card and which revision round is
  it in" is answerable from connector data. Content lines gain `| labels: ...` and
  `| assignees: ...`, and a label/assignee change on an unmoved card now emits as a change
  (with the old → new label transition inline). Existing per-card poll state upgrades silently.

### Fixed

- **Owner-console brief self-update is append-only** — on the loop's first live fire the
  full-replace contract let the model overwrite the entire seeded operating manual (including
  the self-update rule itself) with its one new lesson. `console_brief_update` now takes a
  `lesson` and appends it under `## Lessons` with today's date, preserving everything else;
  a missing brief is re-seeded before appending, and a ceiling-busting brief is refused loudly
  (owner curation, never truncation).

## [0.28.0] / mama-core [1.9.0] / mama-os [0.28.0] - 2026-07-24

### Added

- **Agent-owned owner-console operating brief** — the owner console now carries an evolving
  operations manual at `~/.mama/briefs/brief-owner-console.md`: seeded once with a mechanism
  skeleton (reporting philosophy, procedure recipes, situational awareness, self-update rule),
  injected into every owner-console session, and rewritten by the agent itself via the new
  `console_brief_update` tool whenever the owner corrects its working style. Upgrades never
  overwrite it; the code-owned act-vs-ask discipline floor remains the security boundary.
  Brief changes re-anchor live Codex threads through the policy fingerprint.

### Fixed

- **Per-call session keys** — the agent-loop client wrapper no longer mutates the shared
  AgentLoop's session key before each run. Overlapping runs could race the mutation and land on
  the wrong session lane (observed live as polluted `default:*` zero-tool sessions); the key now
  rides per-call options through both `run()` and `runWithContent()`.

### Removed (breaking)

- **Legacy persona run path deleted** — the Stage-2 workorder pipeline is now the only system
  run path. The `MAMA_STAGE2_WORKORDERS` migration flag is retired: unset or `on` boots
  normally, while an explicit `off`/`shadow` fails the boot loudly instead of silently running
  the pipeline. The legacy `executeValidatedRun` persona runs, legacy dashboard/wiki/promotion
  cron prompts, the shadow capture harness, and the `reportPublisherOverride` plumbing are all
  removed (net −692 lines). Prompt contracts live on in the personas and packaged brief
  defaults.

### Upgrade notes

- If your environment pins `MAMA_STAGE2_WORKORDERS=off` or `shadow`, remove the variable (or
  set it to `on`) before upgrading — the daemon refuses to boot on the retired legacy modes.

## [0.27.6] / mama-core [1.9.0] / mama-os [0.27.6] - 2026-07-23

### Fixed

- **Token telemetry hotfix** — the runtime agent-loop client wrapper was stripping
  `totalUsage` from run results, recording NULL for every workorder completion. The wrapper now
  forwards usage, and a source-guard test pins the contract. First live verification recorded
  real token counts for all completions.

## [0.27.5] / mama-core [1.9.0] / mama-os [0.27.5] - 2026-07-23

### Added

- **Stage-2 token telemetry** — workorder completions now carry the run's total token usage
  end-to-end (WorkerRunner → workerRun → consumer completion event → `agent_activity.tokens_used`).
  Absent usage records NULL, never a fabricated zero.

### Fixed

- **Report-lane Code-Act audit visibility** — host tools invoked inside Code-Act executions are
  now collected and reported in the run's audit summary, removing the false "agent gathered no
  evidence" classification for full reports that gathered via Code-Act.

## [0.27.4] / mama-core [1.9.0] / mama-os [0.27.4] - 2026-07-23

### Fixed

- **Operator report lane tool regression** — the report lane runs under a dedicated built-in
  Code-Act role (`operator-report`) whose allowlist is derived from the report instructions,
  fixing runs that started with zero tools.
- **Codex thread re-anchoring** — `thread/resume` now re-sends base instructions through a lazy
  resume callback, so resumed Codex threads keep their role policy after a daemon restart.

### Added

- **Owner console operating discipline** — a code-owned discipline block in the stable role
  policy: act-by-default with an explicit ask-first boundary for irreversible actions, evidence
  and citation rules, and a ban on closing by offering work the agent could have done.

## [0.27.3] / mama-core [1.9.0] / mama-os [0.27.3] - 2026-07-22

### Fixed

- **Owner-selected Drive delivery parity** — the verified `owner_console` can now resolve and
  upload to the Drive folder explicitly selected for the active owner request, matching
  Kagemusha's proven same-folder delivery behavior. Static envelope destinations and short-lived
  capabilities continue to constrain non-owner and capability-bearing calls; uploads remain
  restricted to files inside MAMA's private workspace.

### Upgrade notes

- This patch bumps only `@jungjaehoon/mama-os` to `0.27.3`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.

## [0.27.2] / mama-core [1.9.0] / mama-os [0.27.2] - 2026-07-22

### Fixed

- **Kagemusha-parity media composition budget** — Code-Act now keeps the reference five-minute
  execution budget, allowing one owner turn to compose several bounded Drive downloads and OCR
  calls without the previous 30-second whole-program deadline aborting a healthy workflow. Memory,
  host-call, concurrency, parent-cancellation, and mutation-settlement safety limits remain active.

### Upgrade notes

- This patch bumps only `@jungjaehoon/mama-os` to `0.27.2`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.

## [0.27.1] / mama-core [1.9.0] / mama-os [0.27.1] - 2026-07-22

### Fixed — Codex session and Code-Act runtime stability

- **Proactive Codex policy rotation** — durable thread policy compatibility and presence are
  checked before the first model request, so a release, role-policy change, or missing registry
  opens a full current-policy thread directly instead of relying on an error fallback.
- **Bounded concurrent Code-Act isolation** — every QuickJS execution owns an async WASM module,
  preventing cross-lane runtime disposal races. A wall-clock deadline covers host calls, abort is
  propagated to nested tools, browser waits are clamped to the remaining budget, and a process-wide
  eight-module ceiling prevents stalled reads from accumulating memory. Parent-turn cancellation
  removes queued executions immediately; side-effecting calls retain their slot until the
  underlying operation and every sibling mutation settle or a finite settlement grace expires.
  Late or still-unknown writes become structural non-retryable turn failures across native,
  app-server, HTTP, and MCP transports, and workorders do not requeue them automatically. MCP calls
  are serialized and latched after an ambiguous mutation. Drive downloads remove artifacts created
  after cancellation; browser screenshots publish only operation-owned temporary files, reject
  existing destinations, and cannot traverse nested paths or symlinks.
- **Code-Act progress detection** — the repeated-tool guard distinguishes different Code-Act
  programs while retaining the global 50-call ceiling and blocking fifteen identical programs.
- **Shutdown-safe workorder drain** — once shutdown begins, the consumer stops claiming queued
  work and leaves an interrupted active claim for the existing boot-recovery policy instead of
  failing every pending workorder with `Agent loop is stopping`.

### Upgrade notes

- This patch bumps only `@jungjaehoon/mama-os` to `0.27.1`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.

## [0.27.0] / mama-core [1.9.0] / mama-os [0.27.0] - 2026-07-22

### Added — Owner-agent execution and Telegram parity

- **Composable owner workflows** — the Telegram owner can freely combine Drive discovery,
  attachment reading, structured OCR, image translation, same-folder upload, and Telegram return
  through one role-scoped Code-Act surface instead of relying on a prebuilt scenario workflow.
- **Local document and image processing** — PDF and Office attachments have bounded local text
  extraction, OCR setup diagnostics, provenance-carrying image regions, and a canonical private
  workspace shared by Drive, browser capture, and image output tools.
- **Durable Telegram delivery** — inbound responses and owner reports persist delivery progress,
  serialize by chat, resume from the first unconfirmed chunk after restart, and retain undelivered
  work when the bounded ledger reaches capacity.

### Fixed

- **Owner report recovery** — on-demand full-report requests are persisted before composition,
  prepared text is persisted before the first send, startup resumes either phase, and a newer
  request cannot silently replace older pending work.
- **Codex session continuity** — continued app-server threads avoid repeated full prompt injection,
  while an explicit policy mismatch replaces the stale thread once with the current bounded owner
  policy and attachment context.
- **Attachment privacy and authority** — custom workspaces replace the logical default capability,
  private attachment paths are shown only to verified owner DMs, Drive descendant destinations use
  envelope-bound authority, and archive-controlled errors never enter model-visible text.

### Upgrade notes

- This minor release bumps only `@jungjaehoon/mama-os` to `0.27.0`; MAMA Core, MCP Server, and the
  Claude Code plugin keep their existing versions.

## [0.26.0] / mama-core [1.9.0] / mama-os [0.26.0] - 2026-07-22

### Added — Telegram media and owner Drive parity

- **Telegram media conversations** — allowlisted chats can send captions, photos, image documents,
  and regular documents through the same message router and single-message response presenter used
  for text conversations.
- **Owner Drive operations** — the verified Telegram owner console can list shared drives, browse
  folders, resolve folder paths, download files into the private MAMA workspace, and upload private
  workspace files to explicitly configured Drive destinations. Claude and Codex use the same
  role-scoped direct-tool and Code-Act surfaces.

### Security and reliability

- **Fail-closed media handling** — Telegram media requires a non-empty `allowed_chats` trust anchor,
  downloads are size- and time-bounded, transient files are removed after safe prompt construction,
  and forwarded image analysis remains wrapped as untrusted content.
- **Drive envelope enforcement** — Drive reads require the enabled connector in the active envelope;
  uploads additionally require a configured non-ignored folder or shared-drive destination and a
  write-capable tier. Drive-derived Code-Act results remain marked untrusted after transformations.
- **Bounded connector polling** — Drive change pagination continues across polling cycles without
  blocking the daemon event loop, and repeated or malformed page tokens fail explicitly.

### Upgrade notes

- This minor release bumps only `@jungjaehoon/mama-os` to `0.26.0`; MAMA Core, MCP Server, and the
  Claude Code plugin keep their existing versions.

## [0.25.0] / mama-core [1.9.0] / mama-os [0.25.0] - 2026-07-22

### Added — Verified temporal owner-task reconciliation

- **Active overdue decisions** — optional temporal workorders now inspect exact-time and date-only
  owner tasks, then atomically resolve, finalize without a workflow change, or defer a bounded
  follow-up from fresh connector evidence.
- **Codex and Claude parity** — both backends use the same host-issued temporal context, role-scoped
  Code-Act surface, trusted receipt contract, retry policy, and owner-visible workorder status.

### Security and compatibility

- **Source-bound evidence** — context packets bind to the active task generation and accept only raw
  references matching that task's source event/channel. Superseded workers lose read and write
  authority before any further gateway result is returned.
- **Conservative receipt migration** — receipts from older binaries remain quarantined at
  attestation version 0; only the current source-bound transaction writes authoritative version 1.
- **Mixed-version task safety** — legacy deadline, status, and content writes advance revision/epoch
  state through compatibility triggers, while SQLite foreign keys reject orphan generations and
  effects.
- **Bounded shutdown** — temporal admission stops and open attempts are durably paused before the
  runtime waits for an in-flight worker to drain.

### Upgrade notes

- This minor release bumps only `@jungjaehoon/mama-os` to `0.25.0`; MAMA Core, MCP Server, and the
  Claude Code plugin keep their existing versions.

## [0.24.2] / mama-core [1.9.0] / mama-os [0.24.2] - 2026-07-22

### Fixed — Workorder forward compatibility

- **Version-owned workorder reads** — older MAMA OS binaries now count, claim, recover, and cancel
  only the workorder kinds they understand. Rows written by a newer version remain untouched,
  preventing downgrade crashes and preserving future work for the binary that owns it.

### Upgrade notes

- This patch bumps only `@jungjaehoon/mama-os` to `0.24.2`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.

## [0.24.1] / mama-core [1.9.0] / mama-os [0.24.1] - 2026-07-21

### Fixed — Codex report recovery and tool parity

- **Durable thread recovery** — an exact Codex app-server policy mismatch now triggers one bounded
  reset with a freshly rebuilt full policy prompt. Replacement sessions are invalidated on retry
  failure and released by their current owner ID after later failures, avoiding stale claims and
  five-minute channel stalls.
- **Operator report reliability** — report and workorder workers receive the same native Code-Act
  host bridge as Claude, with role-specific tool surfaces for board, wiki, and memory-curation
  jobs. Empty worker responses remain explicit failures instead of silent reports.
- **Connector least privilege** — Trello raw access is limited to board workorders. Owner guidance
  advertises Trello only when the current route envelope grants it, while wiki, memory-curation,
  and report routes keep their narrower connector scopes.
- **Untrusted evidence boundary** — connector and compiled evidence is treated as data rather than
  instructions before any report, wiki, task, or memory write is allowed.

### Upgrade notes

- This patch bumps only `@jungjaehoon/mama-os` to `0.24.1`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.

## [0.24.0] / mama-core [1.9.0] / mama-os [0.24.0] - 2026-07-21

### Added — Codex app-server backend parity

- **Native Codex app-server transport** — MAMA now runs Codex through one managed,
  multiplexed `codex app-server --stdio` process with durable thread IDs, explicit fresh-session
  handling, and a current runtime bootstrap after daemon restarts.
- **Native MAMA host tools for Codex** — Codex receives the same role-scoped gateway and memory
  tools as Claude, including MAMA-owned connector surfaces such as Trello. Tool calls flow through
  MAMA's canonical host bridge rather than a separate Trello app or a text-parsed MCP workaround.
- **Code-Act parity** — `code_act` is available to Codex and reuses the same role, tier, runtime,
  channel, and Reactive-envelope authorization gates as direct host-tool calls.
- **Codex configuration and UI support** — the default Codex model is `gpt-5.4`, custom model IDs
  remain selectable, and stored `codex-mcp` backend values migrate to `codex` automatically.

### Fixed

- **Turn isolation and recovery** — timed-out or late Codex turns are reconciled without cancelling
  unrelated confirmed conversations; unresolved starts trigger a bounded process recovery, and
  cancellation stops new tool callbacks and reconciles callbacks that already started before the
  turn failure is surfaced.
- **Managed runtime integrity** — Codex auth and managed configuration are repaired only when their
  content changes, instruction sources are constrained to managed roots (including symlinks), and
  external MCP secret changes safely refresh the process without leaking values in errors.
- **Fail-closed backend handling** — unknown backend names are rejected instead of silently falling
  back to Claude, while the single supported legacy alias is migrated explicitly.

### Upgrade notes

- This release bumps only `@jungjaehoon/mama-os` to `0.24.0`; MAMA Core, MCP Server, and the Claude
  Code plugin keep their existing versions.
- Existing Codex users do not need to rewrite configuration. Authenticate with `codex login`; MAMA
  synchronizes the credentials into its managed Codex home and migrates legacy backend values.

## [0.23.0] / mama-core [1.9.0] / mama-os [0.23.0] - 2026-07-18

### Added — Owner console (PR #153, Stage 0+1)

- **`owner_console` role with trust-conditional escalation** — granted per
  message ONLY when telegram + `allowed_chats` locked + 1:1 private DM all
  hold; groups never escalate; a static sourceMapping to owner_console is
  downgraded at runtime and flagged MAJOR by the code audit. `allowed_chats`
  is now the owner trust anchor (documented in the security guide).
- **Artifact hub tools** — `board_read` and `audit_findings_read` let the
  owner console answer status questions from operational artifacts instead of
  stale memory; `report_request` routes owner intent into the REAL report
  machinery (fire-and-forget on the operator lane, consume-the-hour semantics).
- **Report context carry** — the last delivered full report persists (0600,
  atomic) and is injected into owner-console turns, so the chat agent knows
  what its own system last reported.
- **Owner directive persistence** — directives stated in owner chat are
  detected and saved as memory with imperative-form Korean patterns
  (config-externalizable keywords).
- **`workerRun` primitive + `operator` global lane** — briefed fresh-session
  lane runs for host code; all operator work (reports + workers) serializes
  away from the chat lane. Per-run state moved off instance fields (RunScope).
- **Role-filtered tool advertising** — each role's prompt advertises exactly
  the tools it can execute (advertised set == executable set, tested).

### Security — PR #153

- **Memory-write secret inviolability** — `mama_save`/`mama_update`/
  `mama_add`/`mama_ingest` refuse secret-shaped content (API keys, bot
  tokens, credentials) with `secret_material_refused`; shape-based scanner
  with a fail-closed recursion depth cap; patterns assembled at runtime so no
  secret shapes exist at rest.
- **Forwarded-message provenance** — telegram forwards are wrapped as
  untrusted content with a trusted gateway metadata flag (in-band markers are
  never a trust boundary); the extractor and sensitive-wall strip gated on
  that flag.
- **Sensitive-config wall + tripwires** — sensitive config questions from
  non-owner surfaces are walled with record-only telemetry
  (observability-over-restriction; no incident-pipeline pollution).
- **Config roles hygiene** — additive default-role merge at load + prune-at-
  save (canonical compare) in both config-manager and graph-api paths, so
  persisted roles neither disable new defaults nor freeze old ones.

### Fixed — PR #154 (live-proven small repairs)

- **Korean topic slugs** — `buildDecisionId` collapses underscore runs and
  falls back to a stable topic hash for pure-non-ASCII topics (was
  `decision_______<ts>` unreadable/near-colliding ids).
- **Dual-save dedup** — when the chat agent already persisted memory in a turn
  (gateway `mama_save` in the reasoning header), the extractor safety net
  skips instead of writing a duplicate record.

### Added — Stage 2: workorder ownership (trigger-loop → operator transfer)

- **Durable workorder ledger** — the system runs (board/wiki/memory promotion)
  now flow through `operator_tasks` workorder rows (`kind='system'`, payload,
  per-occurrence idempotency keys) instead of fire-and-forget timers: a failed
  or crashed run leaves a requeueable row, never silent loss. Guarded copy-swap
  migration (BEGIN IMMEDIATE, sequence preserved, busy_timeout on both
  construction sites); owner surfaces (board/REST/gateway/badge/verifier hash)
  are kind-filtered and tamper-guarded (system rows host-managed; `failed`
  rejected externally).
- **Single consumer** — `workorder-consumer.ts`: dedicated 60s host-code timer
  (independent of `MAMA_TRIGGER_LOOP`), serial claim→await→next with tick
  re-entrancy guard, per-kind retry policy (wiki retries once; board/promotion
  self-heal on the next cycle), boot recovery for crash-stale claims, and a
  3-surface failure alarm (loud log + owner notice queue + active telegram via
  `MAMA_OPS_ALERT_CHAT`, per-kind 6h dedup). Per-kind completion hooks re-home
  the legacy post-run effects (board reconcile bracket verification re-keyed to
  the worker identity, promotion `PROMOTED` parse → `memory:promoted` chain,
  wiki NO_UPDATE reading).
- **Tri-state migration flag** — `MAMA_STAGE2_WORKORDERS=off|shadow|on`;
  `shadow` dual-runs the board only with a capture publisher
  (`reportPublisherOverride` threaded through the full execution-context chain;
  capture runs can never touch the live report store).
- **Owner visibility tools** — `workorder_request` (enqueue+ack, priority
  high) and `workorder_status` (per-kind last run/failures) on the owner
  console; code-audit warns when a customized persisted `owner_console`
  definition lacks new default tools.
- **Briefs** — worker procedure knowledge seeded to `~/.mama/briefs/`
  (`ensureBriefs()`, user edits win, no auto-upgrade — agent/user-owned after
  seeding); missing brief fails the workorder loudly.
- **Store canonicity** — owner-console instructions + tool descriptions now
  declare kagemusha as read-only project-task truth vs the native ledger, and
  `kagemusha_tasks` results carry a status-vocabulary annotation (no more
  "blocked tasks are missing" hallucinated contradictions).

### Upgrade notes

- `MAMA_STAGE2_WORKORDERS` unset = `off` = **zero behavior change**; a
  malformed value **fails the boot** (no-fallback by design). Briefs are
  seeded to `~/.mama/briefs/` only when the flag is `shadow|on`.
- The `operator_tasks` table is migrated in place on first boot (guarded
  copy-swap inside a transaction; idempotent across the daemon's two DB
  connections).
- Users who previously saved API keys/tokens into memory will now see
  `secret_material_refused` — intentional (secrets never enter memory).

## [0.22.1] / mama-core [1.8.1] / mama-os [0.22.1] - 2026-07-17

### Security

- **Telegram inbound allowlist** — the bot no longer silently accepts messages
  from any Telegram user when `telegram.allowed_chats` is unset: startup emits a
  loud SECURITY WARNING, dropped messages from non-allowlisted chats are logged
  (rate-capped per chat), and the deterministic audit flags an open inbound as
  MAJOR.
- **Untrusted-content wrapping** — connector-derived text (third-party chat
  messages) now embeds into operator report prompts and history-extractor
  passes inside explicit untrusted-content delimiters with a treat-as-data
  preamble (indirect prompt-injection mitigation).
- **Parse-error sanitization** — config parse failures reported by the audit
  carry only the first line of the error (js-yaml exceptions embed config
  source snippets, which must never reach alert payloads).

### Fixed

- **Hourly audit is deterministic code, not an LLM loop** — lands the
  2026-04-22 read-only code-audit decision: read-only checks (config parse, WAL
  and log sizes, health endpoint, persona files, alert-channel hygiene), 24h
  MAJOR-alert dedup preserved, MINOR never alerted, no auto-fix, no shell.
  MAJOR alerts flow through a direct dispatch path that cannot fabricate
  incident/denylist/RDAP artifacts, awaits delivery, and retries on the next
  run after total delivery failure. `POST /api/conductor/audit` returns the
  full report (runs in ~100ms vs the prior 150-210s LLM burn per hour).
- **Security telemetry test pollution** — `MAMA_SECURITY_LOG_DIR` redirects all
  security telemetry (events, incidents, denylist artifacts); the test suite
  pins it plus `MAMA_SECURITY_ENRICHMENT=false`, so fixture events (TEST-NET
  IPs, `test-session`) never land in live logs or generate live RDAP lookups
  again.
- Security alert sender now propagates total delivery failure (all targets
  rejected) instead of resolving silently; alert messages no longer reference
  incident artifact paths for self-generated events that never wrote them.

## [0.22.0] / mama-core [1.8.1] / mama-os [0.22.0] - 2026-07-16

### Fixed

- Persona-lane agents (operator reports, chat) no longer fail with "Task ledger/Report publisher/... not configured" — the daemon persona now shares the boot-wired gateway executor (root fix for the dual-executor wiring class).
- Main-persona CLI sessions no longer expose Claude Code native built-in tools; gateway tools are the only surface (`MAMA_PERSONA_NATIVE_TOOLS=1` re-enables).
- System prompt for spawned/continued runs is now deterministic per call on BOTH backends (claude spawn, codex thread-start developer-instructions) — previously any lane's new process could inherit the last caller's prompt.
- Operator report envelopes now budget the full multi-turn run (`MAMA_REPORT_WALL_SECONDS`, default 900s, min 60, max 1800); runs whose envelope expires mid-run abort loudly (operator lane) or log loudly (chat) instead of silently losing every end-of-run write.
- Operator reports run STATELESS (fresh session per run) — the previous continuous session accumulated gather context until runs outlived their envelope (measured 146s→521s growth). The heavy message gather is delta-anchored at the last successful report (`report-schedule-state.json`).
- Concurrent lanes can no longer cross-route prompts or wipe each other's pending tool results (per-call session routing replaces shared setSessionId mutation).
- The memory agent shares the boot executor and the boot MAMA API instance (no second API/adapter stack against the same DB).

## [0.21.0] / mama-core [1.8.1] / mama-os [0.21.0] - 2026-07-12

### Added

- **Operator board at `/ui`** — New Kagemusha-style React viewer served next
  to the legacy `/viewer`: agent-published report slots render live over SSE
  (DOMPurify + `script-src 'self'` CSP), with trigger stat cards and an owner
  veto tray backed by the new `/api/operator` endpoints. Report slots now
  persist across daemon restarts (`~/.mama/report-slots.json`).
- **Task truth on the board** — The dashboard agent reads real task lifecycle
  state (`pending`/`in_progress`/`review`/`done`) through the kagemusha bridge
  query tools instead of guessing status from message archaeology. Badges map to
  the actual status, and the kagemusha query tools are exposed to tier 2/3
  code-act sandboxes.
- **Four-slot board authoring** — The dashboard agent publishes all four slots
  (briefing, action required, decisions, pipeline) in one `report_publish` call
  using a shared card/badge HTML vocabulary; the scheduled full report publishes
  the same slots (Kagemusha's dual-output mechanism).
- **Wiki v5: daily journal + lessons** — The wiki's purpose narrowed to what the
  board cannot do: an append-only daily note per day (`daily/YYYY-MM-DD.md` with
  Progress/Decisions/Issues/Lesson-candidates sections, every bullet cited) and
  durable lesson pages (`lessons/clients|process|system`) that accumulate
  evidence on recurrence and get superseded instead of deleted. Obsidian CLI
  calls are pinned with `vault=<name>` so wiki writes can never land in a
  personal vault, and nested pages use the `path=` contract.
- **Scheduled memory promotion** — A curation pass (default every 6h, manual
  `POST /api/memory/promote`) has the memory agent promote durable judgments
  (pricing/scope agreements, standing client preferences, process rules) from
  recent channel data into decisions. Task lifecycle states never become
  memories. A successful run emits `memory:promoted`, which triggers the wiki
  compile — reviving the poll → promote → wiki chain.
- **Trigger success circuit** — Owner reports now name the fired triggers they
  actually drew on (machine trailer, stripped before delivery and validated
  against the window); cited triggers earn a `succeeded` outcome only after the
  report is delivered. Evolution is no longer elimination-only.
- **Near-duplicate trigger gate** — The author pass rejects proposed triggers
  whose keyword set is a subset/superset of an existing trigger's or overlaps at
  Jaccard >= 0.6 in the same scope (day-1 live data showed 65% of fires were
  co-fires of overlapping triggers).
- **Audit alert dedup** — The hourly conductor audit diffs findings against
  `~/.mama/state/audit-findings.json` and re-alerts a MAJOR finding only when it
  is new, escalated, or 24h stale; MINOR findings never ping the owner, and the
  audit never writes memory.
- **Unconditional multi-slot report publishing** — `report_publish` is no longer
  gated on the dashboard agent being configured and no longer drops every slot
  except `briefing`; `createReportPublisher` is the single write path (64KB/slot,
  24-slot caps, loud skips) reused by the heartbeat briefing writer.
- **Message-router memory policy opt-ins** — Added `memory_policy.implicit_recall`
  and `memory_policy.implicit_legacy_context_search`, plus matching environment
  variable overrides, so startup-prompt memory recall and legacy context search
  remain explicit local choices instead of default gateway behavior.
- **vNext release-readiness guide** — Added an opt-in rollout checklist that records
  the remaining migration, real local smoke, privacy, dogfood, and review gates
  before vNext can become the default runtime.

### Changed

- **Report attribution discipline** — Both report framings now state that a room
  is never a person and a sender is never a room; unclear identity is written as
  "(sender unclear)" instead of guessed.
- **Wiki novelty check is recency-based** — The wiki decides "is anything new"
  from the no-query recency list instead of a semantic packet, which silently
  dropped cross-language items; `context_compile` stays for enrichment only.
- **PII check branch-diff mode** — Added `scripts/check-pii.sh --base <ref>` so
  release-readiness PRs can scan committed branch diffs, not only staged pre-commit
  changes.

### Removed

- **vNext runtime stub** — The opt-in vNext rebuild was removed; the trigger
  loop (agent-authored triggers, fire → recall → situation reports) is the
  operator runtime. Earlier Unreleased notes about keeping vNext opt-in are
  superseded by this removal.

### Security

- **Public-tree PII scrub and history rewrite** — Personal identifiers were
  removed from the working tree and the entire git history was rewritten
  (filter-repo) so the public repository carries no personal or project data;
  personal configuration lives only under `~/.mama`.

## [0.20.1] / mama-core [1.7.0] / mama-os [0.20.1] - 2026-05-04

### Added

- **Context Compile V0 release surface** — Added append-only `context_packets`,
  deterministic source readers/policy, `context_compile` gateway/API surfaces, and the
  `@jungjaehoon/mama-core/context-compile` package export so workers can compile
  selected/rejected/missing evidence for a task
- **Managed agent context packets** — Default `dashboard-agent` and `wiki-agent` Code-Act
  allowlists, personas, and scheduled prompts now prefer `context_compile` before `mama_search`
  fallback for packet-backed briefings and wiki compiles
- **Trusted context-packet saves** — `mama_save` can now attach a trusted `context_packet_id`
  from the active envelope/model run, preserving source refs from compiled context through memory
  provenance
- **Raw-backed connector memory ingest** — Added deterministic raw-backed memory candidate
  builder and ingest path so connector evidence becomes scope-bound memory without LLM
  extraction, with isolation tests against the case and decision stores

### Fixed

- **Code-Act policy hardening** — `/api/code-act` now fails closed unless the resolved agent exists
  and explicitly opts into Code-Act, and request allow/deny lists can only narrow the configured
  per-agent gateway policy
- **Code-Act allowlist deny-by-default** — Agents that resolve to no allowed tools are rejected
  instead of being widened to wildcard, and `intersectAllowedToolPolicies` distinguishes undefined
  (fallback) from explicit empty arrays (deny-all) so a wildcard request cannot unblock a fully
  restricted policy
- **Context boundary hardening** — Direct compiler/source-reader calls now clamp `as_of` and
  range to active boundaries, preserve tenant boundaries, reject blank `as_of` values, and block
  Tier 3 `context_compile` writes
- **Trusted provenance fail-closed paths** — `mama_save` rejects present-but-invalid
  `context_packet_id` values (non-string, empty, or whitespace) with `context_packet_denied`
  instead of silently dropping provenance, and `context_compile` Tier-3 detection now checks the
  envelope and agent context independently so a non-Tier-3 fallback cannot mask a Tier-3 envelope
- **Source reader consistency** — `readGraphCandidates` fails closed when connectors is an
  explicit empty array, both raw and graph readers run `normalizeTimeFilters` for parity with
  memory reads, and the graph reader trims whitespace-only `source_id` values
- **Global scope id migration** — Memory and raw context readers now match legacy
  `('global', 'global')` bindings alongside the canonical `('global', 'system')` sentinel so
  records written before the alignment remain visible through `context_compile`
- **Wiki-agent feature gating** — `normalizeLegacyMultiAgentConfig` only backfills the built-in
  `wiki-agent` when `config.wiki.enabled` is true, matching runtime provisioning by `runAgentLoop`
  and api-routes-init
- **Connector tenant visibility** — `bindConfiguredScope` now stamps a default tenant alongside
  the project scope so configured-channel raw evidence is no longer filtered out of context
  packets by the default tenant boundary
- **Envelope key TOCTOU** — `loadOrCreateLocalEnvelopeSigningKey` uses an atomic `wx`-flag write
  with EEXIST handling instead of a non-atomic `existsSync`+write, so concurrent processes
  converge on the first key written instead of overwriting each other
- **Raw-backed save validation** — Raw-backed memory ingest now requires an explicit
  `success: true` and non-empty `id` from `saveMemory` before counting a row as saved
- **Managed dashboard persona broader fallback** — Dashboard persona v8 now falls back to
  `mama_search` on any non-success `context_compile` result, not only when the worker envelope is
  missing

## [0.20.0] / mama-core [1.6.0] / mcp-server [1.14.0] / plugin [1.10.0] - 2026-05-01

### Added

- **Reactive runtime envelopes** — Gateway and worker tool calls now carry signed runtime
  envelopes, scope snapshots, and mismatch audit rows so agents operate inside an explicit
  permission boundary instead of relying on prompt-only intent
- **Memory provenance foundation** — Memory writes can preserve trusted origin metadata including
  agent id, envelope hash, gateway call id, model run id, source refs, scope bindings, and
  provenance audit/backfill helpers
- **Model run and tool trace ledger** — Added adapter-scoped model run stores, tool trace stores,
  replay compatibility helpers, and lifecycle hardening for reconstructing what an agent did
- **Worker context APIs** — Added unified raw search, agent situation packets, and worker graph/entity
  APIs so subordinate agents can read bounded evidence without manually stitching DB internals
- **Twin edge ledger** — Added first-class twin edges with ref validation, visibility rules, and
  graph provenance tests for durable relationships between memory, raw, entity, and case refs
- **Strict memory search controls** — `mama_search`, MCP search, and `mama.suggest()` now accept
  `strict`, `strictness`, `threshold`, `disableRecency`, `includeRelated`, `topicPrefix`,
  `minLexicalSupport`, `diagnostics`, and `scopes` so agents can choose recall-friendly,
  balanced, or strict retrieval per request
- **Retrieval diagnostics** — Search results can now expose lexical/entity/scope/graph support,
  vector-only status, strictness rejection counts, and contributing-leaf diagnostics so operators
  can see why a result was included instead of trusting a broad vector match

### Changed

- **North Star shifted toward bounded context** — MAMA now treats memory as one substrate inside a
  larger local runtime for permission-scoped, provenance-backed agent context
- **Standalone gateway execution** — Gateway tool execution and delegation were split into clearer
  pipeline modules, with envelope context propagated through internal calls and Code-Act paths
- **Raw connector indexing** — Connector raw stores now keep unified indexes and provenance so raw
  rows can be queried and traced as evidence, not just treated as ingest byproducts
- **Search quality pipeline** — Strict search options now flow through MCP and standalone handlers
  into `mama.suggest()` and `recallMemory()`, including the memory_v2 fusion/rollup path, wiki
  hits, graph-expanded hits, and learned-ranker metadata
- **Standalone search scope handling** — `mama_search` now defaults to the active envelope scopes
  and rejects out-of-envelope caller scopes before they reach core memory search

### Fixed

- **Envelope and provenance review gaps** — Hardened reactive envelope issuance, public health vs
  authenticated status separation, gateway scope mismatch logging, model-run replay contracts,
  situation packet visibility, graph visibility, alias replay, and graph API internal error
  sanitization
- **Vector-noise leaks in strict search** — Strict and balanced modes no longer allow vector-only
  fallback, wiki vector hits, or graph-expanded rows through without independent relevance
  confirmation
- **Persistent CLI process buildup** — Standalone now reclaims idle persistent Claude processes,
  preserves active tool-result leases, and makes `mama stop` process discovery safer under large
  process tables

## [0.19.1] / mama-core [1.5.0] / mcp-server [1.13.0] - 2026-04-20

### Added

- **Case-first memory substrate** — Added the case-first schema, write paths, timeline range reader, freshness sweeper, merge/split flows, corrections, composition overrides, and MCP case timeline tool for bounded case narrative access
- **Canonical entity substrate foundation** — Added first-class entity types, errors, normalization,
  persistence, candidate generation, resolution rules, recall bridge wiring, and audit metrics for
  multilingual canonical identity handling across MAMA core
- **Entity review and audit APIs** — Added standalone candidate review flows, entity audit queue and
  runner paths, and authenticated `/api/entities/candidates*` and `/api/entities/audit/*` routes
- **Entity benchmark and synthetic audit fixtures** — Added gold canonical identity fixtures,
  cross-language alias fixtures, perturbation/replay samples, and benchmark coverage for entity
  candidate and audit quality gates
- **Entity operations runbook and viewer design** — Added the entity substrate operations runbook
  plus a dedicated operations-viewer design for Feed, Lineage, Entities, Review, Integrity, and
  Memory surfaces

### Changed

- **Learned ranker + suggest integration** — `mama.suggest()` now exposes learned-ranker metadata, respects `rerankWithLearned`, preserves memory source types for fallback rows, and keeps graph expansion counts aligned with the returned result set
- **Standalone Claude auth detection** — standalone install/init/setup/run/status flows now prefer `claude auth status` for Claude Code login detection, while preserving the legacy `~/.claude/.credentials.json` fallback for older environments
- **Slack-to-entity ingest path** — Connector ingestion now preserves raw provenance into
  `entity_observations` so connector evidence can be traced from raw rows through observations and
  downstream entity workflows
- **Canonical recall integration** — `recallMemory()` now probes canonical entities through the
  recall bridge under `MAMA_ENTITY_PROJECTION_MODE`, keeping `off`, `shadow`, and `dual-write`
  modes distinct and reviewable
- **Entity audit runtime packaging** — Standalone audit runs now resolve packaged runtime fixtures by
  default instead of depending on test-only paths

### Fixed

- **Review follow-up hardening** — Membership unpin now clears manual-pin metadata, freshness writes refresh `freshness_checked_at` without mutating stable scores, drifted-case listings exclude terminal rows, and exact-merge lineage adoption no longer floats async work inside sync transactions
- **Standalone auth UX** — postinstall and setup no longer falsely warn about missing Claude Code auth when `claude auth status` is valid, and release/setup docs now describe the actual login path (`claude auth login`)
- **Entity review follow-up hardening** — Review handlers now prefer stable actor UUID identity,
  validate byte-sized request bodies, resolve alias-backed evidence correctly, and fail loudly on
  malformed persisted audit metrics
- **Observation row validation** — Entity observation parsing now rejects missing or malformed
  optional columns instead of coercing undefined values into silent fallbacks
- **Embedding-backed candidate preservation** — Zero-score blocked pairs are no longer discarded
  when an embedding scorer is available, allowing cross-language recovery during candidate ranking

## [0.19.0] - 2026-04-12

### Added

- **Managed agent lifecycle foundation** — Added DB-backed `agent_versions`, `agent_metrics`, and `agent_activity`, plus managed-agent CRUD/version/metrics APIs for create, update, compare, archive, and history flows
- **Agents viewer surface** — Added the Agents tab with list/detail flows for Config, Persona, Tools, Activity, Validation, and History, including deep links, create modal, status badges, and activity summary integration
- **Agent to Viewer command channel** — Added UI command queue, page-context reporting, `viewer_state`, `viewer_navigate`, and `viewer_notify` so the frontdoor agent can inspect and steer the same Viewer surface the user is using
- **Validation session system** — Added validation session migrations, store/service APIs, summary/history/session detail/compare/approve routes, and Viewer baseline approval flows
- **Agent testing and runtime sync** — Added `agent_test` scoring, validation-session linkage, managed-agent runtime sync helpers, and config/persona hot-reload wiring for `agent_create` and `agent_update`
- **OS Agent same-view groundwork** — Exposed `os-agent` as a managed system agent and expanded Viewer context for agents, wiki, dashboard, feed, settings, and other same-view surfaces
- **Mobile daemon CLI coverage** — Added regression coverage for the mobile Claude daemon stream-json spawn flags and UUID session handling

### Changed

- **Frontdoor alignment** — Viewer-facing traffic now prefers `os-agent` as the user-facing frontdoor while conductor remains the system audit/background role, with viewer/system lanes separated to prevent audit traffic from blocking the frontdoor
- **Validation contract hardening** — Validation summary/history/compare/approve flows now validate agent ownership, trigger compatibility, baseline selection, session scoping, and API error handling against the shipped store shape
- **Viewer context and routing** — Dashboard, Agents, Memory, Wiki, Feed, Logs, Settings, and chat-shell flows now publish clearer page context and route selection so agent replies can stay grounded in the user’s visible state
- **Agent activity and telemetry** — Scheduled audit, wiki, dashboard, memory, delegate, and agent-test flows now record activity/validation data through the shared agent telemetry path
- **Viewer build hygiene** — Standalone build now clears stale `public/viewer/js` outputs before recompiling, preventing deleted modules from shipping accidentally
- **Release docs alignment** — README, roadmap/design docs, viewer docs, and landing-page copy now describe the shipped agent-management, validation, and post-playground viewer model

### Fixed

- **Agent backend and tool handling** — Managed-agent backends now support `claude`, `codex`, `codex-mcp`, and `gemini`, viewer-only mutations are guarded consistently, and alias/canonical agent ids resolve correctly during updates and tests
- **Validation and telemetry resilience** — Agent tests, delegations, and scheduled runs no longer fail just because telemetry persistence fails, and started validation sessions are cleaned up or finalized more consistently
- **Activity and metrics correctness** — Version writes are serialized, response averages aggregate instead of overwrite, terminal outcomes drive summaries, audit failures count toward error streaks, and activity rows preserve run metadata
- **Viewer state and safety** — Fixed stale detail/list context races, approval refresh issues, page-context leakage, keyboard accessibility gaps, wildcard tool-permission preservation, and multiple XSS-prone unescaped render paths
- **Same-view wiring** — Wired the active UI command queue into the executor path actually used by OS agent flows so page lookup, navigation, and same-view context operate through the live Viewer channel

### Removed

- **Legacy viewer surfaces** — Deleted the old Playground/Skills viewer modules, removed playground template assets, and stopped serving legacy root viewer asset aliases such as `/manifest.json`, `/viewer.css`, and `/js/utils/*`
- **Legacy playground runtime artifacts** — Archived the old user playground skill/workspace assets out of the active runtime path to stop stale prompt injection and viewer references

## [0.18.2] - 2026-04-10

### Fixed

- **Cloudflare Tunnel auto-trust** — Requests through Cloudflare Tunnel with CF Access identity headers are now automatically trusted without requiring `MAMA_TRUST_CLOUDFLARE_ACCESS` environment variable. Peer must be localhost (tunnel by definition)

## [0.18.1] - 2026-04-10

### Fixed

- **Config migration** — Existing users with `e5-small` (384-dim) config are automatically migrated to `e5-large` (1024-dim) on startup. Added `configVersion` field with versioned migration framework
- **npx install** — `npx @jungjaehoon/mama-os init` now works. Added `mama-os` bin alias to match scoped package name

## [0.18.0] - 2026-04-10

### Added

- **Knowledge Agents** — Conductor orchestrates Dashboard Agent (project briefings), Wiki Agent (Obsidian knowledge compilation), and Memory Agent (automatic decision extraction). Agents delegate via `delegate()` gateway tool with optional skill injection (`~/.mama/skills/{skill}.md`)
- **Viewer redesign** — Dashboard (project intelligence), Feed (connector stream), Wiki (Obsidian editor), Memory (1000+ node graph with neighbor expansion, hover labels), Logs (full-featured daemon viewer with stats/pins/export/WebSocket), Settings (connectors, agents, cron, token budget). Floating chat on all tabs
- **Delegate gateway tool** — `delegate(agentId, task, background?, skill?)` replaces DELEGATE:: text parsing. Retry with exponential backoff (3 attempts), channel history injection on crash recovery, tier-based permission control
- **OS Agent mode** — Conductor delegates specialized work to sub-agents. Sub-agent tools (report_publish, wiki_publish, obsidian) blocked on Conductor to enforce delegation
- **Obsidian wiki integration** — Wiki agent compiles knowledge into Obsidian vault via CLI. Search-before-write prevents duplicates. Change detection skips compilation when no new information
- **Agent audit system** — Hourly audit cron job, agent activity timeline in Logs tab, agent notices API
- **Kagemusha query tools** — `kagemusha_overview`, `kagemusha_entities`, `kagemusha_tasks`, `kagemusha_messages` for progressive business data exploration
- **Claude Code connector** — Plugin hooks feed coding session context into the connector framework
- **Graph improvements** — 1000 node limit, neighbor expansion on click, zoom-independent hover labels, physics optimization
- **start.ts refactoring** — Extracted into 14 focused modules under `src/cli/runtime/` (agent-loop-init, api-routes-init, api-server-init, connector-init, daemon, gateway-init, gateway-wiring, mama-core-init, memory-agent-init, metrics-init, scheduler-init, server-start, shutdown, utilities)

### Changed

- **Playground system removed** — Playground tab, CRUD API, template seeding, playground_create tool all deleted. Log viewer moved to `/viewer/log-viewer.html` (full 1399-line feature set preserved)
- **SQLite driver unified** — Standalone migrated from `node:sqlite` to `better-sqlite3`, aligning with mama-core. Node.js 22.13+ no longer required
- **Source code English conversion** — 230 → 93 Korean lines in source. Pre-commit hook blocks new Korean in .ts files
- **Multi-agent handlers simplified** — Removed DELEGATE:: text parsing, delegation-format-validator, multi-agent-base. Delegation now routes through gateway tool exclusively
- **Plugin mama-core dependency** — Changed from `"^1.3.0"` (npm registry) to `workspace:*` (local build). Fixes stale e5-small model resolution

### Fixed

- **mama_save null ref** — `agent-loop-init.ts` was creating AgentLoop without passing `executorOptions` (4th arg), leaving `GatewayToolExecutor.mamaDbPath` undefined
- **Logs tab iframe** — Empty `src=""` attribute caused browser to resolve current page URL, making the load check always fail
- **Dashboard/Wiki agents not delegatable** — Were created as separate AgentLoops in api-routes-init instead of being registered in multi-agent config

### Security

- **All API routes protected** — 7 previously unprotected routes (`/api/sessions`, `/api/logs/daemon`, `/api/workspace/skills`, etc.) now require `requireAuth`
- **IP ban on honeypot hit** — Probes to `.git`, `.env`, `wp-login.php`, `mama-memory.db` trigger immediate 15-minute IP ban + tarpit
- **IP ban on auth failure** — 5 authentication failures within 5 minutes → automatic 15-minute IP ban
- **Banned IP rejection** — Enforced at both security middleware and requireAuth levels
- **X-Frame-Options hardened** — Only `/viewer/log-viewer.html` allows SAMEORIGIN; all other paths DENY

## [0.17.0] - 2026-04-07

### Added

- **Connector Framework** — plugin-based architecture for connecting MAMA OS to external data sources. `IConnector` interface, `ConnectorRegistry` (dynamic loading), `PollingScheduler` (batch polling with state persistence), `RawStore` (per-connector SQLite evidence storage). Source role classification: truth, hub, deliverable, spoke, reference. Shared `gws-utils.ts` utility for Google Workspace CLI commands (Gmail, Calendar, Sheets, Drive)
- **13 Connectors** — Slack (Web API), Telegram (Bot API), Discord (REST API), Chatwork (API), iMessage (local DB), Gmail (gws CLI), Calendar (gws CLI), Notion (API), Obsidian (local vault), Kagemusha (kagemusha.db reader), Sheets (gws CLI, truth source), Trello (REST API, truth source), Drive (gws CLI, deliverable tracking)
- **Truth-first 3-pass extraction** — Pass 0: structured data (spreadsheet/kanban) → `ProjectTruth` snapshot (no LLM). Pass 1: cross-source activity merged by timestamp + truth context → LLM extraction. Pass 2: spoke channels linked to projects via context. Functions: `buildProjectTruth`, `buildActivityExtractionPrompt`, `buildSpokeExtractionPrompt`
- **Batch polling** — `PollingScheduler.pollAll()` collects from all connectors, classifies by source role, and feeds unified 3-pass pipeline
- **CLI: `mama connector`** — `add/remove/list/status` commands for managing connectors. Config at `~/.mama/connectors.json`
- **Memory kinds: task, schedule** — `mama-core` MEMORY_KINDS extended to support project task tracking and schedule events from connectors
- **DB migration 025** — adds `kind` CHECK constraint for `task` and `schedule` values in the decisions table

### Changed

- **search_decisions_and_contracts** — migrated from inline handler in `server.js` to `src/tools/search-decisions-and-contracts.js` (single source of truth)

## [0.16.1] - 2026-04-07

### Fixed

- **Telegram gateway: 0 vulnerabilities** — migrated from `node-telegram-bot-api` (8 vulnerabilities via deprecated `request` chain) to `grammY` (1.42.0). Zero npm audit issues. Package count reduced 372 → 244
- **MCP protocol scopes wiring** — `server.js` inline tool definitions were missing `scopes` and `event_date` parameters. `src/tools/` files had them but were not connected to the MCP protocol handlers. Now `save` and `search` MCP tools correctly pass scopes + event_date to mama-core
- **Default embedding model** — changed from `Xenova/multilingual-e5-small` (384-dim, ~113MB) to `Xenova/multilingual-e5-large` (1024-dim, ~560MB) to match production usage across all packages, docs, and tests

## [0.16.0] - 2026-04-06

### Added

- **MemoryBench benchmarking framework** (`packages/memorybench/`) — pluggable provider/benchmark/judge framework for objectively measuring memory retrieval quality. Supports MAMA, Mem0, SuperMemory, Zep, filesystem, and RAG providers against LongMemEval (500 questions, 6 categories). Pipeline: ingest → index → search → answer → evaluate → report with checkpoint/resume. Web UI for real-time visualization and run comparison. MemScore composite metric (accuracy / latency / context tokens)
- **Vector-first recall with lexical augmentation** (`mama-core`) — `recallMemory()` now uses vector search as primary retrieval path instead of truth text matching. Added FTS5 BM25 lexical search with `lexicalScoreToConfidence()` normalization for hybrid vector+lexical ranking. Fixes the root cause of near-random retrieval when conversations were stored as single blobs
- **Claude CLI extraction pipeline** — benchmark uses `ingestConversation()` with Claude CLI for typed memory extraction (fact/preference/decision/lesson/constraint), giving each fact its own embedding for precise retrieval. No API key needed
- **Memory core infrastructure** — scoped memory system with typed records (preference, fact, decision, lesson, constraint), truth projection for recall filtering, evolution engine with automatic graph edge resolution, and channel summary state management. SQLite migrations 014-023. 16 test files, 59 tests.
- **Candidate-driven memory writer agent** — when you say "기억해" or "we decided X," MAMA now reliably catches and saves it. A deterministic `SaveCandidateExtractor` pre-filters turns for durable memory candidates (Korean + English), then a writer-only memory agent searches related memories, resolves topic relationships, and saves with scope bindings. Replaces the previous audit-only flow that could silently skip explicit decisions.
- **Memory agent dashboard API** — `/api/memory-agent/stats` and `/api/memory-agent/dashboard` expose candidate lifecycle metrics (turnsObserved, acksApplied/Skipped/Failed), channel tracking, and recent extraction activity
- **Scoped memory saves** — `mama_save` now forwards scope refs (project, channel, user, global) through the full chain from agent persona to mama-core `saveMemory()`, preventing cross-scope pollution
- **Strongly-typed scope refs** — `ScopeRef` type with `MemoryScopeKind` union replaces bare `{ kind: string; id: string }` across standalone types, catching invalid scope names at compile time
- **event_date temporal tracking** — `decisions` table now stores when events actually occurred (migration 024). Threaded through `ingestConversation(sessionDate)` → `saveMemory(eventDate)` → DB. Search API returns `event_date` in results
- **Tool-use answer phase** (`memorybench`) — LLM re-searches via `mama_search` gateway tool when initial results are insufficient. Question-type-specific prompts. LongMemEval 100Q: 78% (static) → 93% (tool-use)
- **Memory agent persona v5** — temporal marker extraction: relative time (yesterday, last week) → ISO 8601 `event_date` in `mama_save`
- **MCP v2 API integration** — all MCP tools (`save_decision`, `recall_decision`, `suggest_decision`, `list_decisions`) now accept `scopes` parameter for scope-based memory isolation. `save_decision` also accepts `event_date`. New `ingest_conversation` MCP tool for importing conversations. Plugin `save_decision` updated with scopes + event_date

### Fixed

- **Vector search blocked by text matching** — `recallMemory()` used `queryRelevantTruth` as primary path which returned all decisions by update time, not query relevance. Vector search is now primary with truth status as post-filter
- **Similarity scores hardcoded to 1** — `suggest()` now returns actual cosine similarity instead of hardcoded value, enabling meaningful ranking
- **Extraction CLI session ID** — Claude CLI requires UUID format for `--session-id`; was using string `'extraction-cli'` causing silent extraction failures

### Changed

- **Graph API pagination** — `/api/graph` now returns `decision_preview` (220 chars) instead of full decision text, with `?limit=N` (default 300, max 1000) and `?full=true` for unbounded fetch. Viewer disables physics simulation above 400 nodes for performance
- **Memory agent persona** — rewritten from auditor to writer role; resolves "save when in doubt" vs "prefer quarantine" contradiction; now instructs agent to parse and include scopes when calling `mama_save`
- **Memory agent isolation** — `blockedTools` expanded to include Grep, Glob, Edit alongside Read, Write, Bash for defense-in-depth
- **Search quality overhaul** — LongMemEval benchmark 58% → 88% (static) → 93% (tool-use, 100Q) via RRF fusion, FTS5 BM25, event_date tracking, tool-use answer with entity-broadening search, question-type prompts, and session boundary isolation
- **better-sqlite3 restored for FTS5** — `node:sqlite` (introduced in 0.14.0) lacked FTS5 support needed for BM25 lexical search; better-sqlite3 was rolled back as the SQLite runtime to enable hybrid vector+FTS5 retrieval
- **GitHub Actions runtime refresh** — CI, publish, release, pages, and marketplace sync workflows now use current `actions/checkout`, `actions/setup-node`, and `pnpm/action-setup` releases; GitHub release creation moved from `softprops/action-gh-release` to `gh release create` to avoid deprecated Node 20 action runtimes in future runs

## [0.14.5] - 2026-03-24

### Fixed

- **npx broken in pnpm workspace** — removed `.npmrc` settings (`script-shell`, `unsafe-perm`, `enable-scripts`, etc.) that were added for native module builds no longer needed, which broke `npx` bin resolution and prevented MAMA MCP plugin from connecting when Claude Code was opened in the MAMA project directory

## [0.14.4] - 2026-03-24

### Added

- **Telegram gateway integration** — production-ready Telegram bot support ported from internal project with full platform parity alongside Discord and Slack (#58)
  - **2-stage message dedup** — message_id (60s TTL) + content signature (5s TTL) prevents duplicate processing on polling reconnect
  - **Group chat filtering** — bot only responds to @mentions, /commands, and reply-to-bot in group chats
  - **Sticker support** — receive stickers as `[sticker: emoji]` text; send stickers via `telegram_send(sticker_emotion)` with emotion-to-emoji mapping and sticker set cache
  - **ToolStatusTracker streaming** — real-time tool progress display using the same PlatformAdapter pattern as Discord/Slack
  - **Typing indicator** — 4-second refresh interval during message processing
  - **`telegram_send` tool** — agents can send messages, files, and stickers to Telegram chats
  - **Platform parity** — health check, security alert delivery, and CronResultRouter all include Telegram
  - **Polling hardening** — IPv4 forced, polling_error handler, periodic dedup cleanup timer, bot cleanup on start failure
  - **Markdown fallback** — retries as plain text on 400 errors only

## [0.14.2] / mama-core [1.3.2] / mcp-server [1.9.2] / plugin [1.8.2] - 2026-03-14

### Fixed

- **Cloudflare Access external auth** — Standalone now supports an explicit `MAMA_TRUST_CLOUDFLARE_ACCESS=true` mode so trusted Cloudflare Tunnel/Access requests with validated Access identity headers can reach protected `/api/*` routes without also requiring a separate Bearer token; direct remote requests and untrusted forwarded headers remain blocked

## [0.14.3] / mama-core [1.3.3] / mcp-server [1.9.3] / plugin [1.8.3] - 2026-03-14

### Fixed

- **Cloudflare Access WebSocket trust** — external chat sessions behind Cloudflare Zero Trust now apply the same trusted Access identity checks to `/ws` upgrades that were added for `/api/*`, so viewer chat no longer fails with repeated `1006` reconnect loops after Access login
- **Cloudflare Access operator guidance** — security, deployment, standalone setup, mobile access, and standalone README docs now explain when to use `MAMA_TRUST_CLOUDFLARE_ACCESS=true` versus `MAMA_AUTH_TOKEN`

## [0.14.0] / mama-core [1.3.0] / mcp-server [1.9.0] / plugin [1.8.0] - 2026-03-14

### Security

- **Default-deny external API hardening** — sensitive `/api/*` reads now require auth consistently, non-local WebSocket upgrades are rejected, and trusted proxy checks prevent spoofed `cf-connecting-ip` / `x-forwarded-for` attribution
- **Security event pipeline** — unauthorized requests, SSRF blocks, risky Bash patterns, honeypot hits, and WebSocket violations now write structured JSONL events with client IP metadata, alert fan-out, incident summaries, and abuse-report drafts
- **Tarpit + honeypot response** — repeated probing and known trap paths now trigger delayed responses, evidence retention, and denylist candidate generation for Cloudflare/WAF workflows

### Changed

- **SQLite runtime** — all shipped packages now use Node's built-in `node:sqlite`; `better-sqlite3` support and prebuild handling were removed
- **Node.js baseline** — all public packages now require Node.js 22+
- **Plugin/MCP install path** — first-run setup no longer depends on compiling SQLite native addons; Codex and Claude clients use the same shared SQLite file through `node:sqlite`
- **Codex MCP bootstrap** — Standalone now bootstraps its internal `CODEX_HOME` from `~/.codex/auth.json` when needed, so `codex-mcp` startup works on fresh MAMA installs without manual copy steps

### Fixed

- **Codex MCP backend startup** — fixed `Process not running` failures caused by missing internal `CODEX_HOME`
- **Daemon shutdown path** — `mama stop` now completes the embedded server shutdown flow, cancels the initial heartbeat timeout, drains in-flight agent work, and avoids the previous `libc++abi` abort from forced shutdown on pending SQLite/fs cleanup
- **Live database compatibility** — Codex-installed MCP server verified against the existing `~/.claude/mama-memory.db` for search, decision save, checkpoint save, and checkpoint load without `better-sqlite3`

## [0.13.3] - 2026-03-12

### Fixed

- **Setup wizard stuck on onboarding screen** — After onboarding completed, browser stayed on `/setup` instead of redirecting to `/viewer`. Now detects onboarding completion by checking for `USER.md` + `SOUL.md` files and sends redirect
- **Remove dead custom tool handlers from setup wizard** — CLI handles all tool execution directly; removed unused `createAllOnboardingToolsWithHandlers` and `createSetupTools` references

## [0.13.2] - 2026-03-12

### Fixed

- **Onboarding prompt leaking into OS agent** — `COMPLETE_AUTONOMOUS_PROMPT` was injected into the OS agent's system prompt when persona files were missing. Onboarding is now handled exclusively by the Setup Wizard (`/setup`)
- **Setup wizard config alignment** — Setup wizard now reads `model`, `dangerouslySkipPermissions`, and `requestTimeout` from `config.yaml` instead of hardcoding, matching the agent loop's config path

## [0.13.1] - 2026-03-12

### Fixed

- **Setup wizard authentication failure** — Setup wizard was the only component using OAuth direct API (`ClaudeClient`), causing "credentials not found" errors when `~/.claude/.credentials.json` was missing. Replaced with `PersistentCLIAdapter` (CLI subprocess) to match agent loop behavior

## [0.13.0] - 2026-02-26

### Added

- **Cron worker isolation** — cron jobs now execute in a dedicated `CronWorker` (separate `PersistentClaudeProcess` with Haiku model), completely decoupled from the OS agent. Eliminates 300s session timeout when OS agent is busy with long-running tasks
- **CronResultRouter** — delivers cron results directly to gateways via EventEmitter, bypassing the OS agent entirely. Supports `discord`, `slack`, and `viewer` channel routing
- **Job channel configuration** — new `channel` field in cron job config (`discord:channelId`, `slack:channelId`, `viewer:sessionId`) for result delivery routing
- **Cron API security validations** — channel format validation (known gateways only), prompt length limit (10,000 chars), and tool restriction (`Bash`, `Read`, `Write`, `Glob`, `Grep` only)

### Changed

- **Cron lane removal** — removed cron-specific lane logic from `agent-loop.ts`; cron jobs no longer flow through the lane system
- **Scheduler callback signature** — `CronScheduler.setExecuteCallback()` now receives `(prompt, job)` instead of a single string

### Security

- **CronWorker tool restriction** — `allowedTools` limits cron execution to safe tools only, preventing RCE via prompt injection
- **Channel IDOR prevention** — API validates channel format and rejects unknown gateway names

## [0.12.2] - 2026-02-26

### Fixed

- **Viewer conversation history loss on refresh** — user messages now saved to DB immediately before agent loop; streaming responses flushed every 5 seconds via `flushStreamingResponse()`; session lock released only after final persistence to prevent out-of-order turns
- **localStorage key tied to sessionId** — changed to channel-based fixed key (`viewer_mama_os_main`); history survives server restarts and session ID changes
- **Server history replacing local history** — `displayHistory()` now merges server + local history by timestamp instead of full DOM replacement
- **isAlive check preventing session resume** — viewer now uses server session regardless of `isAlive` flag
- **localStorage history limit** — increased `maxHistoryMessages` from 50 to 200; `displayHistory()` merge respects cap to prevent overflow

### Improved

- **Gateway tools discoverability** — `gateway-tools.md` now explicitly connects `mama_save`/`mama_search` ↔ `code_act`, with usage examples and callouts that these are NOT direct MCP tools

## [0.12.1] - 2026-02-26

### Added

- **Dashboard agent restart/stop** — per-agent Restart and Stop buttons in dashboard agent cards with `POST /api/multi-agent/agents/:id/restart` and `POST /api/multi-agent/agents/:id/stop` endpoints (auth-guarded)
- **MCP tool access for Codex agents** — `codex-mcp-process.ts` now receives filtered tool list via `--tools` flag based on ToolRegistry permissions
- **Plugin skill loader** — `skill-loader.ts` supports `.claude-plugin/` directory structure with `skills/` sub-directories and `SKILL.md` files, symlink-safe path traversal guard via `realpathSync`
- **Configurable workflow timeouts** — `workflow_step_ms` (default 10min) and `workflow_max_ms` externalized to `config.yaml` with Settings UI controls
- **System reminder cross-platform routing** — batch key scoped by `source:channelId` to prevent Discord reminders leaking to Slack and vice versa

### Fixed

- **Queued workflow execution** — `sendQueuedResponse()` now calls `tryExecuteWorkflow()` and strips plan JSON; previously workflow plans were sent as raw text to chat
- **Queued delegation parsing** — delegations parsed from `workflowResult.directMessage` only, not the concatenated display string containing workflow output
- **Message queue drain lock** — per-agent `draining` Set prevents concurrent `drain()` calls from idle event + `tryDrainNow()` race
- **Message queue atomic re-queue** — busy-agent re-queue creates queue array if concurrent `clearExpired()` removed it
- **Agent process timeout** — extracted `_getRequestTimeoutMs()` helper with `try/catch` + `Math.max(0, ...)` safety, used in both `sendMessage` and `sendToolResults`
- **Council step timeout** — passes `workflow_step_ms` override to `getProcess()` during council/workflow execution
- **Slack duplicate cleanup interval** — removed redundant `mentionCleanupInterval` (base class `cleanupInterval` already handles `clearExpired` + `cleanupProcessedMentions`)
- **Empty catch blocks** — added `DebugLogger`-based logging to previously silent catch blocks in skill-loader, workflow model resolution, and message queue

### Security

- **Auth guard on agent control endpoints** — `isAuthenticated(req)` check on restart/stop API routes
- **Symlink escape prevention** — skill loader uses `realpathSync` to block symlink-based path traversal attacks

## [0.12.0] - 2026-02-25

### Added

- **Layered config system (STORY-001)** — externalized 26 hardcoded constants into `~/.mama/config.yaml` with env override support (`MAMA_*`), deep merge for nested sections, and sync `getConfig()` accessor
- **Token accuracy & skill loading (Sprint 2)** — per-model token budget with fail-closed enforcement, prompt size monitor migrated from char-based to token-based, semantic skill truncation in agent loop
- **IModelRunner interface (Sprint 3)** — unified CLI backend abstraction for Claude/Codex with consistent streaming, tool dispatch, and error handling
- **ToolRegistry SSOT (Sprint 4)** — centralized tool permission source of truth with per-agent MCP tool filtering, gateway tool generation from registry
- **Observability stack (STORY-019)** — SQLite-backed MetricsStore with WAL mode, batch recording, time-range queries, label filtering, aggregation, and automatic cleanup
- **HealthScoreService** — composite health score (0-100) computed from metrics window with configurable weights
- **Connection-based health check (STORY-022)** — 4-tier check system (critical: gateway/embedding, warning: cron/metrics) with `/api/metrics/health` endpoint
- **Viewer UI improvements** — unified dark mode cards, multi-agent settings panel with tier badges, metrics/token budget config sections

### Fixed

- **Daemon restart loop** — `process.exit(1)` on shutdown timeout caused systemd `Restart=on-failure` loop; changed to `exit(0)`, added `SO_REUSEADDR`, `closeAllConnections()` on stop
- **Server fd leak in retry loop** — failed server instances now properly closed with `removeAllListeners()` before retry
- **setTimeout retention in stop()** — guard timer cleared when `s.close()` completes to prevent event loop retention
- **setInterval cleanup on shutdown** — metrics and health warning intervals captured and cleared during graceful shutdown
- **JSON.parse safety in metrics query** — label filter wrapped in try/catch for malformed data
- **Unsafe type casts** — replaced `Record<string, unknown>` cast with typed `ApiMetricsConfig`, `embeddingServer` typed as `HttpServer`
- **Config initialization order** — `daemon` command now uses `initConfig()` to populate cache before `getSessionPool()` accesses it
- **systemd service** — moved `StartLimitIntervalSec`/`StartLimitBurst` to `[Unit]` section, added `ExecStop` directive

### Changed

- **Periodic logs** — metrics summary and health warning intervals use `DebugLogger` instead of `console.log/warn`
- **healthService.compute()** — wrapped in try-catch with error logging in `/api/metrics/health` endpoint
- **ApiServer.server type** — corrected from Express return type to `HttpServer | null`

## [0.11.1] / mama-core [1.2.1] - 2026-02-24

### Added

- **Quantized embedding model (q8)** — default `dtype: 'q8'` for Transformers.js pipeline; 75% smaller model (449MB → 113MB), 36% faster cold start, <1% quality loss
- **`quantized` config option** — configurable via `~/.mama/config.json` (`true`=q8, `false`=fp32)
- **`getQuantized()` API** — exported from mama-core for runtime config access

### Fixed

- **Documentation model name** — corrected all references from `all-MiniLM-L6-v2` to actual model `multilingual-e5-small` across 13 files

## [0.11.0] / mama-core [1.2.0] / mcp-server [1.8.0] - 2026-02-24

### Removed

- **openclaw-plugin** — extracted to standalone repo ([openclaw-mama](https://github.com/jungjaehoon-lifegamez/openclaw-mama))
- **sqlite-vec** native extension — replaced with pure-TS brute-force cosine similarity (no native dependencies)
- **better-sqlite3 prebuild** dependency from mcp-server (now only in mama-core)

### Fixed

- **vectorSearch dimension guard** — skip rows with mismatched embedding dimensions instead of throwing
- **Architecture diagram** — corrected client→server flow (Claude Desktop connects directly to MCP Server, not through Embedding Server)
- **Tier 2 fallback description** — clarified trigger: `vectorSearch()` throws when `embeddings` table is missing
- **Stale test count** in deployment guide (removed hardcoded "597")
- **Package count** in README (five→four after openclaw-plugin extraction)

### Changed

- **CI pnpm version** — removed hardcoded `version: 9` from all workflows; auto-detected from `packageManager` field
- **sqlite-adapter migration** — `_migrateFromVssMemories()` called unconditionally (not gated by table check)

## [0.10.4] - 2026-02-23

### Fixed

- **Type safety**: Removed all `callbacks as any` casts by unifying `PromptCallbacks` interface into `types.ts` — single source of truth across Claude CLI, Codex MCP, and Persistent CLI backends
- **Type drift prevention**: Consolidated duplicated `ToolUseBlock` definitions from 3 files into canonical `types.ts` export
- **`StreamCallbacks` duplication**: Replaced identical interface with `type StreamCallbacks = PromptCallbacks` alias

### Changed

- **`PromptFinalResponse`**: New shared type `{ content: string; toolUseBlocks: ToolUseBlock[] }` normalizes `onFinal` callback across all backends
- Codex MCP `onFinal` now emits `{ content, toolUseBlocks: [] }` instead of `{ response }` for backend consistency

## [0.10.3] / plugin [1.7.14] - 2026-02-23

### Fixed

- **4-layer agent isolation** — prevents ~50K token/turn waste from global config injection:
  - `cwd` scoped to `~/.mama/workspace` (blocks `~/CLAUDE.md` auto-load)
  - `.git/HEAD` boundary (stops upward CLAUDE.md traversal)
  - `--plugin-dir` empty directory (blocks global plugin skill loading)
  - `--setting-sources project,local` (excludes `~/.claude/settings.json` enabledPlugins)
- **Watchdog restart loop** — removed `killProcessesOnPorts()` from daemon startup that was killing sibling daemons; added PID file adopt + health check fallback
- **Zombie process cleanup** — `handleTimeout()` now kills timed-out claude processes (SIGTERM → SIGKILL) instead of only resetting state
- **turnCount reset** — `resetSession()`/`setSessionId()` now re-inject system prompt for new sessions
- **Detached process removal** — `ClaudeCLIWrapper` no longer spawns with `detached:true` (prevents orphan processes)

### Added

- **New documentation guides:**
  - `docs/guides/playgrounds.md` — Playground usage, built-in 4 types, sendToChat API
  - `docs/guides/codex-backend.md` — Codex CLI backend setup, Claude vs Codex comparison
  - `docs/guides/multi-agent-advanced.md` — Council, Dynamic Workflow, Swarm DB, personas
  - `docs/guides/code-act-sandbox.md` — QuickJS/WASM sandbox, HostBridge, security model
- **CLAUDE.md agent isolation section** — documents 5 prohibited modifications with rationale

### Changed

- **mama-os.md** — complete rewrite of tab documentation to match actual Viewer UI (5 tabs + floating chat), updated architecture diagrams, gen-4.x model list
- **Plugin SKILL.md** — UserPromptSubmit is Claude Code host-side (no plugin script), PreToolUse/PostToolUse marked disabled, teaser format 40 tokens
- **Plugin README.md** — agents marked as planned (not yet registered), test count 328, version 1.7.14

## [0.10.2] / mama-core [1.1.5] - 2026-02-22

### Added

- **Code-Act sandbox tool visibility**: Viewer reasoning header now shows which tools Codex used (e.g., `mama_search`, `Read`, `Bash`) via `onToolUse` callbacks from HostBridge
- **Shared MAMA tool handlers** (`mama-tool-handlers.ts`): Extracted `handleSave`, `handleSearch`, `handleUpdate`, `handleLoadCheckpoint` — eliminates duplication between `MCPExecutor` and `GatewayToolExecutor`
- **Type interfaces**: `SemanticEdgeItem`, `DecisionEdgeRow`, `ConversationMessage`, `RecallGraphResult`, `GatewaySessionStore` — replacing `any`/`unknown[]` throughout

### Changed

- **Codex streaming optimization**: Simplified system prompt loading, removed `state.json` dependency, conditional `ONBOARDING.md` loading
- **Multi-agent system prompt**: `buildToolsSection()` now uses full `gateway-tools.md` instead of hardcoded 5-tool subset — fixes Codex OS agent not knowing available tools on startup
- **Context injection**: Skip `getRelevantContext()` on CONTINUE turns for lower token overhead
- **Gateway tools cache**: Cache `getGatewayToolsPrompt()` in production, hot-reload in dev
- **`formatContextForPrompt` hoisted**: 3 calls → 1 call per message route

### Fixed

- **mama_save checkpoint crash**: `sessionStore.getRecentMessages()` didn't exist — `any` type hid the error at compile time. Replaced with `getHistory('current')`
- **vectorSearch feature detection**: `getPreparedStmt('vectorSearch')` passed non-SQL to SQLite causing syntax error warnings on every search. Replaced with `adapter.vectorSearchEnabled`
- **checkpoint search**: `mama_search(type='checkpoint')` returned 0 results because it queried decisions table. Now routes to `loadCheckpoint()` for correct checkpoints table
- **Gateway tool result consistency**: `updateOutcome()`, `saveCheckpoint()`, `loadCheckpoint()` now all return `{ success: true }` — prevents HostBridge from treating valid results as failures
- **loadCheckpoint HostBridge compatibility**: Added `success` field to raw DB checkpoint results
- **Type safety**: Removed `any`/`unknown[]` casts throughout `mama-core` — `SemanticEdges`, `addEdge`, `querySemanticEdges` usage, `RawSemanticEdge` eliminated
- **PR #41 code review fixes** (4 rounds):
  - `esc()` quote escaping for attribute injection safety
  - Stale pin/selection indices after log trimming
  - `postMessage` targetOrigin scoped (was wildcard `'*'`)
  - `in` operator guard against non-object primitives
  - CONTINUE path dropping skill injection
  - `savePins()` sync to localStorage on clear
  - `isSearchResultItem` type guard for runtime validation
  - `diffTailLines` optimization (removed intermediate array)

### mama-core 1.1.5

- **`SemanticEdgeItem`**: `SemanticEdges` 배열 타입을 `unknown[]` → `SemanticEdgeItem[]`로 교체
- **`DecisionEdgeRow`**: `DecisionRecord.edges` 타입을 `unknown[]` → `DecisionEdgeRow[]`로 교체
- **`ConversationMessage`**: `CheckpointRow.recent_conversation` 타입을 `unknown[]` → `ConversationMessage[]`로 교체
- **`RecallGraphResult`**: `recall()` 반환 타입을 `unknown` → `string | RecallGraphResult`로 교체
- **vectorSearch feature detection 수정**: `getPreparedStmt('vectorSearch')` → `getAdapter().vectorSearchEnabled`
- **`RawSemanticEdge` 제거**: `SemanticEdgeItem`으로 통합, `as unknown as` 캐스트 제거

## [0.10.1] - 2026-02-22

### Added

- **Watchdog auto-restart**: Daemon process is now monitored by a watchdog that checks `/health` every 30s and auto-restarts on failure (max 10 restarts with exponential backoff)
- **`mama status` watchdog display**: Shows watchdog PID and active status
- **`mama stop` watchdog cleanup**: Watchdog is terminated before daemon shutdown to prevent restart during stop

### Changed

- **Timeout tuning**: Rebalanced all timeout values based on actual usage patterns
  - MCP request: 15min → 3min (single LLM call doesn't need 15min)
  - Agent response: 15min → 5min
  - Council round: 2min → 3min (prevent mid-discussion timeout)
  - Workflow step: 10min → 5min
  - Workflow total: 10min → 30min (multi-step DAG needs more headroom)
  - UltraWork total: 30min → 60min (autonomous work sessions need time)
  - UltraWork max steps: 20 → 50 (delegation + council consume steps fast)

## [0.10.0] - 2026-02-22

### Added

- **Code-Act Sandbox**: QuickJS WASM-based JavaScript sandbox engine
  - LLM agents can invoke gateway tools via code execution
  - Host Bridge: sandbox ↔ MAMA gateway tool bridge with Tier 1/2/3 permission differentiation
  - MCP Server: stdio `code_act` tool for direct use from Claude CLI
  - Type Definition Generator: auto-generates `.d.ts` per tool
- **MAMA Log Viewer**: Built-in HTML playground for real-time daemon log viewing
- **Daemon Log API**: `GET /api/daemon/logs` endpoint with `since` parameter and 304 support
- **Slack Send API**: `POST /api/slack/send` — Slack file/message sending parity with Discord
- **Backend-specific AGENTS.md**: Separate `AGENTS.claude.md` / `AGENTS.codex.md` injection per backend
- **Playground file_path**: Added `file_path` parameter to `playground_create` for large HTML support

### Changed

- **Tier differentiation**: Tier 2 = read-only + memory-write (`mama_save`/`mama_update`), Tier 3 = strictly read-only
- **Code-Act API**: Restricted to Tier 3 (read-only) permissions, authentication required
- **ESLint**: `no-explicit-any` rule enforced as error across all packages

### Fixed

- **Claude API contract**: `continue` no longer skips `results.push`
- **Tier Leak**: Missing `currentTier=1` reset in `else` branch
- **Path Traversal**: 4-layer validation on `/api/slack/send` to prevent directory traversal
- **Sensitive Files**: Block sensitive file types (`.db/.key/.pem/.env/.sqlite`) in Slack send
- **Resumed Sessions**: Prevent duplicate gateway tools injection on resumed sessions
- **Backend Fallback**: Sync `process.env.MAMA_BACKEND` on fallback
- **returnType accuracy**: Fixed 17 host-bridge tool returnTypes to match actual executor return shapes

### Dependencies

- `quickjs-emscripten@^0.32.0`
- `@jitl/quickjs-wasmfile-release-asyncify@^0.32.0`

## [0.9.5] - 2026-02-20

### Added

- **Playground Integration**: Skill Lab ↔ Skills Tab bidirectional integration
  - Playground viewer module with iframe embedding and Skills Tab sync
  - 3 built-in playgrounds: Skill Lab, Cron Workflow Lab, Wave Visualizer
  - Skill Registry API (`/api/skills/list`) for playground consumption
  - "Open in new tab" support for full-screen playground editing
- **Built-in Skill Templates**: 4 new skill templates (frontend-design, multi-agent-collab, playground, scheduling)
- **Tool Status Tracker**: In-place tool execution status updates in Viewer chat
  - Real-time tool progress display (running → completed/failed)
  - Gateway tool executor backend integration
- **Slack File Upload**: Shared attachment utilities for Discord/Slack file handling
  - `attachment-utils.ts` with `downloadAttachment`, `compressImage`, `detectImageType`
  - Deduplicated file upload logic across gateways

### Changed

- **Fail-Fast Policy**: Removed silent fallbacks, added explicit permission gates across standalone
- **AgentProcessPool Removed**: Simplified to direct process management (no pool_size)
- **Port Cleanup**: `mama start` ensures clean port release to prevent EADDRINUSE crashes

### Fixed

- **Timeout Propagation**: Agent timeout correctly passed through CLI wrapper
- **System Prompt Truncation**: Long system prompts no longer silently truncated
- **EADDRINUSE**: Restart no longer crashes when previous daemon port not released

## [0.9.4] - 2026-02-19

### Added

- **BMAD Workflow Integration**: Conductor PLAN mode generates BMAD-compliant workflow DAGs
  - Brainstorm, PRD, Architecture, Sprint Planning flows via `workflow_plan`
  - BMAD template engine with project-level awareness and output path computation
  - `is_planning_agent` flag for opt-in/opt-out BMAD injection per agent
- **Workflow Concurrency Limit**: Semaphore-based `max_concurrent_steps` (default 3) prevents rate limit hits
- **Backend Round-Robin Balancing**: Automatic claude ↔ codex-mcp load distribution across workflow steps
  - `backend_balancing` config option (default true)
- **Workflow Failure Feedback**: Conductor receives `[SYSTEM]` error message when plan validation or execution fails, enabling plan adjustment
- **Slack `slack_send` Gateway Tool**: Agents can send messages/files to Slack channels directly
- **Effort Level Support**: Claude 4.6 adaptive thinking effort (`--effort` flag) for Conductor and agents
- **Zombie Daemon Cleanup**: `killAllMamaDaemons()` kills orphaned daemon processes on start/stop

### Changed

- **Conductor Merge Policy**: Conductor no longer auto-merges PRs — must report verification results and await human `!merge` approval
- Hardcoded model IDs replaced with dynamic config resolution
- `--thinking-effort` CLI flag renamed to `--effort`
- `max_ephemeral_agents` default raised to 20

### Fixed

- **Raw JSON Leak**: Workflow plan JSON no longer leaks to Slack/Discord when plan execution fails
  - `extractNonPlanContent` now strips unfenced JSON plans
  - Fallback path in Slack/Discord handlers strips plan JSON before display
- **Codex MCP**: Spawn error fast detection + retry on failure; tilde expansion in `codexCwd`
- **BMAD Opt-Out**: Explicit `is_planning_agent: false` now correctly suppresses BMAD injection
- **Disabled Agent Skip**: `hasCodexBackendConfigured` skips disabled agents
- **YAML Error Handling**: `loadYamlFile`/`tryReadFile` throw on non-ENOENT errors instead of silent null
- **Slack Ghost Responses**: Message subtype events filtered to prevent duplicate responses
- **Settings UI**: Removed redundant `as any` casts in agent rendering

## [0.9.3] - 2026-02-18

### Added

- **UltraWork 3-Phase Loop (Ralph Loop)**: Restructured UltraWork from freeform loop to Plan→Build→Retrospective
  - Phase 1 (Planning): Lead agent creates implementation plan, optionally runs Council discussion
  - Phase 2 (Building): Executes plan via delegation loop, records each step to disk
  - Phase 3 (Retrospective): Reviews completed work, Council discussion for quality check
  - RETRO_INCOMPLETE triggers Build phase re-entry (max 1 retry)
  - File-based state persistence: `~/.mama/workspace/ultrawork/{session_id}/`
  - New `UltraWorkStateManager` class for session/plan/progress/retrospective CRUD
  - Config: `persist_state` (default: true), `phased_loop` (default: true)
  - Backward compatible: `phased_loop: false` preserves legacy freeform behavior
  - 24 new tests (8 phased loop + 16 state manager)
- **Council Engine**: Multi-round structured debates among named agents
  - Conductor outputs `council_plan` JSON block to initiate Council discussion
  - Configurable rounds (1-5), agent list, synthesis toggle
  - Progress updates in Slack/Discord per round
- **Onboarding multi-agent sync**: Phase 7b introduces all 5 agents + 4 coordination modes
  - Quick-start guide includes Multi-Agent System section
  - `handleSaveMultiAgent` auto-provisions persona files from templates
  - `provisionDefaults` copies missing persona files without overwriting existing ones

### Changed

- **Conductor persona**: Lead orchestrator renamed from Sisyphus to Conductor
  - Auto-migration: `sisyphus` config entries automatically converted to `conductor`
  - `default_agent: conductor` added to default multi-agent config
  - Updated metaphor from "roll the boulder" to orchestra/conductor theme
- Default agent model updated to `claude-sonnet-4-5-20250929`

### Fixed

- **Security**: Path traversal protection in UltraWork session IDs
- **Race condition**: TOCTOU fix in UltraWork state read-modify-write
- **Memory leak**: Lock cleanup comparison fix in UltraWorkStateManager
- **Retrospective validation**: isRetroComplete regex word boundary added
- **Workflow progress**: `completedSteps !== null` → `!== undefined` (Discord/Slack)

### Removed

- **PR Poller**: Removed ~1,200 lines of legacy PR polling code

## [0.9.2] - 2026-02-17

### Added

- **Dynamic Workflow Orchestration**: Conductor dynamically generates multi-step workflow DAGs from user requests
  - Ephemeral agents are spawned on-demand with custom system prompts, backends, and models
  - DAG-based execution with topological sort, parallel execution per level, and result interpolation
  - No pre-defined agents needed — Conductor designs the team for each request
  - Progress messages in Slack/Discord show agent name, model, and duration per step
  - Automatic cleanup of ephemeral agent processes after workflow completion
  - 30 unit tests for workflow engine (parsing, validation, cycle detection, execution)
- **Image type detection**: Discord gateway detects actual image media type from magic bytes
- **Configurable image analysis model**: ImageAnalyzer reads model from config instead of hardcoded value

### Fixed

- **Slack null message crash**: Fixed `Cannot read properties of undefined (reading 'replace')` in cleanMessageContent
- **Workflow timer leak**: Clear timeout after Promise.race settles in workflow step execution
- **Workflow duration measurement**: Capture full workflow execution time, not just Conductor response time
- **Workflow validation**: Add `display_name` validation and NPE guard in topologicalSort
- **Code style**: Add braces to single-line control statements, use DebugLogger instead of console.log

## [0.9.0] - 2026-02-15

### Added

- **Codex MCP backend**: New `codex-mcp` backend using MCP protocol instead of CLI wrapper
  - Proper threadId-based session management
  - compact-prompt parameter for context compaction control
  - Token usage tracking from MCP response metadata
- **Session busy queue**: Messages wait when session is processing, with `onQueued` notification
- **CI/CD improvements**: Turborepo for package-scoped builds and tests
  - Path-filtered test jobs (only run affected package tests)
  - Husky pre-commit uses turbo for faster checks

### Changed

- **Backend simplification**: Reduced to 2 backends (`claude` | `codex-mcp`)
  - Removed legacy `codex` CLI wrapper
  - Mixed agent support (Claude + Codex MCP in same conversation)
- **Session pool token tracking**: Disabled 160K threshold reset for Codex MCP (handles own compaction)
- **Viewer settings**: Added effort level selector for Codex models
- **WebSocket safety**: All `ws.send()` calls now use `safeSend()` helper with readyState check

### Fixed

- **MCP server startup**: Fixed timeout issue by using simple sleep instead of stdout wait
  - MCP protocol requires client to send first request
  - Added proper cleanup on initialization failure
- **PreToolUse hook**: Fixed decision display using `exit(2)` + stderr (additionalContext not supported)
- **Plugin hook search**: Simplified buildSearchQuery to filename tokens only (reduced noise)

## [mama-core-1.1.4] - 2026-02-15

### Added

- **safeSend helper**: WebSocket send with readyState guard and try-catch for race conditions
- **onQueued callback**: MessageRouter process() now supports busy queue notification

## [plugin-1.7.13] - 2026-02-15

### Changed

- **PreToolUse hook**: Use exit(2) + stderr for decision context (additionalContext not supported)
- **Search query**: Simplified to filename tokens only for better embedding relevance

### Removed

- **POC files**: Removed haiku-agent-poc.js and mcp-direct-poc.js

## [0.8.6] - 2026-02-14

### Changed

- **Viewer TypeScript migration**: Converted all viewer modules (chat, dashboard, graph, memory, settings, skills) from JavaScript to TypeScript
- **Typed API client**: New fully-typed API module with proper error handling
- **Plugin hook redesign**: PreToolUse triggers on Read (decision context), PostToolUse shows lightweight reminder

### Added

- **Viewer utilities**: DebugLogger, DOM helpers, format helpers, markdown renderer with DOMPurify
- **Test utilities**: `@jungjaehoon/mama-core/test-utils` export for isolated test databases
- **Session state**: Hook session isolation via SESSION_DIR environment variable

### Fixed

- **URL encoding**: All API path parameters now use encodeURIComponent
- **Hook performance**: Simplified hook logic, removed pattern detection

## [0.8.4] - 2026-02-14

### Fixed

- **Configuration loading diagnostics**: On startup, `~/.mama/config.yaml` parsing now surfaces a clear
  hint when cron expressions like `*/10 * * * *` are provided without quotes, avoiding silent
  startup failure and reducing recovery time.
- **Standalone/core API compatibility hardening**: Added startup-time normalization around `mama-core`
  memory API adapters used by context injection and scheduled jobs to guard against export-shape drift.

## [0.8.3] - 2026-02-14

### Fixed

- **Security: Symlink escape prevention** in `graph-api.ts` persona_file validation
  - Now uses `fs.realpathSync` to resolve symlinks before path validation
- **Security: MAMA_TRUSTED_ENV guard** enforced consistently in `discord.ts` setMultiAgentConfig
- **PR Review Poller**:
  - Fixed immediate reminder firing after initial report (`lastUnresolvedReminderAt` timing)
  - Added hot-reload support via `configurePrPoller()` helper
  - `sendMessage` now throws Error instead of silent return when sender is missing
- **Array input validation** in `normalizeDiscordGuilds` to prevent numeric key coercion

### Changed

- **DebugLogger migration**: Replaced `console.log/warn/error` with DebugLogger in:
  - `discord.ts` (init/permission diagnostics)
  - `multi-bot-manager.ts` (all logging)
- **ESM import**: Replaced `require()` with ESM import for DebugLogger in `start.ts`
- **Code style**: Added braces to all single-line if statements per coding guidelines
- **Test performance**: Added `MAMA_FORCE_TIER_3=true` in orchestrator tests to skip embeddings

## [0.8.2] - 2026-02-13

### Changed

- **LLM backend strategy updated (cost-aware)**:
  - Standalone onboarding/init now supports backend-agnostic selection (`auto | claude | codex`).
  - Motivation includes rising premium model operating costs (including Opus 4.6 tiers), so runtime
    backend choice is now user/environment-driven instead of vendor-fixed defaults.
  - New users can start with whichever authenticated CLI is available and switch later without
    architecture changes.
- **Embedding server ownership clarified**:
  - Standalone (`@jungjaehoon/mama-os`) is now the default owner of HTTP embedding runtime.
  - MCP server no longer starts HTTP embedding by default; legacy opt-in via
    `MAMA_MCP_START_HTTP_EMBEDDING=true`.
- **Port model unified**:
  - API/UI: `3847`
  - Embedding/chat runtime: `3849`
  - `MAMA_EMBEDDING_PORT` is primary; `MAMA_HTTP_PORT` remains backward-compatible alias for
    embedding runtime paths.
- **Dependency ownership cleanup**:
  - Direct `@huggingface/transformers` dependency removed from `mcp-server`,
    `claude-code-plugin`, and `openclaw-plugin`.
  - Embedding warmup and checks now go through `@jungjaehoon/mama-core` exports.

### Fixed

- **MCP legacy embedding port parsing**:
  - Invalid embedding port env values no longer produce `NaN` runtime behavior in
    `packages/mcp-server/src/server.js`; fallback to `3849` is enforced.
- **Docs/runtime command drift**:
  - Mobile/security/troubleshooting docs now consistently use `mama start` for MAMA OS runtime
    workflows and align systemd/PM2 examples with current startup model.

### Documentation

- Updated architecture, performance, reference, tutorial, installation, and troubleshooting docs
  to match current runtime boundaries and port responsibilities.

## [mama-core-1.1.0] - 2026-02-13

### Changed

- **TypeScript Migration**: Complete rewrite of all 30+ JS files to TypeScript
  - All source files now `.ts` with strict type checking
  - Exported type definitions for downstream consumers
  - Proper interface definitions for all public APIs
  - `tsconfig.json` added with strict mode configuration
  - CommonJS compatibility maintained via named exports

### Added

- **Type Interfaces**: 50+ new type definitions
  - `DecisionRecord`, `CheckpointRow`, `PreparedStatement`
  - `DeprecateAutoLinksResult`, `ScanAutoLinksResult`, `DeleteAutoLinksResult`
  - `CreateLinkBackupResult`, `RestoreLinkBackupResult`, `VerifyBackupResult`
  - `SaveParams`, `SaveResult`, `SearchResult`, `RecallResult`, `UpdateResult`
  - `SuggestOptions`, `SuggestResult`, `QualityReport`, `QualityRecommendation`
- **Runtime Validation**: Type guards for LLM response parsing
  - `isDecisionAnalysisResult()`, `isQueryIntentResult()` validators
- **Safety Guards**:
  - Cycle detection in supersedes chain walks (prevents infinite loops)
  - Nullish coalescing (`??`) for values where `0` is valid
  - Depth limits (MAX_CHAIN_DEPTH=1000) for graph traversals

### Fixed

- **WebSocket Security**: Internal error details no longer exposed to clients
- **Interval Leak**: try/finally now properly wraps interval lifetime
- **Cron Race Condition**: Graceful handling when job removed during execution

### Technical Debt

- Removed duplicate `PreparedStatement` interfaces (consolidated to `db-adapter/statement.ts`)
- Removed duplicate `DecisionRecord` interfaces (consolidated to `db-manager.ts`)
- Async/await annotations retained for future-proofing (sync SQLite adapter today)

## [0.8.0] - 2026-02-12

### Added

- **Webchat Media Upload**: Image/PDF upload with drag & drop, preview thumbnails, and Claude Vision integration
  - Supported formats: JPEG, PNG, GIF, WebP, SVG, PDF (20MB max, auto-compress >5MB)
  - `/api/upload` and `/api/media/:filename` endpoints
  - WebSocket `attachments` protocol for real-time image processing
- **TTS (Text-to-Speech)**: Auto-read assistant responses with voice
  - Toggle via speaker icon, speed control 0.5x-2.0x (default 1.8x for Korean)
  - Markdown/emoji stripping for clean speech output
  - Hands-free mode: auto-start STT after TTS completes
- **STT (Speech-to-Text)**: Voice input with auto-silence detection (2.5s)
  - Continuous recognition for multiple sentences
  - Auto language detection (Korean/English)
- **Image Analysis**: Claude Vision API integration via `ImageAnalyzer`
  - Singleton client caching for performance
  - Prompt injection sanitization (`sanitizeUserPrompt`)
  - Path validation to prevent LFI attacks
- **Hybrid MCP+Gateway Mode**: Both MCP servers and gateway tools can run simultaneously
  - `--mcp-config` and `--strict-mcp-config` flags passed to Claude CLI
  - Gateway tools (browser, media, PR review) available alongside MCP tools
  - Enables rich ecosystem: external databases, APIs via MCP + MAMA-native tools
- **Cron Job Lock Timeout**: 10-minute default lock timeout prevents stuck jobs
- **Dashboard Reorganization**: Agent selection in floating chat, session improvements
- **BaseGateway Abstract Class**: Deduplicated common gateway logic (Discord, Slack, Telegram)
- **Graph API**: `/api/graph/decisions`, `/api/graph/checkpoints` endpoints for decision visualization
- **Browser Tools**: `browser_open`, `browser_screenshot`, `browser_click` in gateway-tools.md
- **Lightbox Viewer**: Click images in chat to view full-size with zoom/pan

### Changed

- **Session Reset Warning**: Now bilingual (English + Korean)
- **System Prompt Optimization**: Gateway tools embedded directly to prevent truncation
- **DebugLogger**: Consistent logging across all modules (no more console.log)
- **Multi-Agent Free Chat**: Only responds to explicitly mentioned agents

### Fixed

- **Double Image Analysis**: Discord gateway now always clears contentBlocks after analysis
- **Port Conflict**: Stale process cleanup on startup
- **Prompt Overflow**: Enforced system prompt truncation and auto-session reset
- **Safari Compatibility**: Removed lookbehind regex patterns for iOS support
- **ESM Import**: Fixed `matchAll` with proper import syntax

### Security

- **LFI Prevention**: Server ignores client `filePath`, reconstructs from `filename` only
- **Filename XSS**: Sanitization with `escapeHtml` and `escapeAttr` for attribute contexts
- **Prompt Injection**: `sanitizeFilenameForPrompt` and `sanitizeUserPrompt` guards
- **Path Traversal**: `allowedBase` validation on all file operations
- **MCP Args Masking**: Sensitive arguments redacted in logs
- **MAMA_TRUSTED_ENV**: Hard gate for dangerous operations

### Removed

- **Gemini Workflows**: Removed unused `.github/workflows/gemini-*.yml` and `.github/commands/gemini-*.toml`

## [0.7.1] - 2026-02-12

### Fixed

- **Config preservation**: Custom config sections (scheduling, etc.) no longer lost on restart
- **Cron job persistence**: Jobs created via Settings UI now saved to config.yaml and survive restarts
- **Cron job loading**: Config-defined scheduling.jobs now loaded into scheduler on startup
- **Setup auth error**: Local requests no longer require MAMA_AUTH_TOKEN for config updates
- **Zombie process cleanup**: `mama stop` now kills processes holding ports 3847/3849

## [0.7.0] - 2026-02-12

### Added

- **Skill System**: Unified skill registry with 3 sources (MAMA, Cowork, External GitHub repos)
  - Skills Marketplace UI in Viewer (browse, install, toggle, search)
  - Agent auto-detects installed skills by keyword matching in system prompt
  - `mama init` copies default skill templates to `~/.mama/skills/`
  - Path traversal protection (`validateSkillName`) on all skill endpoints
- **Cron Scheduler**: Dashboard + Settings UI for scheduled job management
  - Create/edit/delete/toggle cron jobs from Viewer
  - Agent knows cron API via `gateway-tools.md` documentation
- **Token Tracker**: Per-agent token usage tracking with cost breakdown
  - Dashboard cards (today/week/month) with agent breakdown bars
  - `/api/tokens/summary` and `/api/tokens/by-agent` endpoints
- **Floating Chat**: Draggable/resizable chat panel overlay on all Viewer tabs
- **Codex Backend**: OpenAI Codex CLI as alternative agent backend
- **PR Review Workflow**: Multi-agent autonomous PR review with LEAD delegation
  - `pr_review_threads` gateway tool for agent autonomy
  - Background task delegation (`DELEGATE_BG`) with workspace isolation
  - Auto-checkout PR branch, parallel delegation, busy retry
- **Gateway Tools**: `pr_review_threads`, `pr_review_reply` for PR interaction
- **Work Tracker**: Agent task tracking across multi-agent delegation chains
- **Ecosystem Support**: Anthropic Cowork plugins, MCP servers, GitHub repos all installable via agent or UI

### Changed

- `SkillRegistry` constructor no longer requires `builtinSkillsDir` parameter
- `dangerouslySkipPermissions` defaults to `false` in Discord gateway
- Agent system prompt now includes all installed skill directives
- `console.*` replaced with `DebugLogger` in viewer modules and multi-agent-base
- README rewritten: removed "vibe coding" section, added skill/cron/ecosystem showcase

### Fixed

- `isAuthenticated(req)` check added to `POST /api/restart` and `PUT /api/config`
- `JSON.parse` wrapped in try/catch for `gh` CLI output in gateway-tool-executor
- PR review poller: `L` prefix formatting when line number is null
- PR review poller: `resolvedCount` accuracy with filtered thread subsets
- Lone surrogate stripping before sending to Claude API
- Multi-agent: prevent hallucinated file paths in delegation
- Agent message queue: drain on enqueue, correct agent cwd
- Stop command: properly kill lingering daemon processes

### Security

- Path traversal validation on all skill name inputs
- Source validation on DELETE/PUT skill endpoints
- CSRF protection via `isAuthenticated` on state-changing endpoints
- `dangerouslySkipPermissions` default hardened to `false`

## [0.6.1] - 2026-02-10

### Fixed

- Gateway Read tool file size guard (200KB limit) preventing 10MB+ prompt overflow from large files (e.g. daemon.log)
- Gateway Read tool parameter flexibility: accept `path`, `file_path`, and `file` to prevent agent hallucination from failed tool calls
- Gateway tools system info: replaced incorrect `systemctl` commands with `mama status/stop/start`
- Added tool call rules to prevent agent fabrication when tools fail

## [0.6.0] - 2026-02-10

### Added

- ESLint TypeScript support with `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`
- TypeScript override in `.eslintrc.json` with `no-unused-vars`, `no-explicit-any` (warn), `no-require-imports` (warn)
- Typed Graph API (`graph-api.ts`) with `graph-api-types.ts` for all handler types
- `ContentBlock` interface for Claude stream protocol (`text`, `tool_use`, `tool_result`)
- `MultiAgentHandlerBase` abstract class extracting shared Discord/Slack infrastructure
- Authentication guard (`isAuthenticated`) on config-writing endpoints (`PUT /api/config`, `PUT /api/multi-agent/agents/:id`)
- Timing-safe token comparison (`crypto.timingSafeEqual`) to prevent side-channel attacks
- Input validation for agent config fields (tier, enabled, cooldown_ms, can_delegate)
- `safeParseJsonArray` for defensive JSON.parse on DB data

### Changed

- Lint scripts now include `.ts` files (`--ext .js,.mjs,.ts`)
- `lint-staged` unified to `*.{js,mjs,ts}` with eslint + prettier
- `format`/`format:check` scripts include `.ts` files
- `maskToken` standardized to `***[redacted]***` format with consistent `isMaskedToken` detection
- `dangerouslySkipPermissions` default changed from `true` to `false` in Discord gateway
- `body.confidence || 0.8` changed to `body.confidence ?? 0.8` (preserves zero)
- `body.outcome` uses `String()` instead of unsafe `as string` cast
- `start.ts` migrated `require('../../api/graph-api.js')` to ES import
- Redundant `require('fs'/'path'/'os'/'http')` calls removed across agent-loop.ts and start.ts
- `onboarding-state.ts` uses top-level `unlinkSync` import instead of inline `require`

### Fixed

- 70+ ESLint errors (no-unused-vars, prefer-const, no-useless-escape, no-empty, no-control-regex)
- 208 ESLint warnings (no-explicit-any, no-require-imports) suppressed with targeted disable comments
- Token masking mismatch: `isMaskedToken` regex now matches `maskToken` output format
- CORS headers centralized in `createGraphHandler` instead of per-route duplication
- `req.url` null guard before URL construction in graph handler
- Missing `afterEach` import in content-dedup.test.ts
- Missing `vi` import in yaml-frontmatter.test.ts
- Explicit `ChainState` return type on `MultiAgentHandlerBase.getChainState()`
- Pre-existing postinstall.test.js failure (empty config.json JSON.parse)

### Removed

- Outdated architecture docs (`docs/architecture-current-state-2026-02-08.md`, `docs/architecture-mama-swarm-2026-02-06.md`)
- Legacy `graph-api.js` (replaced by TypeScript `graph-api.ts`)

## [0.5.1] - 2026-02-09

### Fixed

- Plugin load error from agents entry in plugin.json

## [0.5.0] - 2026-02-08

### Added

- Multi-agent swarm system with 6-phase architecture
- Plugin hooks streamlining, OMC overlap removal

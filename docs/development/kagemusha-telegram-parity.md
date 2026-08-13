# Kagemusha → MAMA Telegram parity contract

This is the shared implementation and review artifact for Telegram owner-console parity. It is a
contract, not background reading: every related change and review finding must cite one or more
scenario IDs from this document.

## Baselines

- Reference: `mama-suite` commit `ea982c1`, `apps/kagemusha`
- Target: MAMA branch `codex/kagemusha-owner-workflow-parity`
- Reference inspected from source, not inferred from prompts or runtime descriptions.
- Never copy credentials, owner chat IDs, user names, or attachment contents into tests or docs.

## Comparison rules

1. Compare the complete user path, not isolated tool names or files.
2. Preserve Kagemusha's proven behavior unless MAMA intentionally strengthens safety or recovery.
3. An intentional difference must be recorded below with a test; silence is not a decision.
4. Internal helper tests are insufficient when the behavior depends on Telegram polling, session
   replacement, role projection, or an external-send boundary.
5. A scenario is complete only when its target test passes and the evidence path is updated here.
6. Preserve agent freedom: the host exposes safe, coherent primitives and durable context; the
   agent chooses the tool sequence. Do not replace Kagemusha's Code-Act composition with a
   hard-coded scenario workflow.

## Scenario matrix

| ID    | User-visible contract                                                                                                                                                                               | Kagemusha evidence                                                                                                                                                                                                                                                      | MAMA target evidence                                                                                                                                                                                                                                                                | Current gap / decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Required verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| TG-01 | Messages in one Telegram conversation are handled and presented in order, including long multi-part replies.                                                                                        | `channels/telegram/telegram-channel.ts`: `enqueueStream`, `handleStreaming`, `splitMessage`                                                                                                                                                                             | `gateways/telegram.ts`, `gateways/telegram-message-ledger.ts`, `gateways/telegram-response-presenter.ts`, `gateways/message-router.ts`, `operator/report-carry-delivery.ts`, `operator/pending-report-store.ts`, `operator/operator-trigger-loop.ts`                                | MAMA serializes the entire per-chat delivery boundary. Re-entrant sends from the active agent turn execute inline to avoid deadlock; external reports wait behind that turn. The production report assembly forwards the prepared delivery ID to one host-bound Telegram target. Pending requests and deliveries persist that target plus a payload identity, and recovery rejects configuration drift or mutated payloads before send or carry persistence. Telegram binds one delivery ID to the same chat and text: conflicting reuse is rejected, identical reuse stays idempotent. Existing confirmed/uncertain chunk semantics remain unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `telegram.test.ts`: exact external report behind an active same-chat turn, conflicting chat/text reuse, overlapping turns, failed chunk, 429, Unicode boundary. `operator-trigger-loop.test.ts`: scheduled/on-demand target-scoped production assembly and cross-boot target drift. `pending-report-store.test.ts`: target/payload validation and quarantine. `telegram-response-presenter.test.ts`: long response and Unicode boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | GREEN (2026-08-02)                                            |
| TG-02 | A received photo or document is downloaded, retained privately, and its real local path reaches the agent that can inspect it. A follow-up after backend session replacement can still refer to it. | `channels/telegram/telegram-channel.ts:170-255`; `runtime/monitoring-runtime.ts:305-310`                                                                                                                                                                                | `gateways/telegram-media.ts`, `gateways/telegram.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`                                                                                                                                                                     | MAMA retains host-verified media instructions separately from the truncated caption portion during bounded context restoration. Owner roles retain the private path; group roles receive neither an unavailable OCR instruction nor the path, and visible output redacts it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `message-router.test.ts`: retained path and long-caption fresh-session rebuild. `role-manager.test.ts` and `telegram-response-presenter.test.ts`: role/path boundaries. `telegram-media.test.ts`: retention/quota.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | GREEN                                                         |
| TG-03 | The owner agent can freely compose shared-Drive lookup/download, OCR/translation, output creation, same-folder upload, and Telegram return in one run.                                              | `tools/drive-tool-registry.ts`: Drive primitives; `tools/image-tool-registry.ts`: image primitives; `tools/conti-tool-registry.ts`: `drive_translate_conti` returns guidance rather than executing a fixed pipeline; all are registered together in `server.ts:105-114` | `agent/drive-tools.ts`, `agent/image-translation-tools.ts`, `agent/tool-registry.ts`, `agent/code-act/host-bridge.ts`, `agent/cline-cli-adapter.ts`, `agent/role-manager.ts`, `agent/code-act/constants.ts`, `templates/skills/image-translate.md`                                  | All primitives share the owner Code-Act surface. A verified `owner_console` may resolve and upload to the Drive folder explicitly selected for the active owner request, matching Kagemusha; configured-root capabilities remain available and validated when supplied. Non-owner Drive operations require role permission and configured connector/envelope scope and cannot select arbitrary roots. Uploads remain contained to private MAMA workspace files. Translation guidance permits agent-selected tools and forbids success claims after failed side effects. Repeated OCR text consumes distinct regions in source order. Cline receives the same outer Code-Act capability as a session-bound Hub custom tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `drive-tools.test.ts`; `image-translation-tools.test.ts`; `setup-ocr.test.ts`; `image-translate-skill-template.test.ts`; owner-selected and capability validation cases in `envelope/executor-integration.test.ts`; owner/non-owner projection in `gateway-tool-executor.test.ts`; composition and advertisement cases in `code-act/integration.test.ts`; Cline projection in `cline-cli-adapter.test.ts` and `agent-loop.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | GREEN (2026-08-02)                                            |
| TG-04 | Tool availability is determined by the active role but the owner gets the full proven tool chain without switching execution surfaces.                                                              | Kagemusha registers channel/task/Trello/memory/image/Drive/schedule/conti functions into one `CodeActSandbox` in `server.ts:105-114`.                                                                                                                                   | `agent/code-act/tool-policy.ts`, `agent/code-act/host-bridge.ts`, `agent/cline-cli-adapter.ts`, `agent/agent-loop.ts`, `agent/role-manager.ts`, `agent/tool-registry.ts`                                                                                                            | MAMA projects one canonical HostBridge registry through role and tier narrowing. Every default owner inner tool is registered and projected, including the complete Drive composition surface even when no static Drive destination is configured. Wildcard group roles cannot gain the owner's cross-root Drive selection or private media instructions; scoped Drive access remains role-bound. Cline keeps only role- or managed-policy-permitted native tools and receives the narrowed MAMA outer bridge in the same Hub session; the owner role is not a native wildcard bypass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `code-act/tool-policy.test.ts`; Code-Act owner/group runtime calls in `gateway-tool-executor.test.ts`; prompt/registry coherence in `code-act/integration.test.ts` and `gateways/tool-ad-coherence.test.ts`; Hub projection in `cline-cli-adapter.test.ts` and `agent-loop.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | GREEN (2026-08-02)                                            |
| TG-05 | A continued model session does not receive the full system/context prompt again. When the backend session changes or is lost, only bounded recent context is restored.                              | `agent/agent-loop.ts:357-398`: `retainsContext`, session-change detection, bounded previous-turn restoration                                                                                                                                                            | `agent/codex-app-server-process.ts`, `agent/cline-cli-adapter.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`, `agent/agent-loop.ts`, `connectors/private-connector-policy.ts`, `connectors/private-prompt-overlay.ts`                                               | Same-policy continuation sends only the new user message. Codex threads and Cline Hub sessions both retain live model context. A private-policy fingerprint change rejects the stale durable session, rebuilds the full current policy exactly once, then resumes minimally; a missing Cline Hub session takes the same bounded rebuild path. Kagemusha remains a configured user-private connector: fresh, disabled, generic, and legacy-unbound surfaces do not receive its catalog, and unknown-tool errors do not enumerate it. Disabled prompt projection removes actual private directives and calls, including safely matched nested Markdown wrappers, while preserving historical prose and the user-owned brief bytes. Delivered owner reports become durable SQLite context events (telegram-report-context-store); a verified owner turn consumes a bounded deterministic Projection V1 snapshot exactly once, and the final turn, its receipt, and the consumption marks commit in ONE transaction (SessionStore.finalizeTurnWithReportReceipt). An actual backend replacement restores committed projections from receipts (provisional turns never restore); successful resume does not replay them. No nested Codex CLI is used.                                   | `agent-loop.test.ts`, `codex-app-server-process.test.ts`, and `cline-cli-adapter.test.ts`: durable continuation, policy replacement, missing-session rebuild, then minimal continuation. `message-router.test.ts`: current-policy rebuild and one-shot target-scoped carry. `message-router-report-inbox.test.ts`, `session-store-report-receipt.test.ts`, `owner-report-inbox.test.ts`, `report-projection-v1.test.ts`: snapshot-once consumption, atomic turn/receipt finalize, replacement-restore vs resume, bounded deterministic projection vectors. `private-connector-policy.test.ts`, `tool-ad-coherence.test.ts`, `gateway-tool-executor.test.ts`: fail-closed private discovery/execution. `private-prompt-projection.test.ts`: shared console/workorder invocation and historical-prose matrix.                                                                                                                                                             | GREEN (2026-08-06; operational Telegram verification pending) |
| TG-06 | Full-report requests and scheduled reports use the same owner tool capabilities and are visibly delivered. A failure cannot be reported as success or leave a durable response stranded.            | Owner-only full-report routing in `runtime/monitoring-runtime.ts:289-310`; report tool workflow in `runtime/report-prompts.ts`; Telegram send path in `channels/telegram/telegram-channel.ts:395-400`                                                                   | `operator/operator-trigger-loop.ts`, `operator/situation-report.ts`, `operator/pending-report-store.ts`, `operator/report-carry.ts`, `operator/task-ledger.ts`, `operator/workorder-consumer.ts`, `cli/commands/start.ts`, `cli/runtime/api-routes-init.ts`, `gateways/telegram.ts` | MAMA persists the exact report text, provenance, occurrence, delivery ID, Telegram target, and payload identity before sending. Startup replays the same prepared artifact rather than regenerating it; target/payload conflict is quarantined or rejected, and scheduler success advances only after delivery. Digest, scheduled full, and on-demand full deliver through ONE ReportDeliveryPort coordinator: durable SQLite reservation before any Telegram send, a pinned confirmed-send ledger proof that cannot expire while the row is nonterminal, CAS attempt leases so exactly one executor ever sends, typed retry/rejection/cancellation outcomes, and scheduler success plus trigger credit only on `delivered`. The legacy V2 carry file migrates one-time into the store (exact prefix bytes preserved). Structured private-connector lifecycle events produce host-built candidates; task/binding mutation and its receipt commit atomically, generic mutation paths cannot bypass candidate authority, and partial or ambiguous receipt states do not replay automatically. These receipts prove internal task-effect arbitration, not Telegram API recovery. The shared scheduled/on-demand output proves delivery/carry assembly, not identical Code-Act grants. | `operator-trigger-loop.test.ts`, `pending-report-store.test.ts`, `situation-report.test.ts`, `report-carry.test.ts`, and `message-router.test.ts`: exact prepared report, target/payload/provenance binding, restart, and one-shot carry. `telegram.test.ts`: delivery-ID target/text binding plus rejection/ambiguity, ledger pinning, and the report delivery control port. `report-delivery-coordinator.test.ts`, `telegram-report-context-store*.test.ts`, `operator-trigger-loop-report-delivery.test.ts`: reservation/lease/terminal protocol, V2 migration, capacity backpressure, delivered-only credit. `report-delivery-wiring.test.ts`: structural sole-executor and production-assembly pins. `external-lifecycle-reconcile.test.ts`, `external-lifecycle-workorder-recovery.test.ts`, `api-routes-init-reconcile.test.ts`, and `gateway-tool-executor.test.ts`: atomic receipts, private-scope production wiring, mutation guards, and no-replay recovery. | GREEN (2026-08-06; operational Telegram verification pending) |

### Sender-boundary completion evidence: 2026-08-13

| ID    | Evidence update                                                                                                                                                                                                                        | Verification                                                                                                                                                                                   | Status                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| TG-01 | Owner and public Telegram traffic use distinct durable lane keys (`channel` and `channel#public`). Each lane preserves its own arrival order, and a blocked public turn does not take ownership of the owner's lane.                   | `sender-boundary-matrix.test.ts`: `TG-01 preserves per-lane order and isolates owner and public Telegram session keys`.                                                                        | GREEN (2026-08-13)         |
| TG-04 | A mentioned Telegram group non-owner is classified external and admitted only to `public_lane`: fixed public policy, no tools, no memory/context injection, no attachment download in the conversation-only case, and same-chat reply. | `sender-boundary-matrix.test.ts`: `covers 'telegram'/'group'/'external' without crossing the sender boundary`; the complete parameterized matrix covers all 18 connector/surface/sender cells. | GREEN (intentional change) |
| TG-05 | Backend replacement for the public lane rebuilds from the fixed public policy plus bounded public history only. Owner turns and external history metadata are excluded, and resumed public turns do not invoke memory retrieval.       | `sender-boundary-matrix.test.ts`: `TG-05 replaces a public session with only bounded public history` and `excludes a diverted Discord sender from the next owner prompt history`.              | GREEN (2026-08-13)         |

### Final review closure

The final coverage, security, and temporal reviewers read this artifact first. Their findings
refined the green contracts above as follows:

- **TG-01:** only an explicit active-turn Telegram tool send may re-enter a chat queue. Detached
  reports always queue, even if they inherited an old async context. Inbound long replies persist
  uncertain and confirmed chunk indexes; recovery revalidates `processing`, `ready`, and
  `delivered` after acquiring the queue and resumes at the first unconfirmed chunk.
- **TG-02:** a configured workspace replaces the logical default workspace capability instead of
  widening it. Only a host-verified owner DM receives local attachment paths. Group documents do
  not expose a path even when the group role includes `Read`. Archive-controlled Office names and
  extractor stderr never enter model-visible errors.
- **TG-03:** Drive download, OCR, output, upload, and browser capture share one canonical workspace.
  OCR is returned as provenance-carrying structured data, so `ocr_image(...).regions` composes
  directly into `translate_conti` on the real Code-Act path.
- **TG-06:** an accepted on-demand occurrence and UUID are persisted before composition starts,
  then transitioned to the exact prepared delivery. Startup resumes either phase. An older pending
  delivery returns `busy` for a new request instead of silently substituting it. Ledger capacity
  evicts delivered tombstones only and refuses a new response rather than dropping undelivered work.

Corrective verification is in `telegram.test.ts`, `telegram-message-ledger.test.ts`,
`telegram-response-presenter.test.ts`, `operator-trigger-loop.test.ts`,
`pending-report-store.test.ts`, `message-router.test.ts`, `role-manager.test.ts`,
`attachment-text-extractor.test.ts`, and `gateway-tool-executor.test.ts`.

### Trigger-loop token-cost closure: 2026-08-03

- **TG-05:** trigger authoring consumes each successful event window once. Provider or parse
  failures persist a process-independent 6-to-24-hour exponential backoff, so maintenance ticks,
  connector nudges, new events, and daemon restarts cannot resend a poison window continuously.
  Author input keeps the newest bounded evidence, caps every new trigger field and collection,
  and invokes an explicit configured model in a tool-free, non-persistent JSON session.
- **TG-06:** review advances a durable per-trigger fire watermark only after applying a decision,
  backs off failed candidates without starving later rows, and reviews one candidate per default
  maintenance pass. Prompt construction bounds both legacy trigger fields and the newest context
  through the final provider boundary. Agent retire/refine writes require an active source row, so
  a late decision cannot overwrite an owner veto; refine replacement remains transactional.
  Daemon shutdown concurrently drains the active loop tick and aborts author/reviewer provider
  calls; abort completion cannot start a later review/report leg or create a false provider
  backoff.
- Evidence: `operator-trigger-loop.test.ts`, `trigger-author.test.ts`,
  `trigger-registry.test.ts`, `trigger-review.test.ts`, and `trigger-runtime-wiring.test.ts` cover
  unchanged-window consumption, failure/restart backoff, newest-context preservation through the
  final prompt, fixed prompt ceilings, one-pass catch-up after five missed intervals, review
  isolation, migration locking, owner-state races, refine rollback, provider abort/drain, and
  shutdown wiring. The focused gate passed 134 tests; the complete standalone gate passed 344
  files and 4,600 tests with four files and seven tests skipped.

### Principal-following Code-Act correction: 2026-07-31

- **TG-03/TG-04:** every persistent Claude process generation owns a random 32-byte context key.
  The host registers the exact prompt-attempt principal under that key, the MCP child passes only
  the inherited key to the local HTTP boundary, and the keyed executor reacquires the trusted
  context instead of rebuilding identity from request fields. Closing a prompt lease blocks new
  acquisitions while already-pinned executions drain under the attempt abort signal. Evidence:
  `agent/code-act/run-context-registry.ts`, `agent/persistent-cli-adapter.ts`,
  `cli/runtime/code-act-executor.ts`, `mcp/code-act-server.ts`,
  `run-context-registry.test.ts`, `persistent-cli-adapter-context.test.ts`,
  `code-act-executor.test.ts`, and `temporal-work-context.test.ts`. **Status: GREEN.**
- **TG-05:** same-process continuation remains unchanged. Abnormal prompt cleanup retires only the
  exact acquired process generation; even when an error listener has already removed the pool
  entry, that generation is stopped without touching a replacement. Evidence:
  `agent/persistent-cli-process.ts`, `persistent-process-pool.test.ts`, and the existing
  `message-router.test.ts`, `session-store.test.ts`, and `channel-history-persistence.test.ts`
  continuation matrix. **Status: GREEN.**
- **TG-03/TG-06:** completed Claude MCP exchanges are paired by tool-use ID and recorded in history
  without host replay. Identical pending duplicates are idempotent; result-before-use, conflicting
  duplicates, and completed-ID reuse fail the prompt and retire its process. A missing MCP result
  is `MCP_RESULT_MISSING`, non-retryable, and creates no replacement workorder because the mutation
  outcome is unknown. If the stream ends after a paired successful mutation but before its final
  result event, `MCP_COMPLETED_MUTATION_INTERRUPTED` carries the completed exchange into history and
  likewise blocks replacement. A paired terminal result carries the same exchange through
  close/error, and completed mutation/terminal evidence takes precedence over any later protocol
  violation or missing result so neither history nor no-retry policy is lost. A protocol violation
  while a Code-Act call is still unresolved is likewise promoted to `MCP_RESULT_MISSING` before the
  workorder layer can retry it. Oversized Code-Act results are structurally compacted so terminal
  metadata and the host audit remain valid JSON.
  Evidence: `agent/persistent-cli-process.ts`,
  `agent/code-act/completed-terminal-result.ts`, `agent/agent-loop.ts`,
  `operator/workorder-consumer.ts`, `persistent-cli-process-stream.test.ts`, `agent-loop.test.ts`,
  and `workorder-consumer.test.ts`. **Status: GREEN.**
- **TG-06:** the Code-Act HTTP/MCP result is a versioned `mama.code_act.result` envelope whose
  host-authored `hostToolExecutions` ledger records returned failures, thrown denials, and aborts.
  Terminal MCP conversion retains successful nested executions recorded before the terminal failure,
  so paired history and report audit do not lose already-observed evidence.
  Report audit reads only that top-level ledger and counts successful executions, never nested
  sandbox values, logs, messages, or legacy `[tools]` prose. Only bare host `code_act` and the exact
  `mcp__code-act__code_act` transport may supply this evidence; similarly named tools from other MCP
  servers are not trusted. Evidence: `agent/code-act/host-bridge.ts`,
  `agent/gateway-tool-executor.ts`, `mcp/code-act-terminal-transport.ts`, `operator/report-run.ts`,
  `host-bridge.test.ts`, `code-act-server.test.ts`, and `report-run.test.ts`. **Status: GREEN.**

### Cline backend compatibility: 2026-08-02

- **TG-03/TG-04:** the Cline backend uses the installed CLI's official `@cline/core` Hub runtime.
  Native file, search, shell, edit, web, skill, agent, and configured MCP tools are fail-closed and
  remain available only when projected by the active role or managed-agent native permission
  policy. Blocked permissions take precedence, and delegation still requires Tier 1 plus
  `can_delegate: true`.
  MAMA projects `mcp__code-act__code_act` as a session-bound Hub custom tool; its callback reaches
  the exact active prompt's HostBridge, so memory, connector, report, wiki, and other gateway
  functions keep their existing role/envelope checks without relying on child-only MCP state.
  Default roles added while loading an older config inherit the active backend's `agent.model`; an
  explicitly persisted role model still wins. This prevents a verified owner turn from silently
  reverting to the shipped Claude model while the active backend is Cline. Completed tool
  exchanges remain paired and are not replayed by the host. Evidence:
  `agent/cline-cli-adapter.ts`, `agent/agent-loop.ts`,
  `multi-agent/agent-process-manager.ts`, `cli/config/config-manager.ts`,
  `cline-cli-adapter.test.ts`, `agent-loop.test.ts`, `config-manager.test.ts`, and
  `agent-process-manager-env.test.ts`. **Status: GREEN.**
- **TG-06:** deadline, owner-cancel, Hub-transport, and daemon-shutdown interruption paths abort the
  exact active prompt, wait a bounded interval for already-started Code-Act mutation settlement,
  and preserve committed/unknown outcomes as structural non-retryable evidence. Timed-out sessions
  are quarantined before reuse, late Hub runtimes are disposed, and raw provider exceptions are
  sanitized before logging. Evidence: `agent/cline-cli-adapter.ts` and the queue, settlement,
  shutdown, late-runtime, and provider-redaction cases in `cline-cli-adapter.test.ts`. **Status:
  GREEN.**
- **TG-05:** a live Cline route keeps one Hub session and sends later turns with
  `resumeSession: true`, without resending full startup context. If the mapped Hub session is lost,
  the adapter opens a replacement and lazily rebuilds the current policy plus bounded persisted
  conversation exactly once. Evidence: `agent/cline-cli-adapter.ts`, `gateways/message-router.ts`,
  the Cline TG-05 cases in `cline-cli-adapter.test.ts` and `message-router.test.ts`, and an installed
  Cline 3.0.49 two-turn live probe on 2026-08-02. **Status: GREEN.**
- **TG-03/TG-04/TG-06:** auxiliary execution paths follow the configured backend. The setup
  wizard, scheduled jobs, and conversation extraction create isolated Cline Hub runners; a
  non-Claude daemon does not start the Claude token keepalive. Telegram/Discord/Slack image blocks
  stay on the private media path for Cline native `read_files` inspection instead of invoking the
  Anthropic vision client. Evidence: `agent/backend-model-runner-factory.ts`,
  `setup/setup-websocket.ts`, `cli/commands/setup.ts`, `scheduler/cron-worker.ts`,
  `cli/runtime/mama-core-init.ts`, `cli/runtime/scheduler-init.ts`, `gateways/message-router.ts`,
  and the backend factory, setup, scheduler, extraction, and image-routing regression tests.
  **Status: GREEN.**
- **TG-03/TG-04:** setup uses one backend-neutral host-action protocol instead of granting native
  mutation tools. Exact localhost Origin, one-time nonce, single-client admission, serialized
  turns, atomic configuration writes, and fail-closed legacy pseudo-actions bind every success
  claim to a real host result. Discord, Slack, and Telegram credentials are verified with their
  official APIs before persistence. Evidence: `setup/setup-actions.ts`, `setup/setup-prompt.ts`,
  `setup/setup-websocket.ts`, `setup/setup-server.ts`, `setup-actions.test.ts`, and
  `setup-shutdown.test.ts`. **Status: GREEN.**
- Kagemusha remains a user-private connector. Adding Cline as a backend does not add Kagemusha to
  generic catalogs, prompts, or managed-agent role projections.

### Durable-runtime usage and Cline tool-pairing correction: 2026-08-02

- **TG-05:** the first tool-heavy owner turn proved that run usage is not an authoritative current
  context-occupancy signal: Cline sums usage across internal model iterations, while Claude Code
  and Codex app-server already own model-aware compaction for their durable sessions. MAMA no
  longer applies its legacy 160K/200K rotation or PreCompact threshold to any of the three
  backends. This preserves the active runtime's real window, including 1M-class Claude and Codex
  models and the installed DeepSeek V4 Flash 1,048,576-token definition, without assuming every
  selectable model has the same limit. Billing and operational usage remain recorded through the
  separate AgentLoop telemetry path. Evidence: `agent/session-pool.ts` and the Claude/Codex/Cline
  matrix in `session-pool-invalidation.test.ts`. **Status: GREEN.**
- **TG-03/TG-04:** production Cline can omit `toolCallId` from the custom-tool execution context
  while publishing the provider call ID in the preceding Hub event. The adapter now claims that
  pending streamed ID before host execution, so one real Code-Act call produces one completed
  exchange and one reasoning-header entry instead of paired UUID/provider duplicates. Evidence:
  `agent/cline-cli-adapter.ts` and `cline-cli-adapter.test.ts`. **Status: GREEN.**

### Owner-state isolation closure: 2026-08-02

- **TG-01:** commit `d035ac21` bound every pending report request/delivery to its canonical
  Telegram target and payload identity, carried that binding through the production output/carry
  assembly, and made conflicting delivery-ID reuse across chats or text fail loudly. The TG/report
  reviewer returned clear after the target-drift and delivery-ledger regressions passed.
- **TG-05:** commits `281d9061`, `c37243ad`, `eaeddf47`, `963b1baa`, and `b8a533ae` closed private
  catalog disclosure and prompt-only recipe leakage without turning Kagemusha into a generic
  connector. Policy enable/disable changes rotate the durable-session fingerprint and rebuild the
  current policy once; unchanged replacement turns continue minimally. Historical prose and the
  user-owned brief remain intact. The final privacy reviewer returned clear.
- **TG-06:** commits `9fff93ab` and `d035ac21` closed generic mutation bypasses, bound report
  target/payload identity across restart, and made candidate receipts authoritative for internal
  binding/lifecycle effects and no-replay recovery. This receipt evidence does not assert Telegram
  API recovery, and the common scheduled/on-demand output path does not establish identical
  Code-Act grants. The lifecycle and TG/report reviewers returned clear.
- **Whole-branch review follow-up (TG-06):** commit `65fe9ef2` made the exact production
  Kagemusha task metadata shape compatible with fail-closed lifecycle reconciliation; `9dc62450`
  bound every prepared delivery field into the delivery-v2 semantic identity; and `2790e402`
  restricted persisted scheduled/on-demand occurrences to their exact documented keys. Their
  focused gates passed 84, 131, and 83 tests, respectively. The latest commit hook passed 331
  standalone files and 4,413 tests, with four files and seven tests skipped, and the fresh
  whole-branch reviewer returned clear. This is focused/full standalone follow-up evidence, not a
  new root matrix. Kagemusha remains a configured user-private connector.
- **Final compatibility and boundary follow-up (TG-01/TG-05/TG-06):** raw connector scope is now
  projected at every signed-envelope issuance boundary, so generic Code-Act, wiki, and legacy
  unbound surfaces cannot inherit Kagemusha while the configured owner console and operator
  surfaces retain it. Telegram delivery-ledger V2 outbound records without a target binding are
  retired into non-replayable V3 tombstones before a fresh target-bound claim. Both historical
  unscoped report-carry shapes are quarantined before accepting a target-bound V2 carry. Database
  migration 063 detects authoritative updates from pre-sequence writers and allocates fresh
  observation/ingest ordinals; partial 062/063 recovery preserves the largest existing cursor.
  Lifecycle reconciliation normalizes the production 32-byte BLOB content hash instead of
  rejecting real connector rows. Ledger read or schema-upgrade I/O failures preserve the original
  file and fail startup closed rather than quarantining valid delivery state. The privacy,
  migration, API-contract, and final whole-branch red-team reviewers returned clear after the
  compatibility regressions passed.
- **Current-worktree verification:** at `b8a533ae`, the 31-file state-isolation matrix passed 895
  tests and four later-added test files passed 45 more. The full standalone suite included every
  file from the Task 2 production-boundary gate and passed 331 files and 4,388 tests, with four
  files and seven tests skipped. Root lint, typecheck, build, standalone build, generated-catalog
  diff, and `git diff --check` passed. The first root test run saw one transient Codex initialize
  timeout; its focused file passed 96 tests and one fresh root rerun passed all seven Turbo tasks
  without a code change.
- **Formatting disclosure:** root `pnpm format:check` remains exit 1 because of 30 pre-existing,
  branch-unrelated files. A separate Prettier check over every branch-touched supported source,
  test, and documentation file passed. This is recorded debt, not an all-green root-format claim.

## Intentional differences from Kagemusha

| Area               | Decision                                                                                                                                                                                                                                                                     | Reason                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat scope         | MAMA supports configured private owner chats as well as role-restricted groups; Kagemusha's current channel ignores DMs.                                                                                                                                                     | MAMA is an owner console, so copying the group-only restriction would remove required behavior.                                            |
| Filesystem         | MAMA uses a configurable private workspace and media retention/quota policy.                                                                                                                                                                                                 | Avoid host-wide file access and unbounded attachment growth.                                                                               |
| Delivery recovery  | MAMA may persist pending work and delivery progress.                                                                                                                                                                                                                         | Daemon crash and app-server reset are observed production failures. This is a safety extension, not permission to change visible behavior. |
| Telegram ambiguity | MAMA retries an outbound chunk when Telegram acceptance cannot be proven, and logs the duplicate risk.                                                                                                                                                                       | Telegram offers no transactional exactly-once boundary across a daemon crash; at-least-once avoids a silently missing owner report.        |
| Backend            | MAMA uses Codex app-server directly and Cline's official Hub runtime through the companion `@cline/core` shipped with the configured CLI; it never launches nested Codex CLI. Live Cline routes retain one Hub session, while missing sessions use one bounded MAMA rebuild. | Prevent recursion and uncontrolled context while preserving native backend continuity.                                                     |

## Failure archaeology: 2026-07-22 Drive translation turn

The failed owner turn was not evidence that translation knowledge or a prebuilt workflow was
missing. The session proves that the agent itself composed Drive discovery, folder resolution,
listing, download, visual reading, attempted file creation, upload, and follow-up delivery.
Freedom was cut at three host boundaries:

1. The matched legacy image-translation skill injected `도구 사용 금지` and assumed the image was
   already attached, even though the request pointed to Drive and required upload side effects.
2. The generated Code-Act prompt told the model to substitute `Bash`/`Write`, but neither function
   was in the run's projected allowlist. Both calls failed as undefined.
3. The upload enforcer compared the resolved child folder directly with configured Drive roots, so
   a valid descendant was rejected as `destination_out_of_scope`. The subsequent turn also failed
   to re-check the inner allowlist and incorrectly generalized that no Telegram file tool existed.

The correction preserves autonomy: coherent primitives are projected together, configured-root
authority can use an envelope-bound short-lived capability, and the verified owner can select an
explicit Drive destination as Kagemusha does. Non-owner Drive operations remain limited by role
permission and configured connector/envelope scope. Skill text no longer bans tools needed for
requested side effects, and prompt guidance states a general composition/outcome contract rather
than a scenario-specific pipeline.

The post-v0.27.2 owner retry exposed a remaining policy mismatch: the requested `[GOGO]IZANAMI`
shared drive was not one of MAMA's static connector deliverable roots, so no valid capability could
be issued and `drive_upload` failed despite a correct folder selection. v0.27.3 makes verified
owner selection authoritative while retaining configured-root capability checks when a capability
is supplied.

## Runtime verification correction: 2026-07-22 post-v0.27.0

The first real owner Telegram turn after the v0.27.0 restart exposed four gaps that contract-only
verification had not proved:

1. The new daemon tried to resume a durable Codex thread before checking its stored policy
   fingerprint. A release policy change therefore produced one avoidable policy-mismatch error
   before the recovery path opened a current-policy thread.
2. An operator wiki Code-Act run overlapped the owner turn. Two runtimes created from the shared
   async QuickJS WASM module then disposed concurrently, reproducing `QuickJSUseAfterFree` with only
   two delayed host calls.
3. The native repeat guard counted only the outer tool name. Fifteen different Code-Act programs
   therefore looked like fifteen identical calls and failed healthy wiki and memory-curation work.
4. A supervised restart stopped the agent before the workorder consumer. The still-running drain
   then claimed queued rows and failed them with `Agent loop is stopping` instead of preserving
   pending work for the replacement daemon.

The v0.27.1 correction checks durable policy compatibility and presence before the first model
request, gives every QuickJS execution an isolated async module, and keys Code-Act repetition by
the normalized program while retaining the total native-call ceiling. A stalled host call cannot
own a process-global QuickJS queue or an unbounded live module: the same wall-clock budget covers
host calls, abort-aware nested tools receive its signal, browser waits are clamped to the remaining
time, and at most eight execution modules are live process-wide. Regression evidence is in
`agent-loop.test.ts`, `codex-app-server-process.test.ts`, `code-act/sandbox.test.ts`, and
`code-act/host-bridge.test.ts`.

Parent-turn cancellation is part of the same execution signal and removes a queued sandbox before
it creates a module. Read-only calls may release their module at the deadline. A side-effecting host
call instead retains its slot until the underlying promise settles or the finite settlement grace
expires. Concurrent sibling mutations are drained as one execution before its QuickJS context or
slot is released. A late commit is marked committed-after-abort; a call still unresolved at the
grace boundary is marked outcome-unknown. Both are structural, non-retryable turn failures across
native, app-server, HTTP, and MCP transports, and the workorder consumer will not create a
replacement attempt. MCP calls serialize around a terminal latch, and its request timeout exceeds
the sandbox deadline plus settlement grace. After a mutation request is transmitted, disconnects,
timeouts, HTTP 5xx responses, and malformed 200 responses become outcome-unknown before the MCP
queue is released. Drive downloads receive the abort signal and remove late artifacts. Browser
screenshots write an operation-owned temporary file, publish exclusively with collision-free
names, and reject existing filenames, directory components, and nested symlink escape paths.

The correction review also requires a replacement SessionPool entry to remain provisional until
its first fresh Codex request succeeds. A rebuild or first-request failure invalidates that exact
entry. Coverage, security, and temporal reviewers closed every P0-P3 finding; expression-only
Code-Act variants remain bounded by the outer run ceiling and must pass the same role, disallowed
tool, and envelope checks on every nested host call.

## Runtime verification correction: 2026-07-22 multi-image owner turn

A real owner turn downloaded four Drive images and composed OCR calls in one Code-Act program. The
first OCR calls completed in roughly 18-22 seconds each, but MAMA's 30-second whole-program deadline
aborted the next `translate_conti` call. Because that tool may create an output artifact, the
existing settlement guard correctly returned `CODE_ACT_MUTATION_OUTCOME_UNKNOWN` after its finite
grace instead of retrying an uncertain operation. The Telegram turn therefore failed even though
the same composition fits Kagemusha's 300-second Code-Act budget.

The parity correction sets MAMA's default Code-Act budget to the reference 300 seconds. It does not
split the agent-selected program or introduce a scenario workflow. The memory cap, 50 host-call
ceiling, eight-execution process cap, parent cancellation, abort propagation, and five-second
mutation-settlement boundary remain unchanged. `code-act/sandbox.test.ts` pins the reference budget,
and the MCP request timeout continues to derive from the sandbox deadline plus settlement grace.

The workorder consumer now raises its stopping barrier before awaiting the active tick. It leaves
the active claim for the existing boot-recovery transaction and never claims another pending row
after shutdown starts. This is verified independently of model behavior in
`workorder-consumer.test.ts`.

Final runtime evidence on 2026-07-22 used the rebuilt v0.27.1 daemon. `wiki#329` completed in
83 seconds after five distinct Code-Act programs, with no repeat-guard, policy, or QuickJS error.
A supervised restart then interrupted only the active `board#331` claim, logged it for boot
recovery, and preserved already-pending workorders `#332` and `#333`; no pending row failed with
`Agent loop is stopping`. The replacement daemon was a single PID with Telegram connected and a
98/100 health score.

## Review finding format

Every finding must use this compact form:

```text
[TG-0N] severity — violated user-visible contract
Evidence: reference path/symbol → target path/symbol
Reproduction: bounded scenario
Required result: exact visible or persisted outcome
```

Findings that do not map to this contract are handled separately and must not expand this parity
change unless they are release-blocking security or data-loss issues.

## Completion gate

- [x] TG-01 ordered delivery test passes.
- [x] TG-02 attachment and post-reset follow-up test passes.
- [x] TG-03 Drive/image primitive composition and same-folder upload tests pass.
- [x] TG-04 role/tool projection matrix passes.
- [x] TG-05 same-session and reset prompt-cost tests pass.
- [x] TG-06 report/outbox restart matrix passes.
- [x] Focused TG-03 freedom-contract tests pass after the correction (2 files, 13 tests).
- [x] Final corrective standalone test (4,090 passed, 7 skipped), typecheck, build, lint, format, and
      `git diff --check` pass.
- [x] Final reviewers read this artifact first, reported by scenario ID, and every finding was
      closed with a regression test listed in the review-closure section.
- [x] S3 principal-following review closed the orphan-process finding with a RED→GREEN pool
      lifecycle regression; full standalone tests, typecheck, build, lint, changed-file format,
      and `git diff --check` pass.
- [x] Final S3 closure review passed 7 focused files (234 tests), and all three independent
      reviewers reported no remaining TG-03/TG-04/TG-05/TG-06 findings.
- [x] The 2026-08-02 state-isolation gate passed 31 focused files (895 tests); four later-added
      files passed 45 tests. The full standalone gate below included every Task 2
      TG-01/TG-05/TG-06 production-boundary file.
- [x] The 2026-08-02 full standalone gate passed 331 files and 4,388 tests (4 files / 7 tests
      skipped). Root test re-verification passed all 7 Turbo tasks after one diagnosed transient
      Codex initialize timeout; root and standalone builds, lint, typecheck, catalog diff, and
      `git diff --check` passed.
- [x] The 2026-08-02 lifecycle, TG/report, and privacy reviewers returned clear after `9fff93ab`,
      `d035ac21`, and `b8a533ae`, respectively.
- [x] The 2026-08-02 whole-branch TG-06 follow-up closed production Kagemusha metadata
      compatibility (`65fe9ef2`), delivery-v2 full semantic identity (`9dc62450`), and exact
      occurrence keys (`2790e402`). Focused gates passed 84, 131, and 83 tests; the latest full
      standalone hook passed 4,413 tests with seven skipped, and the fresh reviewer returned
      clear. No new root matrix is claimed by this follow-up.
- [x] The final TG-01/TG-05/TG-06 compatibility gate passed the full standalone suite (331 files,
      4,437 tests; 4 files / 7 tests skipped), covering envelope-surface projection, ledger V3
      outbound binding migration, both legacy report-carry shapes, and mixed-version connector
      event writers. Production BLOB evidence and fail-closed ledger migration I/O are included.
      Privacy, migration, API-contract, and final whole-branch reviewers returned clear.
- [x] Branch-touched Prettier verification passes. Root `pnpm format:check` remains exit 1 on 30
      pre-existing branch-unrelated files and is explicitly retained as repository format debt.
- [x] The final Cline release gate passed the complete standalone suite (344 files, 4,569 tests;
      4 files / 7 tests skipped) and all 7 root Turbo test tasks. Root build, typecheck, ESLint,
      changed-file Prettier, version synchronization, and `git diff --check` passed. Independent
      red-team review passed 297 focused tests plus 27 setup/security tests, and independent
      testing review passed 334 focused tests; both returned CLEAR. Root-wide Prettier still
      reports 37 pre-existing branch-unrelated files and is retained as repository format debt.
- [x] The 2026-08-03 TG-05/TG-06 trigger-loop token-cost gate passed 134 focused tests and the
      complete standalone suite (344 files, 4,600 tests; 4 files / 7 tests skipped). Durable
      author/review backoff, newest bounded final prompts, owner-state races, collapsed missed
      intervals, and shutdown provider abort/drain are covered; security/migration,
      cost/performance, testing, and final red-team reviewers returned clear.
- [x] The 2026-08-13 sender-boundary completion gate covers all 18 connector/surface/sender cells.
      The focused file passed 23 tests; the complete gateway + CLI gate passed 76 files and 806
      tests; standalone `tsc --noEmit` passed. TG-01 lane ordering/isolation, the TG-04 Telegram
      group public-lane exception, TG-05 public-session replacement, Slack restart/team-ID failure,
      both Slack ingress routes, and non-owner prompt-history exclusion are pinned.

## Change log

- 2026-08-13: Added the final sender-boundary completion matrix and linked TG-01 ordered lane
  ownership, TG-04 limited Telegram group conversation, and TG-05 replacement/history isolation to
  named integration tests. The matrix keeps all other external cells before model, session,
  history-prompt, attachment, tool, and outbound boundaries while retaining every owner flow.

- 2026-08-03: Closed TG-05/TG-06 trigger-loop token leakage. Author and review calls now consume
  durable work exactly once, back off provider/parse failures across restarts, keep newest evidence
  under fixed provider-input ceilings, and cannot overwrite an owner state change. Maintenance
  overlap collapses to one catch-up pass, and isolated JSON calls use the configured model without
  tools or session persistence.

- 2026-08-02: Closed the final Cline release review. The setup wizard now uses a backend-neutral,
  nonce-bound host-action protocol, validates Discord/Slack/Telegram credentials through official
  APIs before atomic persistence, and rejects legacy pseudo-actions instead of displaying false
  success. Red-team and testing reviewers returned CLEAR; the complete standalone and root test
  gates passed. Public documentation describes only generic configured private connectors; the
  user-owned connector remains installation-local and absent from public catalogs.

- 2026-08-02: Corrected the durable-runtime usage contract after a tool-heavy Telegram turn
  exposed per-run aggregate input as false context occupancy. Claude Code, Codex app-server, and
  Cline Hub now keep their model-aware compaction instead of inheriting MAMA's fixed 160K/200K
  threshold. Also paired Cline custom-tool execution with the preceding streamed provider call ID
  when the execution context omits it, eliminating duplicate completed exchanges and Telegram
  reasoning entries. Focused RED→GREEN coverage is in the Cline adapter and SessionPool tests.
- 2026-08-02: Closed the TG-03/TG-04/TG-05/TG-06 Cline branch review. Native tools now follow the
  active role or managed-agent native permission policy without an owner wildcard bypass. Stable
  routes serialize queued prompts, active sessions cannot be evicted at capacity, and missing,
  timed-out, or policy-incompatible Hub sessions rebuild from the complete current policy.
  Deadline, owner-cancel, transport-failure, and shutdown paths drain already-started Code-Act
  mutation settlement before returning a structural non-retryable outcome. Raw provider errors
  are bounded and sanitized. Focused adapter, AgentLoop, manager, router, worker, and shutdown
  regressions cover these contracts.
- 2026-08-02: Replaced the per-message Cline NDJSON subprocess with the official Cline Hub runtime
  shipped in the configured CLI. TG-03/TG-04 now project MAMA Code-Act as a session-bound custom
  tool while retaining Cline native tools. TG-05 now keeps one live Hub session, sends later turns
  without the full startup prompt, and performs one bounded rebuild only when that session is
  missing. Installed Cline 3.0.49 live evidence confirmed one tool call and exact two-turn memory.
- 2026-08-02: Removed hidden Claude dependencies from Cline setup, cron, conversation extraction,
  token keepalive, and inbound image handling. TG-03/TG-04 image turns now retain the private media
  block for the configured runtime, while TG-06 scheduled work uses the same backend selection.
  Kagemusha remains a configured user-private connector and is not generalized by these shared
  backend primitives.
- 2026-08-02: Added TG-01/TG-05/TG-06 compatibility evidence for signed-envelope private-scope
  projection, non-replayable ledger V3 migration, both historical report-carry shapes, and
  migration 063 mixed-version writer refresh. Production BLOB lifecycle evidence and ledger
  migration I/O preservation closed the final red-team findings. The full standalone gate passed
  4,437 tests with seven skipped. Kagemusha remains a configured user-private connector and is
  absent from generic, wiki, and legacy-unbound surfaces.
- 2026-08-02: Closed the fresh whole-branch TG-06 findings with production Kagemusha metadata
  compatibility (`65fe9ef2`), delivery-v2 full semantic identity (`9dc62450`), and exact
  scheduled/on-demand occurrence keys (`2790e402`). Focused gates passed 84, 131, and 83 tests;
  the latest full standalone hook passed 4,413 tests with seven skipped, and the fresh reviewer
  returned clear. This follow-up does not claim a new root matrix, preserves the existing root
  format disclosure, and keeps Kagemusha configured-user-private.
- 2026-08-02: Recorded TG-01 target/payload-bound report delivery, TG-05 private-policy session
  rotation and prompt/carry isolation, and TG-06 receipted lifecycle authority. Review closure and
  current-worktree gates are recorded with the root 30-file format debt disclosed separately from
  the passing branch-touched Prettier check. Kagemusha remains a configured user-private connector;
  neither shared report output nor lifecycle receipts are used to infer broader Code-Act grants or
  Telegram API recovery.
- 2026-07-31: Recorded process-generation principal binding, completed MCP exchange no-replay,
  structured nested-tool audit, terminal missing-result handling, and identity-safe process
  retirement for TG-03/TG-04/TG-05/TG-06. Follow-up review added structural oversized-result
  compaction, pre-final terminal promotion, interrupted-completed-mutation suppression, and exact
  Code-Act MCP provenance checks. Final closure preserves exact exchanges for interrupted terminal
  results, prioritizes completed mutation evidence over later protocol/missing-result failures, and
  maps unresolved Code-Act protocol failures to the no-retry `MCP_RESULT_MISSING` outcome. PR
  review also normalized Node abort audit codes, made latency accounting attempt-exact, and covered
  expired leases that are still draining pinned executions.
- 2026-07-22: Created after partial, file-by-file parity work repeatedly missed end-to-end
  boundaries. Reference source was re-read from `mama-suite` commit `ea982c1`.

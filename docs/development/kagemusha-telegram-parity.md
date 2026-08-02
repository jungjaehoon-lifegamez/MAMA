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

| ID    | User-visible contract                                                                                                                                                                               | Kagemusha evidence                                                                                                                                                                                                                                                      | MAMA target evidence                                                                                                                                                                                                                                                                | Current gap / decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Required verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| TG-01 | Messages in one Telegram conversation are handled and presented in order, including long multi-part replies.                                                                                        | `channels/telegram/telegram-channel.ts`: `enqueueStream`, `handleStreaming`, `splitMessage`                                                                                                                                                                             | `gateways/telegram.ts`, `gateways/telegram-message-ledger.ts`, `gateways/telegram-response-presenter.ts`, `gateways/message-router.ts`, `operator/report-carry-delivery.ts`, `operator/pending-report-store.ts`, `operator/operator-trigger-loop.ts`                                | MAMA serializes the entire per-chat delivery boundary. Re-entrant sends from the active agent turn execute inline to avoid deadlock; external reports wait behind that turn. The production report assembly forwards the prepared delivery ID to one host-bound Telegram target. Pending requests and deliveries persist that target plus a payload identity, and recovery rejects configuration drift or mutated payloads before send or carry persistence. Telegram binds one delivery ID to the same chat and text: conflicting reuse is rejected, identical reuse stays idempotent. Existing confirmed/uncertain chunk semantics remain unchanged.                                                                                                                                                                                                                                       | `telegram.test.ts`: exact external report behind an active same-chat turn, conflicting chat/text reuse, overlapping turns, failed chunk, 429, Unicode boundary. `operator-trigger-loop.test.ts`: scheduled/on-demand target-scoped production assembly and cross-boot target drift. `pending-report-store.test.ts`: target/payload validation and quarantine. `telegram-response-presenter.test.ts`: long response and Unicode boundary.                                                                                                                                              | GREEN (2026-08-02) |
| TG-02 | A received photo or document is downloaded, retained privately, and its real local path reaches the agent that can inspect it. A follow-up after backend session replacement can still refer to it. | `channels/telegram/telegram-channel.ts:170-255`; `runtime/monitoring-runtime.ts:305-310`                                                                                                                                                                                | `gateways/telegram-media.ts`, `gateways/telegram.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`                                                                                                                                                                     | MAMA retains host-verified media instructions separately from the truncated caption portion during bounded context restoration. Owner roles retain the private path; group roles receive neither an unavailable OCR instruction nor the path, and visible output redacts it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `message-router.test.ts`: retained path and long-caption fresh-session rebuild. `role-manager.test.ts` and `telegram-response-presenter.test.ts`: role/path boundaries. `telegram-media.test.ts`: retention/quota.                                                                                                                                                                                                                                                                                                                                                                    | GREEN              |
| TG-03 | The owner agent can freely compose shared-Drive lookup/download, OCR/translation, output creation, same-folder upload, and Telegram return in one run.                                              | `tools/drive-tool-registry.ts`: Drive primitives; `tools/image-tool-registry.ts`: image primitives; `tools/conti-tool-registry.ts`: `drive_translate_conti` returns guidance rather than executing a fixed pipeline; all are registered together in `server.ts:105-114` | `agent/drive-tools.ts`, `agent/image-translation-tools.ts`, `agent/tool-registry.ts`, `agent/code-act/host-bridge.ts`, `agent/role-manager.ts`, `agent/code-act/constants.ts`, `templates/skills/image-translate.md`                                                                | All primitives share the owner Code-Act surface. A verified `owner_console` may resolve and upload to the Drive folder explicitly selected for the active owner request, matching Kagemusha; configured-root capabilities remain available and validated when supplied. Non-owner Drive operations require role permission and configured connector/envelope scope and cannot select arbitrary roots. Uploads remain contained to private MAMA workspace files. Translation guidance permits agent-selected tools and forbids success claims after failed side effects. Repeated OCR text consumes distinct regions in source order.                                                                                                                                                                                                                                                         | `drive-tools.test.ts`; `image-translation-tools.test.ts`; `setup-ocr.test.ts`; `image-translate-skill-template.test.ts`; owner-selected and capability validation cases in `envelope/executor-integration.test.ts`; owner/non-owner projection in `gateway-tool-executor.test.ts`; composition and advertisement cases in `code-act/integration.test.ts`.                                                                                                                                                                                                                             | GREEN              |
| TG-04 | Tool availability is determined by the active role but the owner gets the full proven tool chain without switching execution surfaces.                                                              | Kagemusha registers channel/task/Trello/memory/image/Drive/schedule/conti functions into one `CodeActSandbox` in `server.ts:105-114`.                                                                                                                                   | `agent/code-act/tool-policy.ts`, `agent/code-act/host-bridge.ts`, `agent/role-manager.ts`, `agent/tool-registry.ts`                                                                                                                                                                 | MAMA projects one canonical HostBridge registry through role and tier narrowing. Every default owner inner tool is registered and projected, including the complete Drive composition surface even when no static Drive destination is configured. Wildcard group roles cannot gain the owner's cross-root Drive selection or private media instructions; scoped Drive access remains role-bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `code-act/tool-policy.test.ts`; Code-Act owner/group runtime calls in `gateway-tool-executor.test.ts`; prompt/registry coherence in `code-act/integration.test.ts` and `gateways/tool-ad-coherence.test.ts`.                                                                                                                                                                                                                                                                                                                                                                          | GREEN              |
| TG-05 | A continued model session does not receive the full system/context prompt again. When the backend session changes or is lost, only bounded recent context is restored.                              | `agent/agent-loop.ts:357-398`: `retainsContext`, session-change detection, bounded previous-turn restoration                                                                                                                                                            | `agent/codex-app-server-process.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`, `agent/agent-loop.ts`, `connectors/private-connector-policy.ts`, `connectors/private-prompt-overlay.ts`                                                                             | Same-policy continuation sends only the new user message. A private-policy fingerprint change rejects the stale durable thread, rebuilds the full current policy exactly once, then resumes minimally. Kagemusha remains a configured user-private connector: fresh, disabled, generic, and legacy-unbound surfaces do not receive its catalog, and unknown-tool errors do not enumerate it. Disabled prompt projection removes actual private directives and calls, including safely matched nested Markdown wrappers, while preserving historical prose and the user-owned brief bytes. Target-scoped report carry is injected only into the intended Telegram owner turn and acknowledged only after final assistant persistence. No nested Codex CLI is used.                                                                                                                            | `agent-loop.test.ts` and `codex-app-server-process.test.ts`: two-direction private-policy replacement then minimal continuation. `message-router.test.ts`: current-policy rebuild and one-shot target-scoped carry. `private-connector-policy.test.ts`, `tool-ad-coherence.test.ts`, `gateway-tool-executor.test.ts`: fail-closed private discovery/execution. `private-prompt-projection.test.ts`: shared console/workorder invocation and historical-prose matrix.                                                                                                                  | GREEN (2026-08-02) |
| TG-06 | Full-report requests and scheduled reports use the same owner tool capabilities and are visibly delivered. A failure cannot be reported as success or leave a durable response stranded.            | Owner-only full-report routing in `runtime/monitoring-runtime.ts:289-310`; report tool workflow in `runtime/report-prompts.ts`; Telegram send path in `channels/telegram/telegram-channel.ts:395-400`                                                                   | `operator/operator-trigger-loop.ts`, `operator/situation-report.ts`, `operator/pending-report-store.ts`, `operator/report-carry.ts`, `operator/task-ledger.ts`, `operator/workorder-consumer.ts`, `cli/commands/start.ts`, `cli/runtime/api-routes-init.ts`, `gateways/telegram.ts` | MAMA persists the exact report text, provenance, occurrence, delivery ID, Telegram target, and payload identity before sending. Startup replays the same prepared artifact rather than regenerating it; target/payload conflict is quarantined or rejected, and scheduler success advances only after delivery. Successful full reports create one exact-target carry that is consumed only after the owner's response persists. Structured private-connector lifecycle events produce host-built candidates; task/binding mutation and its receipt commit atomically, generic mutation paths cannot bypass candidate authority, and partial or ambiguous receipt states do not replay automatically. These receipts prove internal task-effect arbitration, not Telegram API recovery. The shared scheduled/on-demand output proves delivery/carry assembly, not identical Code-Act grants. | `operator-trigger-loop.test.ts`, `pending-report-store.test.ts`, `situation-report.test.ts`, `report-carry.test.ts`, and `message-router.test.ts`: exact prepared report, target/payload/provenance binding, restart, and one-shot carry. `telegram.test.ts`: delivery-ID target/text binding plus rejection/ambiguity. `external-lifecycle-reconcile.test.ts`, `external-lifecycle-workorder-recovery.test.ts`, `api-routes-init-reconcile.test.ts`, and `gateway-tool-executor.test.ts`: atomic receipts, private-scope production wiring, mutation guards, and no-replay recovery. | GREEN (2026-08-02) |

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

| Area               | Decision                                                                                                                 | Reason                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat scope         | MAMA supports configured private owner chats as well as role-restricted groups; Kagemusha's current channel ignores DMs. | MAMA is an owner console, so copying the group-only restriction would remove required behavior.                                            |
| Filesystem         | MAMA uses a configurable private workspace and media retention/quota policy.                                             | Avoid host-wide file access and unbounded attachment growth.                                                                               |
| Delivery recovery  | MAMA may persist pending work and delivery progress.                                                                     | Daemon crash and app-server reset are observed production failures. This is a safety extension, not permission to change visible behavior. |
| Telegram ambiguity | MAMA retries an outbound chunk when Telegram acceptance cannot be proven, and logs the duplicate risk.                   | Telegram offers no transactional exactly-once boundary across a daemon crash; at-least-once avoids a silently missing owner report.        |
| Backend            | MAMA uses the Codex app-server directly and must never launch nested Codex CLI.                                          | Prevent recursion, uncontrolled context, and token overhead.                                                                               |

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
- [x] Branch-touched Prettier verification passes. Root `pnpm format:check` remains exit 1 on 30
      pre-existing branch-unrelated files and is explicitly retained as repository format debt.

## Change log

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

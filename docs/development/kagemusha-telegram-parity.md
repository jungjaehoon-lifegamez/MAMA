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

| ID    | User-visible contract                                                                                                                                                                               | Kagemusha evidence                                                                                                                                                                                                                                                      | MAMA target evidence                                                                                                                                                                                                 | Current gap / decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Required verification                                                                                                                                                                                                                                                                                                                         | Status |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| TG-01 | Messages in one Telegram conversation are handled and presented in order, including long multi-part replies.                                                                                        | `channels/telegram/telegram-channel.ts`: `enqueueStream`, `handleStreaming`, `splitMessage`                                                                                                                                                                             | `gateways/telegram.ts`, `gateways/telegram-response-presenter.ts`, `gateways/message-router.ts`                                                                                                                      | MAMA serializes the entire per-chat delivery boundary. Re-entrant sends from the active agent turn execute inline to avoid deadlock; external reports wait behind that turn. Confirmed chunks are not repeated, while a failed or 429-rejected chunk is retried.                                                                                                                                                                                                                                                                                                                                                           | `telegram.test.ts`: overlapping turns, concurrent external report, failed chunk, 429, Unicode boundary. `telegram-response-presenter.test.ts`: long response and Unicode boundary.                                                                                                                                                            | GREEN  |
| TG-02 | A received photo or document is downloaded, retained privately, and its real local path reaches the agent that can inspect it. A follow-up after backend session replacement can still refer to it. | `channels/telegram/telegram-channel.ts:170-255`; `runtime/monitoring-runtime.ts:305-310`                                                                                                                                                                                | `gateways/telegram-media.ts`, `gateways/telegram.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`                                                                                                      | MAMA retains host-verified media instructions separately from the truncated caption portion during bounded context restoration. Owner roles retain the private path; group roles receive neither an unavailable OCR instruction nor the path, and visible output redacts it.                                                                                                                                                                                                                                                                                                                                               | `message-router.test.ts`: retained path and long-caption fresh-session rebuild. `role-manager.test.ts` and `telegram-response-presenter.test.ts`: role/path boundaries. `telegram-media.test.ts`: retention/quota.                                                                                                                            | GREEN  |
| TG-03 | The owner agent can freely compose shared-Drive lookup/download, OCR/translation, output creation, same-folder upload, and Telegram return in one run.                                              | `tools/drive-tool-registry.ts`: Drive primitives; `tools/image-tool-registry.ts`: image primitives; `tools/conti-tool-registry.ts`: `drive_translate_conti` returns guidance rather than executing a fixed pipeline; all are registered together in `server.ts:105-114` | `agent/drive-tools.ts`, `agent/image-translation-tools.ts`, `agent/tool-registry.ts`, `agent/code-act/host-bridge.ts`, `agent/role-manager.ts`, `agent/code-act/constants.ts`, `templates/skills/image-translate.md` | All primitives share the owner Code-Act surface; the host supplies containment and a short-lived capability for the agent-selected resolved Drive destination without executing a fixed workflow. Code-Act advertises only the functions actually projected for the run and gives a general composition/outcome contract. Translation-skill guidance permits agent-selected tools and forbids success claims after failed side effects. Repeated OCR text consumes distinct regions in source order. OCR setup checks the host Korean/CJK font dependency.                                                                 | `drive-tools.test.ts`; `image-translation-tools.test.ts`; `setup-ocr.test.ts`; `image-translate-skill-template.test.ts`; Drive destination capability cases in `envelope/executor-integration.test.ts`; owner/non-owner projection in `gateway-tool-executor.test.ts`; composition and advertisement cases in `code-act/integration.test.ts`. | GREEN  |
| TG-04 | Tool availability is determined by the active role but the owner gets the full proven tool chain without switching execution surfaces.                                                              | Kagemusha registers channel/task/Trello/memory/image/Drive/schedule/conti functions into one `CodeActSandbox` in `server.ts:105-114`.                                                                                                                                   | `agent/code-act/tool-policy.ts`, `agent/code-act/host-bridge.ts`, `agent/role-manager.ts`, `agent/tool-registry.ts`                                                                                                  | MAMA projects one canonical HostBridge registry through role, tier, and active-envelope narrowing. Every default owner inner tool is registered and projected; verified Drive read/write capabilities appear together only when the envelope has the connector and destination. Wildcard group roles cannot gain owner Drive tools or private media instructions.                                                                                                                                                                                                                                                          | `code-act/tool-policy.test.ts`; Code-Act owner/group runtime calls in `gateway-tool-executor.test.ts`; prompt/registry coherence in `code-act/integration.test.ts` and `gateways/tool-ad-coherence.test.ts`.                                                                                                                                  | GREEN  |
| TG-05 | A continued model session does not receive the full system/context prompt again. When the backend session changes or is lost, only bounded recent context is restored.                              | `agent/agent-loop.ts:357-398`: `retainsContext`, session-change detection, bounded previous-turn restoration                                                                                                                                                            | `agent/codex-app-server-process.ts`, `gateways/message-router.ts`, `gateways/session-store.ts`, `agent/agent-loop.ts`                                                                                                | Same-process turns send only the new user message. Router continuation context is less than one quarter of the startup prompt and contains no full instructions. A durable-thread restart receives one bounded runtime bootstrap; a policy mismatch explicitly replaces the thread and rebuilds the full current policy once. No nested Codex CLI is used.                                                                                                                                                                                                                                                                 | `message-router.test.ts`: same-session prompt-cost and attachment-aware rebuild. `codex-app-server-process.test.ts`: no same-process re-injection and one-time durable restart bootstrap. `agent-loop.test.ts`: policy-mismatch reset with full rebuild.                                                                                      | GREEN  |
| TG-06 | Full-report requests and scheduled reports use the same owner tool capabilities and are visibly delivered. A failure cannot be reported as success or leave a durable response stranded.            | Owner-only full-report routing in `runtime/monitoring-runtime.ts:289-310`; report tool workflow in `runtime/report-prompts.ts`; Telegram send path in `channels/telegram/telegram-channel.ts:395-400`                                                                   | `operator/operator-trigger-loop.ts`, `operator/situation-report.ts`, `operator/pending-report-store.ts`, `cli/commands/start.ts`, `gateways/telegram.ts`                                                             | MAMA persists the exact report text, cited triggers, occurrence metadata, and operation-owned delivery ID before sending. Startup immediately replays the outbox without regenerating text; scheduler success advances only after delivery. Scheduled slots and on-demand UUIDs cannot collide. Telegram records definite API rejection separately from ambiguous acceptance. Confirmed chunks are deduplicated; ambiguous acceptance intentionally uses at-least-once retry and may duplicate the uncertain chunk rather than silently lose the report. Busiest channel/fire evidence survives bounded snapshot recovery. | `operator-trigger-loop.test.ts`: pre-send restart, accepted-send/completion crash, immediate startup replay, same-hour independence. `pending-report-store.test.ts`: exact operation persistence. `telegram.test.ts`: 429 versus ambiguous acceptance. `situation-report.test.ts`: bounded busiest-first restart snapshot.                    | GREEN  |

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

The correction preserves autonomy: coherent primitives are projected together, descendant Drive
authority is represented by an envelope-bound short-lived capability, skill text no longer bans
tools needed for requested side effects, and prompt guidance states a general composition/outcome
contract rather than a scenario-specific pipeline.

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
- [x] Final corrective standalone test (4,550 passed, 6 skipped), typecheck, build, lint, format, and
      `git diff --check` pass.
- [x] Final reviewers read this artifact first, reported by scenario ID, and every finding was
      closed with a regression test listed in the review-closure section.

## Change log

- 2026-07-22: Created after partial, file-by-file parity work repeatedly missed end-to-end
  boundaries. Reference source was re-read from `mama-suite` commit `ea982c1`.

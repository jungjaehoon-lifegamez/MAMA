# Owner reports, corrections, lookup and backend parity

Owner checks: **report**, **learn**, **answer** and **attach**.
Status, 2026-09-27: **R1–R10 are implemented**. Live acceptance is limited to the evidence below;
open checks in [checks.md](checks.md) remain open. Implementation is not completion of INTENT.

The report, lesson-recall and attachment mechanisms were ported from the read-only Kagemusha
reference; its business content and personal literals were not copied. Task revision chains and
ranked work lookup are MAMA additions. Operating instructions:
[reports and board](../guides/reports-and-board.md), [backends](../guides/backends.md),
[corrections](../guides/corrections-and-learning.md).

## Current results

| Item | Implemented behavior                                                                                                            | Live evidence and remaining acceptance                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Owner-facing answers, reports and notifications carry no internal IDs; evidence remains in tool traces.                         | 2026-09-26 11:20: owner answers without IDs.                                                                                                                              |
| R2   | Standing guidance asks for a scoped lesson in the correction turn.                                                              | Lessons were saved on live turns; 20:10 also records a correction that was not saved. Compliance still needs observation.                                                 |
| R3   | Each turn recalls up to three lessons, preferences and constraints; a new session also receives startup context.                | 12:47: a restarted session followed the report-format correction. 20:10: a relevant preference reached the answer. Top-three recall can miss a relevant lesson.           |
| R4   | Live deltas route by the last notify/ack tag, then enqueue a board turn for all four slots.                                     | 23:00: a real calendar delta routed ack and queued a board turn. A delivered notify and full task/board agreement remain to be checked.                                   |
| R5   | Full reports at 08/13/18 KST; reminders 09–21, excluding full-report hours. The hour is recorded after successful delivery.     | Focused scheduler/delivery checks passed. A real next-hour report, its Telegram receipt and task/board agreement remain open.                                             |
| R6   | Native workspace shell, source attachment list/download, Telegram intake and file delivery.                                     | 14:00: source feedback became a delivered spreadsheet. Later Claude runs exercised the same path; output fidelity and remaking rather than resending still need checking. |
| R7   | Replay finalization resets the owner session; new sessions receive recent delivered owner exchanges.                            | Both drivers implement reset/startup preparation; Claude restart context was observed at 19:40. A complete replay-to-live exchange on each backend remains open.          |
| R8   | Ranked lexical and embedding lookup, multiple status filters and progressive work reads.                                        | 12:15: a live lookup found the work and read its history. Same-script queries are proven; transliteration is not guaranteed.                                              |
| R9   | `work.show` defaults to the revision chain, with full values behind `history: all`.                                             | 12:15: the owner received the ordered feedback rounds from the chain.                                                                                                     |
| R10  | Claude and Codex share the host contract for startup, tools, caller attribution, child runs, receipts and workspace boundaries. | Claude answer/file/correction turns and restarted context were observed; 20:10 recorded two children within one turn. Remaining acceptance is listed below.               |

Dates and times above refer to the 2026-09-26 entries in
[the live check log](checks.md#september-replay-run-log). Later D4 entries connect owner/delta
inputs, model runs, tool traces, board writers and Telegram receipts; they do not close every
content-quality or scheduled-delivery check.

## Reports and calendar — R4/R5

The daemon's `onSourceResult` routes the last `[notify]` or `[ack]` tag. Notifications use the
configured `telegram.owner_chat_id` and existing outbound ledger; ack and untagged responses are
logged. A bounded failure reason reaches the daemon log, and uncertain sends are not silently
resent. Each live delta queues an idempotent board turn using
`operator/board-slot-instructions.ts`; replay does not enter this live route.

Scheduled stimuli now execute report turns. Full reports publish `briefing`, `action_required`,
`decisions` and `pipeline`, then return the five-part Telegram report. Reminders update
`action_required`, include gathered non-urgent changes and return a short message. The scheduler
writes `runtime/report-schedule-state.json` only after delivery succeeds; restart recovery retains
pending work and exposes uncertain results.

The calendar connector was restored in `ba90c51cb`. It collects Google Calendar through `gws`
over a 90-day horizon; the live 23:00 check stored 66 events and produced a source delta.
Calendar and lodging lines are in the full-report instruction. Their source coverage and the
resulting report still need comparison with the owner's actual schedule. Static workflow
contracts and the reference's `forward_feedback` automation were not ported.

Code: [daemon assembly](../../packages/standalone/src/cli/commands/daemon.ts),
[report scheduler](../../packages/standalone/src/runtime/report-scheduler.ts),
[report prompts](../../packages/standalone/src/runtime/report-prompts.ts),
[board instructions](../../packages/standalone/src/operator/board-slot-instructions.ts).

## Files, lookup and continuity — R6–R9

Chatwork and Slack observations retain attachment descriptors. Attachment lookup also supports
known-file and uploader/time-scoped discovery; missing descriptors or downloads surface errors.
`source.attachment.download` uses connector credentials to save into `~/.mama/downloads/<source>/<safe room>/`.
`deliver.telegram.file` sends a regular, non-symlink file from `workspace/files/` to the configured
owner, with size checks and idempotency. Telegram owner uploads enter `~/.mama/downloads/telegram/`.
Downloads are read-only for the agent; copy them into `workspace/files/` before modifying,
unzipping, or delivering them.

Both owner backends provide native shell and web access with workspace write boundaries.
Core shell/web defaults remain off. Current credential exclusions and runtime settings are
documented in [security](../guides/security.md) and [backends](../guides/backends.md).

Work lookup ranks lexical and embedding candidates; the agent decides identity.
`work.show` returns a chronology with event time, status, stage and revision summary.
Replay reset clears provider session context while retaining work, wiki, memory and receipts.
New-session context includes recent owner exchanges from delivered Telegram receipts.

Code: [attachments](../../packages/standalone/src/api/attachment-actions.ts),
[file delivery](../../packages/standalone/src/api/file-delivery.ts),
[work reads](../../packages/standalone/src/api/work-actions.ts),
[recent exchanges](../../packages/standalone/src/runtime/session-start-context.ts),
[replay finalization](../../packages/standalone/src/cli/commands/replay.ts).

## Common host and live parity — R10

R10(a–e) are implemented: the action MCP bridge reads the shared runtime credential path;
Claude's caller hook attributes MCP calls to the active dispatch; both drivers prepare startup
content after selecting the actual session; both reset sessions; both enforce the owner's
workspace and credential boundary. Claude file-write permissions are passed with
`--allowedTools` and `dontAsk`; its Bash sandbox remains required.

Each backend keeps its native harness. Codex uses app-server dynamic tools; Claude uses the
standalone action MCP bridge and persistent stream-json. The host owns intake, one-turn-at-a-time
delivery/recovery, per-turn context, policy, model runs and receipts. Child calls have separate
attribution. The public development-memory MCP server is a separate in-process core adapter.

R10(f) has live evidence beyond the first partial run: Claude answered from sources, downloaded
an attachment, produced and delivered a spreadsheet, saved a formatting correction, and received
recent context after restart. Later file read-back improved formatting. At 19:40, background
children produced files but no delivery; the workspace now sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. At 20:10, two children ran within one parent turn with
separate traces and no caller refusal.

Still open in the log: repeat the child-produced-file delivery end to end, verify the intended
formatting lesson reaches a fresh related turn, prove remake requests create a new result, and
watch corrections that the agent fails to save. The old background/autonomous-turn driver code
also remains a separate cleanup. Recheck child execution when the CLI version changes.
The later D4 trace check still calls for a live native-shell trace.

## Completion rule

The original dependency order was R1/R2 → R9 → R8 → R3 → R7 → R4/R5/R6, followed by R10 parity.
All are implemented; remaining work is the named live acceptance above and in [checks.md](checks.md).
Record new evidence there without rewriting earlier results. Overall owner-check completion
still follows [INTENT.md](../../INTENT.md).

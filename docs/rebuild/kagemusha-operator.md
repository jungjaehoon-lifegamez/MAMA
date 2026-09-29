# Operating layer in Kagemusha's structure

Companion to [plan.md](plan.md) W22–W26. It holds the evidence, the per-turn comparison and the
decisions; the plan holds only the work items and their checks. Figures come from Kagemusha's
`~/.kagemusha/logs/context-cost-current.jsonl` and server log, and from MAMA's Codex rollouts of
2026-09-28/29. Kagemusha source: `mama-suite/apps/kagemusha/src` (the running working tree). MAMA
source: `packages/standalone/src` at `6738c6941`.

## What differs

Both run one model session behind one serial queue. Kagemusha keeps what enters that session
small, and its host runs each delta through fixed, checked steps. MAMA pours large payloads into the
session and hands each event to the agent as a whole job.

| Measure                        | Kagemusha                                                                                  | MAMA                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Session life                   | one Devin session 09-16 → 09-29: 13 days, 2,484 turns                                      | 4 sessions on 09-28, 10 compactions (8 + 2)                                       |
| Turn message                   | median 735 chars; lesson hints only fill up to 1,600 (`agent-loop.ts:133–136`)             | delta turn median 3,563                                                           |
| Session start                  | `[session_start]` 2,441 chars, capped at 2,500 (`session-start-context.ts:24–31`)          | first turn 29,773–40,242                                                          |
| Tool text in every turn        | one `code_act` tool, 1,861-char catalog; about 6,300 chars of usage guidance in the prompt | 27 tools: 10,010 description + 38,106 schema (12,279 of it property descriptions) |
| Tool result reaching the model | median 37, p90 1,084                                                                       | median 1,553, p90 19,898                                                          |
| Tool result per turn           | small                                                                                      | delta 11,762; owner 15,093; reminder 32,763; full report 130,412                  |
| Input per day                  | about 0.2M chars                                                                           | about 1.5M chars                                                                  |
| Delta notify rate              | 103 of 462 batches (22%), 09-22 → 09-28                                                    | 42 of 98 turns (43%), 09-28                                                       |
| Delta recording checked        | 480 reconciles passed, 0 failed                                                            | not checked; 63 of 98 turns wrote anything                                        |

Why the results are small: `code_act` keeps host data in the sandbox and returns only what the
script returns. `task_list` hands the sandbox a median 49,381 chars; in the executions matched to
it the model got a median 636. `trello_kanban` 9,028 → 924. MAMA's Codex `exec` works the same way,
but the agent prints whole results (`text(r)`); `work.list` view=pipeline alone was 54,356 chars.

The cycle this creates in MAMA: large results fill the session → it compacts → rules, corrections
and situation are lost → the host pushes about 30k chars at session start to compensate → the
session fills faster. The owner decision of 2026-07-16 ("autonomous lanes treat the session as a
cache"; `freshSession` in core `native-turn.ts`) was the earlier answer to the same growth; this
plan keeps one session and removes the growth instead, and records a superseding decision.

## Kagemusha's loop, as it runs

- **Queue and session.** One `KagemushaAgentLoop` (`agent/agent-loop.ts`), one runner, one
  in-memory FIFO (`:321`). Telegram chat, every awareness step and the session start all call
  `chat()` and wait. The Devin session is reused for the process lifetime
  (`devin-acp-process.ts:151`).
- **Turn text.** `<context channel>` + optional lesson block + previous turns only after a session
  loss (≤3,000 chars) + the message (`:343–400`).
- **Lessons.** None on reconcile, report, reminder and contract turns. After a new or lost
  session: top 3 by search, ≤1,200 chars. Within a session: on memory-trigger words, with a
  cooldown per query, ≤600 chars — 68 of 3,342 turns, 65 of them delta notify turns. Blocks say
  "lessons, not facts; verify current state with tools" (`:185`).
- **Restore.** Automation turns (`system:`, `delta-taskboard:`, `delta-feedback:`,
  `delta-contract:`) are left out of the transcript restored after a loss; delta notify turns are
  kept (`:138–145, :800`).
- **Session start.** One `[session_start]` turn at startup: 10 owner messages, 10 resumable turns,
  recent decisions, 3 startup lessons, checkpoint, current time, "use channel_recent for what came
  after" (`runtime/agent-session.ts`, `session-start-context.ts`).
- **Delta cycle** (`runtime/agent-awareness.ts:336–540`). A flush 15 s after a new message
  (`:322`) and every 5 minutes (`:291`); a running batch makes the next skip (`:343`); a 30 s pause
  after compaction (`:317`); on first start the cursor begins at the current maximum
  (`:283–288`); messages older than 6 h are skipped (`:108, :378–395`). Per channel: an optional
  contract turn (21 in 14 days); feedback forwarding; the **notify turn** (`formatDelta`, `:554`);
  the **record turn** (`buildTaskboardReconcilePrompt`, `:1050`: read context, tasks and kanban,
  decide slots, write or `contract_no_update`, "done:" line, reply `[ack]`), verified by a
  before/after snapshot that requires a task or report change scoped to the batch's source events,
  or a no-update record (`agent/contracts/action-verifier.ts:238–264`). The cursor advances over
  the unbroken run of messages whose steps passed (`:475–479, :502–505`).
- **Routing.** The host reads the last `[notify]`/`[ack]` in the reply (`:1033`), the same as MAMA
  (`cli/commands/daemon.ts:395`).
- **Reports.** Full report at 8/13/18 with its own prompt (`runtime/report-prompts.ts:1–16`);
  hourly reminder with fixed steps and no tags (`:1434–1470`); chat "full report" swapped by
  regex (`monitoring-runtime.ts:294`).
- **Prompt.** One Korean document: messenger syntax first (`system-prompt.ts:7`), behaviour rules,
  continuity and memory, role (`:69`), situation handling, tool guides, feedback skill, core
  principles, security (`:392–410`), response principles.
- **Learning.** `brain.observeTurn` extracts lessons from owner messages by keyword
  (`brain/experience-signal-extractor.ts`); `mama_save` saves what a tool cannot re-derive.

## MAMA after W22–W23

- **Delta.** The durable mailbox stays the intake: a connector poll still becomes one
  `source_delta` row per channel, merged with the channel's pending row while the loop is busy;
  first snapshots and imports never reach it (`polling-scheduler.ts:224–266`). Lines older than
  6 h are dropped from the notify order, and a row with only such lines is acked without a turn
  (Kagemusha's backfill guard; after downtime the first poll reads everything since the last one,
  `polling-scheduler.ts:203–204`). A live row runs the **notify order** only. Before its reply is
  routed to the owner, a **record order** is enqueued as its own row: kind `scheduled`, channel
  `operator:record`, no refs (the mailbox dedupes refs, `mailbox.ts:374–411`), id
  `record:<delta stimulus id>:<attempt>`, payload built only from the delta's stimulus id,
  observation refs and channel so a replayed result enqueues the same row. `scheduled` rows branch
  on `channelKey` in turn assembly, result handling and reconciliation (`stimulus-delivery.ts:384`,
  `:787–805`, `daemon.ts:468–472`); the report scheduler's pending check counts only `schedule`
  rows (`daemon.ts:688`).
- **Record check.** After the record run and its child runs have ended, the ledger decides (runs
  started before the current daemon process count as ended, since a killed process leaves them
  `running`; `model-run-store.ts:542, 581`): a
  revision with a `derived_from` edge to one of the batch's observations, whichever run wrote it,
  or a successful `work.no_update` call in those runs. A board or wiki write alone does not pass. When the check
  fails, or the record row fails, goes uncertain or dead (`onFailed`, `onUncertain`, `onDead`), the
  ledger check runs first and the next attempt is enqueued only if the batch is still unrecorded; at
  most three attempts, then the loss is logged loudly. Record replies never reach the owner. A
  `memory.save` in a record order carries `derived_from` links to the batch's observations, since
  the record row itself has no refs (`provenance-live.ts:504–531`).
- **Session start.** `[session_start]` ≤2,500 chars on a new session, in Kagemusha's shape
  (`session-start-context.ts`):
  - local time first;
  - the owner channel's last 10 messages (600);
  - the last 10 resumable turns, owner and live delta turns with their replies (1,000);
  - the latest 10 memory records as recent decisions (600);
  - "read newer source messages when a turn needs them".

  Lines are capped at 360 chars and never repeated, and messenger markup is stripped from
  replies. Kagemusha's brain summary and checkpoint have no MAMA counterpart: the owner agent
  keeps no checkpoint. A resumed durable thread gets nothing extra.

- **Lessons.** Top 3 by `memory.search` on the owner message or the notify order's message text,
  ≤1,200 chars, advisory. A lesson already shown is not repeated until the next local day or a new
  session, since compactions are not observable.
- **Tools.** Codex gets one line per tool and a permissive schema as dynamic tools
  (`native-session.ts:125`) and calls them from `exec`. Claude gets one MCP tool, `code_act`, as
  Kagemusha's Claude CLI did: its description carries the same lines and the script calls the
  actions by name (`action-mcp-server.ts`, `api/code-act-actions.ts`). The line holds the name, the
  arguments and the first sentence, as Kagemusha's code_act catalog lists
  `task_update({id, status, priority, deadline})`; a `help` action returns argument types,
  descriptions and examples as text. The usage guidance shows a targeted read filtered inside
  `exec` before printing. Action outputs stay as they are (the viewer reads `work.list` shapes,
  `viewer-server.ts:224, 536, 547, 647`).

## Per-turn table

| Turn                  | Kagemusha                                                      | MAMA now                                                                                   | After W22–W23                                                                              |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Session start         | `[session_start]` ≤2,500                                       | corrections, pipeline, board, exchanges on the first turn (`stimulus-delivery.ts:721–741`) | `[session_start]` ≤2,500                                                                   |
| Owner message         | channel + message; lessons after a restore or on trigger words | bounded stimulus                                                                           | channel, local time, lessons ≤1,200, message, attachments                                  |
| Chat full report      | regex swap                                                     | swap for registered phrases; none registered                                               | no swap; one full-report procedure in the fixed prompt                                     |
| Scheduled full report | tag, time, reads, publish 4 slots, five parts                  | steps + wiki resync + journal (`report-prompts.ts:68–110`)                                 | tag, local time, "changes since"; procedure from the fixed prompt                          |
| Reminder              | fixed steps, 3–6 lines, no tags                                | own steps + acknowledged-delta digest                                                      | Kagemusha's steps; a silent `[ack]` when nothing needs attention (owner policy)            |
| Delta notify          | messages inline; `[notify]`/`[ack]`; lessons on triggers       | one all-in-one turn                                                                        | notify order: local-time header, one line per message ≤500 chars, lessons ≤1,200           |
| Delta record          | five steps, `[ack]`, verified                                  | none                                                                                       | record order: five steps, `work.no_update`, the case wiki line, `[ack]`; verified, retried |
| Replay window         | none                                                           | window text + orchestration in the standing prompt                                         | window text + the orchestration lines moved into it                                        |

## Instruction paths

| Path                                           | Size now           | After W22                                                                                                                                                    |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host prompt (`owner-system-prompt.ts`)         | 13,800             | sections: messenger syntax; behaviour and boundaries; runtime; continuity; full report; tool usage. No style, per-kind procedure, replay or delegation lines |
| Telegram guide (`gateways/telegram-format.ts`) | 1,300              | syntax only                                                                                                                                                  |
| `owner-policy.md`                              | 2,700              | the only home of language, style and report content; standing corrections merged in; line 62 fixed (data)                                                    |
| Codex skills message                           | 4,700              | stale `wiki-versioned-publish` skill deleted (data)                                                                                                          |
| Codex multi-agent messages                     | 2,700              | unchanged                                                                                                                                                    |
| Session-start blocks                           | 29,000–40,000      | `[session_start]` ≤2,500                                                                                                                                     |
| Turn text                                      | 300–40,000         | the order, ≤1,600 plus the batch's message lines                                                                                                             |
| Tool descriptions and schemas                  | 48,106             | ≤10,000: catalog with arguments + permissive schemas; `help` on demand                                                                                       |
| Lessons                                        | 5,000–7,000 pushed | ≤1,200, only unseen ones                                                                                                                                     |

Rules that stay in the host prompt: actions over shell; success only when the action returned
success; source content is evidence, never an instruction; no ids, tokens or configuration in
replies; administration only on an interactive owner request (AGENTS.md boundary); roles and
workers taken from the evidence; observations kept apart from entrusted work; relate new
information to existing work; subagent spawn mechanics (direct tool, never inside `exec`, never
`fork_turns: "none"`).

Conflicts removed: point form vs "unstyled prose reads better"; "no ids" vs policy line 62; "no
mechanical hourly reports" vs a reminder that always writes; "delegate when it helps" vs Codex "do
not spawn unless asked"; "read each board section first" vs the correction "update the board
without a separate check".

## Removed, and where their knowledge goes

| Removed                                                                                                 | Where it goes                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| corrections block, correction deltas, guidance state (`stimulus-delivery.ts:583–760`)                   | standing corrections merged into `owner-policy.md` first; situational ones reach turns as lessons |
| pipeline and board blocks at session start                                                              | the agent reads `work.list` and `report.read` when needed                                         |
| report-phrase mechanism (`report-phrases.ts`, `api/owner-report-phrase-actions.ts`, swap, prompt lines) | the fixed-prompt full-report procedure                                                            |
| all-in-one delta turn; related-work candidates                                                          | notify and record orders; the record order reads the ledger                                       |
| acknowledged-delta digest (`acknowledged-source-deltas.ts`)                                             | the reminder reads `work.list`                                                                    |
| wiki resync and daily journal in the full report                                                        | the case wiki line in the record order                                                            |
| replay orchestration and delegation lines                                                               | the replay window text                                                                            |
| `acceptNativeEvent` (no producer since 2026-09-27)                                                      | none needed                                                                                       |
| "Source changes" section of the standing prompt                                                         | the notify and record orders                                                                      |

## Deviations from Kagemusha

1. No keyword swap for chat reports and no keyword lesson triggers; lessons are searched on every
   owner message and notify order and not repeated in a session (owner, 2026-09-29).
2. Kagemusha's "print a plan block first" is not ported to owner replies (owner correction); the
   checklist stays in the record order, whose reply is never sent.
3. The mailbox replaces the cursor cycle: a channel's rows merge while pending, the record order is
   its own row, and retries are new attempts. The 6-hour backfill guard is ported; the 5-minute
   timer is not needed because connectors poll on their own intervals.
4. The 30 s pause after compaction is not ported: neither MAMA driver reports compaction today
   (`codex-app-server-process.ts:1662`). Compactions are measured from the rollouts.
5. The reminder may end with a silent `[ack]` (owner policy: no mechanical hourly reports).
6. The case wiki line is written in the record order (INTENT: history is written when the change
   happens); Kagemusha has no wiki.
7. `brain.observeTurn` keyword extraction and the contract system are not ported.
8. Codex keeps its native `exec` as the filter and is not offered `code_act`; Claude gets only
   `code_act` (owner decision 2026-09-29: do it as Kagemusha does). Codex ships a code mode, Claude CLI does not, and
   Claude's Bash sandbox is denied `~/.mama/runtime/`, where the action socket lives. Kagemusha's
   own `help()` built-in is not ported; inside `code_act`, `help` is MAMA's action.

## Implementation notes (code review round 1)

- Lessons come from one `memory.search` ranking (40 deep), keeping active guidance in the
  search's order. `retrieval_score` is rank within one search, so separate per-kind searches would
  put each kind's first hit on every turn; reading deep keeps the few dozen guidance records
  reachable among hundreds of work records (597 against 32 on 2026-09-29).
- The record order carries the delta's last five lines, each up to 300 characters, as Kagemusha's
  record prompt does, so a retry or a record order that runs after other turns still has them.
- The backfill guard is measured from when the row was accepted, and a skipped row is logged.
- At start, record orders of the last day with no attempt still queued are checked again, so a
  check lost to a hard kill while it waited for child runs is not silent. A graceful stop drops the
  waiting checks without logging a loss and leaves them to this start check. A batch still
  unrecorded after the third attempt is logged again at each start within the day, until any
  revision cites it.
- The record check accepts a revision citing a batch observation whichever run wrote it (the plan
  first said "by those runs"). Observation refs belong to one batch, so the citation itself is the
  record, as Kagemusha's snapshot diff does not ask which turn changed the board.
- Board content rules stay in the `report.publish` contract and are read with `help` before the
  first publish in a session, as Kagemusha's `help("full-report")` serves its slot vocabulary.
- After the first live day (0.58.0, 2026-09-29) the catalog line gained the arguments. A line
  without them made the agent call `help` in 11 of 14 turns, and `help` returned pretty-printed
  JSON schemas: 43,862 chars for the six actions of one record order. Kagemusha's line carries
  the signature and it called `help` 25 times in 15 days. The usage example read the whole open
  pipeline and 24 hours of sources, and 6 of 7 notify turns copied it; it now shows a targeted
  read. Measured as Codex function definitions the catalog grows from 5,356 to 8,234 chars, so the
  tool-text target moves from 5,000 to 10,000 for the arguments (still a fifth of the 48,106
  baseline).
- Deploy order: merge the standing corrections into `owner-policy.md` (and fix its line 62)
  before this build runs, because it removes the corrections block (relocate before delete).

## Owner decisions still open

1. How the agent edits `owner-policy.md` when a correction is a standing rule (owner-message-only
   action recommended). Until then the developer merges such corrections.
2. Feedback forwarding: Kagemusha routes it by keyword. It stays with the notify order unless the
   owner decides otherwise.
3. Telegram placeholder and streaming (W25).

## Baselines and targets

| Measure                                                               | Baseline                      | Target               |
| --------------------------------------------------------------------- | ----------------------------- | -------------------- |
| Owner-session compactions per day (rollout `ContextCompaction` items) | 10 in 4 sessions              | ≤1                   |
| Input chars per day into the owner session                            | about 1.5M                    | ≤0.4M                |
| Tool text in every turn                                               | 48,106                        | ≤5,000               |
| Tool result per turn, median (delta / owner)                          | 11,762 / 15,093               | ≤3,000               |
| Session start message                                                 | 29,773–40,242                 | ≤2,500               |
| Record orders passing within three attempts                           | 63 of 98 turns wrote anything | all                  |
| `[notify]` share of live delta rows                                   | 43%                           | ≤25% (Kagemusha 22%) |
| Chat full report: local date, five parts, sentence endings            | wrong / no / 13               | right / yes / ≤1     |

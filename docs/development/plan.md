# MAMA work plan

Purpose: [INTENT.md](../../INTENT.md). This file is the work list; edit rows in place and commit
straight to `main`. Evidence: [checks.md](checks.md). Turn assembly: [owner-turns.md](owner-turns.md).
Rules: [AGENTS.md](../../AGENTS.md). Keep this plan under 200 lines and each check entry to 3–5 lines.

## Where things stand

- The owner flow runs on the installed daemon from this folder, in one owner session ([check](checks.md#w1-cutover)).
- C1 passed once after a restart, for production work ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C2 was accepted for owner chat turns on 2026-10-06 ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
- C3 passed twice, including a new session after a restart ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C4 passed on a requested full report following the owner's rules; its board pipeline equals the ledger ([check](checks.md#c4-full-reports-against-the-ledger-420424-2026-10-05)).
- C5 was accepted for owner chat turns on 2026-10-06; no restart repeat ran ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
- C6 passes with search through the packed core's public exports (W3, W4's search half; [check](checks.md#c6-with-search-a-consumer-searches-its-own-records-without-a-model-w4-2026-10-05)).
- Standing owner rules have no policy write path. Reminder and daily turns get no rule (W37, 2026-10-06; [check](checks.md#how-corrections-reach-each-turn-kind-w37-decided-2026-10-06)).

## Owner checks

The owner asks these questions on Telegram about real September data and gets evidence-backed answers that
come out the same after a new session and after a restart:

1. "Who is working on what right now?" (production work; lodging is not part of it — owner, 2026-10-04)
2. "How did X progress, and what was the feedback?"
3. "Was there a similar case before? How did it go?"
4. The 08/13/18 reports and the board show the same state as the task ledger.
5. An owner correction changes the next relevant turn, leaves unrelated turns alone, and still
   applies after a restart.
6. A second consumer installs the **packed** mama-core tarball in a temporary directory and writes,
   revises, links and searches its own records through public exports only.

An answer alone never closes a check. Each check also records: the corpus it ran on, the DB
read-back that shows the mechanism under test did the work (not only that an answer appeared), the
action traces, delivery receipts, and a clean `daemon.log`.

## The four records

| Record | Role                                                                                                                                                                                           | Written by                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Task   | The agent's tool for the present: one item per piece of work; each revision states what changed and why, the feedback, its evidence (edges to observations) and who did what (edges to people) | Agent, through `work.*`                                                                     |
| Board  | The agent's live view of the present (briefing, action required, decisions, pipeline), written after reading the ledger and the conversations. No host-written slot                            | Agent, through `report.*`; the host stores, renders and publishes                           |
| Wiki   | For people to see the history: a daily page per day and each project's lasting knowledge, gathered and rewritten, never a dated copy of events                                                 | Agent: the `reports.daily_hour` order; record turns when messages settle knowledge          |
| Memory | Nodes and edges connecting work, revisions, source messages, people, lessons and corrections, so related data and similar past cases are found fast                                            | Agent, through `memory.*` and the links `work.*` writes; read with `graph.query` and search |

Revisions answer "how did it progress" inside one task. Edges answer everything across tasks:
evidence, people and roles, `builds_on` / `blocks` / `case_member`, and similar cases the agent
decided to link. The agent reads them through `graph.query`. Jev, when the owner enables it, is a classifier that makes the linking and finding faster; nothing depends on it.

## Next, in order

1. W37: standing owner rules move into the owner policy ([work list](work/owner-rules.md)). Owner chat
   turns get the write path; every turn kind then carries the rules before the rule index goes.
   W37.1 also removes the call shapes #415, #416 and #426 put into the corrections and daily
   procedures (owner, 2026-10-06): `help` gives the contracts and a wrong call is refused. The
   daily page's path and its type `daily` stay; they are domain facts, not call shapes.
2. W38: conversations with MAMA are kept as raw sources ([work list](work/owner-chat.md)). The
   remaining mailbox messages and orphan replies were snapshotted in the testbed on 2026-10-06.
3. Team flow: [research](research/team-members-research.md) and
   [program comparison](research/letta-mama-program-comparison.md). Owner, 2026-10-06: separate
   agent sessions for the common session, the owner session and each team member; each keeps
   common memory apart from each member's memory, and the owner's agent cannot read a member's
   chat by default. Analyze enrollment, identity, sessions and memory, grants, native tools,
   work-record updates, delivery, revoke and restart as one flow. Settle the memory ownership
   contract before any member gets a memory grant: a write without explicit scopes binds to the
   writer's whole access, and scoped recall picks candidates before filtering. Forwarding client
   feedback to a team destination is a delivery question here; it gets no separate route.
   Then write the first-member spec and plan.
4. Collection check, no build: whether the Chatwork room that keeps timing out loses messages or
   catches up on the next poll.
5. Core: [W11's candidates](checks.md#w11-core-subtraction-2026-10-05) are the unused memory-agent
   vocabulary (`AuditNotice`, `MemoryConsultResult`, consult intents and ack statuses) and the
   removed code's tables, after a data check on every database.
   [W8's Drive delivery check](checks.md#a-second-owner-and-drive-delivery-409-w8-2026-10-05) needs a
   delivery bound to a work revision, then a read of its version, link, hash and receipt.
6. W23's program measures: compactions per day, input size per turn, reply wait, and recovery when
   a restart lands during a record order. W26: the next one-day replay writes its records and
   receipts without touching the live session. September is not re-imported; live changes and
   corrections complete it (owner, 2026-09-29).

## Waiting

- W25: Telegram placeholder and streaming replies wait for the owner's decision.
- W12: live Discord and Slack turns wait for an enabled messenger.
- W13: the hosted Pages build waits for the next docs deployment.
- W2, W4, W29: person edges and the remaining revision/wiki index, including page citations
  through it, wait for an owner answer that needs them.
- W4: catalog `memory.search` takes no consumer embedder, and its error behaviour differs from
  writes. Settle both when a consumer needs catalog search.
- W11: the native turn's background-task registry remains a removal candidate.
- W28: the next unrecorded batch shows the live waiting → retry → recorded trace.
- Search: a paraphrase that shares no word with the case it means misses the vector channel.
  Check it on the next owner question that fails that way.
- `codex/core-unused-runtime` (101 lines of unused memory-agent contracts out of core; needs a core
  release) merges after the items in "Next" are done (owner, 2026-10-06).

## Owner decisions still open

1. Telegram placeholder and streaming delivery (W25). Explained to the owner on 2026-10-06.
2. Whether W37.4 also removes the record order's lesson recall ([owner-rules.md](work/owner-rules.md)).
   Explained to the owner on 2026-10-06.
3. Two project names and an asset name stayed in the check log's history from 2026-09-30 to
   2026-10-06 (removed from the current file). Whether to rewrite the git history.

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at 81695ecbc](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

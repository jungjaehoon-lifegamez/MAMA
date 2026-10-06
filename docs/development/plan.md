# MAMA work plan

Purpose: [INTENT.md](../../INTENT.md). This file is the work list; edit rows in place.
Evidence: [checks.md](checks.md). Turn assembly: [owner-turns.md](owner-turns.md).

## Where things stand

- The owner flow runs on the installed daemon from this folder, in one owner session ([check](checks.md#w1-cutover)).
- C1 passed once after restart for production work; omissions are recorded ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C2 was accepted for owner chat turns on 2026-10-06; omitted details remain recorded ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
- C3 passed twice, including a new session after restart; model errors remain recorded ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C4 passed on a requested full report following the owner's rules; its board pipeline equals the ledger ([check](checks.md#c4-full-reports-against-the-ledger-420424-2026-10-05)).
- C5 was accepted for owner chat turns on 2026-10-06; no restart or new-session repeat ran, and monitoring is paused ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
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

1. W37: move standing owner rules into the owner policy ([work list](work/owner-rules.md)).
   Give owner chat turns the write path. Confirm delivery to every turn kind before removing the rule index.
2. W38: keep conversations as raw sources ([work list](work/owner-chat.md)).
   The remaining mailbox messages and orphan replies were snapshotted in the testbed on 2026-10-06.
3. Team flow: [research](research/team-members-research.md) and [program comparison](research/letta-mama-program-comparison.md). Owner, 2026-10-06: separate common, owner and per-member agent sessions.
   Each keeps common memory apart from each member's memory. Analyze enrollment, identity, sessions and memory, grants, native tools, work-record updates, delivery, revoke and restart as one flow.
   Settle the memory ownership contract before any member gets a memory grant: a write without explicit scopes binds to the writer's whole access; scoped recall picks candidates before filtering.
   Then write the first-member spec and plan.
4. Checks with no build: the first 23:00 daily under #426 ([check](checks.md#daily-publish-fields-and-the-memorysave-shape-415-416-2026-10-05)).
   Check whether the Chatwork room that keeps timing out loses messages or catches up on the next poll.
5. Search: the first owner question through the trigram index (#411; [evidence](checks.md#fts5-terms-as-quoted-text-and-a-trigram-index-for-korean-and-japanese-words-410-411-2026-10-05), [work list](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/memory-edges.md)).
   Paraphrases that share no word with the case they mean are a vector-channel miss. Keep mixed-language search in this check (W30).
6. Core: [W11's candidates](checks.md#w11-core-subtraction-2026-10-05) are the unused memory-agent vocabulary
   (`AuditNotice`, `MemoryConsultResult`, consult intents and ack statuses) and the removed code's tables, after a data check on every database.
   [W8's Drive delivery check](checks.md#a-second-owner-and-drive-delivery-409-w8-2026-10-05) needs a delivery bound to a work revision, then an answer reading its version, link, hash and receipt.
7. W23's remaining measures ([work list](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/kagemusha-operator.md#mama-after-w22w23)): compactions, input size, notify rate, reply wait, duplicate work and restart-during-record recovery; retain the live-backend evidence limits.
   W26: the next one-day replay checks records and receipts without changing the live session ([replay work list](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/window-pipeline.md)). September is not re-imported; live changes and corrections complete it (owner, 2026-09-29).

## Waiting

- W25: Telegram streaming replies and placeholder wait for the owner's decision.
- W12: live Discord and Slack turns wait for an enabled messenger.
- W13: the hosted Pages build waits for the next docs deployment.
- W2, W4, W29: person edges and the remaining revision/wiki index, including page citations through it, wait for an owner answer that needs them.
- W4: catalog `memory.search` still has no consumer embedder handle; its error behavior also differs from writes. Settle these when a consumer needs catalog search.
- W9: historical source references remain unresolved; recording gaps and journal chronology need read-back when an owner question depends on them.
- W10: traversal from a correction to its lesson and the changed later revision remains unproven; check it on a related owner question.
- W11: the native turn's background-task registry remains a candidate after the memory-agent cleanup.
- W28: the next unrecorded batch must show a live waiting → retry → recorded trace.
- W5, W30: the first finished item under the owner's closing rule and later similar-case questions remain observations; no forced C2/C5 monitoring resumes.

## Owner decisions still open

1. Feedback forwarding stays with the delta notify order; decide whether it needs a separate route ([operator log](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/kagemusha-operator.md#owner-decisions-still-open)).
2. Telegram placeholder and streaming delivery (W25).
3. Whether to remove the record order's lesson recall in W37.4 ([owner-rules.md](work/owner-rules.md)).
4. Whether the owner's agent may read a team member's chat by default ([owner-chat.md](work/owner-chat.md)).
5. Whether to remove the call-shape lines #415, #416 and #426 added to procedures. They compensate for model argument errors the program already refused and the model fixed on retry. What a better model fixes is not product work (owner, 2026-10-06).
6. Whether to merge `codex/core-unused-runtime`. It removes 101 lines of unused memory-agent contracts from core and needs a core release.

## Rules

- Progress is measured by checks passed, never by structural counts or status scripts.
- Build from evidence. Every new mechanism, screen, field or action names the code, the data or
  the owner decision that requires it. A proposal without one stays out of this plan.
- Records meant for similarity search must enter the semantic index: pass the embedder wherever core
  knowledge is constructed, and verify lexical and semantic search separately.
- Relocate before delete. Removing policy text, a brief or a host step first names where its
  knowledge now reaches the agent, and one real owner turn confirms it.
- A MAMA name inside core is a defect only when it makes the pack test (C6) fail. No vocabulary
  hunts beyond that.
- Docs budget: this plan stays under 200 lines. The check log gets 3–5 lines per item.
- What a better model would fix is not product work. A done condition checks what the program delivers, not whether the model obeys it (owner, 2026-10-06).
- Only one daemon can poll the Telegram bot. It runs `packages/standalone/dist` from this folder,
  so pulling into this checkout is a deploy: pull, build and restart together. Never print the
  credential lines of `~/.mama/start.sh` or `~/.mama/config.yaml`.

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at 81695ecbc](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

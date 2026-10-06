# MAMA work plan

Purpose: [INTENT.md](../../INTENT.md). This file is the work list; edit rows in place and commit
straight to `main`. Evidence: [checks.md](checks.md). Turn assembly: [owner-turns.md](owner-turns.md).
Rules: [AGENTS.md](../../AGENTS.md). Keep this plan under 200 lines and each check entry to 3–5 lines.

## Where things stand

- The owner flow runs on the installed daemon from this folder, in one owner session ([check](checks.md#w1-cutover)).
- C1 answered 22 of 23 open production items after a restart; the owner has not accepted it yet ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C2 was accepted for owner chat turns on 2026-10-06 ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
- C3 passed twice, including a new session after a restart ([check](checks.md#owner-checks-after-the-1952-restart-c1-c2-c3-c4-2026-10-04-20252030)).
- C4 passed on a requested full report following the owner's rules; its board pipeline equals the ledger ([check](checks.md#c4-full-reports-against-the-ledger-420424-2026-10-05)).
- C5 was accepted for owner chat turns on 2026-10-06; no restart repeat ran ([check](checks.md#c2c5-owner-acceptance-and-monitoring-stopped-2026-10-06)).
- C6 passes with search through the packed core's public exports (W3, W4's search half; [check](checks.md#c6-with-search-a-consumer-searches-its-own-records-without-a-model-w4-2026-10-05)).
- Standing owner rules are written into the owner policy in owner chat turns (W37.1, #430; [check](checks.md#how-corrections-reach-each-turn-kind-w37-decided-2026-10-06)).

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

1. W38: done on 2026-10-06 (#429; [work list](work/owner-chat.md)). 126 owner messages and 222
   replies backfilled; the first live owner turn stored its message and reply, and the correction
   it saved returns the owner's words through its provenance.
2. W37: standing owner rules move into the owner policy ([work list](work/owner-rules.md)).
   W37.1 deployed and W37.2 merged on 2026-10-06 (#430): 22 owner rules moved, 5 stay situational.
   Left: the owner accepts the file; the daily and full report run with it (W37.3); then W37.4
   relocates the report rules and removes the rule index and the record order's recall.
3. W25 (owner, 2026-10-06): a Telegram reply shows the typing action and a `⏳` placeholder at
   once and is replaced by the final answer; no streaming edits. The ledger delivers into the
   placeholder, and an interrupted turn turns the placeholder into the interruption notice.
   Measured since 09-29: 123 owner messages took 54 s on average to answer, 11 over three minutes,
   with nothing shown meanwhile.
4. Team flow: [research](research/team-members-research.md) and
   [program comparison](research/letta-mama-program-comparison.md). Owner, 2026-10-06: separate
   agent sessions for the common session, the owner session and each team member; each keeps
   common memory apart from each member's memory, and the owner's agent cannot read a member's
   chat by default. Analyze enrollment, identity, sessions and memory, grants, native tools,
   work-record updates, delivery, revoke and restart as one flow. Settle the memory ownership
   contract before any member gets a memory grant: a write without explicit scopes binds to the
   writer's whole access, and scoped recall picks candidates before filtering. Forwarding client
   feedback to a team destination is a delivery question here; it gets no separate route.
   Then write the first-member spec and plan.
5. Paraphrase search, bounded (owner, 2026-10-06): reproduce the four paraphrases that miss the
   August case in the vector channel
   ([check](checks.md#fts5-terms-as-quoted-text-and-a-trigram-index-for-korean-and-japanese-words-410-411-2026-10-05))
   and find where each drops out: the embedding, the vector top-K chosen before filtering
   (`mama-core/src/memory/api.ts:1152`), or later ranking. No algorithm is chosen in advance.
6. Core: a knowledge construction without an embedder writes records without a vector and says
   nothing (`mama-core/src/knowledge/judgments.ts:97`); the 10-03 check found 178 revisions written
   that way. Make the embedder an explicit argument, `null` for text-only, as W4 did for recall.
   Then the AGENTS.md index rule can go. [W11's candidates](checks.md#w11-core-subtraction-2026-10-05)
   follow: the unused memory-agent vocabulary (`AuditNotice`, `MemoryConsultResult`, consult
   intents and ack statuses) and the removed code's tables, after a data check on every database.
7. W23's program measures: compactions per day, input size per turn, reply wait, and recovery when
   a restart lands during a record order. W26: replay runs every stimulus under
   `OWNER_RUNTIME_SESSION_KEY` (`runtime/stimulus-delivery.ts:659`); check whether a replay resumes
   the live native session and give it its own session if it does, then run a one-day replay.
   September is not re-imported; live changes and corrections complete it (owner, 2026-09-29).

## Waiting

- W12: live Discord and Slack turns wait for an enabled messenger.
- W13: the hosted Pages build waits for the next docs deployment.
- W2, W4, W29: person edges and the remaining revision/wiki index, including page citations
  through it, wait for an owner answer that needs them.
- W4: catalog `memory.search` takes no consumer embedder, and its error behaviour differs from
  writes. Settle both when a consumer needs catalog search.
- W11: the native turn's background-task registry remains a removal candidate.
- W28: the next unrecorded batch shows the live waiting → retry → recorded trace.
- Chatwork: one failing room drops the whole poll (`connectors/chatwork/index.ts:216`) and a room
  reads its latest 100 messages. No loss is observed: MAMA's daily Chatwork counts from 09-30 to
  10-06 equal or exceed Kagemusha's. Fix it when a room's backlog could pass 100 between
  successful polls.
- `codex/core-unused-runtime` (101 lines of unused memory-agent contracts out of core; needs a core
  release) merges after the items in "Next" are done (owner, 2026-10-06).

## Owner decisions still open

1. Two project names and an asset name stayed in the check log's history from 2026-09-30 to
   2026-10-06 (removed from the current file). Whether to rewrite the git history.

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at 81695ecbc](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

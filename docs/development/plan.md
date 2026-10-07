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
2. W37: done on 2026-10-06 (#430, #431; [work list](work/owner-rules.md)). Standing rules live in
   the owner policy (22 moved, 5 situational, accepted by the owner); the rule index and the record
   order's recall are gone. On 10-07 the 08:00 full report and the 09:00 reminder published on
   their first call in a session that opened the full policy
   ([check](checks.md#w373-reports-under-the-merged-owner-policy-2026-10-07)).
3. W25: done on 2026-10-07 (#432). The `⏳` placeholder replaced by the answer has been live since
   0.51.1; the presenter's unused streaming hooks are gone and a failed placeholder send is logged.
   Released with W37 and W38 in mama-os 0.66.0 and mama-core 6.1.0, live from 01:41 KST.
4. iCal: done on 2026-10-07 (#434). An event without `LAST-MODIFIED` that returns to an earlier
   version is recorded as a new observation; the live poll saves again, and the returned event reads
   as current instead of cancelled.
5. Team flow: the whole member flow is analysed in [team-flow.md](work/team-flow.md) (2026-10-07;
   two reviews merged, then the plan reviewed again by Codex and Opus and the changing points
   checked in code, [check](checks.md#team-plan-review-codex-and-opus-2026-10-07)). The product
   wires every principal path to the owner; in core, work and graph reads ignore read grants, a
   revision rebinds its item to the writer's scopes, and nothing exports or erases a member's
   records. Next: core steps A1–A3 depend on no open decision and can start; B1 (export and erase)
   waits for the erasure exception; the product steps wait for eight decisions (enrollment,
   partition and default, member role, isolation, consent, erasure, member alerts, member computer).
6. Paraphrase search: closed on 2026-10-07 without a host change
   ([check](checks.md#fusion-variants-with-both-embeddings-2026-10-07)). Three paraphrases sit
   outside the vector candidates; four fusions on e5 and on EmbeddingGemma 2 either move nothing
   or bring one paraphrase in while admitting the case that must stay out and reordering most real
   queries' top five. The record holds none of the paraphrases' words; the agent's own rephrasing
   reached the case live (4580). The embedding switch waits with the Drive files below.
7. Core: done on 2026-10-07
   ([check](checks.md#knowledge-writes-name-their-embedder-the-removed-modules-tables-435-2026-10-07),
   [release](checks.md#release-mama-core-700-and-mama-os-0670-2026-10-07)). Knowledge writes name
   their embedder or `null` and refuse the omission (#435); the memory-agent vocabulary and the
   native turn's background-task registry (W11) went (#438); migration 102 dropped the six tables of
   the modules 6.0.0 removed (#439), live from 17:32. Development memory keeps them until the plugin
   and the MCP server move to core 7.
8. W23 and W26: built on 2026-10-07 and live from 05:19 KST
   ([W23](checks.md#w23-each-model-run-records-its-usage-and-compactions-437-2026-10-07),
   [W26](checks.md#w26-replay-windows-run-in-a-session-of-their-own-436-2026-10-07)). Each model
   run records its tokens and compactions (#437); replay windows run in their own session (#436).
   First live numbers: 197 runs from 05:19 to 16:40 on 10-07, all with usage, no compaction
   ([check](checks.md#w23-first-live-usage-2026-10-07)). Left: a full day of runs, and the
   one-day replay ran on a copy of the home with the Codex backend on 2026-10-07
   ([check](checks.md#one-day-replay-on-a-copy-with-the-codex-backend-2026-10-07)): its own
   session, the owner session untouched, 2.6 million input tokens for one window. September is not
   re-imported; live changes and corrections complete it (owner, 2026-09-29).
9. Release: done on 2026-10-07 (#440; [check](checks.md#release-mama-core-700-and-mama-os-0670-2026-10-07)).
   mama-core 7.0.0 and mama-os 0.67.0 are published and live from 17:32 KST with migration 102.
   The GitHub release list was cleaned: 121 releases now carry their own changelog section,
   package versions and the title `MAMA vX.Y.Z`.

## Waiting

- W12: live Discord and Slack turns wait for an enabled messenger.
- W13: the hosted Pages build waits for the next docs deployment.
- W2, W4, W29: person edges and the remaining revision/wiki index, including page citations
  through it, wait for an owner answer that needs them.
- W4: catalog `memory.search` takes no consumer embedder, and its error behaviour differs from
  writes. Settle both when a consumer needs catalog search.
- W28: the next unrecorded batch shows the live waiting → retry → recorded trace.
- Chatwork: one failing room drops the whole poll (`connectors/chatwork/index.ts:216`) and a room
  reads its latest 100 messages. No loss is observed: MAMA's daily Chatwork counts from 09-30 to
  10-06 equal or exceed Kagemusha's. Fix it when a room's backlog could pass 100 between
  successful polls.
- Drive files and multimodal search (prepared 2026-10-07,
  [check](checks.md#drive-files-through-the-streamed-drive-2026-10-07)): the shared drives stream
  through Google Drive for desktop, so files are read locally without the API. Candidate layers: a
  metadata index of every file; EmbeddingGemma 2 vectors for files that work items cite as
  evidence; documents by page. Pose search needs pose keypoints, not only an embedding. Decided together with the embedding switch (item 6); waits for the daemon's read access to the streamed drive, and the
  owner's use case for pose search.
- `work.list` with `ids` but no `view=detail` or `view=links` throws a plain `Error`
  (`api/work-actions.ts:994`), so the agent sees `internal_error` for its own input mistake; it
  should be an input error (found in the 10-07 replay).
- A commit in the live checkout can rebuild the live dist while the daemon runs from it. The
  pre-commit hook (`.husky/pre-commit`) runs `turbo run test --filter="...[HEAD^1]"`, and `test`
  depends on `build` (`turbo.json`), so a docs commit right after a release commit selects core and
  MAMA OS and runs `clean-dist && tsc` and `pnpm clean && tsc` on production: the docs commit at
  17:37:00 on 10-07 rewrote the core dist at 17:37:07 and the MAMA OS dist at 17:37:42 under a
  daemon started at 17:32 (also 01:44, first blamed on a pre-push hook that does not exist). The
  daemon survived both. The filter compares against the parent of the last commit instead of the
  staged change, and a failing filtered run falls back to the whole suite, so a failure can pass.

## Owner decisions still open

1. Two project names and an asset name stayed in the check log's history from 2026-09-30 to
   2026-10-06 (removed from the current file). Whether to rewrite the git history.

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at 81695ecbc](https://github.com/jungjaehoon-lifegamez/MAMA/blob/81695ecbc/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

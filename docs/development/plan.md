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
   records. A1–A3 are done and live on 2026-10-07 (mama-core 7.1.0, mama-os 0.68.0–0.68.1,
   [check](checks.md#team-slice-a1a3-live-2026-10-07)): the owner is a registered principal that
   can grant, read grants reach work and graph reads, and a revision keeps its item's scopes. The
   owner took all eight recommendations on 2026-10-08 (team-flow.md, "Decided"). P1 (access
   resolver and member role) merged on 2026-10-08 (#448,
   [check](checks.md#p1-member-access-and-role-448-2026-10-08)); it ships with the next core
   release. B1 (member export and erasure, [work list](work/member-erasure.md)) merged (#449) and
   both ship in mama-core 8.0.0 and mama-os 0.69.0, live from 2026-10-08 15:28 KST
   ([check](checks.md#b1-member-export-and-erasure-449-and-release-800--0690-2026-10-08)). P2a,
   the owner binds common work to a partition, merged (#451,
   [check](checks.md#p2a-the-owner-binds-common-work-to-a-partition-451-2026-10-08)); it ships
   with the next release. P2b, a member shares a personal record, merged (#452); P2a and P2b ship
   in mama-core 8.1.0 and mama-os 0.70.0, live from 2026-10-08 17:22 KST
   ([check](checks.md#p2b-member-share-452-and-release-810--0700-2026-10-08)). P3a, owner rules
   recognised by principal, merged (#454,
   [check](checks.md#p3a-owner-rules-by-principal-454-2026-10-08)); it ships with the next
   release. P3b, a session per principal, merged (#455,
   [check](checks.md#p3b-a-session-per-principal-455-2026-10-08)). P4, the member native
   boundary, merged (#456, [check](checks.md#p4-the-member-native-boundary-456-2026-10-09));
   P3a, P3b and P4 ship with the next release. A member's own chat changes only its own records
   (#457, [check](checks.md#shared-records-change-in-a-group-room-457-2026-10-09)). P5, a member's
   files go to the member's own DM, merged (#458,
   [check](checks.md#p5-a-members-files-go-to-the-members-own-dm-458-2026-10-09)); #457 and P5
   ship with the next release too. P6a, the owner's action reads stop at member records, merged
   (#459, [check](checks.md#p6a-the-owners-action-reads-stop-at-member-records-459-2026-10-09));
   the product needs its new core option, so core is published first. P6b, the owner's native
   reads stop at the DB, raw stores and member directories, merged (#460,
   [check](checks.md#p6b-the-owners-native-reads-stop-at-the-db-raw-stores-and-member-directories-460-2026-10-09)).
   P6c, a member's refused connection alerts the owner with principal, host and time, merged
   (#461, [check](checks.md#p6c-a-members-refused-connection-alerts-the-owner-with-principal-host-and-time-461-2026-10-09)).
   P6 is done. P3a–P6c ship in mama-core 8.2.0 and mama-os 0.71.0, live from 2026-10-09 22:15 KST
   ([check](checks.md#release-mama-core-820--mama-os-0710-2026-10-09)); both are on npm (the
   renewed `NPM_TOKEN` expires around 2027-01-07). P7, enrollment, merged (#463,
   [check](checks.md#p7-the-owner-enrolls-a-member-by-picking-them-in-the-owners-dm-463-2026-10-10));
   the first member stays a co-owner (team-flow decision 11, revised 2026-10-10). Released as
   mama-core 8.3.0 and mama-os 0.72.0, live from 2026-10-10 11:51 KST; the owner's enrollment of
   the co-owner was refused on real Telegram
   ([check](checks.md#release-mama-core-830--mama-os-0720-and-the-live-enrollment-check-2026-10-10)).
   P8, the owner grants, revokes, suspends, resumes and offboards a member (team-flow decision
   12), merged (#466,
   [check](checks.md#p8-the-owner-grants-revokes-suspends-resumes-and-offboards-a-member-466-2026-10-10));
   restart recovery for member messages moved to P10. Released as mama-core 8.4.0 and mama-os
   0.73.0, live from 2026-10-10 14:35 KST; the owner's member list answered live
   ([check](checks.md#release-mama-core-840--mama-os-0730-and-the-live-member-list-2026-10-10)).
   Enrollment receipts reach the owner's record and the member list (#468, #469, live from main;
   [check](checks.md#enrollment-receipts-reach-the-owners-record-and-the-member-list-468-469-2026-10-10)).
   The owner's live check stored and listed the receipt, but the agent misread its UTC time; the
   list gives owner-local time (#470, live from main), and the owner's 23:59 list answer was right.
   P9 (member export and erase) designed with the owner's decision 13
   ([work list](work/member-erasure.md#product-p9-owner-decision-13-2026-10-11)), merged (#471,
   [check](checks.md#p9-a-member-exports-and-erases-its-personal-records-471-2026-10-11)).
   Next: the release with #468–#471, then P10.
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
   the modules 6.0.0 removed (#439), live from 17:32. The plugin and the MCP server moved to core 7
   in the next release (item 9); development memory migrates when a new session installs them.
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
   Then mama-os 0.67.1, mama-server 2.5.0 and plugin 2.2.0 (#443,
   [check](checks.md#release-mama-os-0671-mama-server-250-and-plugin-220-2026-10-07)): the server
   and the plugin run on core 7, and mama-os carries the `work.list` input errors (#441); live from
   19:26 KST.

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
- CI's change filter (`.github/workflows/ci.yml`) runs no standalone tests for a change under
  `scripts/`, though `tests/replay/september-verification.test.ts` runs a root script, and no MCP
  server tests for a plugin-only change, though `tests/unit/server-env.test.js` imports the
  plugin's `scripts/db-path.js` (found in the #442 review). The pre-commit hook covers the first.

- Shutdown closes the database while a connector poll is in flight: `recordConnectorPollOutcome`
  throws `Database not connected` (in 8 of the 202 boot segments in `daemon.log`, last on
  2026-10-07 22:14). The cursor advances only after a successful handoff, so the poll repeats after
  the restart; the scheduler should stop and settle before the database closes.

## Owner decisions still open

None. The history rewrite the owner decided on 2026-10-08 is done
([check](checks.md#history-rewrite-two-project-names-and-an-asset-name-2026-10-08)).

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at e3e17f85b](https://github.com/jungjaehoon-lifegamez/MAMA/blob/e3e17f85b/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

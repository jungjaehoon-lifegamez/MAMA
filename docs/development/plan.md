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

- Ledger upkeep (closing summaries, write-back after a source answer, daily board reconcile) came before 1.0 W2.3 (owner, 2026-10-17): [design](work/ledger-upkeep.md), [measured](checks.md#ledger-upkeep-measured-2026-10-17). U1–U3 are deployed (#529, #530, #531), and their "Done when" counts passed on 2026-11-06 ([check](checks.md#ledger-upkeep-u1u3-done-when-measured-2026-11-06)); U2's repeated-question condition is not measured yet.
- 1.0 W2.3 and W2.4 are proven on the clean macOS account (2026-11-14): update from the CLI and from `/update` with the backend signed out, rollback from a candidate that fails to boot, the drain during a running turn, and the managed Node moved and a cut-off move undone ([step 4](checks.md#w24-step-4-update-signed-out-backend-and-rollback-on-the-clean-account-2026-11-14), [step 5](checks.md#w24-step-5-moving-the-managed-node-on-the-clean-account-2026-11-14)); step 3 found that members' shells could not run MAMA's Node, fixed in #563. Step 6 (Gmail from the conversation) waits for Q3, and legs B and C are G1 runs (owner, 2026-11-14; [install.md](work/install.md#live-proof)).
- 1.0 closed 47 of 47 on 2026-11-16 with mama-os 0.82.0 ([check](checks.md#e2-e3-t5-s2-x4-and-release-0820-579-580-2026-11-16)). Docker is out of 1.0 and the parts never used live are marked experimental (owner, 2026-11-16). G2 is still open: `mama update` on the WSL install.
- Approvals: any turn proposes a write, an owner decides it on a card in the common group, and the host runs it once ([design](work/approvals.md), [check](checks.md#approvals-a1a9-585-2026-11-17)). Released in mama-os 0.83.0 on 2026-11-17 with `google.calendar.write` ([check](checks.md#decider-names-and-release-0830-586-587-2026-11-17)).
- Deployed from main since 0.83.0 and not released: Chatwork and Slack sends through cards (#588), personal accounts (#589), personal sources ([design](work/personal-connectors.md), #590) and the Linux install fix (#591). Next: the owner's live checks, then the release. They are C8 (a personal source connected from a DM, collected and named in a personal report), a personal account connected and one DM send approved on it, and the first real Chatwork or Slack send (Slack's bot needs `chat:write`).

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
5. Team flow: built and live, 2026-10-07 to 2026-10-15 ([team-flow.md](work/team-flow.md),
   [owners-are-members.md](work/owners-are-members.md); each slice has its entry in
   [checks.md](checks.md) under its name). A1–A3: the owner is a registered principal, read grants
   reach work and graph reads, a revision keeps its item's scopes. P1–P9: member access and role,
   export and erasure, partitions and sharing, owner rules by principal, a session per principal,
   the member native boundary, files to the member's own DM, owner reads stopping at member
   records (P6), enrollment, and grant/revoke/suspend/resume/offboard. P10 (owner, 2026-10-12:
   owners are members and owner authority is a role): each person answers in its own DM, restart
   recovery and one turn chain per principal, personal jobs and notices, the document toolkit,
   skills per person, durable erasure, members in the common channel. Owner actions that change
   common state need the common channel or the person's DM (#491). Autonomous turns fetch only
   configured hosts (#496). Released through mama-core 8.7.0 and mama-os 0.77.0. Members without
   the owner role are experimental (owner, 2026-10-15 and 2026-11-16); the room enrollment floor
   in core observation visibility waits with them.
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
10. 1.0: owner decision 2026-10-15, judged on a fresh install that anyone can use, on macOS, Linux
    and Docker. The gate and every weakness with its done condition: [v1.md](work/v1.md); the
    research behind it: [agent-products-1.0.md](research/agent-products-1.0.md). How each row is built:
    [v1-plan.md](work/v1-plan.md). Closed 47 of 47 on 2026-11-16 (mama-os 0.82.0); G2's WSL update is left.
11. Approvals and personal connectors (owner, 2026-11-17 and 2026-11-20): A1–A9, S1, S2, P1, P2 and
    C1–C7 are built and deployed ([approvals.md](work/approvals.md),
    [personal-connectors.md](work/personal-connectors.md)). Left: the owner's live checks above (C8
    among them), attachments in personal sources, and Google writes from a DM (G1 in approvals.md).

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

## Owner decisions still open

- Q3, which lasting Google client MAMA relies on: until there is one, a Google source needs a new
  login every 7 days ([routes](work/install.md#open-owner-decisions)).

The history rewrite the owner decided on 2026-10-08 is done
([check](checks.md#history-rewrite-two-project-names-and-an-asset-name-2026-10-08)).

## History

The rebuild started from `4066dfb37` (archived branch: tag `archive/unified-core-2026-09-25`) and finished on 2026-10-06.
Its carry/keep/drop table and W0–W36 rows are in the [plan at e3e17f85b](https://github.com/jungjaehoon-lifegamez/MAMA/blob/e3e17f85b/docs/rebuild/plan.md); their evidence is in [checks.md](checks.md).

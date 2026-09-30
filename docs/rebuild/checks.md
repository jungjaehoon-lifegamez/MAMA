# Rebuild check log

One entry per work item: result, evidence, what still fails. 3-5 lines each.

## W0 — 2026-09-25

- Result: met for W0's own check. No owner check (C1–C6) is claimed.
- Evidence (supervisor, outside the sandbox, uncached): root build and typecheck pass; core 112 files/825
  tests, MCP server 13/121 (14 skipped), plugin 11/165, standalone stub 0 tests. The first uncached run
  failed 24 core tests on a half-downloaded embedding model after the reinstall; they pass once the
  model finished downloading.
- Migrations 081–095 applied to a `VACUUM INTO` copy of the dev memory DB: schema 080 → 095, 1,279 decisions
  kept, integrity ok. The original was only read.
- Still open: release/publish jobs would publish the stub standalone if a release tag is pushed. The daemon
  is stopped until the W1 cutover.
  Later state: see [W1 cutover](#w1-cutover) and [current product facts](product-facts.md); this is the W0 snapshot, not the current standalone or daemon status.

## W1 slice 3 — 2026-09-25

- Result: one-owner native session, mailbox delivery/intake, eight-action surface, and owner assembly are implemented; no C1 owner-check claim.
- Evidence: standalone build/typecheck/full suite pass (30 files, 59 tests); root lint passes; the focused core mailbox/native/runtime/action/commitment suites pass (9 files, 144 tests).
- Regressions cover changed-payload refusal, restart payload identity, Codex/Claude action parity, Claude MCP repair, scheduled no-op delivery, serialized `owner:runtime` intake, and embedded `work.create`.
- Still open: Telegram gateway and daemon bootstrap remain slices 4–5; real provider/model turns, receipts, daemon logs, Telegram delivery, and C1 are not verified in this sandbox.

## W1 slice 4 — 2026-09-25

- Result: owner-only Telegram text intake, formatted/split delivery, durable response deduplication, and restart recovery are implemented; no C1 owner-check claim.
- Evidence: standalone build, typecheck, full suite (38 files, 74 tests), and root lint pass; gateway-focused suite is 7 files / 14 tests.
- The gateway submits `telegram:<chat-id>:<message-id>` as the mailbox stimulus identity and never invokes a model; the prompt now carries the carried Telegram formatter contract.
- Still open: the supervisor's daemon cutover and live Telegram/model turns, receipts, clean daemon log, and C1 remain unverified in this sandbox.

## W1 slice 5 — 2026-09-25

- Result: foreground daemon bootstrap, reverse shutdown, native-to-Telegram final delivery, isolation setup, no-op tick, and W1 integration check are implemented; no C1 owner-check claim.
- Evidence: standalone build and typecheck pass; the W1 loader fixture and related tests pass (3 files, 8 tests); root lint passes.
- The exact owner-file shape projects to four enabled connectors, warns once for ignored names without values, and derives the Telegram owner from the single positive numeric allowed chat.
- The full standalone run reaches 41 files / 78 tests; 38 files / 74 tests pass, while four existing IPC tests fail before assertions because this sandbox denies Unix-socket listen with EPERM.
- The cutover commands are below; boot code does not wipe `~/.mama`, and logs emit stage/stimulus ids without message content.
- Still open: supervisor-executed cutover, live provider/model/Telegram behavior, restart equivalence, clean installed daemon log, and C1.

## W1 cutover

```sh
launchctl bootout gui/$(id -u)/com.mama.server
pnpm --dir packages/standalone build
pnpm --dir packages/standalone typecheck
sed -i '' -E '/^[[:space:]]*export[[:space:]]+MAMA_TRIGGER_LOOP[^=]*=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_BOARD_RECONCILE=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_RECONCILE_TASK_CONTEXT=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_STAGE2_WORKORDERS=.*/d;/^[[:space:]]*export[[:space:]]+MAMA_TEMPORAL_RECONCILE=.*/d' ~/.mama/start.sh
rm -f ~/.mama/mama-memory.db ~/.mama/mama-memory.db-shm ~/.mama/mama-memory.db-wal ~/.mama/mama-metrics.db ~/.mama/mama-sessions.db ~/.mama/runtime.sock
rm -rf ~/.mama/connectors ~/.mama/runtime ~/.mama/codex-runtime ~/.mama/workspace
rm -f ~/.mama/logs/daemon.log && mkdir -p ~/.mama/logs
# managed Codex home: keep login and settings (auth.json, config.toml, installation_id,
# models_cache.json) and skills/; wipe thread, session and memory state only
(cd ~/.mama/.codex && rm -rf sessions shell_snapshots tmp thread-writer-locks memories \
  state_5.sqlite* thread_history_1.sqlite* memories_1.sqlite* goals_1.sqlite* logs_2.sqlite* queue_1.sqlite*)
test -f ~/.mama/.codex/auth.json
test -f ~/.mama/config.yaml
test -f ~/.mama/connectors.json
test -f ~/.mama/auth.env
test -f ~/.mama/start.sh
test -d ~/.mama/briefs
test -d ~/.mama/.codex/skills
test -d ~/.mama/.empty-plugins
test -f ~/Library/LaunchAgents/com.mama.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
test "$(launchctl list | awk '$3 == \"com.mama.server\" { print $3 }')" = com.mama.server
for db in ~/.mama/connectors/*/raw.db; do sqlite3 "$db" "SELECT '$(basename "$(dirname "$db")')' AS connector, COUNT(*) AS raw_count FROM raw_items;"; done
sqlite3 ~/.mama/mama-memory.db "SELECT source_connector, COUNT(*) AS indexed_count FROM connector_event_index GROUP BY source_connector ORDER BY source_connector;"
jq -c 'to_entries[] | {connector: .key, poll_cursor: .value}' ~/.mama/connectors/poll-state.json
sqlite3 ~/.mama/mama-memory.db "SELECT stimulus_id, kind, status, attempts FROM mailbox_inputs ORDER BY id;"
sqlite3 ~/.mama/mama-memory.db "SELECT model_run_id, status, model_id, created_at, completed_at FROM model_runs ORDER BY created_at;"
sqlite3 ~/.mama/mama-memory.db "SELECT tool_name, execution_status, failure_code, model_run_id, operation_id FROM tool_traces ORDER BY created_at;"
sqlite3 ~/.mama/mama-memory.db "SELECT commitment_id, current_revision, head_record_id, updated_at FROM commitments ORDER BY task_id;"
jq -c '.entries[] | {key, state, updatedAt, nextChunkIndex, deliveryUncertain}' ~/.mama/runtime/telegram-message-ledger.json
```

## W1 live-run defect corrections — 2026-09-25

- Result: fixed input-sensitive native loop detection, owner `max_turns`/timeout propagation, Kagemusha channel-id mapping, mailbox ACK timing, and hashed source-delta identities.
- Evidence: core loop, mailbox-boundary, standalone config, Kagemusha epoch-ms, source-id, and native-session regressions pass; core/standalone builds and typechecks pass.
- Live cause: Kagemusha timestamps were epoch-ms and the 102-row window was present; bare configured channel ids did not match the namespaced connector key, so all rows were filtered.
- Live cause: native receipt acceptance updated `mailbox_inputs` to `acked` before final delivery; failed native turns now remain claimed/uncertain until reconciliation, while pre-dispatch failures use mailbox retry.
- Still open: full suites are socket-blocked in this sandbox only (`listen EPERM`); no socket workaround or daemon/live rerun was performed.

## W1 source-delta handle correction — 2026-09-25

- Result: source deltas now carry the projected `observationRef` from connector index projection through mailbox payload and rendered stimulus; no C1 owner-check claim.
- Evidence: real connector-runtime fixture with two observations reaches the mailbox and dispatches real `source.read` for both handles; connector and polling tests pass, while socket-backed W1 delivery remains sandbox-blocked by `listen EPERM`.
- Still open: supervisor rerun of the native W1 path and live model/receipt evidence.

## W1 action-contract descriptions — 2026-09-25

- Result: source, work, memory, and graph query input fields now expose concise descriptions with example shapes, including nested fields; no new inputs were added.
- Evidence: core catalog contract test passes all 10 tests and standalone source/work contract tests pass; no C1 owner-check claim.
- Still open: full standalone verification and live model confirmation that the described source handle is selected.

## W1 scheduled producer removal — 2026-09-25

- Result: daemon no longer creates the W1 periodic scheduled no-op or returns a scheduled resource; direct scheduled intake and generic scheduled delivery remain in place.
- Evidence: daemon bootstrap tests pass; the scheduled delivery test remains unchanged but is socket-blocked in this sandbox before its assertions.
- Still open: full standalone/root verification and supervisor confirmation that no scheduled mailbox rows are produced during the live run.

## W1 real-path integration verification — 2026-09-25

- Result: corrected the integration test’s action ledger; no product change was needed.
- Evidence: the real delta payload supplied both observation handles to two real `source.read` dispatches, `work.create` returned a commitment, and all full suites pass: core 113/829, standalone 41/84, MCP 13 files with 121 passed and 14 skipped.
- Cause: the fixture double called `work.create` but never recorded `actionNames.push('work.create')`, so the assertion reported a false stop before creation.
- Still open: live provider/model/Telegram owner evidence and the C1 owner check remain outside this test.

## W1 third live-run recording correction — 2026-09-25

- Result: source-delta policy now records moved work, treats other-system tasks as evidence, admits the owner global/user/connector scopes, and stores bounded final responses in model-run summaries.
- Evidence: focused regressions pass; core 113 files / 831 tests, standalone 41 / 86, MCP 13 files with 121 passed / 14 skipped; build, typecheck, lint, and formatting pass.
- Read-only live state remains unchanged: 12 model runs, one historical scope denial, and one historical graph-visibility denial; the daemon stayed stopped.
- Still open: supervisor rerun of the native W1 path and live provider/model/Telegram receipt and delivery evidence.

## Known flaky (carried from the archive)

- `mama-core tests/knowledge/graph-roundtrip.test.ts` "browses visible edges in bounded pages" failed
  once in a full parallel run (cursor expected null) and passed 3/3 alone; no knowledge code changed.

## Replay Task 1 — 2026-09-25

- Result: external owner policy loading, stable citation standing text, and the owner work contract fields are implemented; no C1 owner-check claim.
- Evidence: absent/present boot logging, exact-byte fingerprint reload, policy-layer ordering, changed-policy thread rotation, and contract traversal pass; root full suite passes 41 standalone files / 96 tests.
- Still open: replay collection, source-time read ceilings, ordered delivery, live connector fence, and real provider/model owner evidence remain in later tasks.

## Replay Task 2 — 2026-09-25

- Result: source event time now reaches decision and assignment projections, history exposes it, readWork filters by it, and replay writes reject missing/future event times with named errors.
- Evidence: commitment read/write focused suites pass 27/27; root full suite passes 113 core files / 833 tests and the standalone replay gate passes before any knowledge write.
- Still open: the active replay ceiling is only exposed as a session fact here; Task 4 must populate it through the replay runtime, and C1/C2 live verification remains open.

## Replay Task 3 — 2026-09-25

- Result: collect-only Kagemusha/Trello import modules, bounded manifest/fence, read-only source DB, pending projection drain, and R2 direct-channel continuity are implemented; no mailbox, model, commitment, or source-delta path is called.
- Evidence: standalone full suite is 44 files / 105 tests; replay tests cover equal-time keyset pages over 5,000 rows, numeric Chatwork mappings, unmapped-row counts, Trello 1,000-plus paging, stable action IDs, read-only opening, and idempotent reruns.
- Read-only real-data dry-run at the recorded fence mapped kakao 3,737/3,737, line 183/183, telegram 59/59, airbnb 0/0, slack 188/188, chatwork 149/149; every origin had zero unmapped rows.
- Still open: the approved import has not been run against MAMA state, and Trello API actions were not fetched; this turn wrote no `~/.mama`, `~/.claude`, or `~/.kagemusha` data.

## Replay Task 4 — 2026-09-25

- Result: the inclusive replay source ceiling now flows from active delivery through native and dynamic IPC/MCP session facts into dispatcher allowances, source readers, raw queries/cursors, graph visibility, provenance, and Task 2 work-write validation.
- Evidence: core full suite is 116 files / 837 tests; standalone full suite is 44 files / 105 tests; regressions cover source/list/read/history, cursor-ceiling mismatch, graph/observation and provenance visibility, native action calls, and dynamic socket facts.
- The standalone Vitest harness uses a single fork because concurrent native SQLite teardown otherwise exits 139 after passing replay tests; the serialized full run exits 0.
- Still open: ordered model replay, real owner/provider turns, receipts/delivery, and C1/C2 remain intentionally outside Tasks 3–4.

## Replay Task 5 — 2026-09-25

- Result: metadata-only source catalog, KST half-day ordering, one delta per connector/channel/window, replay ceiling, 500-ref preflight, append-only ledger, and atomic crash cursor are implemented.
- Evidence: replay catalog/feeder tests cover global and group ordering, source-time occurrence, cursor restart, cap failure before acceptance, and uncertain delivery stop; mailbox cap and source-delta tests pass.
- Files: `packages/standalone/src/replay/{replay-source-catalog,replay-feeder,replay-cursor,replay-ledger}.ts`, `stimulus-delivery.ts`, `packages/mama-core/src/runtime/mailbox.ts`, and their focused tests.
- Still open: the supervisor must run the real provider replay and inspect native receipts/model writes; no `~/.mama` state was written here.

## Replay Task 6 — 2026-09-25

- Result: `mama replay` boots the owner runtime and feeder only, logs `replay collectors: disabled`, leaves the configured live connector set unchanged, and writes every enabled live poll cursor to fence T after settlement; Kagemusha live messages use `(created_at,id)` keyset pages with no 5,000-row limit.
- Evidence: daemon replay isolation, poll-fence, and 5,001-row Kagemusha tests pass; R1/R2/R4/R5 are encoded, and no overlap report or collector-set rewrite is present.
- Files: `packages/standalone/src/cli/commands/{daemon,replay}.ts`, `runtime/connectors.ts`, `connectors/kagemusha/index.ts`, `cli/index.ts`, plus replay/runtime tests.
- Still open: only a supervisor run can prove T→now live polling, Telegram startup, clean daemon log, native receipt, and C1/C2.

## Replay Task 7 — 2026-09-25

- Result: counts-only `verify-september.mjs` checks Kagemusha/raw and Trello coverage, ledger/cursor order, event-time revisions, task-shape fields, and resolvable citations; the collect-only import runner and Trello board/day manifest support the operator path.
- Evidence: the verification fixture passes with zero coverage/order/null-time/unresolvable-citation differences; standalone full suite is 47 files / 117 tests and core full suite is 116 files / 838 tests.
- Read-only dry run at the current Kagemusha fence found T=`1790313098001`, 4,322 mapped source rows, 50 KST half-day windows, 326 message deltas, and zero unmapped rows. Trello API history was not fetched, so final replay deltas are `326 +` the Trello board/window groups shown by replay preflight.
- Still open: import/replay, final counts-only verification, and real owner C1/C2 confirmation remain supervisor work.

## September replay — supervisor runbook (R1–R5)

The implementation writes raw/index data during import only. Replay is the owner runtime plus feeder; it does not start live connectors or Telegram. The current read-only dry run predicts 25 KST daily turns through T=`1790327903001`, 5,670 source observations (4,341 mapped messages, 74 parsed feedback calls, 1,255 Trello rows), and a maximum daily stimulus of 451 refs; the 500-ref ceiling remains sufficient.

1. Stop the launchd daemon before touching the disposable testbed:

   ```sh
   launchctl bootout gui/$(id -u)/com.mama.server
   ```

2. Wipe the same W1 cutover state, keeping credentials/configuration, briefs, skills, and launchd files. The exact keep-list commands are the W1 cutover block above; the destructive portion is:

   ```sh
   rm -f ~/.mama/mama-memory.db ~/.mama/mama-memory.db-shm ~/.mama/mama-memory.db-wal ~/.mama/mama-metrics.db ~/.mama/mama-sessions.db ~/.mama/runtime.sock ~/.mama/report-slots.json
   rm -rf ~/.mama/connectors ~/.mama/runtime ~/.mama/codex-runtime ~/.mama/workspace
   rm -f ~/.mama/logs/daemon.log && mkdir -p ~/.mama/logs
   (cd ~/.mama/.codex && rm -rf sessions shell_snapshots tmp thread-writer-locks memories \
     state_5.sqlite* thread_history_1.sqlite* memories_1.sqlite* goals_1.sqlite* logs_2.sqlite* queue_1.sqlite*)
   ```

   Re-check that `~/.mama/.codex/auth.json`, `config.yaml`, `connectors.json`, `auth.env`, `start.sh`, `briefs/`, `.codex/skills/`, and the launchd plist still exist. Do not print `config.yaml` or credentials.

3. Build and run collect-only import. Supply Trello credentials through the environment; the runner never prints them:

   ```sh
   pnpm --dir packages/standalone build
   TRELLO_API_KEY="$TRELLO_API_KEY" TRELLO_TOKEN="$TRELLO_TOKEN" \
     node scripts/replay/import-september.mjs \
       --mama-db ~/.mama/mama-memory.db \
       --raw-root ~/.mama/connectors \
       --connectors-config ~/.mama/connectors.json \
       --manifest ~/.mama/runtime/september-import-manifest.json
   ```

   The output is counts only, including feedbackRows and unmappedFeedbackRows. Import must leave mailbox, model-run, commitment, tool-trace, and source-delta counts unchanged; it drains raw projection queues and records the exclusive fence T in the manifest.

4. Run replay. This is the only command that opens the owner runtime and feeder; it does not start live connectors or Telegram:

   ```sh
   node packages/standalone/dist/cli/index.js replay
   ```

   Watch progress without exposing contents:

   ```sh
   tail -f ~/.mama/logs/daemon.log | rg 'replay|stimulus'
   jq '{nextWindowStartMs, currentWindow: (.currentWindow.deltas | length)}' ~/.mama/runtime/september-replay-cursor.json
   jq -s 'group_by(.status) | map({status: .[0].status, count: length})' ~/.mama/runtime/september-replay-ledger.jsonl
   ```

5. After a crash, do not delete the cursor or ledger and do not manually re-send a delta. Stop/restart the same replay command; it reuses the deterministic stimulus IDs and waits for already-admitted rows. A `dead` or `uncertain` mailbox/native state stops replay loudly and requires receipt reconciliation before resuming.

6. Finish only after the cursor reaches T and replay exits successfully. The replay command writes T to every currently enabled connector cursor without changing the connector configuration. Then start the normal daemon so live polling covers T→now and Telegram starts normally:

   ```sh
   jq '.nextWindowStartMs' ~/.mama/runtime/september-replay-cursor.json
   jq -c 'to_entries[] | {connector: .key, poll_cursor: .value}' ~/.mama/connectors/poll-state.json
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
   ```

7. Verify counts and order after replay:

   ```sh
   node scripts/replay/verify-september.mjs \
     --kagemusha-db ~/.kagemusha/kagemusha.db \
     --mama-db ~/.mama/mama-memory.db \
     --raw-root ~/.mama/connectors \
     --manifest ~/.mama/runtime/september-import-manifest.json \
     --ledger ~/.mama/runtime/september-replay-ledger.jsonl \
     --cursor ~/.mama/runtime/september-replay-cursor.json \
     --report-slots ~/.mama/report-slots.json \
     --wiki-root "$WIKI_ROOT"
   ```

   Set `WIKI_ROOT` to the configured `vaultPath/wikiDir` root without printing the owner config. The counts-only result now includes board slot count and latest-update days, wiki page count, lesson count, and lesson provenance count.

   A nonzero exit means at least one count or invariant differs. Finally send the real owner Telegram C1/C2 questions, retain the native receipt/daemon log/DB read-back, restart the daemon, and ask both questions again; those live owner checks are not claimed by the automated script.

## Replay Task 8 — 2026-09-25

- Result: carried agent-written board/wiki stores are wired into the owner catalog and viewer; replay now admits one cross-channel KST daily stimulus with bounded message text, current-work digest, feedback observations, and an end-of-window four-record instruction.
- Evidence: the carried report/wiki assertions pass (a one-slot update is `report.publish` with one slot; the new `report.update` duplicate and the unused Obsidian CLI action were removed at review); replay, importer, verification, viewer-record, and native stimulus tests pass; read-only dry run is 25 windows/turns, 5,670 observations, max 451 refs, and 50 accepted/settled ledger entries.
- Verification: `verify-september.mjs` checks message/feedback/Trello coverage, cursor/order/dead/uncertain state, board snapshot/update days, wiki page count, lesson count/provenance, event-time task shape, and citations.
- Still open: the collect-only import/replay and real owner/provider/Telegram receipt run remain supervisor work; no `~/.mama`, `~/.claude`, or `~/.kagemusha` state was written here.

## September replay run log

- 2026-09-25 run 1 stopped at the first accept (feeder compared a mailbox row number with the stimulus
  id; fixed in bef473b37). Run 2 stopped in window 2 because the feeder's 60-second settle deadline
  killed a healthy turn (fixed in 74c1e49f2). The interrupted delivery (mailbox row 17) was marked
  uncertain; its model run made only reads (source.read 18, work.list 2, memory.search 2, graph.query 2,
  no writes), so the row was returned to pending and its native delivery record removed for
  re-delivery (testbed, supervisor, recorded here).

## Replay delta batch reads and native bridge call cap — 2026-09-25

- Result: `source.read` now accepts one `observationRef` or up to 500 `observationRefs`; each batch item keeps bounded content, replay ceiling, grant checks, and a per-ref error.
- Result: the host bridge no longer counts calls or applies the emergency cap; the identical-call signature guard and configured turn timeout remain.
- Evidence: full root suite passed — core 116 files/838 tests, standalone 47/119, MCP 13 files with 121 passed/14 skipped, plugin 11 files/165 tests; typecheck, lint, and format check passed.
- Still open: the stopped replay and live owner/provider turn were not rerun here; no `~/.mama`, `~/.claude`, or `~/.kagemusha` state was written.
- Run 3 stopped at delta 32: 50 refs read one call each, aborted by the core 50-call emergency cap before
  any write (model run: source.read 50, no writes). Fixed with batched source.read and the cap removed;
  row 32 returned to pending for re-delivery (testbed, supervisor).

## W10 — 2026-09-25

- Result: the carried Tasks drawer now loads the archive-compatible task detail path and renders one event-time-ordered History entry per revision, including summary, reasoning, and cited observations.
- Evidence: standalone FULL suite is 52 files / 137 tests, core is 116 / 838, MCP is 13 passed files / 121 passed and 14 skipped tests, plugin is 11 / 165; forced build, typecheck, lint, focused API tests, and the component render test pass.
- Data path: operator tasks request `work.list(history: all)` and add `commitment_id`; drawer detail reads `work.show`, `graph.query(derived_from)`, and bounded `source.read` slices, projecting event-time Created/Updated and source channels/observation ids.
- Still open: supervisor replay/live owner C1/C2 evidence remains outside this viewer change; the model cache remained exactly 561768762 bytes after the full suite.

## Action MCP door moved into standalone — 2026-09-25

- Result: the owner agent's action MCP adapter is standalone's own `src/runtime/action-mcp-server.ts` (built to `dist/runtime/action-mcp-server.js`); standalone no longer depends on `@jungjaehoon/mama-server`. The owner pointed out that the public MCP server (Claude Code development memory) is a separate product unrelated to MAMA OS; the engine carry (03da2c6fd) had pulled it in with the archive.
- Evidence: core 838, standalone 232 (archive handleRequest unit tests carried), mcp-server 121, plugin 165 passed; the built adapter answers `initialize` over stdio; `resolveActionServerPath()` points at standalone's dist for both backends (Claude MCP config and Codex `mcp_servers` read the same file).
- Still open: `packages/mcp-server` and the plugin keep the archive's carried state, in which the public server calls the daemon socket (`~/.mama`) instead of its own `~/.claude` database. That mixes the two data homes and must be fixed before any mcp-server release; it is outside the owner-flow work.
- 2026-09-25 day-window run: stopped after window 4 settled to ship the standalone action MCP door and the
  wiki wording fix (the agent read "publish wiki pages for cases that changed" as "no page changed" on an
  empty wiki). Window 5's turn was interrupted after writes (work.revise 2, work.create 2, memory.save 1);
  mailbox row 5 (claimed/accepted) was returned to pending and its native delivery record removed so the
  whole day is re-delivered; the agent resolves against existing work before writing (testbed, supervisor).
- 2026-09-25 19:31 KST: stopped after window 9 settled because the daemon's Codex home (`~/.mama/.codex`,
  a separate free-plan account) had used 13% → 79% of its 30-day limit in nine windows (~7% per window).
  Window 10's turn had made no action calls; row 10 was returned to pending. Resume after the owner logs
  the daemon's Codex home into an account with headroom.
- 2026-09-25 ~19:55 KST quality check after window 10: task titles follow the owner title format with
  stage and source time; board slots are grounded; 10 lessons come from the owner's own Telegram
  corrections. Two defects: the board file `~/.mama/report-slots.json` was outside the wipe list, so two
  archive-era slots (taskBasis, next_actions) survived; and wiki pages were thin day deltas that replaced
  the page (plus one catch-all page). Fixed: wipe list, and the window/standing instruction asks for one
  page per case rewritten as its whole running history.
- 2026-09-25 ~20:00 KST: owner asked to switch the owner agent to effort max and continue with the
  corrections. Stopped after window 11 settled (row 12 had dispatched but made no action calls; returned to
  pending), set `agent.effort: max`, removed the two archive-era board slots, and resumed with the viewer
  served during replay (3ee5ebfb8) and the cumulative wiki instruction (704b67c03). Windows 1–11 ran at low.
- 2026-09-25 20:30 KST: stopped cleanly after window 12 (max). Resumed with 1b7c603e9 (compact lines),
  ba3f5e7ae (status vocabulary, owner connector-wide read), 17eac0595 (channel names, Trello lines, whole
  messages, in-window duplicate check). The owner asked that the agent fix out-of-contract statuses itself,
  so one owner message was enqueued (mailbox row 13, occurredAt 9/13 00:00 KST) before window 13. Baseline:
  revisions with off-contract (free-text Korean) status touch 29 / 46 / 14 / 2 commitments
  (waiting / in progress / done / merged duplicate).
- 2026-09-25 20:52 KST: window 13 (9/13, max) aborted "without progress" after 5 min of reasoning-only
  activity (Codex completed a reasoning item every ~10 s); replay stopped on the uncertain row as designed.
  The turn had made reads only (report.read 5, graph.query 1, memory.search 1). Fixed in 79f32a954
  (reasoning items refresh the idle timer); row 14 returned to pending; resumed. The owner status
  correction (row 13) had completed: all latest statuses are in the contract (0 off-contract).

## Window pipeline evidence and review — 2026-09-25

- Artifacts (testbed only, business content): `~/.mama/runtime/measurements/2026-09-25/` —
  `window-0902-lines.txt` (mailbox row 2 rendered as compact lines), `hand-simulation-0902.md`
  (supervisor gold proposal, 10 movements, owner confirmation pending), `codex-step-timings.json`
  (per-request time/input/reasoning/output from every replay Codex session),
  `jev-archive-pipeline-0902-{queue.md,plan.json}` (archive `backfill.mjs` run with FROM/TO on 9/2,
  a measurement copy with a metadata shim and an external model cache; not in the repo).
- Numbers: agent record for 9/2 = 9 revisions / 8 items, 3 items for 2 deliverables, 1 wrong project
  tag, 1 stale state, 5 missed movements. Archive Jev run: 144 conversations → 130 after its text
  dedup → 95 chunks; 84 pair verdicts in 1.2 s; 30 chunks attributed in 1.6 s; bands A 10 / B 3 / C 2
  / D 15; the non-deliverable owner work fell to D. Subagent use: every replay session's tool calls
  are `exec` only (0 `spawn_agent`).
- Codex adversarial review of window-pipeline.md (read-only, gpt-5.6-luna max) applied: no verbatim
  port of archive logic that judges in code (first-80 dedup, card propagation, length filters); Jev
  batch failure stops as incomplete; the low band is "unresolved", shown in full and measured for
  promotion; subagent writes checked by trace, not blocked; candidates are the as-of universe; P5
  fixed to three arms on one snapshot with owner-confirmed labels. Added P0 (progressive work.list):
  68 items = 62k characters current / 165k with history per call.

- P0 implemented: `work.list` now exposes overview/items/detail over `knowledge.readWork`, with
  bounded 25/50 pages, filter-bound read-version cursors, four-id detail, basis/history and text
  continuation. Evidence: standalone full suite 67 files / 376 tests; viewer routes now dispatch items/detail.
- P1 implemented: typed Jev client carries configured key/vocabulary paths, retries 429/529 and
  raises ref-bearing incomplete batches; `jev.keyFile` and `jev.vocabFile` default under the owner
  home without logging key contents. Evidence: injected-fetch success/retry/incomplete tests pass.
- P2 implemented: queue generation keeps source identity only, asks Jev for adjacent chunking/relevance/
  candidates/duplicate pairs, uses as-of open+closed work and Trello time/embedding candidates, and
  surfaces missing verdicts with observation refs. Evidence: injected Jev/embedder queue tests pass.
- P3 implemented: replay deltas carry the queue and stimulus renders A/B/C, suspected duplicates and
  unresolved sections with complete KST lines; replay feeder and source-catalog tests pin the payload
  and renderer. Evidence: replay/runtime targeted tests and the full standalone suite pass.
- P4 implemented: standing/window instructions require queue planning, direct `spawn_agent` proposals,
  owner verification/writes, and trace-based child-write checks in `verify-september.mjs`. Live Jev,
  daemon, replay and live subagent trace runs were intentionally not performed under the brief.

## Window pipeline implementation review — 2026-09-25

- Codex implemented P0–P4 in worktree rebuild/window-pipeline (standalone 376 tests). Supervisor review
  fixed: question wording moved back into code as in the archive (the owner vocabulary notes travel as
  state.note; Codex had required note keys the owner file does not have); candidate questions now name
  their candidate (all were identical); adjacent pairs batched per channel and pooled; embeddings cached
  once per window; work candidates narrowed to embedding top-8 plus exact hints; Trello card facts built
  as of the window end (they read later activity) and from the imported action shape (data.card,
  listAfter; none were built); no default 'pending' in the digest; the Jev request body carried the whole
  owner vocabulary as `vocab`, which the API rejected with HTTP 400 — removed (the archive sent model,
  state, questions only).
- Live 9/2 queue (read-only DB, real Jev; `queue-0902-p2.json`): 163 lines in 12 s; all 10 hand-simulation
  movements land in A, B or C. With the archive pair question ("same single work item?") C held 52
  mostly single lines; asking whether B continues A's topic gave A 7 / B 4 / C 17 / unresolved 10.
- P4 additions (relations, provenance, viewer source text, daily journal, Home.md-first wiki, no host
  index) implemented with tests; standalone 378 tests.

## Replay restart on the window pipeline — 2026-09-25 22:40 KST

- Owner decision: stop the running replay (old input, effort max, 27–49 min per window) and restart
  from 9/1 on the merged window pipeline (c57e32bbc) at effort high. Testbed wiped per the runbook
  (measurement artifacts kept), the rebuild wiki folder emptied, import re-run: kagemusha 4,424,
  feedback 75 (2 unmapped), trello 1,290, fence T 1790329110001 (same as before). The 9/1–9/2 windows are
  compared with the hand-simulation gold before continuing.
- 2026-09-25 23:48 KST: window 9/8 stopped on an uncertain row — the stimulus (1.24M characters) exceeded
  the Codex input limit because suspected-duplicate pairs each carried all window refs (fixed in the
  commit after this entry's predecessor, "suspected duplicates carry no window refs"). Windows 9/1–9/7 had
  run at 4–13 min each. Mailbox row 8 (never delivered: the turn failed before any action) was removed
  with its refs, delivery record and seen refs, and the cursor's accepted entry cleared, so the window is
  re-admitted with the new payload (testbed, supervisor). The owner policy gained the [청구] tag rule.
- 2026-09-25 23:55 KST: resume refused by the cursor identity guard — the owner changed the policy file
  ([청구] tag rule), so the policy fingerprint differed. As an owner-made policy change, the cursor's
  policyFingerprint was set to the new file's sha256 (edba0da6… → f7686069…); windows 9/1–9/7 remain
  recorded under the old fingerprint in the ledger history.
- 2026-09-26 00:10 KST: the re-admitted 9/8 row failed with "no rollout found": the rejected turn's thread
  had been saved at thread/start without a rollout. Fixed in 3b39c3f55 (an explicitly rejected first turn
  forgets its thread); the stale registry file was removed and the replay resumed on row 9 (pending,
  one attempt, no action calls).
- 2026-09-26 00:56 KST: one Jev HTTP 500 while building the 9/11 queue stopped the replay as designed
  (incomplete, before admission; nothing to reconcile). The client now retries 500/502/503 like 429/529.
  Windows 9/1–9/10 done; 9/8 15.6 min, 9/9 12.5 min, 9/10 20.9 min.
- 2026-09-26 01:36 KST: stopped cleanly after 9/12 (9/10 20.9 min, 9/11 26.8 min, 9/12 10.5 min) to apply
  7408b73fc (current revision in the digest and candidates, so a window need not re-read every item with
  work.show before writing). Output now goes to ~/.mama/logs/daemon.log, which the viewer's log tab reads
  (config logging.file pointed there; it only fed the viewer and pointed at an unwritten mama.log).
- 2026-09-26 02:05 KST: stopped cleanly after 9/14 (26.2 min; 9/13 1.2 min) to apply 2535bdfae
  (orchestrated windows with child-written lanes, receipts and changedSince read-back; manage.wiki.update;
  human-readable board/wiki without ids). The owner policy's id rule was scoped (board/wiki prose, ids on
  request), so the cursor policy fingerprint moved f7686069 → 48729f27.
- 2026-09-26 02:17 KST: journal audit, 9/1–9/14 against the ledger (revisions grouped by source-event
  day). Every item that moved on a day is named in that day's journal, but the content is gone: 214
  revisions, 0 of the 36 source times in the ledger appear in any journal, 9/10 covers 27 changes in 984
  characters (the archive's 9/10 was 6.4 KB), several items per clause. The ledger has it: each revision's
  latestEvent states who, when and what (average 89 characters), and the items read-back returns it as
  latest_event. Cause: the journal instruction asked only for "what moved per project". The standing text
  and the window instructions now ask for one entry per moved item from latest_event (who, source time,
  what it contained, what is awaited next), never several items in one clause. 9/15 (orchestrated, old
  journal line) is sentence-style but still folds six submissions into one clause. Replay stopped cleanly
  after 9/15 (watcher on the cursor's settled state). 9/1–9/14 are being rewritten by the owner agent from
  work.list asOf=<day end> changedSince=<day start>, source reads capped at the 9/14 end (owner request
  through the mailbox in replay mode, no outbound reply). Still failing: an owner-admin notice seen in raw
  never became work (judgment, not journal).
- 2026-09-26 02:30 KST: the owner agent rewrote 9/1–9/14 in 11 min (three children by date range, main
  reconciled against changedSince). Re-audit: every moved item named on its day (0 missing), ledger
  source times present (35/39), no ids in any body, later dates only as that day's stated deadlines or
  schedules (no future facts); 9/10 now 23 dated entries with actor, files, feedback points and next wait,
  plus a judgment section. Remaining: style differs between children (bold headers vs plain lines, the
  English "unconfirmed" in prose), entries are not time-ordered within a section. Correction of an earlier
  claim: the <place-1> 9/16–9/19 reservation is not in the ledger (13 <place-1> items, none a reservation); like
  the health-insurance notice it is a recording miss in raw, not a journal omission. Replay resumed at 9/16
  on the new journal instruction.
- 2026-09-26 02:53 KST: window 9/16 took 22.3 min on the one-entry journal rule. Split (main rollout
  timestamps): queue 0.5, main listed the whole ledger again 1.0 (two pages, 100k characters, although
  current_work carries every revision), plan and three dispatch messages 3.0, children 3.5–5.5 in
  parallel, main read-back and wiki fixes 3.5, main alone writing the journal ~2.5 (10.9 KB), then board.
  Main context 151k of 258k tokens per call. Changed: the main creates the day's journal with one heading
  per lane before dispatch, each child adds its items' entries under its heading (manage.wiki.update,
  re-read on a version conflict), the main writes only the judgment section and fills entries missing
  from the read-back; and it does not list the whole ledger when current_work already carries it.
- 2026-09-26 03:44 KST: window 9/17 took 24 min (9/16: 22). Children writing their journal entries works
  (9/17: 23/23 items, 16/16 ledger times, no loss from concurrent edits) but lengthened the children
  (6.5–9 min vs 3.5–5.5); dropping the full ledger listing saved 1 min before dispatch. The main's
  post-children phase stayed at 13 min: it re-read pages it had just written (19k–41k characters, three
  times), listed changedSince four times and published the board twice. Code gap: manage.wiki.update
  returned no content version, so any second edit of a page was refused as stale and forced a whole-page
  read (seen on the journal and a project page). It now returns contentVersion, and a stale refusal
  carries the current version and the current text of the sections being edited. 9/18: 24 min, stopped
  at its boundary to apply this.
- 2026-09-26 04:40 KST: windows 9/19 7 min (1 item), 9/20 14 (7), 9/21 19 (12), 9/22 12. Per item 9/21 is
  no faster than 9/17 (23 items, 24 min). The main's rollout shows refused calls, each a 20–60 s round:
  seven in 9/21 alone. Across windows: wiki section not a heading line or not on the page (7; the refusal
  did not name the page's headings, so the agent re-read the page), an unavailable reference (6; the
  agent had dropped the last character of an observation id and the refusal did not say which reference),
  items limit over 50 (2), a channel name passed as the connector (2, left as designed: grants are not
  echoed). The section refusal now lists the page's headings (the heading pattern moved from the schema
  to that check) and the reference refusals name the caller's own kind and id.
- 2026-09-26 05:10 KST: replay complete (25 windows; 9/23 6 min, 9/24 9, 9/25 9). Refused calls in
  9/23–9/25: 3 in total (9/21 alone had 7), and the reference refusal now names the truncated id.
  Journals 9/16–9/25: every moved item present, ledger source times 116/119; 9/15 still has the old
  style (4/17). verify-september: import 4,349/4,349 and Trello 1,290/1,290 with 0 differences, order
  and cursor clean (the one duplicate and one uncertain delivery are the 9/8 incident above), 419
  revisions all with event time, 23 lessons all with derived_from, 233 child writes all tied to a model
  run, 45 wiki pages. Failing: 9 unresolvable citations, all in commitment sourceRefs, all observation
  ids with the last character dropped by the agent; links are checked by core but sourceRefs were stored
  unchecked. work.create/work.revise now refuse a sourceRef that names no observation (the product owns
  the observationRef meaning; core keeps sourceRefs opaque). The 9 stored refs remain in history.
- 2026-09-26 10:16 KST: owner C1/C2 on Telegram against the live daemon (launchd, same Codex thread as
  the replay's end; boot and log clean). C1 "who is working on what" answered in 2 min 50 s from
  work.list (70 open: 27 in progress, 11 review, 32 pending), listing about 15 recently confirmed items;
  33/33 cited commitment and observation ids resolve. Against Kagemusha's open tasks of 9/24–9/25 it
  covers <asset-10> EX/BC/TF, <asset-13>, <asset-11> ST, <asset-8>, <asset-9>, <asset-5> AR/SSR1,
  <asset-7> SSR1/2, <asset-16>; it omits <asset-12> BC and <asset-11> EX submissions (both in the ledger)
  and the lodging items. The 9/21 order-volume notice is not work in the ledger: the 9/21 agent put it in
  the wiki (PROJECT2019 page, journal), Kagemusha made it a task. C2 "how did <asset-1> SSR1 go"
  answered in 56 s: done, client FIX, month-end delivery on 9/17 — matches the 7-revision history; but
  it merged two rounds (the 9/11 side-hair fix is described as the 9/15 second draft), cites the 9/11
  messages for it, and skips the 9/14 feedback round. Answers carry ids in <code>; owner to decide.
- 2026-09-26 10:40 KST: what an owner correction can and cannot change (code and data read). A
  correction lives in one of three places. (1) The session: applies at once, lost at a thread reset —
  9 resets in the last day (every standing-text or policy change and each daemon start). (2) A lesson
  (memory.save kind lesson): durable, but the host never puts lessons into a turn; the agent must search
  for them, and of 41 memory.search calls in the replay only 2 looked for corrections. The standing text
  asks for a lesson only at a replay window's end, not in a chat turn. (3) ~/.mama/owner-policy.md:
  injected into every session as a system layer and part of the session identity, but no action writes
  it — only a person. Kagemusha, by contrast, searches its lessons with each incoming message and injects
  the top 3 (<brain_lessons>, "lessons, not facts") plus a startup summary, and records whether they
  were applied. Of the 23 replay lessons, 6 repeat one correction (feedback PDF → Excel in the existing
  template → the file itself to Telegram): no owner action reads attachments, writes files or sends a
  document, so no correction can make it happen (Kagemusha's agent built scripts for it in its home and
  sends documents). Correctable by the owner once a correction persists: answer scope and stale items
  (C1), listing each feedback round (C2), what counts as work (lodging reservations, admin notices, the
  order-volume notice), journal and board style. Ids in Telegram answers need the standing text changed
  too: it demands ids, and the owner policy is the lower-priority layer.
- 2026-09-26 11:00 KST: why lookups are slow and inaccurate (C1/C2 rollouts; tool results return in
  under 0.3 s, so the gaps are the model). Slow: (1) the live chat continued the replay's Codex thread,
  so every step carried 136k–208k tokens and the first step had no cache hit (14 s); an automatic
  compaction hit mid-turn on a third question (226k → 92k). (2) C1 read the whole ledger in three
  pages (84k characters), then re-read the open items one status at a time (four calls, 25k), because
  status takes one value. (3) Wasted calls: work.list text "<asset-1> SSR1" returned 0 (the title
  is "<asset-1>⑥*SSR*イラスト1"; the filter is a plain substring), graph.query refused kind "work",
  and work.list view=items accepted an ids argument it ignores and returned an unrelated 13k page.
  Inaccurate: (1) the lookup — substring text misses the owner's phrasing (spaces, ⑥, Korean vs
  Japanese names) and memory.search ranked a similarly named other item (<asset-7> SSR1) first.
  (2) C2 called work.show without history, then rebuilt the chronology from provenance fragments and
  merged the 9/11 side-hair fix into the 9/15 second draft although it had read the 9/15 messages; r6
  carried the right evidence. (3) 40 of 70 open items (57%) had no event after 9/18; the ledger has no
  closure for work that went quiet, so a current-work answer must pick and drops real ones.
- 2026-09-26 11:40 KST: owner-reports R1+R2 (Codex implemented, verified outside the sandbox: runtime
  46/46, typecheck clean). The owner-answer line no longer demands commitment/observation handles;
  answers, reports and notifications carry no ids and the reads stay in the traces. The replay-only
  lesson clause became one rule for every turn (save an owner correction as a lesson in that turn;
  replay lessons link the owner observation, live ones carry the host-recorded source message). Live
  proof pending: a Telegram answer without ids and a lesson row from a live correction after the daemon
  picks up the new standing text (new session on the prompt change).
- 2026-09-26 11:20 KST: R1/R2 live (daemon restarted on the new standing text; new Codex thread). Four
  owner turns on Telegram, all without ids: "<asset-2> SSR1" 23 s (was 56 s), its feedback 41 s — now
  in order: 9/11 side-hair feedback, 9/14 PDF (details not in the ledger), second draft, 9/17 FIX; the
  agent read work.show history:"all" this time. "전체보고" 42 s but in chat style; the owner corrected
  it and the agent saved a lesson in that turn (kind lesson, provenance source_message_ref = the
  correction's Telegram message) and resent a report-style version. Still failing: the Korean name
  missed in work.list text again (the agent fell back to "SSR1", 50 rows); the full-report format is
  not known (R5); the board slots are from 9/25 (no live board pass, R4); lesson recall after a reset is
  unbuilt (R3).
- R9 code check: readWork keeps its current default, exposes an internal chain mode, and work.show
  defaults to the compact revision chain while history: all keeps full assignment values.
- Evidence: seven-revision set/clear/withdraw fold, inaccessible judgment summary nulling, and the
  work.show catalog roundtrip pass; knowledge/api suites pass 24 files / 225 tests and core tsc passes.
- Still open: a fresh live owner C2 turn using the new default has not been run in this code-only change.

- 2026-09-26 12:00 KST: owner-reports R9 (Codex implemented; supervisor removed a copied visibility
  query and a wrapper). work.show now returns the revision chain by default — per revision: number,
  operation, event time (null for legacy rows), the status and stage in effect after it (withdraw →
  cancelled), and the revision's summary when its record is visible to the caller; history "all" keeps
  the full values; readWork's own default is unchanged for other callers. Core knowledge+api 225/225,
  typecheck clean. Live proof pending with R8 (one daemon restart for both).

- 2026-09-26 12:30 KST: owner-reports R8. Codex built lexical tokens + embedding cosine with a score
  threshold; measured on the live ledger (109 titles, real e5 embedder) the embedding part did not
  earn its place: every query passed the threshold (total 109; e5 gives unrelated titles ~0.8 cosine),
  a transliterated Korean name ranked a different, similarly named item first (0.654 vs 0.653), a short
  Korean name separated by 0.002, and the first query embedded all items for 80 s (again after every
  restart). The Codex test hid this with a fake embedder that mapped both scripts to one vector.
  Supervisor removed the embedding path: work.list text now ranks by NFKC token overlap plus a
  separator-free containment bonus; an item sharing no token is not a match; rows carry their score.
  status accepts a list (OR); ids outside view=detail is refused. Real-title check: "<asset-1>
  SSR1" and "<task-title-1>" rank their items first; a Korean transliteration shares no token and returns
  nothing, so the agent searches in the title's script (it already translated to katakana in C2 and
  failed only on the space). Standalone api+runtime 134/134, typecheck clean. Tests use synthetic names.
- 2026-09-26 12:15 KST: R8/R9 live (daemon restarted). "<asset-2> SSR1 어떻게 됐지?" 18 s (C2 was 56 s):
  the Korean query shared only "SSR1" (tied rows), the agent picked the item from them and read
  view=detail — FIX, month-end on 9/17 13:56, assignee, due 9/30. "어떤 피드백?" 18 s: internal review
  points, the client's side-hair note with its proposed mesh fix, the resubmission and FIX, and the 9/14
  PDF whose items are not in the ledger — in order, no merged rounds. No ids. Two refusals the agent fixed
  in one step (text_limit over 2000; a memory.save scope outside its access). The answer used Markdown
  bold although TELEGRAM_FORMAT_GUIDE is in the standing text; the owner corrected it and a lesson was
  saved in that turn (R2 working). R3 is what makes such a lesson reach the next session.
- 2026-09-26 12:35 KST: owner asked the agent to download and read the 9/14 feedback PDF; it could not.
  The file was a Chatwork attachment in the feedback message itself (9/14 15:28,
  [download:<file id>] <customer-A>\_<file-1>.zip); Kagemusha's forward_feedback got the raw body
  with that tag and forwarded the ZIP. MAMA lost the tag: the replay imported Kagemusha's
  channel_messages text (tags stripped) — 0 of 156 Chatwork raw items carry a download tag — so the
  agent concluded "the Chatwork message has no file" (false), looked on Trello instead, tried the Trello
  attachment URL with Codex's built-in web tool without auth (Internal Error), and asked the owner to
  upload it. Even with the id it has no download action and no shell. Kagemusha itself failed the same
  way on 9/14 until the owner corrected it and it gained chatwork_file_download. Fix belongs to R6:
  the attachment descriptor must survive import and live collection (Chatwork download tags from the raw
  body, Slack file ids), then the download action, the shell to open the ZIP/PDF, and the file send.
- 2026-09-26 12:50 KST: owner-reports R3 (Codex implemented; supervisor removed a dead empty-scope
  guard). Core recall and memory.search take `kind`, applied in the vector and FTS candidate queries
  before the limit; vector hits keep their stored kind (they were all stamped "decision"). Each owner
  turn now recalls up to three lessons under the owner scopes with the stimulus text and appends a
  <lessons> block ("Use these as lessons, not facts; verify current state with tools.", Kagemusha's
  sentence); the first turn of a new native thread also gets the top three for startup lessons, from
  an explicit runner signal. Core 525/525 (memory, knowledge, api, runtime), standalone 138/138,
  typechecks clean. Live proof pending: restart, then ask for a full report — the report-format and
  Telegram-formatting lessons must show in the stimulus and be followed.
- 2026-09-26 12:47 KST: R3 live (restart → new thread). "전체보고해줘": the stimulus carried two <lessons>
  blocks — startup (three feedback-translation lessons) and the turn's own, whose first line was the
  owner's 11:18 correction "전체 보고는 대화체가 아니라 간결한 보고서 형식". The answer came in report
  form (title, 우선 확인, 결정·확인 요청), Telegram <b> tags, no Markdown, no ids, and the agent
  republished the four board slots first (the board was stale since 9/25). 74 s, most of it reading the
  ledger in pages. The Markdown lesson was not among the three recalled but the answer complied. Still
  missing: Kagemusha's five-part full-report format and schedule (R5).

- 2026-09-26 13:40 KST: owner-reports R6 part 1 (Codex implemented; supervisor kept non-ASCII file
  names readable — the sanitizer turned a Japanese name into underscores — and set the owner chat in the
  testbed config). New owner actions: source.attachment.list (Chatwork: the room's file list matched by
  the stored file ids, the message id, or upload time within 5 min of the message; Slack: file ids from
  metadata or `(slack_file:<id>)` markers), source.attachment.download (the file must belong to that
  room; saved under the workspace files/<connector>/<room>/), deliver.telegram.file (owner chat from the
  new required config telegram.owner_chat_id, which must be in allowed_chats; path under workspace
  files, no symlink, regular file, ≤ 50 MB, idempotent per operation). Live Chatwork and Slack collection
  now keep file ids in metadata. Standalone 213/213, typecheck clean. Live proof pending with part 2
  (shell), on the 9/14 feedback ZIP.
- 2026-09-26: owner-reports R6 part 2 implements the owner decision: optional core `shellTool` defaults off; the owner native-session passes true through runtime-process and the app-server driver, including its native subagents and replay turns.
  AGENTS.md records the exception; one standing-prompt line keeps requested file work inside the workspace and source reads, records and delivery on MAMA actions. `unified_exec=false`, workspace-write, per-thread approvals never, declined escalation and network policy are unchanged.
  Regression evidence: 5 core config/driver tests and 19 standalone native-session/prompt tests pass; both requested package typechecks pass. Core was compiled first because standalone consumes its dist exports.
  Requested runtime suites: core 171 passed, 44 failed plus 3 setup-blocked suites (21 tests not run); standalone 48 passed, 5 failed. Socket `listen EPERM` caused the failures; core IPC teardown also tried `close` on its uninitialized server. Logs: `/private/tmp/mama-r6-{core,standalone}-runtime.log`.
  Still unverified: the live feedback ZIP/PDF to Excel delivery owner turn; no daemon restart or commit. MCP decision save was blocked because the tool requires approval while this session's approval policy is never.
- 2026-09-26 13:40 KST: R6 live, first try. "9/14 <asset-2> SSR1 피드백 첨부 받아서 … 엑셀로 보내줘": lessons
  injected; the agent found the 9/14 message and called source.attachment.list — success, but files []
  — then checked the workspace with the new shell and told the owner to upload the file. Cause
  (measured with the MAMA Chatwork token): GET /rooms/{room}/files returns the room's 100 oldest files
  (2020–2021 in this room), so a recent attachment never matches; ?account_id=<uploader> returns that
  uploader's files including the 9/14 ZIP (upload 15:28:54, message 15:28:56 — the time window is right),
  and GET /rooms/{room}/files/{id} returns it directly. Fix in progress: known ids by direct GET,
  otherwise the uploader-filtered list (account id from metadata, or the room members by exact name).
- 2026-09-26: R6 attachment lookup fix (Attach): known Chatwork file ids and download membership checks now use room-scoped direct GETs; 404s surface as errors.
  Without file ids, list only with the uploader account id from observation metadata or exact room-member name; report an unmatched author explicitly. Match by message id or the existing five-minute upload window when the file omits message id.
  Synthetic fake-fetch evidence: all 28 attachment action/Chatwork tests pass, covering direct reads, filtered lists, member resolution, errors, downloads, and no unfiltered file listing; standalone typecheck and ESLint on all five changed TypeScript files pass.
  Requested connectors/API run: 141 passed, 14 failed across viewer-archive-routes, viewer-records, and viewer-server because sandbox socket binding raises `listen EPERM 127.0.0.1`. Live owner-turn verification remains pending; no daemon restart or commit.
- 2026-09-26 14:00 KST: R6 live, end to end (after the Chatwork lookup fix). Same owner request: the
  agent listed the 9/14 message's attachments (the uploader-filtered list found
  <customer-A>\_<file-1>.zip), downloaded it into the workspace (0.7 s), unzipped it with the shell (two
  1-page PDFs), rendered the target PDF to PNG with sips and read it with its image viewer, wrote an
  .xlsx, and sent it with deliver.telegram.file (Telegram message 4171, 3.2 KB). About 3 min, no ids,
  daemon.log clean. Gaps: the sandbox's python3 has no openpyxl/PyMuPDF (the host's Homebrew python
  has both), so the agent hand-wrote the xlsx XML; the "existing Excel format" is only a lesson — MAMA
  holds no template file — so layout fidelity is the owner's call.
- 2026-09-26: R6 owner Telegram intake (Attach/Answer): all eight media kinds now download into the owner's shared workspace files/telegram; Unicode-safe names, file-only text, per-file errors and readable stimulus descriptors preserve the original request.
  Enforce the Bot API 20 MB limit on message/getFile metadata and streamed bytes; reuse safeFileName and retain caption formatting. Fake-bot coverage includes documents, largest photos, other media names, failures, dedupe and sanitization (22 passing tests).
  Exact reader cause: app-server inherits daemon PATH but isolates HOME; macOS login zsh runs /etc/zprofile path_helper, selecting system Python before Homebrew, while isolated HOME hides the host user site. Owner-only shell_environment_policy.set.PATH plus allow_login_shell=false fixes resolution; core defaults, isolated HOME, workspace-write, approvals never and network policy remain unchanged.
  Evidence: standalone gateways/runtime 87 passed, 5 socket-listen EPERM failures; standalone tsc --noEmit and changed-file ESLint pass; core config/driver 6 passed and core tsc passed; adjacent attachment/daemon suites 17 passed. Isolated-HOME non-login shell imported openpyxl/fitz/pdfplumber/PIL and round-tripped XLSX/PDF. Logs: /private/tmp/mama-telegram-{suites,typecheck,eslint,adjacent}.log and /private/tmp/mama-shell-green.log.
  Still unverified: a live Telegram attachment owner turn after deployment; no daemon restart or commit. MAMA MCP decision save was blocked because the tool requires approval and this session's approval policy is never.
- 2026-09-26 14:30 KST: owner files end to end (0d83e7990 live). The owner sent an existing translation
  workbook (782 KB) with a caption; it was downloaded into files/telegram and listed in the stimulus with
  path, name and size. The shell's python3 now loads openpyxl and PyMuPDF (Codex config: host PATH set,
  allow_login_shell false). The first answer re-translated the sent workbook's own asset — the restart
  had opened a new thread and the previous Kings Cross request was gone. After the owner's correction
  (saved as a lesson in that turn), the agent read the template's widths and merges, rendered the Kings
  Cross PDF with PyMuPDF, built the workbook in that style and sent it (6.6 KB), and revised the work
  item — about 2.7 min, no ids. Gap: a new thread carries no recent owner turns (Kagemusha passes the last
  turns as <이전 대화>); add it with R7.
- 2026-09-26: R10(a), Answer/Attach: daemon boot and stdio MCP now share runtime/session-credential.ts; the reader uses runtime/session-credential under the configured home, freshly on each request, without a second environment/config field.
  Evidence: filesystem tests pass for replacement, deletion, empty credentials and rejection of the legacy root path; added in-process JSON-lines → real socket-client tests for Claude daemon boot tools/list + work.create/read-back and credential rotation/revocation.
  Standalone CLI/runtime/replay: 86 passed, 7 failed exclusively at sandbox listen EPERM (2 new integration cases, 5 existing cases); tsc --noEmit and changed-file ESLint pass. Results: /private/tmp/mama-r10-tests.json, /private/tmp/mama-r10-{typecheck,eslint}.log.
  Still unverified: socket authentication assertions cannot run past listen in this sandbox; no live owner turn or daemon restart. Required MAMA MCP decision save was blocked by approval policy never. Production code across (a)/(c): +43/-37 lines, excluding tests.
- 2026-09-26: R10(c), Answer/Report: replay window and source-read instructions now defer action names and native dispatch to the standing prompt; Claude uses Read for images/PDFs and Bash/python for spreadsheets/archives, while Codex keeps its shell/python and direct subagent guidance.
  Evidence: both backend prompt tests pass through real replay stimulus assembly and compare every mentioned host action with tools/list exposure, including Claude CLI name normalization; Claude text has no spawn_agent/wait_agent requirement.
  Preserved the interactive-owner-only administration boundary while removing nonexistent action names from its text; delegation, journal ownership, receipts and read-back requirements remain explicit.
  Still unverified: live Claude answer/file delivery and R10(b), (d), (e), (f); this run implements only (a)/(c), without committing or deploying.
- 2026-09-26 15:35 KST: MCP vs CLI for the Claude backend, measured (claude -p, sonnet, project settings
  only, empty plugins, read-only owner questions against the live daemon, 2 runs each). Baseline context
  per request: MCP with every schema upfront ~28.5k tokens (built-in tools off also removed tool search),
  CLI (Bash + a prototype `mama-act` over the daemon socket) ~14.0k, MCP with deferred tool search ~10.7k.
  Real questions (one asset's progress and feedback history; one client's open work with assignees), mean context tokens / turns /
  seconds / list cost: CLI 62k·86k / 3·5 / 19·28 / $0.08; MCP upfront 108k·63k / 3·2 / 19·22 / $0.10;
  MCP deferred 69k·40k / 4·3 / 24·21 / $0.075. All answers correct and near-identical. Time and accuracy do
  not separate the three; the only real difference is schema tokens, which deferred loading removes. The
  literature's "CLI 100% vs MCP 72%" compared a remote 43-tool GitHub MCP whose failures were network
  timeouts — not our local bridge. Codex's managed config has tool_search = false; its 19 dynamic tool
  schemas are ~42k characters per session. Small sample (n=2), read-only questions.
- 2026-09-26 15:55 KST: architecture decision recorded (owner-reports.md, MAMA decision
  owner_runtime_harness_and_entry): backend CLIs keep their harness; one thin common host owns intake, push,
  delivery, queue/recovery, per-turn context and records; MCP is the single tool entry for all backends
  (Codex dynamicTools to move), turn attribution once in the daemon; push stays per-CLI session protocol.
  Next: measure Codex over MCP vs dynamicTools before switching.
- 2026-09-26 16:10 KST: Claude subagent identity for MCP calls, verified (claude 2.1.282, project-settings
  PreToolUse hook on mcp**mama**.\*, one parent call plus one Agent-spawned child call to work.list). The
  parent's hook input had no agent fields; the child's carried agent_id and agent_type; both carried a
  distinct tool_use_id and the session id. So the host can attribute Claude calls per child: the hook can
  pass the caller (session, agent id, tool_use_id) into the call (PreToolUse may return an updated input)
  for the MCP bridge to strip and forward as session facts. Fallback not needed.
- 2026-09-26 16:45 KST: Codex over MCP vs app-server dynamicTools, measured (same MAMA driver, gpt-6-luna
  high, shell off, fresh codex home per run, same instructions and read-only questions, 2 runs each). Mean
  seconds / model tool calls / actions / input tokens: dynamicTools q1 19.9 / 2 / 2 / 55k, q2 21.8 / 1 / 1 /
  33k; MCP q1 36.3 / 4.5 / 2.5 / 104k, q2 31.9 / 4 / 2 / 81k. All answers correct. Cause: in code mode the MCP
  tools are not in the visible function list, so the model spent 1–3 exec calls listing ALL_TOOLS to find
  mcp**mama**\* names before calling; dynamicTools are exposed as tools.work_list from the start. No run
  batched several actions in one exec. Findings on the way: the driver deliberately drops an MCP server named
  "mama", and Codex MCP tools need default_tools_approval_mode "approve" under approval never. Verdict:
  Codex keeps dynamicTools (faster, half the tokens, more model-friendly), which also carries the child
  thread id; Claude uses MCP with hook-supplied subagent identity. Parity is the host contract plus one
  conformance test, as recorded at 16:10.
- 2026-09-26: R10(b), Answer/Attach: Claude owner boot installs a project PreToolUse caller hook; standalone MCP strips the reserved input and carries identity over IPC to the active native turn. Shared child-run creation issues access and records separate receipts; Claude drains calls and settles children with the parent, while Codex retains native child events and dynamicTools.
  Evidence: official hook reference and installed Claude Code 2.1.282 confirm hookSpecificOutput.updatedInput; hook/client tests and real-DB conformance cover parent source/channel/tool identity, concurrent child writes, distinct model runs/parent links and failed parent settlement. Review found cross-turn background attribution; its regression failed first, then passed with native launch/resume ownership binding and in-flight drain checks.
  Requested suites: core runtime/api 274 passed, 44 failed at sandbox listen EPERM; standalone runtime/cli/api 150 passed, 22 failed at listen EPERM. Both requested tsc commands, changed-file ESLint and git diff --check pass; JSON results are /private/tmp/r10-b-{core,standalone}-tests-final.json. Temporary HOME uses the existing model cache; without it, the initial core run had 16 additional embedding-cache failures, resolved by the cache fixture alone. Current Claude resumes through SendMessage.to (official subagent reference); tests cover native ID and observed launch-name addressing.
  Still unverified: this implementation's live hook-to-MCP/socket round trip, live launch/resume ordering and owner answer/delivery; socket assertions cannot get past sandbox listen. No daemon restart or commit. MAMA MCP decision recording was attempted but refused by approval policy never; the architecture decision is recorded in owner-reports.md. Production source: +362/-44 lines.
- 2026-09-26 17:00 KST: Claude caller delivery, verified end to end at the MCP boundary (logging proxy in
  front of the action MCP server). A PreToolUse hook returning hookSpecificOutput {hookEventName
  "PreToolUse", permissionDecision "allow", updatedInput <input + \_mama_caller>} changes what the server
  receives: tools/call arguments carried \_mama_caller with session_id and tool_use_id for the parent call
  and additionally agent_id and agent_type for the subagent's call. Claude Code also sends
  \_meta {"claudecode/toolUseId": <tool_use_id>} on every tools/call. The current bridge rejects the extra
  field ("input.\_mama_caller is not an allowed property"), which is what R10 (b) changes: strip it and
  forward it as session facts.
- 2026-09-26 17:25 KST: R10 (b) supervisor check outside the sandbox: core runtime+api 318/318, standalone
  runtime+cli+api 172/172, typechecks clean. Live path with the built hook and bridge against the restarted
  daemon (Codex backend): a bench Claude's parent and subagent calls arrived with \_\_mama_caller (the hook's
  updatedInput applies without a permission decision), the bridge stripped it and forwarded the caller, and
  the daemon refused both with "Native caller attribution requires the Claude owner session" — a process
  that is not the owner session cannot write unattributed. Successful attribution needs the Claude backend
  live (R10 f).

- 2026-09-26: R10(d), Answer/Learn: replaced the SessionPool guess with shared prepareSessionContent/preparePrompt callbacks, invoked after each native driver settles its real session and before input dispatch; normal Codex resumption carries no startup block.
  Evidence: core session-context 5/5 covers first start, continuation, Claude death, policy replacement, explicit reset, failed assembly and death during assembly; Codex protocol suite 127/127 covers durable resume, missing rollout replacement and startup failure before dispatch.
  Requested core runtime suite: 182 passed, 44 failed at socket listen EPERM; 21 tests were blocked in 3 suite setups by the same EPERM, with an ipc-actions teardown close error after failed setup. Both package tsc --noEmit checks pass.
  Isolation settings and native tool boundaries are unchanged. Live installed-CLI owner turns and daemon.log/DB/Telegram read-back remain unverified; this run neither deploys nor commits.
- 2026-09-26: R7, Answer/Learn: new sessions prepend at most 5 owner exchanges, oldest first, with the full rendered block below 6000 characters; mailbox input and native result are joined only through retained Telegram delivered receipts (latest 20 candidates, existing 7-day receipt retention), excluding the current input and other principals.
  Replay finalization resets the native session for either backend after reaching the import fence, before live cursor finalization and daemon.stop; the SessionPool route is dropped while durable mailbox, transport, wiki, report and lesson records are retained.
  Evidence: recent-exchange tests 3/3 and replay-finalization tests 2/2 pass; requested standalone runtime/cli/replay/gateways suite: 136 passed, 8 socket listen EPERM failures. Changed-file ESLint passes; production diff including the new renderer: +289/-64 lines. Logs: /private/tmp/mama-r7-{core-tests,standalone-tests,codex-full,core-tsc,standalone-tsc,eslint}.log.
  Still unverified: a real replay-to-live owner exchange on each installed backend. Required MAMA MCP decision save was attempted but refused because it requires approval and this session uses approval policy never; no replacement memory store was written.
- 2026-09-26 17:55 KST: R7/R10 (d) supervisor check outside the sandbox: core runtime 247/247,
  standalone runtime+cli+replay+gateways+agent+integration 272/272, typechecks clean. Live proof pending
  with the next daemon restart (new thread: startup lessons + recent owner exchanges in the first stimulus).
- 2026-09-26: R10(e), Answer/Attach/shared engine: owner Codex enables live web search through an opt-in (core default output unchanged); owner Claude replaces bypass with dontAsk, required sandboxed Bash and workspace Edit/Write permissions, preserving caller hooks and isolation flags.
  Evidence: 21 focused tests pass, including emitted CLI args, configured outside-path denial and stale local grants; installed Claude 2.1.282 help lists dontAsk, and sandbox status reports enabled=true, strictMode=true, filesystemPolicy=strict, autoAllowBashIfSandboxed=true from the generated project settings.
  Requested suites: core runtime 184 passed, 44 listen EPERM failures and 21 tests blocked by 3 failed setups (plus ipc-actions teardown close error); standalone runtime/cli/agent 199 passed, 8 listen EPERM failures. Both requested tsc checks and changed-file ESLint pass. Logs: /private/tmp/r10-{core-runtime,standalone-suite,core-tsc,standalone-tsc,eslint}.log.
  Still unverified: real CLI outside/symlink writes, temp-path enforcement, subagent inheritance and web calls; no live owner turn or service restart. MAMA decision search/save was refused by approval policy never. Production diff: +88/-7 lines. No commit; R10(f) remains open.
- 2026-09-26 18:20 KST: R10 (e) live check of the Claude boundary (claude 2.1.282, --permission-mode dontAsk,
  --setting-sources project). First probe of the generated config: Write inside the workspace was denied —
  project-settings permissions were not applied at all to these non-interactive runs (bare "WebFetch"
  allowed via --allowedTools worked; the same rule in settings did not), and Edit(/**) anchors at the
  settings file's folder anyway. Bash sandbox from the same settings did apply (write to a home path:
  "operation not permitted"; /tmp writes are allowed by the sandbox by default, so the first "outside"
  probe under /tmp was not a real outside). A bare Write rule allowed writes anywhere. Supervisor fix: the
  rules go on the CLI as --allowedTools [Read, Glob, Grep, Edit(//<workspace>/**), Bash, WebFetch,
  WebSearch, mcp**mama**\*, Agent]; the host-owned settings keep only hooks, sandbox and env. Final probe:
  Write inside allowed / outside denied, Bash inside allowed / outside denied, WebFetch allowed, python
  openpyxl+PyMuPDF load. Codex: web search on for the owner runtime (core default off).
- 2026-09-26 18:40 KST: R10 (f) live owner turns on the Claude backend (claude-sonnet-5). Result: the file
  flow and the correction flow work. Five owner turns: a repeat of the earlier translation request was
  recognised from the carried exchanges; "find the first feedback" ran work.show → memory provenance →
  source.read → attachment list/download → Read of the image → Bash/openpyxl → deliver.telegram.file and
  answered with the right dates, sender and resubmission (about 85 s, 17 tools). The owner correction
  "the Excel style differs" was redone (v2 read back by the supervisor: column widths, fills, header row
  and row heights match the reference; row 2–3 font colours, header borders and centre alignment were not
  copied although the answer claimed an exact match), and "why, did you forget
  the workflow" produced memory.save kind=lesson with the host-set source_message_ref, model_run_id and
  the tool_use id. Every agent tool trace carries a model_run_id; the unattributed work.list rows every 30 s
  are the viewer's operation-scoped reads. Still failing: "make it again and send" resent the old file
  instead of remaking it; the first new Excel ignored the reference layout until corrected. Found and
  fixed: collector deltas without per-ref contentPreview queried lessons with an empty text ("Text
  cannot be empty" warning each delta); the lesson query now uses the row preview (test red→green).
  Not yet seen: lesson applied after a restart, subagent child runs on Claude.
- 2026-09-26 19:40 KST: R10 (f) second round on Claude, after a restart. Recall: the new session got the
  startup block and recent exchanges; the Excel-format lesson was not among the 3 lessons of either turn
  ("<asset-4> … 보내줘" ranks it 8th; an Excel-format phrasing ranks it 1st), which is the top-3 design,
  same as Kagemusha. Read-back of the files made after the correction: fills, widths and font colours now
  match the owner template; the subagent-made files also match alignment (one also borders).
  Failure found: "use two subagents" produced two files and zero deliveries. Claude 2.1.282 runs Agent in
  the background by default, so the parent turn ended first; the children's later host calls and the
  CLI's own follow-up turn hit "Native tool caller has no matching active turn" (the host never listened
  to autonomousTurn, and attachSubagentWake was removed in the rebuild). Fix: the host-written workspace
  settings set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (undocumented; measured on 2.1.282 via project
  settings env with --setting-sources project: two Agents in parallel, one turn, one answer, 22 s vs 28 s
  split into three answers). Re-check this on every CLI bump: the symptom is files made, nothing delivered.
  Not done: the now-unreachable background/autonomous-turn code in persistent-cli-process (39 refs) is
  left for a separate deletion with tests because the driver is exported under ./runtime/\*.
- 2026-09-26: Learn — recall kind accepts a scalar or non-empty tuple; vector, FTS5, lexical and graph re-checks include each requested kind. Owner recall requests lesson/preference/constraint; no new fallback or guard.
  Evidence: core recall/ranking/graph tests 11 passed; owner resolver unit 1 passed (each new regression failed before its fix); both package typechecks, changed-file lint and diff check passed.
  FTS5 source assertions prevent lexical fallback from masking a failed filter; scalar-kind regressions pass. SQL in suggestInAdapter/listDecisionsInAdapter is outside recall's call path and unchanged.
  Still unverified: live owner behavior after restart. Existing owner-runtime and stimulus-delivery socket tests fail with listen EPERM in this sandbox; no service restart or commit.
  MAMA MCP API-contract save was attempted but blocked: tool requires approval and approval policy is never.
- 2026-09-26 20:05 KST: supervisor check of the kind-array recall outside the sandbox: core recall tests
  11/11, standalone runtime 72/72, both typechecks clean. Live-DB probe with the owner resolver's kinds:
  the work-assignment rule, the hourly delta rule and the deadline-reminder rule (all saved as preference,
  never injected before) now rank in the top 3 for questions on their subject.
- 2026-09-26 20:10 KST: live owner turns after the recall change (Claude). Two subagents ran in parallel
  inside one turn (128 s, one answer, 14 traces under each child run linked to the parent, no refusal).
  "Who should take the TF of <asset>?" got the work-assignment rule (saved as preference) first in the
  <lessons> block and answered by it: the BC artist is unassigned, so the TF waits (17 s, 3 tools). The
  owner corrected "feedback arriving means someone is working on it"; the agent re-read the source chat,
  named the likely artist with the evidence level stated and asked before revising (73 s, 13 tools).
  Still failing: that correction was not saved (no memory.save in the turn) despite the any-turn lesson
  rule; the earlier correction in this session was saved. Agent compliance, not host; watch it on Codex.
- 2026-09-26: Answer/Recognise — stored source search now ANDs escaped literal substring terms across title/content/author/channel; capture-time DESC and event-index-id ASC replace rank in ordering and cursors, preserving visibility filters and source-ceiling assertions.
  Evidence: standalone connector/source/replay tests 78 passed; core migration/DB tests 50 passed; both package typechecks, changed-file lint and diff check passed. Regressions cover Japanese/Korean substrings, literal LIKE characters, term order, paging, filters and retained rows/writes after migration.
  Reader audit: owner-runtime -> action-surface -> sourceActionRegistrations -> stored-source-reader -> searchRaw is the source path; MCP memory tools use the core memory action path. No other connector FTS reader remains; core migration 096 drops its table/three triggers, and standalone 001 no longer recreates them on a fresh DB.
  Still unverified: live owner answers after deployment; no daemon restart or commit. The pre-existing owner-system-prompt.ts content is unchanged. MAMA MCP decision save was blocked because the tool requires approval while approval policy is never.
- 2026-09-26 21:00 KST: supervisor check of the substring search outside the sandbox: standalone connectors,
  source actions and replay 102/102, core migration chain and database instances 15/15, typecheck clean.
  Also fixed: search from/to filtered capture time while browse used source time, so a 9/22 chat backfilled
  on 9/25 vanished from a date-bounded search; both now filter source time (test red without the fix).
  Live-DB replay of the 60 distinct zero-hit agent searches of the last 3 days: 24 now return hits; the
  rest are queries in another script than the source (Korean names for Japanese chats) or absent content.
  The asset number finds the uploader's files at once (7 hits, 2 ms).
- 2026-09-26: Answer/Recognise — owner session startup now supplies one readable-source line from the stored index filtered by the actual owner connector grant; SQL aggregates channel families/counts without room names. Core connector refusals return only the caller's own connector grant; no aliases or fallback reads.
  Evidence: new regressions failed before the fix; core dispatch 11/11 and standalone source/prompt/native-session/raw-query tests 44/44 pass. Both backends exercise real DB -> owner grant -> prompt assembly with synthetic families, bare rows, hidden connectors and empty grants. Core build, both typechecks, changed-file lint/format and diff check pass.
  Full core suite under temporary HOME: 805 passed, 44 failed in experience-read-over-socket, intake-is-the-runtimes, ipc-actions, native-input-delivery, principal-grants, replay-session-facts and runtime-lifecycle; socket listen EPERM blocks all seven files, and ipc-actions also fails cleanup after server creation fails.
  Full standalone suite under temporary HOME: 473 passed, 23 failed in viewer-archive-routes, viewer-records, viewer-server, daemon-boot, w1-owner-q1, action-mcp-server, owner-runtime and stimulus-delivery; all eight files are blocked by socket/HTTP listen EPERM.
  Still unverified: live owner answers after deployment; no daemon restart or commit. MAMA MCP decision save was blocked because the tool requires approval while approval policy is never.
- 2026-09-26 21:10 KST: supervisor check outside the sandbox: core dispatch 11/11, standalone runtime,
  source actions and connectors 148/148, typecheck clean. The live-DB source line reads: chatwork (156),
  kagemusha (4089; feedback 75, kakao 3771, line 183, telegram 60), slack (190), trello (1290). Cause it
  answers: the assignee re-check subagent asked for source "kakao", got "may not read kakao" and gave up on
  the 66% of stored rows that are kakao chats under kagemusha.
- 2026-09-26 21:35 KST: assignee re-check after the rule, search and source-list fixes (Codex, new session).
  Result: the asset whose uploader the owner asked about is now assigned to that uploader on both BC and
  TF with the delivery observations as evidence; one billing item was assigned to its author. The agent
  searched source kagemusha (7 calls) after one "kakao" refusal that now names the readable connectors.
  54 calls in one run, no subagents; the answer said it had not re-checked every item. Read-back of the 26
  still unassigned: none has a file upload under its number in any kakao channel; they are lodging chores,
  quotes, meetings, pending orders and material received but not started, where no worker exists yet.
  Still open: the agent stopped short of the full list without saying why beyond "not all re-checked".
- 2026-09-26: Report/R4 — live delta instructions and last-tag routing now reuse the configured owner chat, Telegram send path and outbound ledger; each delta queues one idempotent native-event board pass using the four-slot helper. Replay never enters that route; urgency and hourly gathering remain agent judgment/R5.
  Evidence: standalone focused routing/prompt/gateway/config tests 40/40 pass, including mid-text/last tags, distinct and duplicate deltas, non-recursive board turns, configured destination, replay isolation, uncertain failed sends, bounded failure logs and no resend after gateway restart.
  Lifecycle review: boot-time deltas wait on the existing runtime ready gate; shutdown keeps Telegram open until owner result writers drain. Both regressions failed before the fixes and now pass; standalone typecheck, changed-file ESLint/Prettier and git diff --check pass.
  Full standalone suite under temporary HOME/MAMA_DB_PATH: 488 passed, 23 failed in viewer-archive-routes, viewer-records, viewer-server, daemon-boot, w1-owner-q1, action-mcp-server, owner-runtime and stimulus-delivery; all failures are socket/HTTP listen EPERM. Ran pnpm --manage-package-manager-versions=false test to avoid downloading pnpm into the temporary home.
  Still unverified: a real live delta's Telegram message/ack log, all four board slots and clean daemon.log after deployment. No daemon restart or commit; MAMA MCP decision save was blocked because it requires approval while this session's approval policy is never.
- 2026-09-26: Report/R5 — added validated KST report hours (full 8/13/18; reminders 9–21 excluding full hours), a live-only 60 s scheduler, and scheduled owner turns replacing the no-op. Full reports publish four board slots and five text sections; reminders update action_required, return 3–6 lines and include changes since the previous report not already notified. Urgency remains agent judgment.
  Delivery: the existing owner Telegram path and ledger send before runtime/report-schedule-state.json is atomically written. Pending mailbox rows prevent overlap; a failed accepted send leaves the hour unwritten for a new attempt next tick. Scheduler stops before the owner drains and Telegram closes.
  Evidence: focused standalone tests 55/55 pass (11 unrelated cases excluded), covering parser defaults/errors, KST boundaries, send-before-state, retries, replay exclusion, lessons, ledger idempotency and shutdown. Fresh review found an orphaned accepted/dispatching report could block all later ticks; both restart regressions failed first, then passed after reconciliation parks the orphan uncertain. Restored pending input still runs once.
  Validation from packages/standalone: npx vitest run on the five focused files; pnpm --manage-package-manager-versions=false typecheck; changed-file ESLint/Prettier and git diff --check pass. Full pnpm --manage-package-manager-versions=false test under temporary HOME/MAMA_DB_PATH: 521 passed, 22 failed in viewer-archive-routes, viewer-records, viewer-server, daemon-boot, w1-owner-q1, action-mcp-server, owner-runtime and stimulus-delivery, all socket/HTTP listen EPERM.
  Still unverified: real next-hour Telegram report content, task/board agreement and clean daemon.log after deployment; no live daemon restart or commit. MAMA MCP decision save was blocked because it requires approval while this session's approval policy is never. Concurrent viewer file edits are outside this R5 change.
- 2026-09-26: Answer/viewer — dashboard counts decisions and trailing-seven-day created_at through the daemon database; graph carries stored memoryKind and displays commitment for work records. Fixed kind colours and visible-data legend share graph edge styles, including amends; layout unchanged.
  Evidence: core agent-graph 14/14 and standalone viewer-data plus daemon wiring 14/14 pass (4 unrelated boot cases excluded); kind regressions failed before the fix. Core compilation, standalone typecheck, viewer build and changed-file ESLint pass.
  Boundary: dashboard totals include all decisions rows and all states; the existing graph decision list still includes observation nodes and can be a partial graph, so its displayed count is not a database total.
  Still unverified: 15 HTTP tests blocked by listen EPERM; live browser access denied by browser policy. No daemon restart or commit. MAMA MCP contract save requires approval, unavailable under this session's never policy.
- 2026-09-26: Recognise/Report — restored the calendar connector and gws helper from 2fb693d75^; retained f3f0316c7's now + 90-day horizon, 250-event pages, repeated-token rejection and 20-page cap. Calendar CLI auth loads without an ignored warning; shared loadable names now also supply daemon/default owner grants.
  Evidence: from packages/standalone, vitest run tests/connectors tests/runtime/{connectors,owner-readable-sources,action-surface,w1-real-config}.test.ts tests/api/source-actions.test.ts passed 104/104; vitest run tests/cli/daemon-boot.test.ts -t 'starts producers' passed 1/1. All ran under temporary HOME/MAMA_DB_PATH with gws mocked; missing-loader, ignored-config and missing-owner-grant regressions failed before the fixes. Typecheck, changed-file ESLint/Prettier and git diff --check pass.
  Storage: real runtime/index/source.search/source.read tests retain start/end, title, optional location, organizer, cancellation and all-day exclusive ends; both owner prompts list stored calendar events. Content previews redact emails/phone numbers and omit attendees. Unchanged snapshots do not duplicate deltas; incomplete paging saves nothing and does not advance the cursor. Init checks actual Calendar read access, with install/PATH or gws auth login remediation and no fallback.
  Full standalone test (pnpm --manage-package-manager-versions=false test): 551 passed, 23 failed, all listen EPERM in viewer-archive-routes, viewer-records, viewer-server, daemon-boot, w1-owner-q1, action-mcp-server, owner-runtime and stimulus-delivery. No live gws call, activation, daemon restart or commit; existing full-report instructions already require the next 14 days and this week's lodging check-ins/outs. Real collection, a fresh owner session/report and clean daemon.log remain supervisor checks after activation.
  MAMA MCP decision search/save was blocked by its approval requirement under the session's never policy; the decision was not persisted there.
- 2026-09-26 23:00 KST: calendar connector live. Supervisor: standalone connectors, runtime, cli 225/225,
  typecheck clean; connectors.json calendar enabled; after restart 66 events stored (9/25 to 12/25), no
  email address or phone number in stored content. First live R4 evidence: the calendar's first delta turn
  routed ack ("delta report route=ack") and queued its board turn.
- 2026-09-26: Shared engine/public MCP — restored the origin/main in-process design against current core public exports; removed the transport client/helper and retained save/search/update, contracts, case timeline, checkpoint/resume and raw conversation ingest. The server and plugin choose MAMA_DB_PATH or ~/.claude/mama-memory.db before initDB; no alternate transport.
  Evidence: from packages/mcp-server, `pnpm exec vitest run` passes 139/139 (15 files, zero skips), including real stdio initialize/tools-list/save/vector-search/update/ingest, DB read-back and checkpoint resume across restart. All DB tests use temporary HOME and DB paths. Current mama-core `pnpm build`, MCP ESLint/Prettier, plugin db-path ESLint/Prettier, public-export resolution and scoped git diff --check pass.
  Adaptations: current save returns an object, ingestConversation's ambient facade is in mama-api, registry writes take an adapter, and timeline evidence lives in observation_versions. Retained queryless topicPrefix, contract pre-filtering, diagnostics/meta, provenance stripping, package-local helpers and external core loading. Dropped obsolete config-loader tests (no current configuration-file API); cache declaration and model defaults use the public embeddings module.
  Limits: MAMA MCP decision save was blocked by its approval requirement under approval=never; no decision persisted there. No commit, live DB test, service restart or OS owner-flow completion claim. Unrelated concurrent edits remain untouched.
- 2026-09-27 00:00 KST: supervisor check of D0 outside the sandbox: mcp-server 139/139, plugin 165/165
  (a new manifest test fails without the fix); live stdio run of `node src/server.js` on a temporary
  MAMA_DB_PATH, no daemon involved: tools/list shows save, search, update, search_decisions_and_contracts,
  case_timeline_range; save, search, save type=checkpoint, load_checkpoint and update all succeed. The
  server and hook default honours the older MAMA_DATABASE_PATH name the core still reads (Codex had
  dropped it, which would have switched such users to the default database silently).

- 2026-09-27: Answer/Report security P1 — standalone now removes all secret-shaped environment names before either CLI starts; the shared drivers accept a complete consumer-provided processEnv. Connectors retain the daemon environment.
  Evidence: environment-name tests, a mocked Claude spawn and a real synthetic app-server subprocess show no inherited test credential; Codex start and restart/resume use the same filtered environment. No secret-shaped backend exception was necessary; CLI authentication remains in its managed home.
  Boundary: native children inherit the backend environment. This is repository/test evidence, not a new live daemon process; deployment and a fresh owner session remain unverified.
- 2026-09-27: Answer security P1 — Claude gets CLI Read denies plus sandbox denyRead for auth.env, config.yaml, runtime/ and managed/custom Codex homes; Codex gets a named workspace profile with denied paths and network disabled, selected on both thread/start and thread/resume.
  Evidence: settings and process-argument tests, config tests and synthetic app-server restart/resume tests pass; removing the environment/file restrictions makes their regression tests fail. Installed Codex package version is 0.156.1; static binary fields and official config/app-server documentation support the named profile path.
  Limit: automatic approval review rejected shell-launched Codex help; no real CLI sandbox read attempt was run. These profiles constrain model tools, not the trusted backend's own authentication reads. No service restart.
- 2026-09-27: Recognise/Answer security P1 — both model-result choke points quote source.read/search, source.attachment.list/download, manage.wiki.read and report.read, including errors. The JSON envelope remains valid; data is delimited text containing the original serialized data. Host receipts retain their structure.
  Delta messages, preview, fallback payload and replay queue are quoted; embedded end markers are neutralized. Unused stripping/instruction helpers were deleted. The connector reader regression still reads every quoted source handle successfully.
  Evidence: MCP/dynamic-tool tests cover all six actions; delta tests cover message refs and fallback payload. Removing the wrappers makes the boundary regressions fail. Real model resistance to hostile instructions is not claimed from delimiters alone.
- 2026-09-27: Report/viewer security P1 — removed identity-header trust and the retired server-token alias. Authentication awaits RS256 signature/JWKS verification (10-minute cache), issuer/audience, expiry/clock skew and email; all tunnel-header requests require a verified assertion or MAMA_AUTH_TOKEN.
  Missing/invalid Access configuration fails closed and logs one value-free startup message. Direct loopback without tunnel headers still works. Synthetic RSA tests cover signatures, claims, forged/empty headers, cache expiry, fetch failure and token fallback; no real credentials or deployment details were used.
  Validation and per-file line counts are in security-p1-2026-09-27.md. Core compilation, standalone typecheck and changed-file lint pass. Full-suite socket/HTTP tests are blocked by listen EPERM; MAMA decision search/save requires unavailable approval, so the decision is recorded here and in AGENTS.md only. No commit.
- 2026-09-27 00:45 KST: security P1 live check (Codex backend). Supervisor fix: the environment filter
  kept dropping MAX_THINKING_TOKENS (a Claude budget, not a credential); it is now kept by name. Suites
  outside the sandbox: core runtime 251/251, standalone runtime/api/cli/agent 408/408. After restart:
  the daemon still holds the six connector secrets, its Codex children hold none; Codex sandbox under the
  generated profile denies reads of auth.env, config.yaml and runtime/session-credential, reads the
  workspace, denies writes outside it; the first turn ran under the profile and its rollout shows tool
  results and delta text wrapped (report.read 10, source.read 4, source_delta 4). Viewer origin: plain
  loopback 200; tunnel-shaped requests with forged Access headers or no credentials 401; bearer 200. Access
  issuer and audience were taken from the live Access app and placed in auth.env without printing them.
  Not yet seen: a logged-in browser passing the JWT check; the Claude deny rules live (backend is Codex).
- 2026-09-27 01:05 KST: the owner opened the viewer through the Cloudflare domain and logged in: the board
  and task pages load. With forged Access headers refused at the origin (401), this is the verified-JWT
  path passing. Security P1 is live on the Codex backend; the Claude deny rules are still test-only.

- 2026-09-27: Answer/Report security P2 — native owner and subagent tool notifications now enter the existing core observation path and `tool_traces`, with parent run attribution, provider call IDs, bounded masked inputs, status and duration.
  Evidence: driver callback tests and real SQLite read-back cover read/web/write calls, concurrent identical names, interrupted calls, late child events and failed observation storage. Replay eligibility remains separate from read-only observation; storage errors do not block the owner.
  Remaining: native backend/live daemon validation is not claimed. Detailed commands, results and per-file deltas are in security-p2-p3-2026-09-27.md.
- 2026-09-27: Answer security P2 — every viewer request checks its Host before authentication to prevent DNS rebinding; MAMA_VIEWER_HOSTNAMES extends loopback names. Existing Access JWT verification and bearer authentication remain the identity boundary.
  Evidence: handler tests reject malformed, duplicate and unapproved Hosts before auth, and log tunnel requests/auth failures exactly once with verified identity hashes or token/anonymous markers. Direct local requests remain quiet.
  Remaining: socket-based and live tunnel checks are blocked or unperformed; no deployed configuration was read or changed.
- 2026-09-27: Attach/Answer/Report security P2 — wiki publish/update and report publish now declare recallableWrite. The shared scan visits evidence-reference leaves without rejecting ordinary content/version hashes; rejected catalog writes also receive masked trace summaries.
  Evidence: dispatcher tests prove rejected page/report writes leave existing files and slots unchanged; valid source references, section edits and hashes still persist. Existing credential patterns are reused without entropy-based token matching.
  Remaining: this does not retrospectively scrub stored data or recognise arbitrary secret formats.
- 2026-09-27: Answer security P2 — Claude stderr shares configured-value redaction with Codex, including split chunks. Viewer internal failures receive generic client responses and retain sanitized diagnostic detail in the log.
  Evidence: shutdown/split-stderr tests, wrapped-action error tests, bounded log-tail file I/O tests, and daemon startup tests cover 0600 creation/tightening. The tail endpoint reads at most 256 KiB and reports an unknown full-file line count as null.
  Remaining: the running daemon and existing live log permissions were not changed; startup enforcement applies on the next boot.
- 2026-09-27: Recognise/Attach security P3 — rejected non-owner Telegram messages now log only chat/sender hashes. Shared downloads enforce 50 MiB across headers and streamed bytes; Slack credentials are restricted to the approved HTTPS file origin with redirects refused.
  Evidence: connector/gateway tests cover exact-limit success, oversized or dishonest lengths, cancellation, cleanup, unchanged targets and credential destination checks. Telegram's existing narrower 20 MiB download limit remains intact.
  Remaining: no live connector download or delivery was attempted. The security guide now describes this branch's actual boundaries and limitations.
- 2026-09-27: Security P2/P3 decision recording — MCP save was attempted under the repository rule but returned “requires approval” while this session's approval policy is never.
  The architecture/API/environment decisions are recorded in this check log and security-p2-p3-2026-09-27.md. No commit, daemon restart or live state mutation was performed.
- 2026-09-27: Security P2/P3 validation — 367 focused tests passed, core compilation and standalone typecheck passed, and changed-file lint passed. No commit.
  Full standalone retains 23 sandbox listener failures; full core retains listener/embedding failures and one graph pagination assertion that passed isolated reruns on current and unchanged baseline source. The report names every affected suite.
  These are source/test results only; owner-facing live behavior, deployment and connector delivery remain unverified.
- 2026-09-27 01:40 KST: security P2/P3 supervisor check: core 891/891, standalone 687/688 → fixed the one
  failure (the generic-error change also hid fixed host messages such as 503 "Report store is not wired";
  now only unexpected errors and server-side action failures are hidden, 4xx action messages kept).
  API 182/182. Live after restart: loopback 200; Host evil.example 421 (DNS rebinding); tunnel Host with
  forged Access header 401 and logged as a [viewer] line; a /.env probe logged; daemon.log 0600;
  MAMA_VIEWER_HOSTNAMES set without printing the hostname. Not yet seen live: a native shell/web call
  traced (no turn since the restart used the shell; unit tests only).
- 2026-09-27: Report check — viewer security observation extends `79accb48a`: one 0600 JSONL event per tunnelled/refused request, an authenticated bounded event tail, and recent events on the existing logs page; access decisions are unchanged.
  Classification precedence is host_rejected → probe (fixed scanner fingerprints) → forged_access_header → unknown_identity → auth_failed → owner_access; authenticated non-success responses use request_failed. `MAMA_VIEWER_OWNER_EMAILS` is an optional comma-separated, case-insensitive observation list; an explicitly empty list matches nobody. Emails are hashed, and paths omit queries and redact credentials.
  Alerts use the daemon's late-bound `gateway.sendToOwner`, once per class/path per ten minutes within the running viewer; owner_access and replay never alert. Send failures log fixed metadata with no retry loop. Evidence: temporary-HOME focused verification 92 passed / 1 socket test excluded; full standalone 681 passed / 23 listener EPERM failures; typecheck, changed-file lint and viewer inline JavaScript syntax passed.
  The eight affected suites are `viewer-archive-routes`, `viewer-records`, `viewer-server`, `daemon-boot`, `w1-owner-q1`, `action-mcp-server`, `owner-runtime`, and `stimulus-delivery`. Commands from `packages/standalone`: `node node_modules/vitest/vitest.mjs run tests/api/viewer-security.test.ts tests/api/auth-middleware.test.ts tests/api/cf-access.test.ts tests/cli/daemon-boot.test.ts -t '^(?!.*authenticates MCP list)'`; `pnpm --manage-package-manager-versions=false test`; `pnpm typecheck`; changed-file `pnpm exec eslint`; extracted inline script `node --check`.
  Still unverified: deployed tunnel traffic, real Telegram receipt and visual browser rendering (local preview navigation blocked by browser policy). MAMA MCP decision search/save was denied by approval policy `never`. No daemon restart, deployment or commit performed; this is source/test evidence, not completion of the owner loop.
- 2026-09-27 02:20 KST: external-access detection live. Supervisor: standalone api/cli/gateways/runtime
  397/397, typecheck clean. After restart, three tunnel-shaped requests at the origin were recorded in
  logs/security-events.jsonl (0600) as forged_access_header (401), probe (/.env, 404) and host_rejected
  (421), identities anonymous, and three owner Telegram alerts show as delivered in the message ledger.
  Limit stated to the owner: requests that Cloudflare Access refuses at the edge never reach the origin,
  so they appear only in Cloudflare's Access logs, not here.
- 2026-09-27: D4 Answer/Report — outbound Telegram ledger v3 now retains the readable `idempotencyKey` and confirmed chunk `messageIds`; one completion log carries those IDs without message text.
  Evidence: temporary-HOME gateway tests read receipts from disk after split delivery, partial failure and restart; daemon delta/scheduled tests verify the same key in the ledger and logger. Delivered sends remain deduplicated.
  Older receipts still load without fabricated IDs; a supplied key can annotate an existing receipt. Historical Telegram message IDs cannot be recovered from the old hash alone.
  Remaining: no live send, daemon restart or deployment was performed for this change.
- 2026-09-27: D4 Report — changed slots persist `operationId` and `modelRunId` from the action context through the existing atomic report snapshot writer; absent context is explicit null.
  Evidence: dispatcher-to-file tests verify both slots, reload, basis-only rewrites and manual calls. An unchanged HTML/basis publication remains a no-op and preserves its original writer.
  Old slot snapshots retain their existing fields and load unchanged; report-persistence.ts already serializes the full slot, so it needs no separate format or migration.
  Remaining: existing slots are not retrospectively attributed; a live agent publication has not been exercised here.
- 2026-09-27: D4 Answer/Report — stimulus delivered/failed lines include `model_run_id`; native `onModelRunStarted` carries the actual opened run through model, receipt-storage and outbound failures before a result is available.
  Evidence: native-turn tests cover completion, model failure and commit failure; daemon tests cover source deltas, board turns, scheduled reports and failed sends. Result provenance/replay semantics stay unchanged; unavailable run identity is null.
  Validation: focused core 6/6 and standalone 69/69, core compilation, standalone typecheck, changed-file lint and diff whitespace checks passed, all tests under a temporary HOME with isolated MAMA_DB_PATH.
  Remaining: source/test evidence only. Full standalone 686 passed / 23 socket-listen EPERM failures; full core 806 passed / 67 failures, with all 50 tests in its four embedding-affected suites passing after copying the model cache into the temporary HOME. Socket-bound suites remain blocked by the sandbox.
  MAMA MCP decision save was attempted under AGENTS.md but refused because approval is required and this session has policy `never`; the contract decision is recorded above. No commit.
- 2026-09-27 02:40 KST: D4 trace check. Live trace of one owner message (Telegram receipt → mailbox row →
  native input delivery → model run by sourceMessageRef and nativeInputId → 55 tool traces → daemon.log
  accepted/delivered → reply state on the same ledger key) and one source delta (observation in the
  connector index and observation_versions → delta stimulus with 65 refs → model run → 5 log lines →
  board stimulus → board run → report.publish trace) connected by ids. Gaps found and fixed: outbound
  sends keyed only by a hash (now the idempotency key and Telegram message ids are stored and logged),
  board slots without their writer (now operationId and modelRunId), log lines without the model run
  (now model_run_id), security alerts not linked to their event (supervisor: event ids are the alert
  keys). Live: an alert's ledger entry carries its key and message id and the log shows it. Suites:
  core runtime 263/263, standalone 709/709. Open: a native shell call traced live.
- 2026-09-27: D3 onboarding implementation adds owner-only TTY init/secret entry, atomic 0600 auth.env updates staged under denied runtime/, secret-free configuration and opt-in launchd files; bootstrap is only printed.
  Evidence: 74/74 focused tests pass under temporary HOME; generated start.sh executes against a fake daemon, hidden input restores echo, and compiled CLI rejects piped init/set without writing state. Telegram uses only its environment token; legacy YAML is rejected. Trello now reads separate key/token variables.
  Validation from packages/standalone: `pnpm exec env HOME="$d3_test_home" MAMA_DB_PATH="$d3_test_home/dev.db" vitest run --passWithNoTests` — 712 passed, 23 socket-listen EPERM failures across 8 suites; typecheck, isolated-output tsc compilation and changed-file lint pass.
  Remaining: no real owner login or Telegram answer was exercised; live ~/.mama and the running service were untouched, so D3 remains open. No commit. MAMA MCP decision save was blocked by approval policy never; the contract is recorded in docs-cleanup.md D3.
- 2026-09-27 03:10 KST: D3 onboarding supervisor check: standalone 734/735 → fixed the one failure (the
  integration fixture still put the bot token in config; it now comes from MAMA_TELEGRAM_TOKEN). Live: the
  running config's Telegram token moved into auth.env without printing it and removed from config.yaml;
  the daemon boots and Telegram polling starts from the environment. A pseudo-terminal run of
  `mama init` in a temporary HOME with fake tokens: token prompts do not echo; auth.env, config.yaml,
  connectors.json 0600, start.sh 0700; no token in config.yaml, connectors.json or start.sh; auth.env
  names MAMA_TELEGRAM_TOKEN, MAMA_SLACK_TOKEN, MAMA_AUTH_TOKEN (generated); `secret list` shows names only;
  init and secret set refuse without a TTY; a second init refuses to overwrite. Not done live: onboarding a
  real fresh machine through a Telegram reply.

## D2 documentation pass 1 — 2026-09-27

- Result: all 27 D2 pages written or updated; 37 retired files read first, with 35 paths removed and two rewritten in place. Current knowledge was carried forward; no archive folder was added.
- Evidence: source-checked CLI/config/viewer/MCP references; the owner action table is generated from 19 actual runtime registrations. The [pass-1 report](docs-pass1-report.md) records paths, line counts and validation.
- Verification: combined documentation relative-link check has no unresolved paths; catalog grants and generated rows match. Security content is retained except the onboarding and Telegram environment-token addition.
- Remaining: README/website/CHANGELOG/TODOS are pass 2; fresh-machine onboarding, packaged viewer assets and owner-result verification are not established by this documentation pass. `git rm` could not write the sandbox-protected index, so deletions remain unstaged; no commit.
- 2026-09-27 03:40 KST: docs pass 1: 35 obsolete pages deleted (no archive), 27 pages written or updated in
  the D2 tree, link check 228 links / 39 files / 0 broken, owner actions generated from the registrations.
  The new setup guide reported two real defects, fixed here instead of documented: the standalone package
  did not ship public/ (viewer assets; now 30 viewer files in the pack list) and `mama init` told Codex
  users to run plain `codex login` although the runtime reads its own Codex home (now prints
  CODEX_HOME=<root>/.codex codex login; the test fails without the fix). The new pages carry no personal,
  customer or project names; the rebuild logs (checks.md, owner-reports.md) still do — D6.

## D1/D5 documentation pass 2 — 2026-09-27

- Result: root and four package READMEs, website text, Unreleased notes and current TODOs now describe the owner rebuild; report/replay plans distinguish implemented mechanisms from open owner checks.
- Evidence: package manifests, core exports/migrations, MCP tool advertising, plugin hooks and current check-log entries were compared; an independent read-only review corrected the core cache-default description.
- Verification: 366 local/repository links across 47 files pass path and heading-anchor checks; Git-ignored local drafts and three external font URLs are outside this check. Website CSS, scripts, layout structure and images are preserved; released changelog entries are byte-identical. Added-line privacy patterns and diff whitespace checks pass.
- Remaining: this documentation pass does not close live owner acceptance, fresh-machine onboarding or the D6 history-wide privacy gate. Historical checks are unchanged except the requested W0 back-reference; no runtime test, deployment or commit.
- 2026-09-27 04:00 KST: D6 privacy gate. Term list built from the live data (authors, channel names and
  ids, Trello board and card tokens, work titles, secrets in auth.env, tunnel hostnames; 636 terms) plus
  the names seen in this session. Found only in the rebuild logs and one core test: customer, asset and
  place names and a customer project code. Replaced with placeholders in the tree and in every commit on
  the branch (git filter-repo limited to origin/main..HEAD, messages included; a local backup branch
  kept and not pushed). Re-scan: 0 sensitive terms (case-insensitive) in the tree, added lines or
  messages; gitleaks on 92 branch commits: no leaks; email/phone/id patterns only synthetic test values.
  Full root build, typecheck, lint and tests pass after the rewrite (core 894, standalone 735, MCP 139,
  plugin 166). The PR body scans clean.
- 2026-09-27 09:10 KST: live report and alert check. The 08:00 full report ran as a scheduled turn,
  was delivered on Telegram (outbound ledger key report:2026-09-27:08, log line with model_run_id), the
  hour was recorded only after the send (lastFullKey 2026-09-27:08), and the four board slots carry their
  writer run. The 09:00 reminder was queued. False alarm found: at 08:25 the owner's browser fetched the
  web manifest without cookies (browsers do), the origin served it (200) and detection classed it
  auth_failed and alerted. Now an unauthenticated request that was served is public_asset (recorded, no
  alert); only a refused one is auth_failed. API tests 200/200 (the new test fails without the fix; five
  tests that encoded the false alarm now use a refused route).

### Review F3.1 — fixed (Answer/Learn)

- Modern project API keys and fine-grained repository tokens escaped the shared scanner and redactor.
- Added both shapes to the shared pattern list; both regression cases failed before the fix.
- Evidence: core `vitest run tests/memory/secret-filter.test.ts` passes; live owner acceptance remains separate.

### Review F3.13 — fixed (Answer)

- ASCII word boundaries prevented Korean vocabulary from matching attached particles.
- Separated Korean alternatives from English boundaries; six Korean regression cases failed before the fix.
- Evidence: core `vitest run tests/knowledge/question-type.test.ts` passes; live owner acceptance remains separate.

### Review F3.2 — fixed (shared engine / Answer / Learn)

- Consumer migration numbers entered core-only handlers and repair; both paths now require the core source.
- Red evidence: Consumer SQL at 72/73/74/77/79 did not run; a consumer file triggered core index repair.
- Green evidence: core `pnpm exec vitest run tests/migrations/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.3 — fixed (shared engine / Answer / Learn)

- Instance recall expanded through the global DB; expansion now uses the supplied adapter.
- Red evidence: Two real databases with identical IDs returned foreign graph content before the fix.
- Green evidence: core `pnpm exec vitest run tests/unit/recall-graph-expansion.test.ts`; live owner acceptance remains untested.

### Review F3.4 — fixed (shared engine / Answer / Learn)

- Observation LIKE search deleted literal metacharacters; it now escapes them with an explicit SQL escape character.
- Red evidence: All three literal percent/underscore/backslash searches returned the wrong observation.
- Green evidence: core `pnpm exec vitest run tests/knowledge/review-f3-graph.test.ts`; live owner acceptance remains untested.

### Review F3.5 — fixed (shared engine / Answer / Learn)

- Timeline slicing preceded recorded-time filtering and lost overflow evidence; filtering now precedes slicing and has_more reaches page coverage.
- Red evidence: A later matching record disappeared behind limit=1; overflow was unreported.
- Green evidence: core `pnpm exec vitest run tests/knowledge/review-f3-graph.test.ts`; live owner acceptance remains untested.

### Review F3.6 — fixed (shared engine / Answer / Learn)

- Run-finished observer exceptions escaped after commit; synchronous and async observer failures are logged without failing the committed turn.
- Red evidence: The synchronous observer rejected the turn; the async observer produced an unhandled rejection.
- Green evidence: core `pnpm exec vitest run tests/runtime/native-turn.test.ts`; live owner acceptance remains untested.

### Review F3.7 — fixed (shared engine / Answer / Learn)

- Pending coalescing could select already dispatched native inputs; it now excludes native states other than prepared.
- Red evidence: Dispatching, accepted and uncertain rows absorbed fresh work before the fix.
- Green evidence: core `pnpm exec vitest run tests/runtime/mailbox-payload.test.ts`; live owner acceptance remains untested.

### Review F3.8 — fixed (shared engine / Answer / Learn)

- Read scopes used ambiguous concatenation and rejected overlapping admitted scopes; tuple keys deduplicate admitted reads while explicit duplicate requests still fail.
- Red evidence: Overlapping access/readScopes threw; collision cases are covered in the same regression.
- Green evidence: core `pnpm exec vitest run tests/api/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.9 — fixed (shared engine / Answer / Learn)

- Path count/depth did not bound unreachable dense searches; frontier is capped at 1000 paths and raw edge work at 10000 candidates, with limit_reached.
- Red evidence: Disconnected fanout and 11000 hidden edges returned no truncation reason; bounded scan is asserted.
- Green evidence: core `pnpm exec vitest run tests/knowledge/review-f3-graph.test.ts`; live owner acceptance remains untested.

### Review F3.10 — fixed (shared engine / Answer / Learn)

- memory.update ignored target scope bindings; scoped targets now require at least one admitted write scope, with read-only scopes excluded.
- Red evidence: Foreign-scoped update completed before the fix; the regression verifies unchanged outcome and permitted same-scope update.
- Green evidence: core `pnpm exec vitest run tests/api/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.11 — fixed (shared engine / Answer / Learn)

- Checkpoint writes lacked the recallableWrite contract flag; the existing shared secret gate now runs before checkpoint persistence.
- Red evidence: A credential in open_files was persisted before the fix.
- Green evidence: core `pnpm exec vitest run tests/api/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.12 — fixed (shared engine / Answer / Learn)

- Current-history hydration followed merged identities without rechecking visibility; the resolved identity is now checked before hydration.
- Red evidence: After a scope change on a merged survivor, the old visible seed exposed the restricted survivor.
- Green evidence: core `pnpm exec vitest run tests/knowledge/review-f3-graph.test.ts`; live owner acceptance remains untested.

### Review F3.14 — fixed (shared engine / Answer / Learn)

- External source.ingest accepted reserved owner-message:/owner-result: source prefixes; it now rejects them before ingestion.
- Red evidence: Both reserved connector inputs were persisted before the fix.
- Green evidence: core `pnpm exec vitest run tests/api/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.15 — fixed (shared engine / Answer / Learn)

- IPC encoding could throw inside connect and leave the Promise unsettled; encoding now rejects before connect and settle clears the deadline.
- Red evidence: Circular/oversized inputs timed out with uncaught errors; settled responses retained a timer.
- Green evidence: core `pnpm exec vitest run tests/runtime/ipc-settlement.test.ts`; live owner acceptance remains untested.

### Review F3.16 — fixed (shared engine / Answer / Learn)

- Applied 095 had an unguarded JSON join expression; new migration 097 guards it independently without editing any applied migration.
- Red evidence: A principal-filtered view read over malformed historical JSON raised malformed JSON before 097.
- Green evidence: core `pnpm exec vitest run tests/migrations/review-f3.test.ts`; live owner acceptance remains untested.

### Review F3.17 — fixed (shared engine / Answer / Learn)

- Unknown scope kinds had NaN sort ranks, grants used aliases verbatim, and journal hashing rejected optional undefined fields; all three contracts are normalized.
- Red evidence: Reversed custom scopes hashed differently, canonical grants denied aliases, and undefined input failed before send.
- Green evidence: core `pnpm exec vitest run tests/api/review-f3.test.ts tests/runtime/ipc-settlement.test.ts`; live owner acceptance remains untested.

### Review F3.18 — fixed (Answer / Learn)

- Stdio smoke options now match the advertised camelCase schema and assert the saved decision is returned.
- Red evidence: the old option names / missing precedence failed the added contract assertions.
- Green evidence: MCP `pnpm exec vitest run tests/integration/stdio.test.js`; no live owner acceptance is claimed.

### Review F3.19 — fixed (Answer / Learn)

- Configure now documents MAMA_DB_PATH, then MAMA_DATABASE_PATH, then the default; the resolver is verified under temporary HOME.
- Red evidence: the old option names / missing precedence failed the added contract assertions.
- Green evidence: plugin `pnpm exec vitest run tests/core/configure-database.test.js`; no live owner acceptance is claimed.

### Review F3 — final verification and limits

- All 19 items fixed after red/green verification; detailed file counts and commands: [review-f3-results.md](review-f3-results.md). No standalone edits or commits.
- Core focused 93/93; full core 870 pass / 44 fail across 7 socket-dependent files (listen EPERM and its cleanup error). MCP 139/139; plugin 170/170; build, typecheck and changed-file lint pass.
- Live owner acceptance and deployment remain untested. MAMA MCP decision save was refused by the tool approval policy (never); contract decisions are retained in the result document.

### F4 — Codex re-verification of F1–F3 (2026-09-27)

- Codex re-read all 49 items against the code: resolved except eight, listed in
  [review-fixes.md](review-fixes.md) §F4 (attachment write race, symlinked delivery root, MCP checkpoint
  secret scan, Telegram recovery blocking polling, regenerated report key, sibling attachment, recursive
  edge CTE, Trello failed-board count). All eight fixed with a red/green test each; a re-download of the
  same attachment still replaces the earlier file (temp file + rename in the rechecked directory).
- Live: not exercised; the Trello count is proven by fixtures while the live token returns 401.
- Codex's review of that commit found five more (review-fixes.md §F5: cross-process directory swap,
  checkpoint transcript scan, recovery chunk reset and polling race, destination binding, exponential
  visibility evaluation); fixed with tests (a 24-level DAG fails on the old evaluator).

- A third Codex pass (§F6): repeated cross-process swaps still beat the path recheck (Node has no
  openat), so the daemon now downloads only into daemon-owned `~/.mama/downloads/` (agent read-only)
  and the recheck code is deleted (+164/−221); the delivered-receipt exception is opt-in for outbound
  text only, so a different file under one operation id is refused again; the final pass made the
  daemon refuse an `agent.codex_cwd` overlapping downloads. Live: `~/.mama/downloads` created 0700 at boot.

### Restoration Phase A0 — 2026-09-27

- Result: registered all nine restored sources, validated their channel fields, and passed state paths into the branch poll handoff.
- Evidence: root build, typecheck and changed-file lint pass; factory/config and scheduler-to-RawStore/event-index prompt tests pass; standalone reports 1,004 pass and 23 socket `EPERM` failures across eight files.
- Still fails: no live source accounts or owner turns were used; no daemon state under `~/.mama` was accessed.

### Restoration Phase A1 — 2026-09-27

- Result: restored Gmail, Drive and Sheets from `origin/main`; added argv-based gws calls, complete page draining, staged cursors/snapshots and removal/deletion events.
- Evidence: Gmail page/message failures, Drive later-page retry/removal, and Sheets range/duplicate/delete/restart tests pass; root build/typecheck/lint pass.
- Still fails: live Google login, source changes and owner reads were not exercised; Sheets retains first-nonempty-cell identity and poll-time source timestamps.

### Restoration Phase A2 — 2026-09-27

- Result: restored Notion, Obsidian, Discord, Telegram and Claude Code, restored iMessage, and added scoped credentials and local-path aliases.
- Evidence: restored connector, iMessage, onboarding and owner readable-source tests pass; root build/typecheck/lint pass and standalone reports 1,004 pass / 23 socket `EPERM` failures.
- Still fails: live provider access and post-restart owner reads were not exercised; Notion reads integration-shared pages and Gmail has no mailbox label scope.

### Calendar incremental polling and source-delta admission (2026-09-27)

- Result: Calendar uses `updatedMin` inside the existing 90-day event window, and event `updated` supplies source time; provenance-only re-polls no longer create pending source projections.
- Evidence: standalone calendar and polling-scheduler regressions pass, including a second identical poll admitting no additional delta.
- Still open: no live calendar owner turn was run; `~/.mama` was left untouched.

### Stored-source coverage contract (2026-09-27)

- Result: Removed the hard-coded false collection-completeness claim; search still returns `returned` and `pageComplete`.
- Evidence: the stored-source action regression confirms those fields and absence of the false completeness claim.
- Still open: no live owner search was run; `~/.mama` was left untouched.

### Claimed mailbox restart recovery (2026-09-27)

- Result: Startup requeues claims with no native dispatch; dispatched or uncertain rows reconcile and park uncertain with a log line. Telegram pending checks no longer treat an unowned claim as live.
- Evidence: restart simulations redeliver unstarted `source_delta` and `native_event` rows once, and result-less dispatches invoke the uncertainty callback.
- Still open: no live daemon restart was run; `~/.mama` and `~/.claude/mama-memory.db` were left untouched.

### W14 — owner guidance index and agent-managed workflows (2026-09-27)

- Result: stimulus-text recall is removed; the first owner turn receives the scoped index and later turns receive only added, revised, or retired entries. Workflows use a migrated core kind and structured content in `payload_json`.
- Evidence: core guidance actions 5/5, migration data-preservation test 1/1, standalone index/session tests 4/4; root build and typecheck, changed-file ESLint, and changed-TypeScript Prettier check passed.
- Full suites: core 889 passed / 44 failed across `native-input-delivery`, `intake-is-the-runtimes`, `runtime-lifecycle`, `replay-session-facts`, `experience-read-over-socket`, `ipc-actions`, and `principal-grants`; standalone 788 passed / 23 failed across `stimulus-delivery`, `daemon-boot`, `viewer-archive-routes`, `w1-owner-q1`, `viewer-server`, `action-mcp-server`, `owner-runtime`, and `viewer-records`. These failures are listener `EPERM` in the sandbox.
- Still open: a live owner turn confirming a correction changes the next related answer was not run. No live data path was touched and no commit was made.

### W15 part 2 — wiki with reports, owner-turn hygiene (2026-09-27)

- Result: delta-board and scheduled full-report turns update the wiki page of each changed work item,
  splitting several pages across subagents inside the turn; owner answers carry no [notify]/[ack],
  refresh the board only when asked, and contain only the answer (no working notes or ids).
- Owner-first ordering already existed (stimulus-delivery prefer owner_message); the 15:02 wait was
  the in-flight turn, whose cause (calendar repeats) W15 part 1 removed. No core change.
- Still open: a live delta or 13:00/18:00 report writing wiki pages, and an owner answer without markers.

### W13 — public documentation (2026-09-27)

- Result: GitHub Pages now builds the Markdown docs tree; README, site home, first-day tutorial, and current release notes describe the rebuild for readers.
- Evidence: checked CLI commands, onboarding/config facts, selectable sources, exports, migrations 096–098, version sync, front matter YAML, and 192 local Markdown links across 34 public Markdown files; no broken paths or heading links.
- Still open: the hosted Pages build and fresh-machine tutorial flow have not been run. Live report/wiki and file-delivery steps remain unobserved as noted above.

### Restoration Phase B1 — 2026-09-27

- Result: Added Discord/Slack owner allowlists, three single-messenger delivery routes, route startup validation, and Slack Socket Mode secret collection in `mama init`.
- Evidence: runtime config and onboarding tests pass; disabled or unconfigured route tests fail startup explicitly.
- Still open: credentials and live provider setup were not exercised; no home data was touched.

### Restoration Phase B2 — 2026-09-27

- Result: Added Discord and Slack owner adapters on the existing turn-intake contract, using the provider SDK calls from `origin/main:packages/standalone/src/gateways/discord.ts` and `slack.ts` without the removed router/session seams.
- Evidence: owner allowlist, hashed rejection, duplicate intake, attachment failure visibility, and restart reply recovery tests pass for both adapters.
- Still open: no live Discord or Slack owner conversation was run.

### Restoration Phase B3 — 2026-09-27

- Result: Generalized the V3 ledger without converting its format, shared one ledger instance across enabled messengers, recorded provider message refs and chunk progress, and added content-bound Discord/Slack file actions.
- Evidence: corrupt-ledger failure, restart recovery, one-time file sends, Telegram receipts, and attachment-action tests pass; downloads use the atomic daemon-owned writer.
- Still open: no live provider upload or recipient-side receipt was observed.

### Restoration Phase B4 — 2026-09-27

- Result: Replaced singleton delivery wiring with an enabled-messenger registry; direct replies follow their source messenger, while notifications, reports, and security alerts follow their configured route.
- Evidence: daemon notification/report tests pass; root build, root typecheck, and changed-file lint pass. Standalone suite: 1,025 passed; 24 listener `EPERM` failures.
- Still open: live scheduled reports, notifications, and security-alert routing were not exercised against providers.

### W12 verified review findings — 2026-09-27

- Result: Fixed route-only notifications, messenger-scoped recovery and serialization, Telegram cursor paging, connector overlap/recursion, managed token names, prompt formats, and viewer card counts.
- Evidence: Root build, typecheck, and changed-file ESLint pass. Standalone suite: 1,045 passed; 25 socket-listener tests in eight suites fail with sandbox `listen EPERM`.
- Still open: live provider turns were not run; all code-level tests outside the sandbox socket failures pass.

### W16 — scheduled report quality (2026-09-27)

- Result: Added scoped recent-source and upcoming calendar/iCal reads, the open-work pipeline view, multi-calendar polling, secret-backed iCal collection, and short report checklists.
- Evidence: report action, pipeline, calendar first-poll, iCal parser/connector, prompt and credential-boundary tests pass; `pnpm build`, `pnpm typecheck` and changed-file ESLint pass.
- Standalone suite: 1,039 passed; 24 listener/socket `EPERM` failures across eight files, isolated to sandboxed binds.
- Still open: no live provider poll or owner report was run; `~/.mama` and `~/.claude` were not accessed.

### W17 — incremental owner deltas (2026-09-27)

- Result: live deltas now revise/create work, update only an affected board slot, append a dated wiki line when enabled, and finish in one turn; first sessions receive the compact open pipeline, and calendar/iCal first snapshots stay collect-only.
- Evidence: focused prompt, candidate, scheduling, calendar, and iCal regressions pass; `pnpm build`, `pnpm typecheck`, and ESLint on changed files pass.
- Standalone suite: 1,062 passed; 25 failures are socket `EPERM` across eight files (Unix runtime sockets and viewer HTTP binds).
- Still open: no live owner turn or provider poll was run; `~/.mama` and `~/.claude` were not accessed.

### Owner report latency and read fixes — live (2026-09-27)

- Result: a report the owner asks for is text written from what the session already knows, with
  reads only to confirm; report reads that failed live (work.list cursor filter, source.read by
  observation refs, source.recent over its cap) now succeed or refuse with a narrowing hint; agent
  effort is `medium`.
- Evidence (live DB read-back, owner Telegram turns): the same full-report request took 291.2 s and
  517,700 tokens at effort `high` before the change, and 18.7 s, 77,075 tokens, 4 tool calls, 0 failed
  calls after it. The answer matched the reference operator's report except one missing extra-fee item.
- Still open: a live source delta on the one-turn flow and the 08:00 scheduled report on the new
  structure have not run yet.

### Review fixes and owner timezone (2026-09-27 – 09-28)

- Result: Opus and Codex reviews of today's commits found two live-relevant P1s (related-work
  candidates always empty; iCal failing every poll on a DTSTAMP replay conflict) and several P2s; all
  fixed (host reads open work from the snapshot, iCal first-seen times and cancellations, poll outcomes
  recorded, pipeline cap removed, board-section rule, wiki structure restored, basis mechanism
  removed). Owner decision: one `timezone` setting, asked by `mama init` and changed in chat through
  `owner.timezone.set` (owner-message turns only); every consumer takes it as a required input.
- Evidence: build, typecheck, lint and focused suites pass; `resolvedOptions().timeZone` remains only
  in config loading and init. First live delta on the one-turn flow (before these fixes, 2026-09-28
  00:02): 30 s and 402,665 tokens, 7 tool calls, routed notify, no board turn (previous flow: about
  113 s and 840k tokens per delta). One wiki update failed because the agent mistyped the optional
  64-character version and succeeded on an append without it.
- Still open: deploy and live checks (iCal re-snapshot, timezone change from chat, board-section
  updates on a live delta); RRULE is not expanded.

### Board lanes, candidates and revision continuity (2026-09-28)

- Result: live monitoring found lanes shrinking (a delta read the 7-card action_required and wrote one
  card; briefing stayed at 08:01 through 24 deltas), same-channel candidates never matching (0 of 29
  open items had sourceChannel), a feedback revision appearing in memory as a new unlinked record
  (one item: 13 revisions, 7 topics, no edges between them), and the viewer task list stuck at 50 of 111. Fixed: merge rule for sections and briefing on deltas (owner decision), action_required up to 8,
  whole-slot report.read, board in new sessions; candidates from evidence channels; revisions keep the
  item's topic and get a host `builds_on` edge (source `code`), migration 099 links stored revisions;
  viewer cursor; attachment errors as invalid input.
- Evidence: build, typecheck, lint and the full suites pass; migration 099 on a backup copy of the live
  database: 33 ms, 385 `builds_on` edges (496 revisions minus 111 creates), every work item down to one
  topic.
- Still open: after deploy, confirm on live deltas that sections keep their cards, candidates appear,
  and the memory view shows revision chains.

### Editable owner lane instructions (2026-09-28)

- Result: four per-turn lanes now use active `workflow` records at `lane/<name>` or their source defaults; lane records stay out of the guidance index and delta.
- Evidence: real `memory.save` plus scoped database reads render and replace all four records; 45 affected tests and two scheduled-stimulus tests pass, with root build/typecheck and changed-file lint/format checks passing.
- Deleted: 83 existing source lines (35 from the standing prompt, 15 from stimulus assembly, 28 from fixed report prompts, and 5 from scheduler assembly); their lane behavior now comes from defaults or scoped workflow records.
- Still open: a live owner correction/response is not verified because this change was required to leave `~/.mama` and `~/.claude` untouched; full stimulus-delivery cases that open IPC sockets remain sandbox-blocked with `listen EPERM`.
- Review fixes: the general correction rule and four deleted instructions (roles and "unconfirmed", work.show on a stale revise, restating a topic page's current state, splitting topic pages across subagents) are back; the `[notify]`-then-message format is fixed host text; lane records render unchanged, with replay and a disabled wiki stated as host facts instead of line filters; only workflow records at the four lane topics leave the index; reminders keep the newest 50 handled deltas inside one untrusted block.
- Still open: the mailbox does not record whether a delta was notified, so a reminder may repeat a delta the owner already received.

### PR 327 code-quality pass (2026-09-28)

- Result: an owner answer that changes work keeps the board merge rule again (it had been left only in the delta lane); duplicated code is shared (Claude effort gating, judgment edge id and hash, the test delivery helper); host data is typed instead of re-parsed (open-work candidates, board slots); an unexplained `edge_idempotency_key` on every agent link and several insurance guards are gone; dead code removed (an unused guidance field, the report prompt's wiki option, two helpers, a duplicate test).
- Evidence: +111/−421 lines; build, typecheck and lint pass; core 966, standalone 1,157 (also under `TZ=UTC`), MCP server 139, plugin 170. One core graph-browse test failed once under the parallel root run and passed alone and in five reruns; the PR does not touch it.
- Still open: the live checks after deploy.

### Live check after deploying PR 327 (2026-09-28)

- Result: delta turns got faster and kept the board: 29 s and 3 tool calls (80–236 s and 10–18 calls before), with the lane block, the marker rule and candidates present, and a later delta changing only the pipeline section.
- Evidence: daemon.log routes, tool_traces per model run, turn inputs counted in the session log, and report-slots.json before and after.
- Still fails: the first delta created a pending item and left the pipeline section unchanged.

### Lane corrections sit on the default (2026-09-28)

- Result: a correction record now renders under the lane default and wins where they conflict, and turn content no longer tells the agent to save a lane.
- Evidence: live, an owner-saved source-delta correction of 4 steps had replaced the 9-line default, and delta, reminder and owner turns re-saved lane records with no correction after reading the footer. Tests now assert that the default comes first and that turn content has no save instruction.
- Still fails: not live-verified until redeployed; records that copied default lines repeat them under the correction line.

### Owner corrections are applied now and consolidated (2026-09-28)

- Result: a correction changes the affected work items and board before the reply and is then saved. Owner turns list every lane's current corrections, and a new correction is merged with them; one marked as for this time only is not saved.
- Evidence: all 10 live owner turns called memory.save and mostly replied with a promise, with no tool failure. The owner-answer record was rewritten 12 times in 30 minutes, and reminder corrections landed in the owner-answer lane.
- Still fails: not live-verified until redeployed. The duplicate tasks the owner saw are cancelled merged records shown by the Tasks page's default "All" filter, which also shows only the first 50 items.

### Core revision change made additive (2026-09-28)

- Result: mama-core keeps `topic` as an optional field on `reviseWork`/`withdrawWork` (the item's topic when omitted), and migration 099 only links stored revisions and leaves their topics alone. The revision-topic policy stays in MAMA OS, whose `work.revise` action takes no topic.
- Evidence: C6. A packed core installed outside the workspace, with its own database and public exports, created work, revised it without a topic (inherited) and with one (kept), read two `builds_on` edges and the current revision, and reported schema 99. A caller that passes `topic`, as 4.0.0 required, type-checks against the packed types. Core 967 tests pass.
- Still fails: the live testbed already ran the earlier 099, which rewrote its revision topics; it is disposable and needs no change.

### One rule set for the owner agent (2026-09-28)

- Result: lanes are removed. The built-in instructions for source changes, reminders, full reports and answers sit together in the standing prompt with the Telegram rendering guide (dropped by the 0.57.0 rebuild and restored) and response principles: lead with the answer, no greetings or apologies, and the owner's language. Every owner correction is shown in full at session start and on change, and takes precedence. A chat report request follows the full-report instructions.
- Evidence: live, a formatting correction was saved to `lane/full-report` while chat reports read `lane/owner-answer`, so it could not reach them in a new session. A delta notification went out in the source's language. Reference check: Kagemusha keeps one fixed system prompt, routes a chat "full report" to the scheduled report prompt, and injects the owner lessons relevant to each message. Tests: every kind of turn in a new session sees a correction saved and replaced through memory.save, in full.
- Still fails: not yet live-verified; needs a new owner session after deploy.

### Report steps in the report turn; owner policy whole (2026-09-28)

- Result: the full report and the hourly reminder carry their own steps again, as in Kagemusha. The standing prompt keeps only the always-on rules, and a test checks that no report step also appears in it. A chat message containing an owner-registered phrase (`owner.report_phrases.set`) gets the same full report turn. The owner's message and files follow the report steps in that turn. `owner-policy.md` is a priority-1 layer and is never cut; loading the tokenizer before the first prompt only makes the counts accurate.
- Evidence: the 22:40 session's base instructions held 190 of the policy's 2,349 chars (`[WARN] Truncated layers: owner-policy`, counted as 8,014 tokens at start versus 4,546 on later turns). Full reports at 13:00 and 18:00 took 694 s and 673 s on the pre-#327 build; tool execution time was about 0, the rest was board HTML (2.5–5 min), the wiki resync (8 failed calls) and unrelated work in the report turn.
- Still fails: not live-verified. The owner needs to register a phrase and ask for a chat report. The wiki resync inside the scheduled full report is kept pending an owner decision.

### W22–W23 — small inputs, one instruction set, checked record orders (2026-09-29)

- Result: each turn kind has one order in `turn-orders.ts`; the standing prompt keeps messenger syntax, boundaries, runtime, continuity, the full-report procedure and tool use. A new session starts with at most 2,500 chars. Lessons are the top 3 of one `memory.search` on owner messages and notify orders (≤1,200 chars, not repeated that session and day). Tools show one line each, with `help` for the full contract. A live delta runs a notify order, then a record order that the ledger checks: a revision citing a batch observation or a `work.no_update`, at most three attempts, and a restart resumes the check. Report phrases, the acknowledged digest, related-work candidates and correction pushes are removed.
- Evidence: plan review PASS at round 4 and code review PASS at round 3 (Opus). The CodeRabbit round was fixed: a graceful stop no longer logs false losses, and the `recover()` reason is correct. Standalone 1,147 tests pass, with lint and typecheck. Found while building: live connector deltas carried no message text, and they now carry author and preview. Baselines (09-28): 29–40k chars pushed at session start, 10 compactions in 4 sessions, about 1.5M input chars a day, and 63 of 98 delta turns wrote anything.
- Still fails: not live-verified. Before this build runs, the owner data must move: always-apply corrections into `owner-policy.md` (fix its line 62), duplicate lessons retired, and the old wiki skill removed. The W22 checks (chat full report in a new and a continuing session, C1/C2 after restart, C4, C5) and the W23 day (record orders within three attempts, `[notify]` ≤25%, ≤1 compaction a day, ≤0.4M chars a day, graceful and hard-kill restarts) wait for the owner's turns. The Claude backend is covered by tests only.

### W22–W23 live, first hour on 0.58.0 (2026-09-29 10:06–10:40 KST)

- Result: deployed after the owner data moved: 17 guidance records went into `owner-policy.md`, and 15 lessons stay active. The new session starts with 11,960 chars of base instructions (16,527 before) and a first turn of 2,477 chars (29–40k before). Eight live deltas were all answered with `[ack]`. Eight record orders all passed the ledger check on attempt 1: 3 revisions, 5 `work.no_update`, 9–11 s each, no retry or loss. A chat full-report request: 61 s, dated 9/29, five parts, point form, all four board sections published, three reads in one `exec`. A question about who is working on one project was answered from `work.list` after the restart in 15 s.
- Evidence: `daemon.log` (`record order recorded` ×8, `delta report route=ack` ×8, no errors); `model_runs` and `tool_traces` for the record orders; the Codex rollout of thread 01a0eab4. Speed against the 00:21 report (279 s): about 150 s was provider token rate (19 against 54 tok/s at publish), and about 75 s was reads (8 calls against 2). Against 01:40 (57 s), the speed is equal.
- Checks: C1/C2 partial (one question, spot-checked against the first 50 viewer items); C4 partial (board published, not read back against the whole ledger); C5 unverified.
- Still fails: tool results were 146,813 chars across 14 turns. `help` made up 44%: the catalog line had no arguments, so the agent read contracts in 11 of 14 turns, and it received JSON schemas, 43,862 chars for one record order's six actions. The usage example that read everything was copied by 6 of 7 notify turns. The fix is below. Not yet measured: a live day of compactions and input, a hard-kill restart, and a chat report in a new session.

### Tool catalog with arguments; help as text (2026-09-29)

- Result: each catalog line is `name({required, optional?, enum?: "a"|"b"}) — first sentence`, the way Kagemusha's code_act description lists `task_update({id, status, priority, deadline})`. `help` returns argument types, descriptions and examples as text. The usage example reads one matching item and prints four fields. The session start says to read newer state only when a turn needs it.
- Evidence (main against this branch, same contracts, measured the same way with the `{success, data}` wrapper): the six-action record bundle went from 42,008 to 9,833 chars (43,862 live with the `exec` header), `work.list` + `source.recent` from 6,062 to 2,679, the four report actions from 10,433 to 6,083, and all 28 actions from 101,465 to 34,560. As Codex function definitions the catalog grows from 5,356 to 8,234 chars (+54%). The W22 tool-text target moves from 5,000 to 10,000 for the arguments. `help` now also shows each argument's limits (for example `at most 4 items`) and the arguments a top-level `oneOf` requires (`source.read`: `observationRef | observationRefs`). Kagemusha: 25 `help` calls in 15 days, and 30–50k chars a day returned to the model by code_act. Standalone suite 1,149 pass.
- Still fails: live. The next record orders show whether the agent still calls `help` for `work.revise`/`work.create`: if it does, the text format is the lever; if not, the signatures are. The untrusted wrapper inside `source.read` results still blocks field filtering; that waits for an owner decision.

### Argument bounds in the catalog; failed calls throw (2026-09-29)

- Result: a catalog line shows the bound of a number or list (`work.list({… ids?: ≤4 items, limit?: ≤50 …})`, `caption?: ≤1024 chars`). The Codex tool-use example reads results through a helper that throws `{error}` when an action fails.
- Evidence: on the argument-list build, the 11:44 chat full report took 171 s, against 61 s at 10:18. The line showed `limit?` without its maximum, so the agent sent `work.list({view: "pipeline", limit: 100})`. It failed twice with `input.limit must be <= 50`. `JSON.parse(raw).data` returned `undefined` without an error, and the first batch silently lost the pipeline. The agent then printed the raw pipeline (25,033 chars) and read it five times in the turn. Codex's `exec` resolves a failed dynamic tool call with its text (`codex-app-server-process.ts` sends `success: false`); Kagemusha's worker rejects the promise (`code-act-worker.ts:67`), so its script stops with the error. Other time went to 34 s of original-source checks on one overdue item, which the owner policy's overdue line asks for in full reports, to 14 s re-publishing one slot, and to 47 s of final text (2,356 tokens, 1,091 of them reasoning). The provider rate was normal, about 50 tok/s. The catalog is 8,362 chars as Codex function definitions (8,234 before). Standalone suite 1,151 pass.
- Still fails: live. The overdue checks inside the report follow the owner policy; whether they belong in the report turn is the owner's call.

### Claude backend parity, first turns (2026-09-29 12:24–12:40 KST)

- Result: switched to Claude Sonnet 5.5 at xhigh on the argument-bounds build and went back to Codex after 16 minutes. Every MAMA tool on Claude had the schema `{type: 'object'}` (W22), so Claude sent numbers, lists and objects as strings.
  - Chat full report: 113 s, with 11 invalid-input failures (`perChannel: "10"`, `days: "14"`, `actions: "[\"report.publish\"]"`). `report.publish` with `slots` as a JSON string was refused twice, so the board was not updated; the reply said so.
  - The owner's readability correction got a shorter report, but `memory.save` with `source` as a string was refused, so the correction was not saved; the reply said so.
  - One record order failed on `work.revise` (`eventDatetime` as a string), then on a revision with no fields, and was logged lost after three attempts.
- Evidence: `tool_traces` of runs `mr_090dd08a…` and `mr_7bbfea6d…`, and the record order for delta `1a6dc429…`.
- Still fails: that batch stays unrecorded; later record orders and the next full report read the same sources.

### Claude calls actions inside one code_act tool (2026-09-29)

- Result: as Kagemusha did on Claude CLI, the Claude backend gets one MCP tool, `code_act`. Its description lists every other action by name, arguments and first sentence, and its JavaScript calls them by name. A failed action throws its error, and the script returns only what the turn needs.
  - Ported from #332 (Kagemusha's sandbox and worker): a separate Node process under `--permission`, with each call dispatched in the caller's context, so inner calls are traced in the calling model run.
  - #332's `help`/`list_tools` built-ins are dropped; `help` inside the script is MAMA's action.
  - `callTool` refuses `code_act` and ungranted names.
  - The result is quoted as untrusted content.
  - Codex keeps `exec` and is not offered `code_act`. `actionName` is removed: both backends name actions `work.list`.
- Evidence: the Claude tool list is 6,801 chars in one tool. A typed schema per tool (the closed #337) came to 21,110. The Codex definitions are 8,401. The Claude path dispatches through `nativeSession.callAction` with the caller's `modelRunId` (`native-session.ts:412`), so `batchRecorded` sees inner `work.no_update` and revisions. The worker starts with an empty environment: `--permission` does not guard `process.env`, and the daemon's holds the `auth.env` credentials. An escaped script now sees no inherited variable. The Claude schema omits `additionalProperties` because the caller hook adds `__mama_caller`. A missing operation id throws instead of falling back. Network is denied by `--permission` on Node 25 only, and web access is granted to both runtimes (owner decision 2026-09-26), so the contract no longer claims it. Standalone suite: 1,160 pass.
- Still fails: live. The next Claude run checks the first record order's inner traces, then a full report and a correction saved with `memory.save`: the three things that failed at 12:26. Open: a script can outlive a timed-out turn and keep writing under that run. `code_act` and the turn both allow 300 s, as in Kagemusha, and nothing cancels a dispatch when the socket closes.

### Chat report window; stale calendar rows; session start against Kagemusha (2026-09-29)

- **Result.**
  - The full-report procedure now says a chat request reads the last 24 hours of `source.recent`, however recent the previous report. A scheduled report reads since the time its order gives. Before this, both chat reports (11:44 on Codex, 13:23 on Claude) read only since the report before them, so the 13:23 report opened with "no new changes since 12:30".
  - The calendar crowding in `source.recent` is data, not code. The pre-rebuild calendar connector stored an event's start as its source time (`timestamp: new Date(startMs)` before #325; now `ev.updated`). In the testbed, 66 rows from that build (63 of them in the future) sorted first as "recent changes". Their source time is reset to their `observedAt`; observations and links stay.
- **Evidence.**
  - `connector_event_index` rows: 66 without `updated` against 89 from the current connector. 65 of the 66 events also have a current-format row. The 0.56 `calendar/index.ts` set `timestamp: new Date(startMs)`.
  - Kagemusha's session start (`session-start-context.ts`, `agent-session.ts:60-70`) is capped at 2,500 chars and holds:
    - the owner channel's last 10 messages (600);
    - the last 10 resumable agent turns, delta notify turns included (1,000);
    - recent decisions (600);
    - a brain summary (1,000) and the checkpoint (500);
    - the time.
  - MAMA's session start at 11:33 (2,801 chars with the first order) held five owner exchanges, four of them full-report requests and their answers, with `<` escaped as `<`. It carried no delta turns, decisions or checkpoint.
- **Still fails.** A new MAMA session does not see what just happened in the sources or what it decided; that waits for an owner decision on the session start contents.

### Session start in Kagemusha's shape (2026-09-29)

- Result: a new owner session receives, in at most 2,500 chars:
  - the time and a read hint;
  - the owner channel's last 10 messages (600 chars);
  - the last 10 resumable turns (750, inside the untrusted-content wrapper because they carry source text);
  - the latest 10 memory records (600).

  Owner and turn lines are capped at 360 and deduplicated, and messenger markup is stripped from replies. Record orders, reports and replay windows are left out, as Kagemusha leaves out its reconcile and system turns.

- Evidence: built from a copy of the live database at 13:52, the block was 2,455 chars. It held three owner-channel messages, eight previous turns (delta notify turns such as a chat line and its `[ack]`, plus the owner's report-criteria exchange) and ten records (the 13:31 report lesson, the 13:32 revisions). The 11:33 session start held five owner exchanges, four of them full-report answers. Standalone suite: 1,161 pass.
- Checkpoint (owner decision 2026-09-29, "give it"): the owner agent is granted `memory.checkpoint.save`. The standing prompt says to save one only as a hand-off (what it was in the middle of, what comes next), with work progress kept in the ledger. The session start shows the latest checkpoint (500 chars) after the previous turns, and decisions take the room left.
- Still fails: live. The next new session's first turn in the rollout should show the block. No checkpoint exists yet; the first one appears when the agent hands off.

### The agent finds what it needs; Jev as its own filter (2026-09-29, 0.59.0)

- Result: turns start with an index (standing prompt 5,080 chars, was 8,611; action lines 4,092, was 6,477); procedures are `help({topic})` texts and help answers one level at a time. The full report is a delta on the ledger; `source.recent` lists channels first; `work.list` has `due`, `changedBefore` and paged detail; the record order follows Kagemusha's context → state → record; a new session carries the last ten owner exchanges. `judge` (Jev) is the owner's choice (`jev.enabled`, `mama init`), works in pairs and refuses a state over 6,000 chars.
- Evidence (live, branch build): full report 218–301 s (one timeout) → 114 s, context +86k → +40k tokens, 0 source searches; bulk cleanup timed out with 0 writes → 215 s, 14 items settled; ledger-gap question 144 s, 4 gaps found. The 17:02 short reply the record order had left unattached was tied to its tk5 check by the ported order (re-run, 8 s).
- Jev: asked with the whole ledger per call (24 calls) it was slower and the agent dropped two real gaps; asked in pairs it placed three disputed facts correctly. The fault was the usage, now bounded by the pair pattern and the state limit.
- Still fails: a fresh codeless delta has not yet been attached live by the new record order (the re-run found the owner's 17:38 correction already recorded). The agent still slips into Markdown in some Telegram replies (15:11, 15:13, 16:14). Six new sessions in one day came from deploy restarts.

### Record retries wait like Kagemusha's cursor (2026-09-29)

- Result: an unrecorded batch waits and rides with its channel's next record order, or goes alone at the next tick (5 minutes). The record order states that the write is required and checked. `work.create`/`work.revise` take `eventDatetime` as an offset ISO time, and a refused `oneOf` names the allowed shapes and the field's description.
- Evidence: the one batch lost on 2026-09-29 (`source_delta:1a6dc429…`, 12:30). `work.revise` refused `eventDatetime: "…T12:30:00+09:00"` with "must match exactly one allowed shape (0 matched)"; the agent dropped the field with its links, was refused again ("must set, clear, or link"), and ended with `[ack]`. Both retries reached the same session within 2 s and were answered `[ack]` with no tool call. In that day's 77 first-attempt record turns, refusals that named the allowed values (11:48, link kind) were corrected in the same turn. Tests: record orders 19, turn orders 13, work actions 16, core catalog 13.
- Kept different from Kagemusha: the notify turn is not re-run, attempts stay capped at 3, the wait is per channel (Kagemusha's cursor also holds later channels), and the tick is a 5-minute constant rather than config.
- Review (CodeRabbit on the PR, the local CLI, an independent reviewer) found five real holes, all fixed with tests:
  - A row parked uncertain is re-reported at every start, so after a day it would have run a lost batch again. `onLost` now skips batches the recovery day does not hold.
  - Waiting lived only in memory and recovery read a day back from now. The day now ends at the latest stored order, so a longer stop keeps the batch.
  - A carried batch that had been recorded while it waited was carried anyway.
  - A no-update in a carrying order covered batches it did not cite.
  - `Date.parse` rolled February 30 into March.
- Still fails: not yet seen live; the next unrecorded batch should log `record order waiting` and then `retry … order=…`. `lost` reaches only the log and repeats at each start for a day. `help` received 8 guessed action names that day (`manage.wiki.list`, `report.get`, …).

### The wiki keeps knowledge; a daily page per day (2026-09-29)

- Result: the wiki procedure keeps only lasting knowledge (overview, decisions and specifications, terms, how a client works), rewritten by section with no dated entries or current state; the record order touches the wiki only when messages settle such knowledge. A daily order at 23:00 writes `daily/<day>.md` (the day in brief, the owner's decisions, what was missed and learned). New reads: `work.list` `eventSince`/`eventBefore` (revisions by source event time) and `owner.messages` (owner conversation by span).
- Evidence: on 2026-09-29, 100 deltas; record turns appended 66 dated lines, 51 to one 51 KB page (two titles, dated sections out of order), repeating the ledger revision written in the same turn. Since 09-27 the wiki took 188 writes and was read 4 times to answer the owner. The ledger's 115 items carried 10 different project spellings, so grouping by code would have split one project; the agent does the grouping. Ledger revisions carry event times back to 09-01 (1–36 a day), so past days can be rebuilt.
- Still fails: not yet run live. The first daily page is tonight's; the 28 earlier ones are to be rebuilt in the new format, and the 13 project pages still hold dated logs until they are reorganised.

### Live: daily pages rebuilt, project pages reorganised (2026-09-29, main after #349)

- Result: every existing daily page for 09-01..09-28 (27) was rewritten in the new format by queued daily orders, and the owner's chat request ("페이지별로 새규칙으로 위키 정리하자") reorganised all 13 project pages into overview / decisions and specifications / terms / how the work goes, with no dated lines left.
- Evidence: 27 daily turns acked, 0 failed, 38 s average (129 s max), 4.5k tokens average; each page 13–25 body lines in the three sections. For days before 09-26 the owner section says the conversation is past the seven-day retention and lists only the decisions the ledger holds. The reorganisation turn took 538 s and 63.7k tokens; the largest page went from 593 to 292 lines, 20 of them body text (the rest `source_ids`).
- Still fails: rebuilt pages mix in later outcomes (hindsight) for some days. The owner's message waited behind up to eight already-claimed orders, because the owner priority applies only when a row is claimed (owner: not a real problem). The agent passed `id` to `memory.read:record`, which takes `memory_id`, five times in one turn.

### Plan and INTENT realigned (2026-09-29)

- Result: INTENT v8 moves the wiki from "the record of each case" to lasting knowledge plus a daily page. It adds two principles: the agent pulls each next step and the host never pre-loads a turn; the September import only seeds records that live flow and corrections complete. plan.md adds W27–W30 and an ordered next list with C3 first.
- Evidence: the owner decisions of this session (progressive agent, Kagemusha record retries, knowledge wiki and daily pages, no re-import of September). Owner checks C1–C6 are all still open; W23 measured 99 of 100 record orders on the first attempt and `[notify]` at 28%.

### The agent links records with a reason; the host writes no edge (2026-09-30)

- Result: `work.link` and `work.list` view `links` in MAMA OS; `save` `links`/`replaces`, `link` and `get_decision` in the MCP; one core `appendLink` under both, appending an edge with its reason and no revision, and correcting a wrong link by a newer `contradicts` edge. The host revision chain, the evolution rules and the similarity view are gone; an amendment keeps the values it replaced. Plan: `docs/rebuild/memory-edges.md` v6.
- Evidence: record turns wrote 0 precedent links in 18 bench runs; answers given the `cases` topic wrote one in 12 of 12, 16 of 17 pointing at a real precedent (`memory-edges-evidence.md`). The development memory held 690 host similarity links and 185 parsed from reasoning text. Tests: core 970, standalone 1,205, MCP 142, plugin 171.
- Verified before merge (2026-09-30), on copies:
  - Development memory (schema 80, 1,311 decisions): the branch's MCP server listed `link` and `get_decision`; a save with `links`, a link after it, a retried link (same edge, `replayed`), a correction, and reads from both ends all worked, and no host edge was written. `get_decision` labelled a similarity link from 1.12.1 `host` and a parsed one `agent_text`. The first run exposed migration 084 deleting all 414 scope bindings on the way to 099 (fixed in this PR); a fresh copy then kept 414 bindings, 14 scopes, 710 checkpoints and 950 decision edges, with clean foreign-key and integrity checks.
  - MAMA OS (live database, claude-sonnet-5-5, xhigh, `code_act` only, one owner question on an open item): the agent read help `cases` first, found the item had no links, searched on the kind of problem, answered with three earlier cases and how each ended, and wrote two `work.link` links (builds_on) with reasons naming the case and its outcome; no revision or record was written. One call passed `commitmentId` to the links view before reading its contract. 18 turns, $1.06.
- PR review round 3 (2026-09-30), each reproduced by a failing test first: graph pages named link evidence the reader could not see; a correction of a correction across two projects was refused (MCP `link` admitted only the first level's scopes); a `work.link` retry with other evidence replayed; `memory.read:graph` read only `decision_edges`. `get_decision` now reads a decision's edges in append order (two amendments in one millisecond read in hash order, 1 run in 5).
- Search follows agent links (S1–S3, owner decision 2026-09-30): search expansion and checkpoint resume read the edges an agent stated and no host edge; a record reached through a link names the hit, relation, reason and any correction in the default results. Tests fail on the old code: a host similarity row was followed and a link was not; expanded rows had null `related_to`/`edge_reason`. A probe on a development-memory copy then showed expanded rows cut at the default limit (the linked root cause 22nd at limit 30, absent at 10); each direct hit now lists the records its links reach, and the same question at limit 10 shows the link on its hit. An independent review found the checkpoint path and the `replaces` gap: default search drops superseded records, so a replaced record shows only as `[Prior context]`; T1 asks a reversal question in the old words to see whether that loses the latest record.
- T1 first pass (2026-09-30, claude-sonnet-5-5 xhigh, one run each, question set and answers confirmed by the owner before the runs, OS with Jev): 11 of 13 answered right. M1–M3, M5, M6, O1–O4, O6, O7 right; in O1 the agent corrected the seeded link's reason with its own `contradicts` link and linked two better precedents; in O4 it read the corrected link and did not use it. Failures: M4 (tool) — two hits linked to each other showed no link, because pointers came only from expanded records; now each hit's stated links are read directly. O5 (harness) — the rule for one client was applied to another; the harness, like verification B's, did not add the daemon's turn lessons, which would have shown the rule; it now does. A check of the owner's point that search puts an earlier judgment above its correction: true for work revisions (a revision 16 of 20 ranked first, the correcting head absent from the top ten); each hit now says which revision it is and the head (`work_item`). 13 runs, about $4.70 plus Jev.
- T1 reruns of the two failures (owner's choice) on the fixed code and harness: M4 right (the hit's link pointer showed the link and its correction). O5 wrong again, differently: the rule now arrived as a turn lesson and the agent named its origin (project A) but applied it to another client; the record never states that limit, so by the fixed rule this is a model failure on a record that lacks its scope, not a tool or guide failure. The owner's take-number rule was saved to the live owner memory on the owner's instruction (daemon stopped, saved through the daemon's own code, restarted with a clean log).
- Released 2026-09-30 as mama-core 5.0.0, mama-os 0.60.0, mama-server 2.3.0 and plugin 2.1.0 (with S1–S3), on the evidence above: copies of both databases (verifications A and B) and the T1 first pass with its reruns, not yet a live daemon turn.
- Applied live (2026-09-30, owner: "전부 반영하자"): the daemon runs v0.60.0 from the main checkout; the owner's two corrections were saved to live owner memory (the take-number rule, and the Spine rule narrowed to project A with `replaces`); the development memory was backed up, migrated 80→99 with every count unchanged (1,312 decisions, 414 bindings, 14 scopes, 710 checkpoints, 953 edges), and moved to mama-server 2.3.0 and plugin 2.1.0.
- Live owner turn (Telegram, the O5 question after the owner's correction; run `mr_7ac4b719…`, clean `daemon.log`, read back from `tool_traces`): the agent said the Spine rule is stored as project A-only and did not apply it to project B, found the project B precedent (an earlier asset SR: the cut marked and confirmed with the client, FIX 9/17), recovered from one refused `source.search` by reading its help, wrote nothing, and asked the owner whether to make it a project B rule.
- T1 second pass (owner: Sonnet 5.5 at low effort; 28 runs, $5.51 plus Jev; the development copy as before, and a fresh live copy with the owner's corrections and the same seeded links): 25 right, 2 partial, 1 not found. Corrections hold and apply: in a new session on the first pass's database the agent reused its own correction (F1); corrected links were read and not used 4 of 4 (O4, M4); the owner's corrections applied 4 of 4 (O5, O7). Stable over two repeats: M2, M3, M5, M6, O2, O3, O6, O7. Low effort showed its cost: one run gave up after two mixed-language searches and said it found nothing (M1), one did not read the item's full history (O1), and one skipped the `cases` guide and the links view and misattributed a correction the search had returned correctly (F2).
- Still fails: search misses a record for a mixed-language query that a single-language query finds first; at low effort the agent may skip the guide's first read (links) and read less history. Not measured: repeats at the daemon's effort (xhigh) beyond the first pass. MAMA OS search expands from the hit record only, not from an item's earlier revisions. People as nodes (W2) are not in this change.

# Update and `/update` (1.0 W2.3)

Rows R3 and R7 of [v1.md](v1.md); plan [W2.3](v1-plan.md#w23-update-and-update-r3-r7). Code read
at `32c6102a6`. `s/` is `packages/standalone/src`, `c/` is `packages/mama-core/src`.

## Why

Updating is npm, build and restart by hand. On 2026-10-05 a restart chained into a running turn
killed the 23:00 daily mid-run (R3). A later deploy showed the idle check and the stop are never
one step: a turn started between them
([checks](../checks.md#p2b-member-share-452-and-release-810--0700-2026-10-08)). The drain below
holds claims until the stop, so nothing starts in that gap. R3 asks for one command that waits until nothing runs, keeps a way back and reports. R7 asks for
the same from chat without a model turn, so an owner can repair an install whose backend is broken.

## Install kinds

The kind comes from the package the service runs, `start.sh`'s exec line (`readStartScript`,
`s/cli/launch-files.ts:273`). The `mama` running the command must be that package, or it refuses
naming both paths: on this Mac `mama` on PATH is a stale global 0.53.2-local.11 while the service
runs the checkout, and updating that copy would change nothing the daemon runs.

| Kind     | Recognised by                                                                       | `mama update` and `/update`                    |
| -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| npm      | the package is `<npm root -g>/@jungjaehoon/mama-os`, asking the npm beside its Node | the full flow below                            |
| checkout | its `package.json` names core `workspace:*` (published packages carry a version)    | refuses and prints the git steps               |
| Docker   | an environment marker; PR 2 names it, the W4 image sets it                          | refuses and prints the pull-and-recreate steps |
| other    | anything else, such as a prefix that is not the service Node's                      | refuses and names the path                     |

Checkout: decision 6's first sentence decides it, "**`mama update` serves npm installs.**" The
checkout clause says how a checkout updates (by git, as the deploy procedure does), not that
`mama update` runs git. The steps printed: `git pull --ff-only`, `pnpm install`, `pnpm build`,
`mama service install`, `mama service restart`. After PR 1 that restart drains first, which closes
the 2026-10-05 incident class on this Mac too.

## Step 0: verify a one-shot launchd job (no code; result in checks.md)

- Scratch LaunchAgent A (outside `~/Library/LaunchAgents`, with the generated plist's
  `ExitTimeOut` and `HOME`) bootstraps plist B into `gui/$UID`. B has no KeepAlive; it writes its
  pid, PPID and the time, boots A out, sleeps 20 s, writes again. Proof: B's second line exists,
  its PPID is 1, `launchctl print` of A exits 113. Also record any background-item notice, and
  that B's label bootstraps again after `launchctl bootout` of the finished B.
- The development session runs it. `systemd-run --user` gets the same check in wave 3.

## PR 1: drain

- New control op `drain` (today only `status`, `stop`, `probe`, `s/cli/runtime/daemon-control.ts:173`).
  It holds claims while its connection stays open, so a dead updater lets go. This changes
  `startDaemonControl`, which ends the socket after one reply (`:221-222`). While held, `ready`
  and `hostReady` are false (`s/runtime/owner-runtime.ts:1183,1195`), so core's `drainOnce` claims
  nothing (`c/runtime/runtime.ts:779-783`). Accepting goes on (`c/runtime/runtime.ts:937`): messages,
  deltas and reports wait `pending` and run after the restart. The W1.1 text said "stop intake";
  accepted rows are durable, so stopping intake would only move the wait into Telegram and the
  sources. Host commands still answer, so `/stop` ends a long turn the existing way.
- It replies at each change of count, then `idle`: no `running` model run and no `claimed` input,
  the queries `status` runs (`s/cli/commands/daemon.ts:491-503`). Bound: `agent.max_turn_ms` plus
  60 s (`PROBE_MARGIN_MS`, `s/cli/commands/init.ts:350`), since the daemon ends every turn by then.
  Past it the hold ends, nothing changes, the running sessions are named, exit 1.
- `mama stop` interrupts today (`s/cli/commands/control.ts:169-174`, core `beginStop`,
  `c/runtime/runtime.ts:911-917`). Now `mama stop`, `service restart` and `uninstall` drain first;
  `mama stop --now` keeps today's stop. `mama backup --restart` (W1.3a's open item) drains, stops,
  backs up, starts. `mama status` shows the hold.
- Tests: a turn running at the hold finishes, its reply delivered and acked; an input accepted
  during the hold runs after the restart; a closed connection or the bound ends the hold; `--now`.
- Live (this Mac): `mama service restart` during an owner turn; the turn commits and its reply
  arrives; `daemon.log` has no `interrupted`.

## PR 2: install kind and release discovery

- `installKind()` per the table, in `s/cli/runtime/install-kind.ts`. Nothing detects it today.
- Once a day the daemon runs `npm view @jungjaehoon/mama-os dist-tags.latest` with the npm beside
  its Node (nothing queries the registry today). It writes `runtime/release-check.json` (0600):
  `checkedAt`, `current`, `latest`, `error`. `checkedAt` outlives restarts. Replay never checks.
- `mama status` and a doctor check `release` read only that file: "newer release X (checked T)"
  with the kind's update path, or "last check failed at T: <code>". No network call from either.
- Tests: status and doctor with a network that throws; a second boot the same day makes no call;
  a failed check shown with its time; each kind from a fixture tree.

## PR 3: `mama update [<version>] [--dry-run]`, `mama update --rollback`

Steps 1–7 run in the old code; 8–13 in a child process of the new CLI. Commands load lazily
(`s/cli/index.ts`) and the launch-file templates ship in the package, so nothing may run from the
old process after the install.

| #   | Step                                                                                                                                                                                                                                                         | Reuses                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | Kind and same-package checks; refuse when no service file is installed (decision 7: the restart goes through the service manager, and nothing else would start the daemon again); take `runtime/update.lock` (a second updater is refused, naming the first) | `serviceFile` (`service.ts:123`); `acquireInstallLock` (`daemon-control.ts:115`) |
| 2   | Target: `npm view …@<version or latest> version`. Same: "already on X", exit 0. Lower: refused (R5: older code refuses the database)                                                                                                                         | new                                                                              |
| 3   | Record `doctor --offline`'s failing checks by name and detail (backend version and login are both named `backend`, `diagnostics.ts:321-347`)                                                                                                                 | `runDiagnostics` (`diagnostics.ts:165`)                                          |
| 4   | Print from → to, kind, the steps and what runs now; `--dry-run` ends here                                                                                                                                                                                    | `status` op                                                                      |
| 5   | Drain, write the journal `runtime/update.json` (0600), stop through the service manager                                                                                                                                                                      | PR 1; `runStop` (`control.ts:175`)                                               |
| 6   | Snapshot with credentials as `backups/mama-update-<from>-<time>.tar.gz`, so cleanup never touches the owner's backups                                                                                                                                        | `runBackup(['--include-secrets'])` (`backup.ts:62`), name option                 |
| 7   | Rename the package folder to `.mama-os-<from>` in its scope folder; `npm install -g @jungjaehoon/mama-os@<to>`                                                                                                                                               | new                                                                              |
| 8   | `mama service install` with the new templates                                                                                                                                                                                                                | `installService` (`service.ts:127`)                                              |
| 9   | `doctor --offline`: a failure (name and detail) not seen at step 3 rolls back: the new minimum backend, Node, schema                                                                                                                                         | `runDiagnostics`; `MINIMUM_BACKEND_VERSIONS` (`backend-probe.ts:8`)              |
| 10  | `mama tools install` when the toolkit's `requirementsSha256` differs from the new `toolkit/requirements.lock`                                                                                                                                                | `document-toolkit.ts:514`, `readDocumentToolkit` (`toolkit-state.ts:50`)         |
| 11  | The journal names `<to>` as the version to start; `mama service start`                                                                                                                                                                                       | `startService` (`service.ts:268`)                                                |
| 12  | Wait for stage `running` with `version` = `<to>`, then `/health`, up to 600 s                                                                                                                                                                                | `waitForBoot` (`init.ts:291`, exported), 600 s as `init.ts:658`                  |
| 13  | Delete the snapshot, the old folder and the journal; report from → to and the time taken                                                                                                                                                                     | new                                                                              |

- The old folder, not a reinstall: mama-os 0.78.0 depends on core `^8.8.0`, so reinstalling
  `<from>` can bring a newer core than the one that ran. A global package holds its own
  `node_modules` (this Mac's stale global has its core inside). A test with real npm proves
  `npm install -g` leaves the dot-folder alone.
- The journal refuses boot (clean exit) unless it names this version to start, as
  `refuseWhileRestoring` does (`daemon-control.ts:59`); doctor fails and names
  `mama update --rollback`, as its `restore` check does (`diagnostics.ts:175`). Reason: after step
  5 a login's `RunAtLoad` or a person's `mama service start` would boot a half-replaced package.
- Rollback from any step: (1) stop through the service manager first, since a failing boot restarts
  on failure and would hold the install lock; (2) remove what is at the package path and rename
  `.mama-os-<from>` back; (3) the previous CLI runs the rest, so restore format and templates match;
  (4) `mama restore <snapshot>` only when step 11 was reached, since before it the database is
  untouched; (5) `service install`, `service start`, boot wait with `version` = `<from>`; (6) report
  the failed step and its message, delete the snapshot after the good boot.
- A failing rollback stops: journal, snapshot and folder kept, `mama update --rollback` printed,
  exit 1, the install left stopped.
- Tests: each step fails in turn and ends on `<from>` with equal `work.list` counts; a killed
  updater's journal refuses boot and `--rollback` resolves it; checkout, Docker, a lower target and
  a second updater are refused; the snapshot is 0600.
- CI leg in `upgrade-check`: a local registry (verdaccio) serves this build at two versions plus a
  third whose daemon throws at boot; update, then rollback, with read-back as #512 does. This PR
  checks whether the runner's service manager can run the daemon; if not, the leg says the
  service half is left to the clean account.

## PR 4: `/update`

- `update` joins `TELEGRAM_HOST_COMMANDS` and the port gets `update(origin)`
  (`s/gateways/telegram-commands.ts:10,21`). Allowed: an owner (`ownerAllowed`,
  `s/gateways/telegram.ts:679`) in the common channel (`chatId === ownerChatId`, `:839`) or in
  their own DM. Refused: everyone else, an owner in another group included. Checkout and Docker
  reply with their steps.
- The daemon writes the origin chat and message to `runtime/update-request.json` (0600), not argv,
  which `ps` shows to any shell. It starts the updater as its own job: macOS `runtime/update.plist`
  (label `com.mama.update`, no KeepAlive, output to `logs/update.log`), booted out first if an
  earlier run left it loaded, then bootstrapped as Step 0 proved; Linux
  `systemd-run --user --unit=mama-update --collect`. It replies "Updating X → Y; progress follows".
- The job runs `runtime/update.sh`, generated from `start.sh`'s PATH, `cd` and `auth.env` lines
  (`startScript`, `startPathEntries`, `s/cli/launch-files.ts:49,94`), because `installService`
  needs the backend on PATH (`s/cli/commands/service.ts:145-150`).
- Progress goes to the origin through Bot API `sendMessage` only, never `getUpdates`, so it cannot
  collide with polling (`defaultTelegramCall`, `s/cli/runtime/diagnostics.ts:121`). Text is the
  updater's own words, versions, step names and error codes, because a group reads it. A failed
  send is logged to `update.log` and the update goes on.
- Tests: the four origins above; no model run opens; after the restart the `/update` message is not
  handled again (`bot.stop` confirms the offset, `s/gateways/telegram.ts:304-307`); progress holds
  no path or message text.

## Live proof

- **This Mac (checkout, live bot):** PR 1's drained restart during a turn; `mama update` and
  `/update` (owner DM, common group) refuse with the git steps.
- **CI:** PR 3's leg proves the npm flow, the rollback from a broken candidate and the journal.
- **A clean macOS account on this Mac** with its own test bot and group (B2 needs one too): install
  release N, the first with `mama update`, through W2.4's `install.sh`, then update to N+1. A
  second root under this account cannot work: the LaunchAgent label is fixed
  (`s/cli/launch-files.ts:154`). Proves R3, R7, the one-shot job and the drain under a real turn.
  Live rollback: boot out `com.mama.server` by hand during step 12.
- **Wave 3 Linux box:** `systemd-run --user` and the systemd half of every step.
- Installs on 0.78.0 or earlier update by hand once; the release notes say so.

## Done when

- **R3:** on the clean account, `mama status` and `mama doctor` show N+1 from the cached check;
  `mama update --dry-run` shows N → N+1 and the steps; `mama update`, started during a test-bot
  turn, waits for it (run `committed`, reply delivered), then snapshots, installs, restarts, waits
  for the boot and reports. `mama status` shows N+1, `daemon.log` is clean, the snapshot and the old
  folder are gone. The CI rollback leg passes.
- **R7:** with that account's backend signed out, `/update` from the test owner's DM runs the same
  steps; progress and the result arrive there and no model run opens. In the test common group
  `/update` answers there ("already on N+1"). A member is refused.

## Failure modes

| Failure                                              | Handling                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A turn outlasts the drain bound                      | Hold ends, nothing changed, session named, exit 1; `/stop` or `mama stop --now` is the owner's         |
| It dies after the stop (sleep, reboot, killed job)   | The journal refuses boot; doctor names `mama update --rollback`                                        |
| The snapshot fails (disk full)                       | Backup's own error; nothing installed; the old version started                                         |
| `npm install` fails, or the prefix is not writable   | Old folder back, old version started, npm's code reported; never `sudo`                                |
| The new doctor fails a check the old one passed      | Rollback before the start, no restore                                                                  |
| No `running` with `<to>` in 600 s                    | Stop, old folder, restore, old launch files, start, boot wait                                          |
| A rollback restores the snapshot                     | Codex sessions start over (`s/cli/runtime/restore.ts:753`); the report says so                         |
| The rollback fails                                   | Stopped; journal, snapshot and folder kept; `mama update --rollback`                                   |
| Two updates at once (CLI and chat, or two `/update`) | `runtime/update.lock` refuses the second, naming the first                                             |
| A full-report hour passes while stopped              | Skipped (`s/runtime/report-scheduler.ts:79-80`); a stop lasts minutes; the daily catches up (`:87-88`) |
| The registry cannot be reached                       | Discovery keeps the error and its time; `mama update` exits 1 before draining                          |
| A daemon run in a terminal, no service file          | Refused at step 1                                                                                      |

## Order of work

Step 0 → PR 1 (deployed on this Mac at once) → PR 2 → PR 3 → PR 4 → the wave 2 release with W2.4
(this design changes no core code; core 8.9.0 from W2.2 still goes first) → the clean-account
proof once N+1 exists → R3 and R7 marked in v1.md, evidence in checks.md.

## Plan corrections

- W1.1 lists `drain` and a draining `mama stop`; neither was built. PR 1 builds them.
- W1.1 calls the launch-file rewrite by `mama update` W2.5; it is W2.3.
- W2.3's "reinstall the previous version" gives a different install under the caret core range;
  the previous folder is kept instead.
- W2.3's sequence runs as two programs: the old code up to the install, the new code after it.
- R3 lists the backup before the wait; `mama backup` needs a stopped install (`backup.ts:81-82`),
  so the order is drain, stop, snapshot.

## Open owner decisions

None: the plan, the code and the rules settle each choice above. The clean macOS account and its
test bot are owner actions, already needed by B2.

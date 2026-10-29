# Update and `/update` (1.0 W2.3)

Rows R3 and R7 of [v1.md](v1.md); plan [W2.3](v1-plan.md#w23-update-and-update-r3-r7). Code read
at `32c6102a6`. `s/` is `packages/standalone/src`, `c/` is `packages/mama-core/src`.

## Why

Updating is npm, build and restart by hand. On 2026-10-05 a restart chained into a running turn
killed the 23:00 daily mid-run (R3). A later deploy showed the idle check and the stop are never
one step: a turn started between them
([checks](../checks.md#p2b-member-share-452-and-release-810--0700-2026-10-08)). The drain below
holds claims until the stop, so nothing starts in that gap. R7 asks for the same from chat without
a model turn, so an owner can repair an install whose backend is broken.

## Install kinds

The kind comes from the package the service runs, `start.sh`'s exec line (`readStartScript`,
`s/cli/launch-files.ts:273`). The CLI running the command must be that package, or it refuses and
names both paths: on this Mac `mama` on PATH is a stale global 0.53.2-local.11 while the service
runs the checkout. Windows is out: `mama service` throws there (`s/cli/commands/service.ts:59`).

| Kind     | Recognised by                                                                    | `mama update` and `/update`        |
| -------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| npm      | the package is `<prefix>/lib/node_modules/@jungjaehoon/mama-os`                  | the full flow below                |
| checkout | its `package.json` names core `workspace:*` (published packages carry a version) | refuses and prints the steps below |
| other    | anything else                                                                    | refuses and names the path         |

- Docker's detection and refusal (decision 6) come with the W4 image, which sets the marker.
- `<prefix>` is derived from the exec path. Every npm call passes `--prefix <prefix>` and the
  registry npm reports once (`npm config get registry`), and runs the npm beside `start.sh`'s
  pinned Node (`stableNodePath`, `s/cli/launch-files.ts:24`).
- Checkout: decision 6's first sentence decides it, "**`mama update` serves npm installs.**" The
  checkout clause says how a checkout updates (by git, as the deploy procedure does). The printed
  steps name the checkout's CLI by absolute path, because `service install` writes the running CLI
  as exec (`s/cli/commands/service.ts:153`): `<node> <cli> stop` (drains), `git pull --ff-only`,
  `pnpm install`, `pnpm build`, `<node> <cli> service install`, `<node> <cli> service start`. The
  stop comes first: sessions start the action MCP server from `dist`
  (`s/cli/runtime/action-mcp-config.ts:82-83`), which the build rewrites.

## Step 0: verify a one-shot launchd job (no code; result in checks.md)

- Scratch LaunchAgent A (outside `~/Library/LaunchAgents`, with the generated plist's
  `ExitTimeOut` and `HOME`) bootstraps plist B into `gui/$UID`. B has no KeepAlive; it writes its
  pid, PPID and the time, boots A out, sleeps 20 s, writes again, then bootstraps A again from
  inside B. Proof: B's second line, its PPID 1, A gone in between and running again at the end.
  Also record any background-item notice, and that B's label bootstraps again after
  `launchctl bootout` of the finished B.
- The development session runs it. `systemd-run --user` gets the same check in wave 3.

## PR 1: drain

- New control op `drain`. `startDaemonControl` ends the socket after one reply
  (`s/cli/runtime/daemon-control.ts:221-222`); `drain` keeps it open and holds claims for as long as
  it stays open, through the service-manager stop, so a dead updater lets go. While held, `ready`
  and `hostReady` are false (`s/runtime/owner-runtime.ts:1183,1195`), so core's `drainOnce` claims
  nothing (`c/runtime/runtime.ts:779-783`). Accepting goes on (`c/runtime/runtime.ts:937`):
  messages, deltas and reports wait `pending`. Host commands still answer, so `/stop` ends a long
  turn the existing way.
- Idle: no `running` model run and no `claimed` input, the queries `status` runs
  (`s/cli/commands/daemon.ts:491-503`). Inputs already claimed still start: up to 8 per person wait
  for the serial slot (`c/runtime/runtime.ts:378-379,636`). Bound: (running + claimed at the hold)
  × `agent.max_turn_ms`, plus 60 s. Past it the hold ends, nothing changes, the running and claimed
  counts are named, exit 1. A held `drainOnce` also skips claim renewal and stale-claim replay
  (`:783-802`).
- `release` op: ends a hold the daemon was booted with (PR 3, step 13).
- `mama stop`, `service restart` and `uninstall` drain first; `mama stop --now` keeps today's stop
  (`s/cli/commands/control.ts:169-174`). `mama backup --restart` (W1.3a) drains, stops, backs up,
  starts. `mama status` shows the hold.
- Tests: a turn running at the hold finishes, its reply delivered and acked; an input accepted
  during the hold runs after the restart; a closed connection or the bound ends the hold; a hold
  longer than the 10-minute lease (`runtime.ts:475`) does not requeue a live claim; `--now`.
- Live (this Mac): the checkout CLI's `service restart` during an owner turn; the turn commits, its
  reply arrives, `daemon.log` has no `interrupted`.

## PR 2: install kind, release discovery, doctor codes

- `installKind()` in `s/cli/runtime/install-kind.ts`. Nothing detects it today.
- Once a day the daemon runs `npm view @jungjaehoon/mama-os dist-tags.latest`, as above, with an
  environment scrubbed by `backendEnvironment` (`s/runtime/backend-security.ts:129`), since
  `start.sh` exports `auth.env`. It writes `runtime/release-check.json` (0600): `checkedAt`,
  `current`, `latest`, `error`. `checkedAt` outlives restarts. Replay never checks.
- `mama status` and a doctor check `release` read only that file: "newer release X (checked T)"
  with the kind's path, or "last check failed at T: <code>". No network call from either.
- `Check` gains a stable `code` (such as `backend.too_old`, `backend.signed_out`, `update.open`), because details
  carry versions (`s/cli/runtime/diagnostics.ts:335,342`) that a backend self-update changes.
- Tests: status and doctor with a network that throws; a second boot the same day makes no call; a
  failed check shown; each kind from a fixture tree; npm's environment holds no credential name.

## PR 3: `mama update [<version>] [--dry-run]`, `mama update --rollback`

The parent is the old code; it statically imports everything it uses, because the CLI's commands
load lazily (`s/cli/index.ts:9-109`) and after step 8 its own files are renamed. From step 8 on it
runs loaded code and Node built-ins only. npm and toolkit children get the scrubbed environment.

| #   | Step (parent, old code)                                                                                                                                                            | Reuses                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Kind and same-package checks; refuse without a service file (decision 7: nothing else would start the daemon again); take `runtime/update.lock`                                    | `serviceFile` (`service.ts:123`); `acquireInstallLock` with a paths argument (`daemon-control.ts:34-42,115`)         |
| 2   | Target: `npm view …@<version or latest> version`. Same: "already on X", exit 0. Lower: refused (R5)                                                                                | new                                                                                                                  |
| 3   | Record `doctor --offline`'s failures as name and code                                                                                                                              | `runDiagnostics` (`diagnostics.ts:165`), PR 2                                                                        |
| 4   | Print from → to, kind, the steps and what runs now; `--dry-run` ends here                                                                                                          | `status` op                                                                                                          |
| 5   | Stage: `npm install -g --prefix <scope>/.mama-update-<to> …@<to>` (same filesystem); the new `bin` names must equal the old. A failure changes nothing                             | new                                                                                                                  |
| 6   | Write the journal `runtime/update.json` (0600); drain; stop through the service manager                                                                                            | PR 1; `runStop` (`control.ts:175`)                                                                                   |
| 7   | Snapshot `backups/mama-update-<from>-<time>.tar.gz` with credentials; record each schema source and the last input id; copy `start.sh` and the service file into `runtime/update/` | `runBackup(['--include-secrets'])` (`backup.ts:62`, it takes `daemon.lock` itself), a name option; `readSchemaState` |
| 8   | Write `runtime/update.hold`; rename the package to `.mama-os-<from>`, then the staged one into its place                                                                           | new                                                                                                                  |
| 9   | Run the child `<node> <cli> update --continue` (stdio inherited); exit 0 is done; non-zero, a signal or no `running` at `<to>` rolls back                                          | new                                                                                                                  |

| #   | Step (child, new code)                                                                                                                                                                                        | Reuses                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 10  | `mama service install`; `start.sh` gains `[ -f runtime/update.hold ] && exit 0`                                                                                                                               | `installService` (`service.ts:127`), `startScript` (`launch-files.ts:49`)     |
| 11  | `doctor --offline`: a failure (name and code) not seen at step 3 exits non-zero; the running update's own journal check (`update.open`) is left out                                                           | PR 2                                                                          |
| 12  | `mama tools install` when the toolkit's `requirementsSha256` differs from the new lock                                                                                                                        | `document-toolkit.ts:514`, `readDocumentToolkit` (`toolkit-state.ts:50`)      |
| 13  | Journal phase `candidate`; remove the hold file; `service start`. The daemon reads the journal and boots with claims held, so boot's recovery drain (`owner-runtime.ts:1202-1205`) runs nothing               | `startService` (`service.ts:268`)                                             |
| 14  | Wait for `running` at `<to>` and `/health`, up to 600 s; then write `phase: committed` to the journal durably before `release`, close the journal, delete the snapshot, the copies and the old folder; report | `waitForBoot` (`init.ts:291`), which must be exported; 600 s as `init.ts:658` |

- The old folder, not a reinstall: mama-os depends on core `^8.8.0`, so reinstalling `<from>` can
  bring a newer core. A global package holds its own `node_modules`. A test proves a package
  installed under the staging prefix runs after the rename.
- Journal fields: phase, step, from, to, prefix, registry, Node path, the previous CLI's absolute
  path, snapshot, schema before, last input id, toolkit hash before, the copied files. While it is
  open, doctor fails and prints `<node> <previous CLI> update --rollback` with absolute paths.
- A journal at `committed` is never rolled back: the candidate may have run inputs, so recovery
  only finishes step 14's cleanup.
- Rollback (the parent, or `--rollback` after a killed updater):
  1. Stop through the service manager; a failing candidate restarts on failure.
  2. Write the hold file; put `.mama-os-<from>` back in place.
  3. Run the previous CLI's `update --rollback --continue`, which does the rest.
  4. Copy back the saved `start.sh` and service file. No regeneration, so a missing backend does
     not block it.
  5. If a schema source moved, `mama restore <snapshot>`, and report how many inputs accepted
     after the snapshot it drops. Otherwise keep the database: the held candidate ran no turn.
  6. If step 12 ran, the previous CLI's `mama tools install` (`tools_root` is outside the backup).
  7. Remove the hold file, start, wait for `running` at `<from>`, check `npm ls -g --prefix`
     shows `<from>`, delete the snapshot, report the failed step and its message.
- A failing rollback stops with the hold file in place. The journal, the snapshot and both folders
  are kept, the absolute rollback command is printed, and it exits 1.
- Tests: each step fails in turn and ends on `<from>` with equal `work.list` counts; a killed parent
  at each step from 6 on leaves a journal that `--rollback` resolves (or, at `committed`, finishes);
  a killed parent before step 6 leaves only the staging prefix, which the next `mama update` removes
  under `update.lock` and doctor reports; inputs accepted by a held candidate
  survive a rollback without a schema move; refusals (checkout, a lower target, a second updater,
  no service file, changed `bin`); the snapshot is 0600; npm children see no credential name.
- CI leg in `upgrade-check`: a local registry (verdaccio) serves this build at two versions and a
  third that crashes at boot; it proves the npm flow, the journal and rollback without the service
  manager. The macOS hosted runner is tried for the service half; it is not counted as that proof.

## PR 4: `/update`

- `update` joins `TELEGRAM_HOST_COMMANDS` and the port gets `update(origin)`
  (`s/gateways/telegram-commands.ts:10,21`). Allowed: an owner (`ownerAllowed`,
  `s/gateways/telegram.ts:679`) in the common channel (`chatId === ownerChatId`, `:839`) or their
  own DM. Everyone else, an owner in another group included, is refused. A checkout replies with
  its steps.
- Before anything, the daemon reads the `update.lock` holder; a running update gets "already
  updating since T". It writes the origin chat and message id to `runtime/update-request.json`
  (0600; not argv, which `ps` shows), kept after the run; a message id already there is refused,
  since a killed daemon may not have confirmed its offset.
- It starts the updater as its own job: macOS `runtime/update.plist` (label `com.mama.update`, no
  KeepAlive, output to `logs/update.log`), booting out an earlier one only when it has no pid,
  then bootstrapping it as Step 0 proved; Linux `systemd-run --user --unit=mama-update --collect`.
  It replies "Updating X → Y; progress follows".
- The job runs `runtime/update.sh`: `start.sh`'s PATH and `cd` lines and its pinned Node, without
  `auth.env` (`startPathEntries`, `s/cli/launch-files.ts:94`). It reads only the bot token from
  `auth.env`, as doctor does (`readAuthEnv`, `s/cli/runtime/diagnostics.ts:101`).
- Progress goes to the origin through Bot API `sendMessage` only, never `getUpdates`
  (`defaultTelegramCall`, `diagnostics.ts:121`): versions, step names and error codes, because a
  group reads it. A failed send is logged to `update.log`, and the update goes on.
- Not covered: a removed backend binary. `service install` refuses at step 10
  (`s/cli/commands/service.ts:146-150`), so the update rolls back and the owner reinstalls it.
- Tests: the four origins; a second `/update` during a run leaves the job alive; a repeated
  message id; no model run opens; `bot.stop` confirms the offset (`telegram.ts:304-307`); progress
  holds no path or message text; `update.sh` holds no secret.

## Live proof

- **This Mac (checkout, live bot):** PR 1's drained restart; the checkout CLI's `update` and
  `/update` (owner DM, common group) refuse with the steps.
- **A clean macOS account on this Mac,** with its own test bot and group (B2 needs one too), before
  the release, as release-process.md asks: verdaccio serves candidates N, N+1 and N+2 that crashes
  at boot. It proves the update under real launchd, `/update`, and rollback from a crashing
  candidate against KeepAlive. A second root under this Mac's own account cannot work, because the
  LaunchAgent label is fixed (`s/cli/launch-files.ts:154`).
- **After the release:** the same account updates from the npm registry once N+1 is published.
- **Wave 3 Linux box:** `systemd-run --user` and the systemd half of every step.
- Installs on 0.78.0 or earlier update by hand once; the release notes say so.

## Done when

- **R3:** on the clean account, status and doctor show the newer version from the cached check;
  `--dry-run` shows N → N+1 and the steps; `mama update` started during a test-bot turn waits for
  it (run `committed`, reply delivered), then snapshots, swaps, restarts, waits and reports; status
  shows N+1; `daemon.log` is clean; the snapshot and the old folder are gone. Updating to N+2 rolls
  back: N runs, `npm ls -g` shows N, and no input is lost. The registry run repeats N → N+1.
- **R7:** with that account's backend signed out, `/update` from the owner's DM runs the same steps;
  progress and the result arrive there and no model run opens. In the common group it answers there
  ("already on N+1"). A member is refused.

## Failure modes

| Failure                                                    | Handling                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claimed work outlasts the drain bound                      | Hold ends, nothing changed, counts named, exit 1                                               |
| Staging (npm, network, prefix not writable)                | Staging removed, nothing else changed, npm's code reported; never `sudo`                       |
| The service stop fails (`runStop` 1, `control.ts:156-167`) | Journal removed, hold released, staging removed, exit 1                                        |
| The parent dies after the stop                             | `start.sh` exits 0 on the hold file; doctor prints the absolute rollback command               |
| The snapshot fails (disk full)                             | Backup's error; staging removed; the old version started                                       |
| New doctor failure, or no `running` at `<to>`              | Rollback; the database is restored only if a schema source moved                               |
| The updater dies while the candidate is held               | Journal stays `candidate`; doctor names `--rollback`; `release` is never sent by hand          |
| A restore in a rollback                                    | Inputs after the snapshot dropped and counted; Codex sessions start over (`restore.ts:753`)    |
| The rollback fails                                         | Stopped on the hold file; journal, snapshot and folders kept                                   |
| A second update (CLI, chat)                                | `update.lock` refuses it; `/update` reads the holder first and leaves the job alone            |
| A full-report hour passes while stopped                    | Skipped (`report-scheduler.ts:79-80`); the stop lasts minutes; the daily catches up (`:87-88`) |

## Order of work

Step 0 → PR 1 (deployed on this Mac at once) → PR 2 → PR 3 → PR 4 → candidate proof on the clean
account → the wave 2 release with W2.4 (no core code changes here; core 8.9.0 from W2.2 goes
first) → the registry run → R3 and R7 marked in v1.md, evidence in checks.md.

## Plan corrections

- v1-plan W1.1 claimed a `drain` op and a draining `mama stop`; neither was built. This change
  corrects W1.1 and its "W2.5" (W2.3).
- W2.3's "reinstall the previous version" gives a different install under the caret core range;
  the previous folder is kept instead.
- W2.3's sequence runs as two programs: the old code up to the swap, the new code after it.
- R3 lists the backup before the wait; `mama backup` needs a stopped install (`backup.ts:81-82`),
  so the order is drain, stop, snapshot.

## Open owner decisions

None: the plan, the code and the rules settle each choice above. The clean macOS account and its
test bot are owner actions, already needed by B2.

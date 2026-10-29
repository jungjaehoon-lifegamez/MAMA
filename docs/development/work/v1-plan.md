# MAMA OS 1.0 — implementation plan

The rows are in [v1.md](v1.md). This plan says how each is built: the slice (one PR unless noted),
the design, the files, the contracts it adds or changes, the tests and the live check. Facts were
traced in the code at `367494f2b` on 2026-10-15 and reviewed by Opus and Codex (#504); `s/` is
`packages/standalone/src`, `c/` is `packages/mama-core/src`. A slice closes its rows only when its
live check passes.

## Corrections to v1.md made with this plan

- R1: on Linux `launchctl` is missing, so `mama status`, `mama stop` and the stopped-only commands
  throw (`s/cli/commands/daemon.ts:981-993`, `s/cli/index.ts:10-15`). A second daemon fails at the
  owner-runtime stage on the live `runtime.sock`, after it has migrated the live database, rewritten
  the workspace settings with its own proxy ports and reset `web-fetch-turn.json`
  (`s/runtime/owner-runtime.ts:316,1047`, `s/runtime/native-session.ts:446-454`).
- X2 is closed by #486: connectors settle before the database closes; none in 26 boots since
  2026-10-12.
- F1: core's read has 25 open items; the 34 stale came from a fold that ignored `applies_until`.
- New rows: R9 (logs grow without rotation) and I6 (`start.sh` pins the Node binary init ran
  under, `s/cli/commands/init.ts:392`, which a Homebrew upgrade or an nvm switch removes).
- G3: the program part is that the daily turn runs, reads the day and publishes; the stretch of
  days is the owner's acceptance, not a program check.

## Decisions this plan settles

1. **Pairing happens in `mama init`, before any daemon runs.** Init writes the config first (with
   the root defaults of decision 3), then polls the new bot itself; later people keep the in-chat
   enrollment (P7). Docker runs `docker compose run mama init` once before `up`; scripts keep
   `register-owner <id>`.
2. **An operating-system lock and a control socket per install.** The single-instance authority is
   an exclusive SQLite lock on `<root>/runtime/daemon.lock`, held for the process's life and
   released by the operating system when it ends, so no stale claim or reused pid needs handling
   (#505). The control socket sits at the root beside `runtime.sock` (the same AF_UNIX path limit)
   and carries status, stop and drain (drain from W2.3); each request needs the per-boot token the daemon writes
   under `runtime/`, which the agents' native reads deny (`s/runtime/backend-security.ts:120`).
3. **Default `member_root` and `tools_root` outside HOME, per platform and per user.** macOS:
   folders in the Shared folder beside the home folders. Linux: `/var/lib/mama/<user>/members` and
   `/var/lib/mama/<user>/tools`, created once by the installer with `sudo`. Docker: volumes.
4. **Minimum backend versions are the versions a release was verified on** (today Claude Code
   2.1.299 and Codex 0.160.1), in one constant, raised only with a verification.
5. **Backups are taken from a stopped install, and restore makes paths follow their roots.**
   Restore rewrites the stored absolute paths that are read back to open files (mailbox payloads,
   the connector event index) by each old root's prefix, and sets the config's paths to the target's
   (#509). Writes keep absolute paths: a second, root-relative scheme would duplicate that rewrite,
   which older rows need anyway (owner, 2026-10-16). A restore keeps the target's credentials when
   the archive holds none, and refuses to start a target that has neither. Restoring an older
   backup brings back what was erased after it was taken; this is documented, not undone (P9,
   owner, 2026-10-16).
6. **`mama update` serves npm installs.** Docker refuses and prints the pull-and-recreate steps; a
   checkout install (this Mac) updates by git, as the deploy procedure does.
7. **Services restart on failure only.** launchd `KeepAlive` with `SuccessfulExit=false` and
   systemd `Restart=on-failure`: a clean stop stays stopped, and a refused second boot exits
   cleanly instead of being restarted every ten seconds.
8. **Core migrations and their consumers move together.** A database newer than the code is
   refused (R5). MAMA OS refuses it from W1.4a (#510); core's refusal is opt-in
   (`openDatabase({ refuseNewerSchema })`), because the plugin hooks and the MCP server share
   `~/.claude/mama-memory.db` without running one core: on this Mac the hooks run core 5.2.0 from
   the plugin's data folder (reinstalled only when its manifest text changes) and the plugin starts
   the server with an unpinned `npx -y @jungjaehoon/mama-server`, which resolves to a global 2.4.0
   on core 5.5.0. #511 (W1.4b-1) makes them run one core and opts them in; it reaches users with
   the next core, server and plugin release. Recorded as an API-contract decision.
9. **Each wave ends with a release** (core first when it changed), so G2 has real earlier versions.

## Decisions for the owner

- D3: if the shell sandbox cannot start in a container without relaxed container security or a
  weaker nested sandbox, the choice goes to the owner and into AGENTS.md first. The backend's OAuth
  token variables are stripped from its environment (`s/runtime/backend-security.ts:104-106`), so
  a token login inside the container is also an AGENTS.md change.
- L5: SteamOS or a native Ubuntu host, decided on the facts wave 3 measures first.
- E4 (Discord and Slack), T1 (members without the owner role), INTENT.md's wording.

## Wave 1 — this Mac, no new environment

### W1.1 Lock, control socket and service files (R1; the generator W1.5 and W1.6 need)

- Boot takes the exclusive SQLite lock of decision 2 on `<root>/runtime/daemon.lock` before the
  config stage and holds it for the process's life; a held lock refuses the boot (clean exit,
  decision 7), and the operating system releases it when the process ends. The holder serves the
  socket. Signal handlers are installed before boot (today after it, `daemon.ts:963-977`).
- Ops: `status` (pid, version, started, boot stage, running turns per session, connectors' last poll
  and error, last error), `stop`. W1.1 built `status`, `stop` and (W2.1d) `probe`; `drain` and
  the draining `stop` below were not built and are W2.3's first PR ([update.md](update.md)).
- CLI: `status` (exit 0 running, 3 stopped) plus the service manager's state; `stop` drains and
  reports running turns, then stops through the service manager when installed, `--now` skips the
  wait; `register-owner` holds the lock while it runs (it opens the database itself,
  `register-owner.ts:62`); `replay` and `backfill` boot through `bootDaemon`, so their
  `requireDaemonStopped` calls go (`index.ts:47,53`).
- `mama service install|uninstall|start|stop|status`, idempotent, writes the launch files from the
  current template (LaunchAgent on macOS; a systemd user unit on Linux, verified in wave 3), with
  decision 7's restart policy. On Linux it enables linger (`loginctl enable-linger`) with the
  person's consent, so the service runs after logout, and says so when it cannot. `mama update` (W2.3) rewrites them when the
  template changes.
- Files: new `s/cli/runtime/daemon-control.ts`, `s/cli/commands/service.ts`; `daemon.ts`;
  `index.ts`; `launch-files.ts`; `register-owner.ts`; `docs/reference/cli.md` (stale PID text and
  secret names).
- Tests: a second boot refused before touching the database; a killed holder's lock free for the
  next start; stop during boot; status under no service manager.
- Live: `mama status` during a turn; a second `daemon` refused with no database or settings write.

### W1.2 `mama doctor` and the bug report (R2, R8, I6; the backend probe of I2)

- Read-only throughout: the database opens read-only and compares each source's stored version with
  its highest migration file (no migration runs). Checks, each with its fix: the config as boot
  loads it without opening resources; `member_root`; the Node path in the launch files (I6); the
  backend on the service's PATH, its version, its login (`claude auth status`, `codex login status`
  in the managed home); the sandbox by running it (a no-op under `sandbox-exec` on macOS, under
  `bwrap` on Linux); the bot token and `can_read_all_group_messages`; ports; the toolkit; the
  service; log sizes.
- `--report` writes the redacted summary; a test seeds tokens, chat IDs and message text and finds
  none. A failed boot prints its stage and message and points to `mama doctor` (today a name and a
  code, `index.ts:73-91`). The launch files use a stable Node path (I6).
- Files: new `s/cli/commands/doctor.ts`, `s/cli/runtime/diagnostics.ts`,
  `s/cli/runtime/backend-probe.ts`; a read-only schema reader in core.

### W1.3 Backup and restore (R4)

- `mama backup` requires a stopped install (`--restart` drains, stops, backs up and starts): the
  database and each `raw.db` copied, the state files under the root and `member_root`, the common
  skills under `tools_root/skills` (owner-published, `s/runtime/skills.ts:446-479`), a manifest
  with versions and SHA-256, verified with `integrity_check` and the hashes. Credentials, including
  each member's copied Codex login and session credential, only with `--include-secrets`; left out:
  `tools_root` binaries, Codex thread caches, model caches, logs unless asked. Archives are written
  0600 to `<root>/backups/`, which joins the agents' read denies; another destination inside the
  workspace or `member_root` is refused. A `config.yaml` that still holds a secret-shaped value
  (older installs) counts as a credential and goes only with `--include-secrets`.
- Poll state is written atomically (today in place, `polling-scheduler.ts:205`, and a parse failure
  is dropped silently, `:179-182`).
- Restore stages each root beside its destination (the roots may sit on different filesystems,
  such as Docker volumes), switches them under a journal that rolls every root back if one switch
  fails, and rewrites the old prefixes of the three roots
  (decision 5), keeping the target's credentials when the archive has none. Done (#508, #509);
  W1.3c, root-relative attachment writes, is dropped (decision 5).
- Proof: back up a copy of this Mac's home, restore it under another HOME and another
  `member_root`, `mama doctor` clean, `work.list` counts equal, a common skill listed, and an old
  owner and member attachment open.

### W1.4 Upgrade check and downgrade refusal (R5; core change, decision 8)

- W1.4a, done (#510): core's migration runner checks every source before any runs and refuses a
  database whose stored version is above the highest file of a source, including deferred
  migrations (92, 98, 100, 103); MAMA OS opts in and stops cleanly; `mama doctor` reports it.
- W1.4b-1, done (#511): the plugin pins the server it is released with, the release writes the exact
  core into the server and the plugin, and the plugin sync fails unless that core is on npm and the
  pinned server depends on it (an invariant check, in place of a `db/migrations` diff); the hooks
  and the server opt in. `sync-plugin.yml`, `publish.yml` and `publish-packages.yml` are retired:
  release.yml is the one publish path.
- W1.4b-2, done (#512): the `upgrade-check` CI job installs the previous published MAMA OS with
  the core it shipped with; that release sets up an install through its own `mama init` and
  `register-owner`, then writes work, a revision, a lesson and a pending owner message through its
  own actions; this build boots on it and reads each back. Runtime JSON ledgers, connector raw
  stores and deltas need a live-mode boot and stay open.

### W1.5 Logs and uninstall (R6, R9)

- The daemon takes over its own stdout and stderr at entry and writes them with size rotation; the
  launch files send only what comes before that to a crash log under `logs/`, capped at start.
  `daemon.log` and `security-events.jsonl` keep a fixed number of compressed files.
  `mama logs [-n N] [--follow]`; `mama uninstall [--dry-run] [--data]`: without `--data` it stops
  and removes the service; with `--data` and a typed confirmation it also removes the MAMA root,
  `member_root` (every person's workspace, downloads, runtime state and copied logins) and the
  common skills under `tools_root/skills`, keeping the toolkit binaries unless `--toolkit` is given;
  `--dry-run` lists exactly what would go.

### W1.6 This Mac on generated launch files

- Done (#516, 2026-10-16): `mama service install --replace`, run with a clean PATH, replaced the
  hand-edited `start.sh` (legacy flags, a PID file, a port-wait loop) and the LaunchAgent (KeepAlive
  true, output into `daemon.log`), still pointing at the checkout's `dist`. Three exports nothing
  reads were dropped first; the previous files are kept under `runtime/`. The generator first had to
  keep Homebrew's folder on PATH (#516), where the agent's shell finds python3 with its packages.

## Wave 2 — onboarding, chat commands and update (this Mac and a clean macOS account)

### W2.1 `mama init` for anyone (B1, B2, B3, B5, B6, I2)

- Order: check the bot token with `getMe` and `can_read_all_group_messages` (privacy must be off
  before the bot joins a group); find the backend and check its version and login; write the config
  with the root defaults and the workspace isolation files; make one real backend call through the
  same isolated launcher the daemon uses (workspace git boundary, empty plugin folder,
  `project,local` settings, the managed Codex home), so no global instructions or plugins load;
  pair; register the first owner as `register-owner` does
  (`register-owner.ts:92-185`); confirm the update offset so the daemon never sees the pairing
  messages; install the toolkit; install and start the service; wait for the boot stages and
  `/health`. Init refuses while a daemon runs (polling beside it gives a 409 that stops the
  daemon, `daemon.ts:822-825`). A state file marks completed steps so a failed init resumes.
- Pairing: the bot sends the DM's sender a code and init asks for it; then `/bind` from the paired
  person in a group sets the common channel. Strangers stay unanswered.
- `mama init --section <name>`; `--non-interactive` from flags and environment: without a person
  at a terminal, the owner's Telegram ID and the common group's ID come from flags or environment
  (as `register-owner <id>` does today), and `mama pair` can replace them interactively later. Sources a fresh install cannot use (the Kagemusha bridge, `init.ts:35`) are not offered;
  the launch-agent question goes to `mama service install`.

### W2.2 Host chat commands (E1)

- Handled by the host before a turn, registered with `setMyCommands`: `/whoami`, `/status`, `/help`,
  `/new` (refused while a turn runs, as `resetSession` refuses a busy session,
  `c/runtime/native-turn.ts:412-434`), `/stop`. In the common group only owners stop the common
  session's turn.
- Built (#520, #521). `/stop` stops a turn through a driver interrupt that keeps the session:
  - Codex: `turn/interrupt`;
  - Claude: the CLI's `interrupt` control request, not the timeout's process kill, which would end
    the conversation.

  The stopped input then takes the existing uncertain path: never run again, its message told it was
  interrupted, closed once that notice is delivered. Since #521 that recovery reaches only the
  stopped message; the startup sweep it used to run also interrupted every other message in flight.

- Queued inputs are not cancelled. `cancelQueued` is per person and kind-blind, so in the common
  session it would drop source deltas, and for a member the correction they sent after the request.
  Each further `/stop` stops the next turn (amended 2026-10-16).

### W2.3 Update and `/update` (R3, R7)

- `mama update [--dry-run]`: drain, stop through the service manager, take a private full
  snapshot for rollback (W1.3 with credentials, kept 0600 and removed after a good boot), install,
  rewrite the launch files, `mama tools install` when the toolkit lock changed, start, wait for the
  boot stages; if the new version does not boot, stop, restore the backup, reinstall the previous
  version and start it.
- Release discovery: the daemon checks the registry at most once a day and keeps the answer in
  `runtime/`; `mama status` and `mama doctor` show a newer release from it, say when the last check
  failed, and make no network call themselves.
- `/update` from an owner in the common channel or the owner's own DM runs the updater as its own
  job of the service manager (a transient `systemd-run --user` unit on Linux; a one-shot launchd job
  on macOS, verified first), because a child of the daemon dies when the daemon's service stops.
  Progress goes to that chat; no model turn is involved. Docker refuses (decision 6).

### W2.4 Install command (I1, I4, I5)

- `install.sh` for macOS and Linux always provisions the managed Node under the user's MAMA folder
  (a stable path the launch files use, whatever Node is already installed, I6), installs the
  package and the backend CLI the person picks (Claude Code or Codex, by its documented install
  method, verified at the time), so `mama init` only signs it in, creates the Linux roots with `sudo` once and starts `mama init`; Docker is
  `docker compose run --rm mama init` once (pairing needs a person), then `docker compose up -d`.
- Enabling a source checks the tools it needs (`gws` today); the install guide lists supported
  versions of Node, the backends, the Linux distribution and Docker.

## Wave 3 — Linux on the Steam Deck (L1–L5, I3)

- First measure and record: SteamOS version, the read-only system root, `sudo` for the default user,
  `bwrap` and `socat` and whether unprivileged user namespaces work (Ubuntu 24.04 restricts them by
  default), LibreOffice availability, systemd user services and linger. These decide L5.
- `document.render` on Linux under `bwrap` with the macOS profile's denies; tests show both hold.
- The toolkit names or installs the Linux packages; iMessage is offered only on macOS (enabled on
  Linux it fails the boot today, `s/runtime/connectors.ts:209`).
- A refused shell connection raises the same alert; one live owner turn runs Bash in the sandbox.

## Wave 4 — Docker (D1–D5)

- Image: Node 22, the toolkit with LibreOffice and Noto CJK, `gws`, `bwrap` and `socat`, the backend
  CLIs, a non-root user, an init process (`init: true`) for orphaned children, a `HEALTHCHECK` that
  passes only when `mama status` reports boot complete (`/health` answers from the viewer stage,
  before connectors and messengers start), version tags, published by the release workflow. amd64 is tested on the Steam Deck;
  arm64 is offered only after the same run on arm64, otherwise labelled experimental.
- Compose volumes: the MAMA home, `member_root`, `tools_root` (common skills live there), the
  backend credentials and the `gws` credential store (`~/.config/gws`, or
  `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`). The viewer needs `MAMA_API_HOST`, `MAMA_VIEWER_HOSTNAMES` and its bearer
  token.
- Sign-in without a desktop: Codex `codex login --device-auth`; the Claude method is verified on the
  image and must be file-based or an owner decision (D3).
- Isolation is measured first: whether the shell sandbox starts with the documented container
  options; then, inside the container, a member session cannot read another member or the
  database, the common session cannot read the database with its WAL and SHM, the raw stores,
  `member_root` or the member temp root, and egress is refused for both (decision D3 if not).

## Wave 5 — everyday use, people, defects and guides

- E2: the viewer's `/api/tokens/*` routes (stubs today, `s/api/viewer-server.ts:1214-1219`) and
  `/status` read usage from `model_runs` per person; child runs record usage (NULL today,
  `c/runtime/native-turn.ts:849-856`); a backend limit is shown only where a CLI reports one.
- E3 and T5: the viewer shows the service, each connector's last poll and error (from
  `connector_event_index_cursors`), the last boot and each person's actions and usage.
- X1: a failing Chatwork room is skipped and reported while the rest are recorded; per-room ids
  persist; a poll that may have missed messages records a gap (whether the API can page beyond 100
  is checked first).
- X3: the standing prompt's sections are measured and cut, or the limit is revised with its reason.
  X4: the member-records and Codex app-server timeouts are reproduced under load. X5: the CI filters
  include the files those tests read.
- S1: a guide per platform, each the one G1 followed; the macOS guide says a LaunchAgent runs only
  while the user is logged in. S2: release-process.md states what 1.x keeps.
- E4 and T1 follow the owner's decisions.

## Owner-flow rows and the gate

- F1 starts with recounting C1 against core's read; F2–F4 and T2–T4 run alongside on live data.
- G1 runs on a clean macOS account, the Linux host decided in wave 3 and the Docker image, never on
  this Mac's live home. G2 upgrades an install of the wave 4 release to the 1.0 candidate.

## Order

W1.1 → W1.2 → W1.3 → W1.4 → W1.5 → W1.6, release; W2.1, W2.2 → W2.3 → W2.4, release; wave 3 (Steam
Deck access); wave 4; wave 5 alongside waves 3 and 4; G1–G4; 1.0.

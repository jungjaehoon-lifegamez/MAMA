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
2. **A lock file and a control socket per install.** An atomic lock file under `<root>/runtime/`
   is the single-instance authority, taken first in boot. The control socket sits at the root
   beside the sessions' `runtime.sock` (the same AF_UNIX path limit, 104 bytes on macOS) and
   carries status, stop and drain; each request needs the per-boot token the daemon writes under
   `runtime/`, which the agents' native reads deny (`s/runtime/backend-security.ts:120`).
3. **Default `member_root` and `tools_root` outside HOME, per platform and per user.** macOS:
   folders in the Shared folder beside the home folders. Linux: `/var/lib/mama/<user>/members` and
   `/var/lib/mama/<user>/tools`, created once by the installer with `sudo`. Docker: volumes.
4. **Minimum backend versions are the versions a release was verified on** (today Claude Code
   2.1.299 and Codex 0.160.1), in one constant, raised only with a verification.
5. **Backups are taken from a stopped install, and restore makes paths follow their roots.** New
   writes store attachment paths relative to the root that owns them (the MAMA root, or
   `member_root` for a person's downloads, `s/gateways/telegram.ts:846-850`); restore rewrites
   older absolute paths in config, payloads and ledgers by both old prefixes.
6. **`mama update` serves npm installs.** Docker refuses and prints the pull-and-recreate steps; a
   checkout install (this Mac) updates by git, as the deploy procedure does.
7. **Services restart on failure only.** launchd `KeepAlive` with `SuccessfulExit=false` and
   systemd `Restart=on-failure`: a clean stop stays stopped, and a refused second boot exits
   cleanly instead of being restarted every ten seconds.
8. **Core migrations and their consumers move together.** A database newer than the code is
   refused (R5), so a release that adds a core migration publishes core, the MCP server and the
   plugin together; they share `~/.claude/mama-memory.db`. Recorded as an API-contract decision.
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

- Boot takes `<root>/runtime/daemon.lock` with an exclusive create holding pid and start time,
  before the config stage; an existing lock whose process is alive refuses the boot (clean exit,
  decision 7), a dead one is replaced. The socket is unlinked and bound only by the lock holder.
  Signal handlers are installed before boot (today after it, `daemon.ts:963-977`).
- Ops: `status` (pid, version, started, boot stage, running turns per session, connectors' last poll
  and error, last error), `drain` (stop intake, report when no turn runs, stay up), `stop`.
- CLI: `status` (exit 0 running, 3 stopped) plus the service manager's state; `stop` drains and
  reports running turns, then stops through the service manager when installed, `--now` skips the
  wait; `register-owner` holds the lock while it runs (it opens the database itself,
  `register-owner.ts:62`); `replay` and `backfill` boot through `bootDaemon`, so their
  `requireDaemonStopped` calls go (`index.ts:47,53`).
- `mama service install|uninstall|start|stop|status`, idempotent, writes the launch files from the
  current template (LaunchAgent on macOS; systemd user unit with linger checked on Linux, verified
  in wave 3), with decision 7's restart policy. `mama update` (W2.5) rewrites them when the
  template changes.
- Files: new `s/cli/runtime/daemon-control.ts`, `s/cli/commands/service.ts`; `daemon.ts`;
  `index.ts`; `launch-files.ts`; `register-owner.ts`; `docs/reference/cli.md` (stale PID text and
  secret names).
- Tests: a second boot refused before touching the database; a dead lock replaced; a slow socket
  never unlinked by another process; stop during boot; status under no service manager.
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
  `tools_root` binaries, Codex thread caches, model caches, logs unless asked.
- Poll state is written atomically (today in place, `polling-scheduler.ts:205`, and a parse failure
  is dropped silently, `:179-182`).
- Restore writes to a staging folder, swaps, and rewrites the old root prefix (decision 5); new
  attachment writes store root-relative paths (`gateways/telegram-attachments.ts:117`).
- Proof: back up a copy of this Mac's home, restore it under another HOME and another
  `member_root`, `mama doctor` clean, `work.list` counts equal, a common skill listed, and an old
  owner and member attachment open.

### W1.4 Upgrade check and downgrade refusal (R5; core change, decision 8)

- Core's migration runner refuses a database whose stored version is above the highest file of a
  source, including deferred migrations (92, 98, 100, 103).
- CI installs the previous published packages in a temporary folder, writes synthetic records,
  revisions and observations through their public API plus an old `config.yaml`, mailbox payloads
  and JSON ledgers, then boots the current code on them and reads them back.

### W1.5 Logs and uninstall (R6, R9)

- The daemon takes over its own stdout and stderr at entry and writes them with size rotation; the
  launch files send only what comes before that to a crash log under `logs/`, capped at start.
  `daemon.log` and `security-events.jsonl` keep a fixed number of compressed files.
  `mama logs [-n N] [--follow]`; `mama uninstall [--dry-run] [--data]`.

### W1.6 This Mac on generated launch files

- `mama service install` replaces the hand-edited `start.sh` (legacy flags, a PID file, a port-wait
  loop), still pointing at the checkout's `dist`; deploy idle checks use `mama status`.

## Wave 2 — onboarding, chat commands and update (this Mac and a clean macOS account)

### W2.1 `mama init` for anyone (B1, B2, B3, B5, B6, I2)

- Order: check the bot token with `getMe` and `can_read_all_group_messages` (privacy must be off
  before the bot joins a group); find the backend, check its version and login, make one real call;
  write the config with the root defaults; pair; register the first owner as `register-owner` does
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
- `/stop` builds on the driver interrupts (Codex `turn/interrupt`, the Claude timeout stop) and on
  member suspension's stop path (`owner-runtime.ts:563-570`): the turn's native delivery is settled
  with a cancelled result and the input acked, so recovery does not run it again
  (`c/runtime/mailbox.ts:620-644`); queued inputs go through `cancelQueued`; the gateway records the
  interruption so the message counts as answered (`daemon.ts:86-90`).

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

- `install.sh` for macOS and Linux installs Node into the user's MAMA folder when missing, installs
  the package, creates the Linux roots with `sudo` once and starts `mama init`; Docker is
  `docker compose run mama init`, then `docker compose up -d`.
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
  CLIs, a non-root user, an init process (`init: true`) for orphaned children, `HEALTHCHECK` on
  `/health`, version tags, published by the release workflow. amd64 is tested on the Steam Deck;
  arm64 is offered only after the same run on arm64, otherwise labelled experimental.
- Compose volumes: the MAMA home, `member_root`, `tools_root` (common skills live there), the
  backend credentials and the `gws` credential store (`~/.config/gws`, or
  `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`). The viewer needs `MAMA_API_HOST`, `MAMA_VIEWER_HOSTNAMES` and its bearer
  token.
- Sign-in without a desktop: Codex `codex login --device-auth`; the Claude method is verified on the
  image and must be file-based or an owner decision (D3).
- Isolation is measured first: whether the shell sandbox starts with the documented container
  options; then a member session cannot read another member or the database and egress is refused
  inside the container (decision D3 if not).

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

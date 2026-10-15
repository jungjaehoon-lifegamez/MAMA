# MAMA OS 1.0 — implementation plan

The rows are in [v1.md](v1.md). This plan says how each is built: the slice (one PR unless noted),
the design, the files, the contracts it adds or changes, the tests and the live check. Facts were
traced in the code at `367494f2b` on 2026-10-15; `s/` is `packages/standalone/src`, `c/` is
`packages/mama-core/src`. A slice closes its rows only when its live check passes.

## Corrections to v1.md made with this plan

- R1: on Linux `launchctl` is missing, so `mama status`, `mama stop` and every stopped-only command
  (`register-owner`, `replay`, `backfill`) throw before doing anything (`s/cli/commands/daemon.ts:981-993`,
  `s/cli/index.ts:10-15`). The "reads stopped while running" case is macOS under `start.sh`.
- X2 is closed by #486 (`0392aaf2d`): connectors settle before the database closes; the error last
  appeared on 2026-10-12 13:06 and not in the 26 boots since.
- F1: core's fold has 25 open items and none older than 2026-09-15 after the 23:00 daily closed
  the last one; the 34 came from a SQL fold that ignored `applies_until` (checks, 2026-10-15).
- New row R9: logs grow without rotation (`daemon.log` 9 MB, `security-events.jsonl` 2.4 MB after
  a manual rotation in July; no rotation in code).

## Decisions this plan settles

These follow from v1.md's rules or from the code; each is reopened only with new evidence.

1. **Pairing happens in `mama init`, before any daemon runs.** Init polls the new bot itself
   (`getUpdates`; no daemon is polling yet), so the first owner and the common group are found
   without a numeric ID and without a daemon mode that runs with no owner. Later people keep the
   existing in-chat enrollment (P7).
2. **One control socket per install.** The daemon owns `<mamaRoot>/daemon.sock` (0600) for its
   whole life; it is the single-instance lock, the status channel and the stop/drain channel for
   the CLI, on every platform. It is separate from the sessions' `runtime.sock`
   (`daemon.ts:289`), which carries session credentials.
3. **Default `member_root` and `tools_root` outside HOME per platform.** macOS: folders in the Shared
   folder beside the home folders (as `tools_root` today, `s/cli/commands/tools.ts:12-17`). Linux:
   `/var/lib/mama/members` and `/var/lib/mama/tools`, created once by the installer with `sudo`.
   Docker: volumes at the same paths.
4. **Minimum backend versions are the versions a release was verified on** (today Claude Code
   2.1.299 and Codex 0.160.1), kept in one constant and raised only with a verification.
5. **Restore keeps data under the MAMA root's path.** It rewrites config paths when the root
   differs; attachment paths stored in the database keep the old root, and `mama doctor` lists them.
6. **`mama update` serves npm and Docker installs.** A checkout install (this Mac) updates by git,
   as the deploy procedure does.
7. **Each wave ends with a release** (core first when it changed), so G2 has real earlier versions to
   upgrade from.

## Decisions for the owner

- D3: if the shell sandbox cannot start in a container without relaxing the container's security
  options or a weaker nested sandbox, the choice goes to the owner and into AGENTS.md first.
- L5: SteamOS or a native Ubuntu host, decided on the facts wave 3 measures first.
- E4 (Discord and Slack), T1 (members without the owner role), and INTENT.md's wording, as listed
  in the work list.

## Wave 1 — this Mac, no new environment

### W1.1 Control socket and single instance (R1)

- Design: `bootDaemon` acquires the socket before the config stage: connect first; a live answer
  refuses the boot with the running daemon's pid and version; no answer removes the stale socket
  and listens. Newline JSON ops: `status` (pid, version, started, boot stage, running turns per
  session, connectors' last poll and error, last error), `stop`, `drain` (stop taking inputs and
  exit when no turn runs; used by R3). Signal handlers are installed before boot, so a stop during
  boot unwinds (today they are added after boot, `daemon.ts:963-977`).
- CLI: `status` asks the socket (exit 0 running, 3 stopped) and adds the service manager's state
  when one is installed; `stop` uses the service manager when installed (launchd `bootout`,
  `systemctl --user stop`), else the socket; `requireDaemonStopped` asks the socket.
- Files: new `s/cli/runtime/daemon-control.ts`; `s/cli/commands/daemon.ts`; `s/cli/index.ts`;
  `docs/reference/cli.md` (it still describes a PID record and six secret names).
- Tests: a second boot refused before `config`; a stale socket recovered; status with no service
  manager; `backfill` refused while running; stop during boot.
- Live: after deploy, `mama status` during a turn; a second `daemon` refused; `backfill` refused.

### W1.2 `mama doctor` and the bug report (R2, R8; the backend probe of I2)

- Checks, each with its fix: the config as boot loads it (`loadConfig`, `validateDeliveryRoutes`,
  `pathsFor`, root validations) without opening resources; `member_root`; the backend on the
  service's PATH, its version against the minimum, its login (`claude auth status`,
  `codex login status` in the managed home); the sandbox (macOS `sandbox-exec`; Linux `bwrap` and
  `socat`); the bot token (`getMe`) and whether the bot can read group messages
  (`can_read_all_group_messages`); ports; the toolkit; the service; schema versions against the
  code (R5); log sizes (R9).
- `--report` writes the redacted summary; a test seeds tokens, chat IDs and message text and finds
  none. A failed boot prints its stage and message and points to `mama doctor` (today the CLI
  prints only a name and code, `s/cli/index.ts:73-91`).
- Files: new `s/cli/commands/doctor.ts`, `s/cli/runtime/diagnostics.ts`,
  `s/cli/runtime/backend-probe.ts`; exports for the dry checks from `daemon.ts` and `config.ts`.

### W1.3 Backup and restore (R4)

- Online copies with SQLite's backup API of the database and each `connectors/<name>/raw.db`; the
  files under the MAMA root and `member_root` that hold state (config, connectors, policy, ledgers
  under `runtime/`, poll and connector state, workspace with wiki, files and skills); a manifest
  with versions and SHA-256; verify runs `integrity_check` and the hashes. Credentials only with
  `--include-secrets`. Left out: `tools_root`, Codex thread caches, model caches, logs unless asked.
- Restore needs a stopped install (W1.1), writes to a staging folder, swaps, and rewrites config
  paths for a different root.
- Proof: back up a copy of this Mac's home, restore into a temporary HOME, `mama doctor` clean,
  and `work.list` counts equal.

### W1.4 Upgrade check and downgrade refusal (R5; core change, core released first)

- Core's migration runner refuses a database whose stored version is above the highest file of a
  source (not detected today).
- CI installs the previous published `mama-core` in a temporary folder, writes synthetic records,
  commitments with revisions and observations through its public API, then opens the database with
  the current code, migrates and reads them back; the same for the standalone migration.

### W1.5 Logs, rotation and uninstall (R6, R9)

- The daemon writes its log itself with size rotation (compressed, a fixed count) for `daemon.log`
  and `security-events.jsonl`; the launch files send only the process's own stdout and stderr to a
  separate crash log. `mama logs [-n N] [--follow]`. `mama uninstall [--dry-run] [--data]` stops and
  removes the service and, only with `--data` and a typed confirmation, the data.

### W1.6 This Mac on the generated launch files

- Replace the hand-edited `start.sh` (legacy flags, a PID file, a port-wait loop) with the one
  `mama init` writes, still pointing at the checkout's `dist`; deploy idle checks use `mama status`.

## Wave 2 — onboarding, chat commands and update (this Mac and a clean macOS account)

### W2.1 Pairing in `mama init` (B2, B3)

- Init asks for the bot token, checks it with `getMe`, then waits for a DM: the bot sends the person
  a code and init asks for it, so the person at the terminal owns that Telegram account. It then
  asks the person to add the bot to a group and send `/bind`; a `/bind` from the paired person sets
  the common channel. If the bot cannot read group messages, init says how to change it. Init then
  registers the first owner as `register-owner` does today (`s/cli/commands/register-owner.ts:92-185`).
- `mama register-owner --pair` adds a later owner the same way; the numeric form stays for scripts.

### W2.2 `mama init` for anyone (B1, B4 for macOS, B5, B6, I2)

- Init finds the backend, checks its version and login and makes one real call; sets
  `member_root` and `tools_root` defaults (decision 3); installs the toolkit; installs and starts
  the service; waits for the boot stages through the socket and `/health`.
- `mama init --section <name>` changes one part with validation; `--non-interactive` takes answers
  from flags and environment variables (used by the Docker image). The launch-agent question is
  asked only on macOS (today it is asked everywhere, `s/cli/commands/init.ts:342-347`).

### W2.3 Service management (B4)

- `mama service install|uninstall|start|stop|status`: a LaunchAgent on macOS; a systemd user unit
  with linger checked on Linux. Linux is verified in wave 3.

### W2.4 Host chat commands (E1)

- Telegram commands handled by the host before a turn, registered with `setMyCommands`: `/whoami`,
  `/status`, `/help`, `/new` (resets the person's session; refused while a turn runs, as
  `resetSession` refuses a busy session, `c/runtime/native-turn.ts:412-434`), `/stop`.
- `/stop` needs a core runtime method that interrupts one principal's running turn (Claude: stop
  that session's process; Codex: `turn/interrupt`) and settles its input as cancelled so recovery
  does not run it again; no host path does this today.

### W2.5 Update and `/update` (R3, R7)

- `mama update [--dry-run]`: reads the registry, backs up (W1.3), drains through the socket, installs
  the version, runs `mama tools install` when the toolkit lock changed, restarts the service, waits
  for the boot stages. If the new version does not boot, it restores the backup and reinstalls the
  previous version.
- `/update` from an owner in the common channel or the owner's own DM starts the same procedure as
  a detached host process and posts progress to that chat; no model turn is involved.

### W2.6 Install command (I1, I4, I5)

- `install.sh` for macOS and Linux installs Node into the user's MAMA folder when missing, installs
  the package, creates the Linux root folders with `sudo` once, and starts `mama init`.
- Enabling a source checks the tools it needs (`gws` today) and prints how to install them.
- The install guide lists supported versions: Node, Claude Code, Codex, the Linux distribution,
  Docker.

## Wave 3 — Linux on the Steam Deck (L1–L5, I3)

- First measure and record: SteamOS version, the read-only system root, `bwrap` and `socat`,
  LibreOffice availability, systemd user services and linger. These facts decide L5.
- `document.render` on Linux under `bwrap` with the macOS profile's denies (no network, credential
  and member reads denied, the same limits); tests show both denies hold.
- The toolkit names or installs the Linux packages; iMessage is offered only on macOS (on Linux an
  enabled iMessage source fails the boot today, `s/runtime/connectors.ts:209`).
- A refused shell connection raises the same alert; one live owner turn runs Bash in the sandbox.

## Wave 4 — Docker (D1–D5)

- Image: Node 22, the toolkit with LibreOffice and Noto CJK, `gws`, `bwrap` and `socat`, the backend
  CLIs, a non-root user, `HEALTHCHECK` on `/health`, version tags for amd64 and arm64, published by
  the release workflow. Compose volumes: the MAMA home, `member_root`, the backend credentials.
- Sign-in without a desktop: Codex `codex login --device-auth`; the Claude method is verified on the
  image before it is documented.
- The isolation model is measured first: whether the shell sandbox starts with the documented
  container options; then a member session cannot read another member or the database, and egress
  is refused, inside the container (decision D3 if not).
- The viewer is published with its bearer token required; an upgrade is pull, recreate, and G2.

## Wave 5 — everyday use, people, defects and guides

- E2: the viewer's `/api/tokens/*` routes (stubs today, `s/api/viewer-server.ts:1214-1219`) and
  `/status` read usage from `model_runs` per person; child runs record usage too (NULL today,
  `c/runtime/native-turn.ts:849-856`); a backend limit is shown only where a CLI reports one.
- E3 and T5: the viewer shows the service, each connector's last poll and error (from
  `connector_event_index_cursors`), the last boot and each person's actions and usage.
- X1: a failing Chatwork room is skipped and reported while the rest are recorded; per-room ids
  persist; a poll that may have missed messages records a gap (whether the API can page beyond 100
  is checked first).
- X3: the standing prompt's sections are measured and cut, or the limit is revised with its reason.
  X4: the member-records timeout and the Codex app-server timeouts are reproduced under load. X5: the
  CI filters include the files those tests read.
- S1: a guide per platform, each the one G1 followed. S2: release-process.md states what 1.x keeps.
- E4 and T1 follow the owner's decisions.

## Owner-flow rows and the gate

- F1 starts with recounting C1 against core's read; F2–F4 and T2–T4 run alongside on live data.
- G1 runs on a clean macOS account, the Linux host decided in wave 3, and the Docker image, never
  on this Mac's live home. G2 upgrades an install of the wave 4 release to the 1.0 candidate.

## Order

W1.1 → W1.2 → W1.3 → W1.4 → W1.5 → W1.6, release; W2.1 → W2.2 → W2.3, W2.4 → W2.5 → W2.6, release;
wave 3 (Steam Deck access needed); wave 4; wave 5 alongside waves 3 and 4; G1–G4; 1.0.

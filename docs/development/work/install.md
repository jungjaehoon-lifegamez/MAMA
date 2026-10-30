# Install command (1.0 W2.4)

Rows I1, I4 and I5 of [v1.md](v1.md); plan [W2.4](v1-plan.md#w24-install-command-i1-i4-i5). Code
read at `17dcbcafb`. `s/` is `packages/standalone/src`. Vendor pages were read on 2026-10-30
([Sources](#sources)).

## Why

A person installs Node, runs `npm install -g`, installs and signs in a backend, then runs
`mama init` (I1). `start.sh` pins whatever Node ran init (`s/cli/commands/service.ts:161`), so an
upgrade or an nvm switch can still break the service. Nothing says how to get `gws` (I4) or which
versions are supported (I5).

## What the script makes

| Path                                                  | What                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `~/.mama/node`                                        | The Node.js 22 release the script pins, unpacked from the official `.tar.gz`    |
| `~/.mama/npm`                                         | npm's global prefix for MAMA: `lib/node_modules/@jungjaehoon/mama-os`, `bin/`   |
| `~/.mama/bin/mama`                                    | A two-line wrapper: `exec` the managed Node on the package's CLI, by full paths |
| A marked block in the login shell's startup file      | Puts `~/.mama/bin` (and `~/.local/bin` when a backend went there) first on PATH |
| `/var/lib/mama/<user>` (Linux only, with `sudo` once) | The parent of the default `member_root` and `tools_root`                        |

- `start.sh` runs `~/.mama/node/bin/node` on the prefix's `dist/cli/index.js`. `installKind` reads
  that as `npm` at `~/.mama/npm` (`s/cli/runtime/install-kind.ts:56-57`); `mama update` runs
  `~/.mama/node/bin/npm` with that prefix (`s/cli/commands/update.ts:172,549`) and renames inside
  its scope folder (`s/cli/runtime/update-journal.ts:130-139`), never touching Node.
- The wrapper: the bin starts with `#!/usr/bin/env node` (`s/cli/index.ts:1`). On a clean account
  no `node` is on PATH, so npm's link cannot run at all; with another Node first, a later
  `mama service install` would pin that Node. The person's own `node` and `npm` stay first.
- The path has no version folder: `stableNodePath` keeps it (`s/cli/launch-files.ts:24-36`) and
  doctor's `versionedNodePath` warning stays off (`:39-43`).
- `umask 077` first: init makes the home 0700 only when it creates it (`s/cli/commands/init.ts:506`).
  Init refuses only on `config.yaml`, `connectors.json` and `start.sh` (`init.ts:390-393,427-430`).

## Node

- The pin is `packages/standalone/install/node.json`: the version (22.23.4 today) and the SHA-256
  of the four `.tar.gz` files (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`; fresh
  Linux images may lack `xz`). `install` joins the package's `files` (`package.json:41-48`), and
  `scripts/sync-versions.js` writes the same values into `install.sh`.
- CI's `node-version: '22'` floats (`.github/workflows/ci.yml:47`, `release.yml:55`); the
  `install-check` leg is what runs the pinned Node.
- The script downloads from `nodejs.org/dist/v<version>/`, checks the hash (`shasum -a 256` or
  `sha256sum`), unpacks into `~/.mama/node.<pid>.tmp` and renames it into place. A wrong hash
  deletes the download and exits 1, naming both. No `gpg` on the person's machine.
- `node-pin` in CI verifies `SHASUMS256.txt.asc` with `gpgv` against `nodejs/release-keys` at a
  pinned commit (`481637f8`, 2026-09-01) and fails if `node.json` differs.

## Moving the managed Node

`mama update` runs npm only, and Node 22 ends on 2027-04-30. Running the install command again on a
script-made install moves Node when the script's pin differs. The script downloads and checks the
new Node into `~/.mama/node.new`, then runs `~/.mama/bin/mama update --node ~/.mama/node.new`,
because the boot wait and doctor's Node check are TypeScript. That command, like the update's
parent, uses only code it has loaded once the folders move:

1. `runtime/update.lock` (`acquireInstallLock`, `s/cli/runtime/daemon-control.ts:118`), so no
   update or second move runs beside it. Journal `runtime/node-move.json` (0600): phase, old and
   new Node versions, and the step last begun. The update journal does not fit: its fields are a
   package's versions, snapshot and schema (`s/cli/runtime/update-journal.ts:30-69`).
2. On a major change, copy `~/.mama/npm` to `~/.mama/npm.new` and run the new npm's
   `rebuild -g --prefix` on it, before any stop. The SQLite module is built for one major
   (`s/cli/runtime/diagnostics.ts:557-583`). A copy, because a rollback needs the old prefix
   untouched; a rebuild, not a reinstall, because the published core range is a caret
   (`release.yml:285`; 0.78.0 depends on `^8.8.0`), so a reinstall could bring a newer core.
3. `mama stop` (it drains, #533), then `runtime/update.hold`, which `start.sh` honours
   (`s/cli/launch-files.ts:54`), so a reboot mid-move starts nothing. Renames, in this order:
   `node` → `node.old`, `node.new` → `node`, then (major only) `npm` → `npm.old`,
   `npm.new` → `npm`. `start.sh` is unchanged, since the paths stay.
4. Doctor's Node check under the new Node; remove the hold; `mama service start`; `waitForBoot`
   (`init.ts:294`). Then `phase: committed`, the `.old` folders deleted, the journal closed. A
   failure before `committed` renames back, removes the hold, starts the old Node and exits 1.

A run killed midway leaves the journal and the hold. The script checks for them before anything
else, in plain `sh`, since `~/.mama/npm` may be missing then: at `committed` it deletes the `.old`
folders; otherwise it renames each `.old` back over whatever is in its place, removes the hold
and starts the service. It then says the move was undone, and a further run tries again. Doctor
reports an open `node-move.json` and says to run the install command again.

`mama update` reads the new package's `install/node.json`; when it differs from the running Node,
`finishCommitted` (`update.ts:910`) ends the report with "run the install command again", and
doctor's Node check (`diagnostics.ts:537`) warns the same. A target whose `engines` excludes the
running Node is refused at step 2, before any change.

## Backend CLI

- The script asks for `claude` or `codex`, or takes `--backend`. When `command -v` finds it,
  nothing is installed; init checks its version and login (`s/cli/commands/init-questions.ts:223-255`).
- Otherwise it runs the vendor's documented installer, into `~/.local/bin`:
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`.
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, always with
    `CODEX_NON_INTERACTIVE=1` and `CODEX_HOME` unset. On a terminal its "Start Codex now?" prompt
    starts Codex on `~/.codex`, not MAMA's managed home (`init-questions.ts:231`).
- `~/.local/bin` joins PATH before init: init and `service install` find the backend there
  (`init-questions.ts:229`, `service.ts:154-159`), and `start.sh` carries its folder
  (`launch-files.ts:102-118`).
- Init refuses a signed-out backend today (`init-questions.ts:252-254`). On a terminal it now runs
  the login it names (`:231`), attached to the terminal, then probes again; `--non-interactive`
  still refuses. Sign-in is then init's only backend step (B1).

## Linux

- One `sudo` call, shown first and asked once:
  `sudo sh -c 'umask 022; install -d -m 0755 /var/lib/mama; install -d -o <user> -m 0700 /var/lib/mama/<user>; loginctl enable-linger <user>'`.
  `sudo` keeps the caller's umask 077, so without `umask 022` the parent would be 0700 and
  `prepareRoot` would fail (`s/cli/runtime/default-roots.ts:46-59`). Root-owned at 0755 it passes
  `assertRootAncestors` (`s/runtime/tools-paths.ts:25-42`); init makes `members/` and `tools/`
  (`default-roots.ts:27`). Linger is what init tries and only reports (`init.ts:634-644`). The
  member temp roots sit under `/tmp` (`s/runtime/backend-security.ts:35,37`).
- W2.4 assumes Ubuntu 24.04: glibc, systemd user units, a writable `/var`, `sudo` for the person.
  Wave 3 measures SteamOS (L5) and confirms each, and owns `bwrap`, `socat` and LibreOffice (L2,
  I3); the script installs no system packages.

## How it is delivered and run

- `create-release` attaches `install.sh` (`release.yml:490`). The documented command:

  ```sh
  curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh
  ```

- `MAMA_OS_VERSION=` and the pin are written by `sync-versions.js`, which the release and the
  pre-commit hook run (`release.yml:127`, `.husky/pre-commit:51-52`); no CI step runs `--check`.
  So `create-release` refuses a script whose version is not the tag's, and waits until
  `npm view @jungjaehoon/mama-os@<version> version` answers before it uploads.
- The body is one function called on the last line, so a cut-off download runs nothing.
- The question and init read `/dev/tty` (init requires a terminal, `init.ts:376`). Without one
  the script needs `--backend` and `--non-interactive` (init reads `MAMA_INIT_*`, `init.ts:240-288`)
  or `--no-init`, which prints the init command. No secret goes through the script or its flags.
- npm and init run by full path with `~/.mama/node/bin` first on PATH, as `npmEnvironment` does
  (`update.ts:181-186`). npm honours `npm_config_registry`; the script has no registry flag.
- Startup block, by `$SHELL`: zsh `~/.zshrc`; bash `~/.bashrc` on Linux, `~/.bash_profile` on macOS
  (or `~/.profile` when only that exists); fish: the `fish_add_path` line is printed, nothing
  written; other `~/.profile`. Each run rewrites the text between `# >>> mama >>>` and
  `# <<< mama <<<`.

| On a run, when                                                             | The script                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `~/.mama/runtime/node-move.json` exists                                    | Finishes or undoes that move first, as above                                                                 |
| `~/.mama/config.yaml` or `start.sh` exists and `~/.mama/npm` holds no MAMA | Refuses before any change: another install owns this account; `mama update --dry-run` shows how it updates   |
| `~/.mama/config.yaml` exists and `~/.mama/npm` holds MAMA                  | Moves Node if the pin differs, then runs `mama init`, which resumes (`init.ts:415-423`) or says it is set up |
| No setup yet, `~/.mama/node` has the pinned version                        | Skips Node                                                                                                   |
| No setup yet, `npm ls -g --prefix ~/.mama/npm` shows the script's version  | Skips the package; another version is reinstalled                                                            |
| `command -v mama` names another program                                    | Names it, and says the startup block puts the wrapper first                                                  |

## PR 1: `install.sh` and its CI leg

- `packages/standalone/install/install.sh`, POSIX `sh`, `set -eu`: an unfinished Node move;
  refusal checks; platform
  (macOS or Linux, x64 or arm64, else exit 1); the Linux `sudo` call; Node;
  `npm install -g --prefix ~/.mama/npm @jungjaehoon/mama-os@<version>`; the wrapper; the backend;
  the startup block; `mama init </dev/tty`.
- `install/node.json`; `sync-versions.js` writes the script; the pre-commit hook stages it with the
  READMEs; `create-release` checks, waits and uploads.
- CI job `install-check`, macOS and Ubuntu, each with a fresh `HOME`:
  1. `node-pin` (Ubuntu).
  2. verdaccio (moved from `packages/standalone/scripts/upgrade-check/update.mjs:36` into a shared
     module) serves this build. `install.sh --backend codex --no-init` runs with
     `npm_config_registry` and `npm_config_node_gyp=/bin/false`, so the prebuilt native binaries
     must cover the platform. Ubuntu: `/var/lib/mama` is 0755, the user's folder 0700.
  3. The package's init under the managed Node, with `writer.mjs`'s answers and stub backend; then
     `~/.mama/bin/mama service install` through `fake-service.cjs` with setup-node first on PATH.
     `start.sh` names `~/.mama/node/bin/node`; `installKind` is `npm` at `~/.mama/npm`; doctor's
     Node check is `ok`; `mama update --dry-run` shows N → N+1.
  4. A second run changes no file; a run cut off after Node skips it next time; a truncated
     script runs nothing.
  5. The whole script, with a `curl` stub first on PATH that serves a Node file with another
     hash, exits 1 and unpacks nothing.
  6. Each vendor installer as the script runs it, with no terminal, meets
     `s/cli/runtime/backend-probe.ts:8-11`.
- `shellcheck` in lint; shell tests: each shell's block, rewritten in place; a username outside
  `default-roots.ts:22`'s pattern refused before `sudo`; no `sudo` on macOS.

## PR 2: `mama` around the managed program

- [Moving the managed Node](#moving-the-managed-node): `mama update --node <folder>`, the
  script's recovery, and two changes to `mama update` itself (the pin note and the `engines`
  refusal at step 2). Tests: a patch pin swaps Node only; a major pin rebuilds the copy; a failed
  boot puts both back; the command killed after each step leaves a journal and a hold that a
  re-run of the script finishes or undoes, and `start.sh` exits at once meanwhile; a second move
  or an update beside it is refused by the lock; `mama update` and doctor name the pin; a target
  whose `engines` excludes the Node is refused.
- Backup keeps an allowlist (`s/cli/runtime/backup.ts:76,84`), so the program was never archived;
  only its "left out" line goes (`backup.ts:345-358`, `s/cli/commands/backup.ts:200-201`). Restore
  switches only archived entries (`s/cli/runtime/restore.ts:702-745`).
- `mama uninstall` (`s/cli/commands/uninstall.ts:1-9`, "the program is an npm package, which npm
  removes"): with `--data` the plan lists the managed program and removes it with the home, last;
  without it the program stays and is named. Both print the startup block to remove.
- Init: the only backend on PATH is the default answer (`init-questions.ts:345`); the login run of
  [Backend CLI](#backend-cli); "already set up" also names `mama update` (`init.ts:419-422`).
- `service install`: for an npm install, `start.sh`'s PATH also names `<prefix>/bin`
  (`launch-files.ts:102-118`), where npm puts commands installed beside MAMA.

## PR 3: tools a source needs (I4)

- A source names its tool with `type: 'cli'` (`s/connectors/gmail/index.ts:68-77`, and calendar,
  drive, sheets). gws's requirement, with its install methods, moves to one export in
  `s/connectors/framework/gws-utils.ts`.
- One helper returns, for the sources being enabled, each tool missing from the service's PATH
  with its methods and login. Callers: `mama init` (`init.ts:578-581`, a fixed name set today,
  `init-questions.ts:42`), `init --section connectors` (`s/cli/commands/init-section.ts:188-189`,
  login only today) and doctor's fix (`diagnostics.ts:787-811`). It reports and never refuses.
- gws is a Node script (`bin` `run.js`, `postinstall` `node install.js`, 0.22.5), so for a
  script-made install the printed commands carry the managed Node; the command then is on
  `start.sh`'s PATH (PR 2). Other installs get `npm install -g @googleworkspace/cli` or
  `brew install googleworkspace-cli`.

  ```sh
  PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/node/bin/npm install -g --prefix ~/.mama/npm @googleworkspace/cli
  PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/npm/bin/gws auth login
  ```

- Tests: each caller with gws missing, on the shell's PATH only, and on the service's. The CI leg
  runs both commands with no other Node on PATH.

## PR 4: docs (I1, I5)

- `docs/start/owner-setup.md`: the command, what it makes and asks, Linux's `sudo`, moving Node,
  and **Supported versions**:

  | What        | Supported                              | Source                                         |
  | ----------- | -------------------------------------- | ---------------------------------------------- |
  | Node.js     | the script's pin (22.x)                | `install/node.json`, the `install-check` leg   |
  | Own Node    | 22.13 or newer (npm installs)          | `engines` (`package.json:38-40`)               |
  | Claude Code | 2.1.299 or newer                       | `backend-probe.ts:8-11`                        |
  | Codex       | 0.160.1 or newer                       | `backend-probe.ts:8-11`                        |
  | macOS       | the version the clean-account run used | its checks entry; Claude Code itself needs 13+ |
  | Linux       | set by wave 3 (L5)                     | wave 3's checks entry                          |
  | Docker      | set by wave 4                          | wave 4's checks entry                          |

- README "Getting started", `docs/start/tutorial.md:19`, `docs/reference/cli.md:30,173`,
  `packages/standalone/README.md:8,14`, the release notes (`release.yml:469-481`): the command
  first, `npm install -g` for a person who keeps their own Node. `docs/guides/connectors.md:43-44`:
  PR 3's methods.
- The `mama-install` skill runs the command with `--backend <choice> --no-init` (Claude Code's Bash
  has no terminal), then the owner runs `mama init` in their own. Its test moves with it
  (`packages/claude-code-plugin/tests/skills/mama-install-skill.test.js:22`).

## Live proof

- **The clean macOS account** (W2.3's candidate proof and B2 need it too):
  1. verdaccio serves candidate N, named in the account's `~/.npmrc` (removed after), because
     `mama update` reads npm's config (`update.ts:553`). `install.sh` from the PR installs Node, N
     and the backend; init signs in, pairs the test bot and starts the service; the DM gets a reply.
     Checks entry: steps, minutes, every place the docs were left.
  2. `mama doctor` is clean; `start.sh` names the managed Node; status shows the npm kind.
  3. A member session's shell runs `node --version`. Members are denied HOME
     (`s/runtime/backend-security.ts:75`) and take the daemon's PATH
     (`s/runtime/native-session.ts:231`), so the managed Node may be unreadable there; a refusal
     becomes a new row.
  4. W2.3's candidate proof, which needs only PR 1–2: N → N+1; the backend signed out, then
     `/update` (R7); N+2 rolls back.
  5. A re-run with another patch pin moves Node, and the service comes back. A move killed after
     its first rename, then a reboot, starts nothing; the next run undoes it.
  6. After PR 3: Gmail enabled without gws names the commands; run as printed, doctor passes.
- **After the release:** W2.3's registry update; then `mama uninstall --data`, the backend removed
  by its vendor's steps, and the published command against npmjs to a DM reply.
- **Wave 3:** the same run on the Linux host L5 settles.

## Done when

- **I1 (macOS):** on the clean account, the published command takes a person from no MAMA and no
  backend to a DM reply with only the sign-in, the bot token and pairing typed; `start.sh` pins
  `~/.mama/node/bin/node`. Linux closes with wave 3, Docker with wave 4.
- **I4 (the command part):** enabling a Google source without gws prints commands that work, in
  init, `--section` and doctor; the image half is wave 4's.
- **I5 (Node, backend, macOS rows):** the guide lists them with sources, and the run used those.

## Failure modes

| Failure                                        | Handling                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| npm install fails (network, registry, a build) | npm's code shown; `~/.mama/npm` left for the re-run, which reinstalls |
| The vendor installer fails                     | Its output shown, exit 1; the vendor's page named                     |
| `sudo` refused or missing (Linux)              | The command printed; init then offers other folders                   |
| Moving Node fails to boot                      | The old folders back and started, exit 1                              |
| A Node move is killed midway                   | The hold keeps it stopped; the next run finishes or undoes the move   |
| The toolkit cannot install on a fresh Mac      | Init goes on without it (`init.ts:605-611`); see I7                   |

## Order of work

PR 1 → PR 2 → the clean-account run's steps 1–5 (W2.3's candidate proof among them) → PR 3 → PR 4
→ step 6 → the wave 2 release → the post-release runs → I1, I4 and I5 marked for macOS in v1.md,
evidence in checks.md.

## Plan corrections

- W2.4's Docker sentence belongs to wave 4: no image exists (D1) and G4 forbids offering a command
  that has not run. I1's and I4's Docker halves close there, on `mama init --non-interactive`.
- I5 closes with waves 3 and 4, which fill the Linux and Docker rows.
- W2.3's `mama update` changes in PR 2: it has no `engines` check today, and it gains the
  `--node` move and the pin note.
- "So `mama init` only signs it in" is not true today (`init-questions.ts:252-254`); PR 2 makes it.
- New row I7: the macOS toolkit runs `brew install` and needs python3 3.10 or newer
  (`s/tools/document-toolkit.ts:292-300,397-405`). An account without its own Homebrew cannot
  install it. The script does not install Homebrew, a machine-wide manager; the clean-account run
  records what happens.

## Open owner decisions

None: the code, the plan and the rules settle each choice. The clean macOS account and its test bot
are owner actions already needed by B2 and W2.3.

## Sources

All read 2026-10-30.

- https://code.claude.com/docs/en/setup
- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/config-file/environment-variables
- https://github.com/openai/codex
- https://chatgpt.com/codex/install.sh (`prompt_yes_no`, `CODEX_NON_INTERACTIVE`, `CODEX_HOME`)
- https://github.com/googleworkspace/cli; https://registry.npmjs.org/@googleworkspace/cli/latest
- https://nodejs.org/dist/latest-v22.x/
- https://github.com/nodejs/node#verifying-binaries; https://github.com/nodejs/release-keys
- https://github.com/nodejs/Release

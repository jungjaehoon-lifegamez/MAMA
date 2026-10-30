# Install command (1.0 W2.4)

Rows I1, I4 and I5 of [v1.md](v1.md); plan [W2.4](v1-plan.md#w24-install-command-i1-i4-i5). Code
read at `17dcbcafb`, revised at `4b25f4b45` for the owner decision of 2026-10-30. Line numbers in
the sections that describe built work (What the script makes, Node, Moving the managed Node, PR
1–3) are from `17dcbcafb`; the rest cite `4b25f4b45`. `s/` is `packages/standalone/src`. Vendor
pages were read on 2026-10-30 ([Sources](#sources)). Measurements and reasons:
[install-notes.md](install-notes.md).

## Why

A person installs Node, runs `npm install -g`, installs and signs in a backend, then runs
`mama init` (I1). `start.sh` pins whatever Node ran init (`s/cli/commands/service.ts:161`), so an
upgrade or an nvm switch can still break the service. Nothing says how to get `gws` (I4) or which
versions are supported (I5).

Owner, 2026-10-30: the person's agent (Claude Code or Codex) installs MAMA through conversation,
and the person never touches a terminal. The bot token goes the existing way: as
`MAMA_TELEGRAM_TOKEN` into init's environment, then into `~/.mama/auth.env` (0600).

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

- The script takes `--backend claude|codex` and asks nothing. A backend that `command -v` finds
  counts only when `<path> --version </dev/null` exits 0 and prints a version (finding A). Otherwise
  the vendor's documented installer runs, into `~/.local/bin`:
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`.
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, always with
    `CODEX_NON_INTERACTIVE=1` and `CODEX_HOME` unset. On a terminal its "Start Codex now?" prompt
    starts Codex on `~/.codex`, not MAMA's managed home (`init-questions.ts:246-247`).
- `~/.local/bin` joins PATH before init: init and `service install` find the backend there
  (`init-questions.ts:245`, `service.ts:153-154`), and `start.sh` carries its folder
  (`launch-files.ts:102-118`).
- Init signs nothing in. It refuses a missing, old or signed-out backend before writing anything
  (`init-questions.ts:238-292`), naming the login with the backend's full path. The agent runs that
  login in the background, gives the person its URL and code, then runs the install command
  again.

| Installing agent | Backend | Sign-in                                                                                                                                                                                                     |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | claude  | None: the account's Claude login is the one the installer uses; `claude auth status --json` reads it from an agent's shell ([notes](install-notes.md#backend-sign-in-measured))                             |
| Claude Code      | codex   | The managed home: `CODEX_HOME=~/.mama/.codex <codex> login` (opens the browser on this machine) or `login --device-auth` (prints a page and a code; the person turns on device code login in ChatGPT first) |
| Codex            | codex   | The same: Codex's own `~/.codex` login is not MAMA's (`init-questions.ts:234`)                                                                                                                              |
| Codex            | claude  | `claude auth login` from Codex's shell; it starts and prints its URL without a terminal, and whether it completes is measured in leg C ([Live proof](#live-proof)); if it does not, Q2                      |

## Linux

- One `sudo` call, shown first and asked once:
  `sudo sh -c 'umask 022; install -d -m 0755 /var/lib/mama; install -d -o <user> -m 0700 /var/lib/mama/<user>; loginctl enable-linger <user>'`.
  `sudo` keeps the caller's umask 077, so without `umask 022` the parent would be 0700 and
  `prepareRoot` would fail (`s/cli/runtime/default-roots.ts:46-59`). Root-owned at 0755 it passes
  `assertRootAncestors` (`s/runtime/tools-paths.ts:25-42`); init makes `members/` and `tools/`
  (`default-roots.ts:27`). Linger is what init tries and only reports (`init.ts:634-644`). The
  member temp roots sit under `/tmp` (`s/runtime/backend-security.ts:35,37`).
- In an agent's shell `sudo` has no terminal to ask the password on (`install.sh:210` runs it
  `</dev/null`), so it runs only where no password is asked; otherwise the script prints the
  command. How a person runs it without a terminal is wave 3's (L5).
- W2.4 assumes Ubuntu 24.04: glibc, systemd user units, a writable `/var`, `sudo` for the person.
  Wave 3 measures SteamOS (L5) and confirms each, and owns `bwrap`, `socat` and LibreOffice (L2,
  I3); the script installs no system packages.

## How it is delivered and run

- `create-release` attaches `install.sh` (`release.yml:490`). The command, which the agent runs:

  ```sh
  curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh -s -- --backend claude --non-interactive
  ```

- `MAMA_OS_VERSION=` and the pin are written by `sync-versions.js`, which the release and the
  pre-commit hook run (`release.yml:127`, `.husky/pre-commit:51-52`); no CI step runs `--check`.
  So `create-release` refuses a script whose version is not the tag's, and waits until
  `npm view @jungjaehoon/mama-os@<version> version` answers before it uploads.
- The body is one function called on the last line, so a cut-off download runs nothing.
- No terminal is read. A new install needs `--backend` and either `--non-interactive` (init reads
  `MAMA_INIT_*` and `MAMA_TELEGRAM_TOKEN`) or `--no-init`, which prints the init command. A set-up
  install needs no flag and keeps accepting these, so the bare command that `mama update`, doctor
  and status print
  (`s/cli/runtime/node-move-journal.ts:61-62`) runs as is.
- Init gets `MAMA_INIT_BACKEND` from `--backend`. `MAMA_TELEGRAM_TOKEN` reaches init through the
  environment only, never a flag, and npm and the vendor installers run without it.
- npm and init run by full path with `~/.mama/node/bin` first on PATH, as `npmEnvironment` does
  (`update.ts:181-186`). npm honours `npm_config_registry`; the script has no registry flag.
- Startup block, by `$SHELL`: zsh `~/.zshrc`; bash `~/.bashrc` on Linux, `~/.bash_profile` on macOS
  (or `~/.profile` when only that exists); fish: the `fish_add_path` line is printed, nothing
  written; other `~/.profile`. Each run rewrites the text between `# >>> mama >>>` and
  `# <<< mama <<<`. The agent's shell does not read it, so the agent uses full paths.

| On a run, when                                                             | The script                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.mama/runtime/node-move.json` exists                                    | Finishes or undoes that move first, as above                                                                                                  |
| `~/.mama/config.yaml` or `start.sh` exists and `~/.mama/npm` holds no MAMA | Refuses before any change: another install owns this account; `mama update --dry-run` shows how it updates                                    |
| `~/.mama/config.yaml` exists and `~/.mama/npm` holds MAMA                  | Needs no flag; moves Node if the pin differs, then runs `mama init --non-interactive`, which resumes (`init.ts:415-423`) or says it is set up |
| No setup yet, `~/.mama/node` has the pinned version                        | Skips Node                                                                                                                                    |
| No setup yet, `npm ls -g --prefix ~/.mama/npm` shows the script's version  | Skips the package; another version is reinstalled                                                                                             |
| `command -v mama` names another program                                    | Names it, and says the startup block puts the wrapper first                                                                                   |

## PR 1: `install.sh` and its CI leg (merged, #538)

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

## PR 2: `mama` around the managed program (merged, #539)

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
- Init: the only backend on PATH is the default answer (`init-questions.ts:345`); the terminal
  sign-in, which PR 5 takes out of the whole setup again; "already set up" also names
  `mama update` (`init.ts:419-422`).
- `service install`: for an npm install, `start.sh`'s PATH also names `<prefix>/bin`
  (`launch-files.ts:102-118`), where npm puts commands installed beside MAMA.

## PR 3: tools a source needs (I4)

In progress on `feat/source-tools`, by another worker.

- A source names its tool with `type: 'cli'` (`s/connectors/gmail/index.ts:68-77`, and calendar,
  drive, sheets). gws's requirement, with its install methods, moves to one export in
  `s/connectors/framework/gws-utils.ts`.
- One helper returns, for the sources being enabled, each tool missing from the service's PATH
  with its methods and login. Callers: `mama init` (`init.ts:578-581`, a fixed name set today,
  `init-questions.ts:42`), `init --section connectors` (`s/cli/commands/init-section.ts:188-189`,
  login only today) and doctor's fix (`diagnostics.ts:787-811`). It reports and never refuses;
  the enabling step refuses on its report (W2.4.5e).
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
- Under the agent (owner, 2026-10-30: a source and its tool are chosen in the conversation):
  - The whole setup's caller goes with `askAnswers` (W2.4.5c), since the connectors are `{}` under
    `--non-interactive` (`init.ts:286`). Whichever of PR 3 and PR 5 lands second drops that call.
  - `--section connectors` uses `sourceTools()` before it writes, and refuses; W2.4.5e lists the
    lines of this PR that change for that.
  - Doctor's lines, read from `mama doctor --json`'s `fix`, stay as written. They serve an enabled
    source whose tool has gone missing since.

## PR 5: setup through the person's agent

Each item ends with its done command. Each names its `## [Unreleased]` entry; the release
(release-process.md, step 2) relies on them.

- **W2.4.5a `install.sh` from an agent's shell.**
  - Remove the terminal mode: the `/dev/tty` probe, the backend question and
    `init </dev/tty >/dev/tty` (`install.sh:76-83,175-187,440-444`).
    - A new install needs `--backend` and `--non-interactive` or `--no-init`.
    - A set-up install (`config.yaml` present) needs no flag. Without `--backend` it skips the
      backend step and keeps `~/.local/bin` in the startup block when a backend is there; with it,
      the backend step runs as today. It runs `mama init --non-interactive` unless `--no-init` is
      given (`scripts/install-check/run.mjs:369` passes both flags).
  - A backend `command -v` finds counts only when `"$backend_path" --version </dev/null` exits 0
    and prints a version; otherwise the vendor installer runs, and the installed one must pass the
    same check (`install.sh:334-371`).
  - Init gets `MAMA_INIT_BACKEND=$backend` (`install.sh:438`). A different `MAMA_INIT_BACKEND`
    already in the environment is refused.
  - npm and the vendor installers run with `MAMA_TELEGRAM_TOKEN` unset.
  - The Linux lines that say init asks for or offers other folders (`install.sh:201,213`) name
    `MAMA_INIT_MEMBER_ROOT` and `MAMA_INIT_TOOLS_ROOT` instead, since no question is left.
  - Tests in `tests/cli/install-script.test.ts`:
    - a `claude` first on PATH that exits 127 makes the vendor installer run;
    - a set-up install with no flags runs init;
    - the token is absent from a stub vendor installer's environment;
    - `--backend codex` with `MAMA_INIT_BACKEND=claude` is refused;
    - the "without a terminal" case is rewritten.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the install script asks
    nothing and runs from an agent's shell. A found backend must run before the installer is
    skipped. A set-up install needs no flags.
  - Done: `cd packages/standalone && npx vitest run tests/cli/install-script.test.ts && cd ../.. && pnpm lint:sh`.

- **W2.4.5b Pairing from the conversation.** Only `ask`'s input and three lines of text change in
  `telegram-pairing.ts`.
  - `environmentAnswers` (`init.ts:245-293`) drops `MAMA_INIT_COMMON_CHAT_ID` and
    `MAMA_INIT_OWNER_TELEGRAM_ID` (`:263`, `:283`). It follows `askAnswers`' order:
    - the backend;
    - `checks.telegram(token)` with no chat (`:264`);
    - the folders;
    - `checks.pair(token)` last (`:215-218`).
  - `checks.pair` (`init.ts:490-513`) is reused; its `ask` (`:497`) becomes a file reader.
    - Init makes a folder with `mkdtemp` under the OS temp folder (0700) and prints the file to
      write, `<folder>/code`.
    - Every second, `ask` treats a missing or empty file as not yet. It reads and unlinks a
      non-empty one and returns its trimmed text.
    - `ask` rejects once the signal aborts (`telegram-pairing.ts:98-99`). The folder is removed when
      init ends.
    - A wrong code gets `:163`'s line, and init waits for the file again.
  - `telegram-pairing.ts` text: `:106` names the file and says that a `/bind` sent early counts
    (`:110-121`); `:134` says "Give this code to the agent setting up MAMA."; `:163` drops "type".
  - Tests:
    - `tests/cli/onboarding.test.ts` runs `--non-interactive` pairing through the file:
      - a wrong code, then the right one;
      - `/bind` before the code, and after it;
      - a code the bot never sent does not count, and the owner is the sender whose code was
        written;
      - an abort while waiting;
      - no folder left afterwards.
    - `tests/cli/telegram-pairing.test.ts` keeps its cases, with the new text.
  - CI: `scripts/install-check/run.mjs:276-277` drops the two IDs. `managed.mjs`'s Telegram
    stand-in serves `getUpdates` (a private message, then `/bind` from the same sender) and
    `sendMessage`, takes the code from the DM it was asked to send and writes it to the file init
    printed.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`:
    - `### Changed`: `mama init --non-interactive` pairs the first owner and the common group
      through the bot. The code the bot sends is written to the file init names.
    - `### Removed`: `MAMA_INIT_OWNER_TELEGRAM_ID` and `MAMA_INIT_COMMON_CHAT_ID`.
  - Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts tests/cli/telegram-pairing.test.ts`, and CI `install-check` green on macOS and Ubuntu.

- **W2.4.5c The terminal setup goes** ([why, and the count](install-notes.md#the-terminal-setup-why-it-goes)).
  - Delete:
    - `askAnswers` (`init.ts:141-237`);
    - the whole setup's `requireTTY` and terminal prompt (`:380-381`);
    - its `signIn` option (`:85`, `:461`).

    Bare `mama init` then fails the usage check (`:367`, `:377-378`), which names `--non-interactive`
    and `--section`. The flag keeps its name, which the owner's decision, `install.sh` and the Docker
    plan use.

  - Relocate, each before its deletion:
    - The tunnel (`:186-214`): `--non-interactive` reads `MAMA_CF_ACCESS_ISSUER`,
      `MAMA_CF_ACCESS_AUD`, `MAMA_VIEWER_HOSTNAMES` and `MAMA_VIEWER_OWNER_EMAILS`, the names
      `start.sh` uses, with the same checks moved into one function.
    - Sources, Discord, Slack and Jev: `mama init --section` (B5, unchanged).
    - The sign-in: the agent runs the login that init names (`init-questions.ts:289-291`). The
      message carries the located binary's full path (`:245-247`).
    - Codex's managed home: `mkdirSync(codexHome)` (`:275-276`) moves out of the deleted branch, to
      just before that refusal, so the named login works.
    - The setup guide: `docs/start/owner-setup.md` gets "Set up through your agent" in place of "Run
      onboarding in your terminal" and the ID rows (`:36-62`, `:109-122`). This is the procedure
      both agents follow (Codex has no plugin):
      - what the person makes (a BotFather bot, a group);
      - the command and its variables, and how the token is handed over;
      - the sign-in table above;
      - running in the background, the pairing relay, and running again;
      - done when MAMA answers. It lands here because the live run's agent reads it from `main`.
  - `terminalSignIn` stays for `--section model` (`init-section.ts:96-101`).
  - Tests: the `runInit([])` cases in `onboarding.test.ts` (35 calls) move to the environment
    answers. A case that tests a question only the deleted path asked goes. A tunnel case is added.
    The `--section` cases stay.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Removed`: the interactive whole
    setup. `mama init --non-interactive` is the setup, run by the person's agent (owner-setup.md).
    The tunnel settings are read from the environment.
  - Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts && pnpm typecheck`;
    `grep -n "askAnswers\|requireTTY" src/cli/commands/init.ts` prints nothing.

- **W2.4.5d The mama-install skill and its test.**
  - `packages/claude-code-plugin/skills/mama-install/SKILL.md` drops "Never ask for a token, key or
    password in the conversation" and "the owner runs it in their own terminal". It says plainly:
    a token given in this conversation reaches the model provider and this agent's transcript.
  - Then, briefly, with owner-setup.md as the procedure:
    1. Ask which backend (yourself unless the person picks the other) and which model.
    2. Take the token. Write it into a 0600 file with a short command; the install command loads
       it, because a long command's text stays in `ps` ([notes](install-notes.md#the-agents-shell)).
    3. Start the install in the background, with its output in a file.
    4. Pass on the sign-in and pairing lines, and write the code where init says. Codex's device
       page warns to cancel a code "another person gave you"; say that this code comes from the
       login the agent started on the person's machine.
    5. After a sign-in, run the same install command again. Use full paths.
    6. The setup is done when MAMA answers the person's message.
  - Sources are chosen in the conversation. The tool is installed with its printed command, the
    person completes its login in the browser, and only then is the source enabled with the
    non-interactive section (W2.4.5e). The Jev paragraph says Jev is turned on later with
    `mama init --section jev` (Q1).
  - `tests/skills/mama-install-skill.test.js:32-39` asserts:
    - the transcript sentence;
    - no "own terminal";
    - `--non-interactive`;
    - the guide link and "MAMA answers" stay.
  - `packages/claude-code-plugin/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the skill installs
    MAMA OS through the conversation. The plugin's `package.json` and `.claude-plugin/plugin.json`
    move together at the release.
  - Done: `cd packages/claude-code-plugin && npx vitest run tests/skills/mama-install-skill.test.js`.

- **W2.4.5e A source enabled from the conversation** (after PR 3). The person chooses the source
  in the conversation. The agent then:
  1. installs the tool with the command `sourceTools()` gives (on a script-made install, the
     managed-Node `npm install --prefix ~/.mama/npm`);
  2. has the person complete the tool's login in the browser;
  3. enables the source.

  Enabling with the tool missing must not be possible: a Google source's `init()` runs
  `gws --version` (`s/connectors/gmail/index.ts:46-53`), and boot rethrows its failure
  (`s/runtime/connectors.ts:236-240`, `s/cli/commands/daemon.ts:1308-1323`), so MAMA would not
  start.
  - `mama init --section connectors --non-interactive` takes `MAMA_INIT_CONNECTORS`: a JSON object
    of connector blocks in `connectors.json`'s own shape (`s/connectors/framework/types.ts`), the
    shape `collectConnectors` builds. It takes each block's token from the variable its
    `auth.tokenName` names, and Slack's app token from `MAMA_SLACK_APP_TOKEN`.
    `requireTTY` (`init-section.ts:64`) applies to every other section and form. The staging, boot's
    `planConnectors` check and the renames (`:170-192`) are reused.
  - Before anything is written, `sourceTools()` (PR 3, `s/cli/runtime/source-tools.ts`, `gwsTool`)
    runs over the new blocks against the service's PATH (`serviceSight`). A tool the service
    cannot find refuses the section, and nothing is saved. The terminal form refuses the same way:
    one rule for enabling.
  - PR 3's lines that change for this:
    - `--section connectors` prints `sourceToolLines` after the save (PR 3's `init-section.ts:194`).
      They move before the write. The missing-tool form says nothing was saved, then gives the
      install command, the login, and "then run this again".
    - The shell-only form ends "mama service install adds it; mama service restart then applies
      it". The section runs with MAMA stopped, so it becomes "mama service install adds it; then
      run this again".
    - The login line is bare `gws auth login` with the scopes in prose. It names them in the
      command, `gws auth login -s <services>`, the flag gws documents for narrowing its scope
      picker. Each Google source's `type: 'cli'` requirement names its gws service.
    - The whole setup's caller goes (W2.4.5c). PR 3's doctor lines stay.
  - Doctor's token fix is `mama secret set` (`diagnostics.ts:174-178`), which needs a terminal. For
    a source token, the agent runs this section again with the variable set; the fix names that.
  - Tests in `onboarding.test.ts`:
    - Gmail with gws on the service's PATH is enabled;
    - with gws only on the shell's PATH, or nowhere, the section is refused and `connectors.json`
      is unchanged;
    - a Notion block takes `MAMA_NOTION_TOKEN` into `auth.env`;
    - a block boot would refuse is refused;
    - the terminal form refuses a missing tool too.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Added`:
    `mama init --section connectors --non-interactive` reads `MAMA_INIT_CONNECTORS`, and a source
    whose tool the service cannot find is no longer enabled (both forms).
  - Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts tests/cli/doctor.test.ts`.

## PR 4: docs (I1, I5)

- `docs/start/owner-setup.md`, beside PR 5's setup section: what the script makes, Linux's `sudo`,
  moving Node, and **Supported versions**:

  | What        | Supported                              | Source                                         |
  | ----------- | -------------------------------------- | ---------------------------------------------- |
  | Node.js     | the script's pin (22.x)                | `install/node.json`, the `install-check` leg   |
  | Own Node    | 22.13 or newer (npm installs)          | `engines` (`package.json:38-40`)               |
  | Claude Code | 2.1.299 or newer                       | `backend-probe.ts:8-11`                        |
  | Codex       | 0.160.1 or newer                       | `backend-probe.ts:8-11`                        |
  | macOS       | the version the clean-account run used | its checks entry; Claude Code itself needs 13+ |
  | Linux       | set by wave 3 (L5)                     | wave 3's checks entry                          |
  | Docker      | set by wave 4                          | wave 4's checks entry                          |

- Each of these says what to tell the agent first, then `npm install -g` for a person who keeps
  their own Node:
  - README "Getting started";
  - `docs/start/tutorial.md:19`;
  - `docs/reference/cli.md:15,30,83-84,173`, with the init variables, without the IDs and with the
    four viewer names;
  - `packages/standalone/README.md:8,14,20`;
  - the release notes (`release.yml:469-481`).
- `docs/guides/viewer.md:26`: the tunnel variables come from the environment. `docs/guides/connectors.md:43-44`:
  PR 3's methods.
- `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the package README and the
  install guide describe setup through the person's agent and list the supported versions.
- Done: `pnpm lint` and `pnpm exec prettier --check README.md docs packages/standalone/README.md`
  pass; `grep -rn "MAMA_INIT_OWNER_TELEGRAM_ID\|hidden prompt" README.md docs/start docs/reference packages/standalone/README.md`
  prints nothing.

## Live proof

**The clean macOS account**, a Standard account (W2.3's candidate proof and B2 need it too). Start
state:

- Claude Code is installed by its vendor and signed in by the person.
- The MAMA plugin comes from the candidate's marketplace.
- verdaccio serves candidate N, named in the account's `~/.npmrc` (removed afterwards), because
  `mama update` reads npm's config (`update.ts:583`).
- The test bot and its group exist.
- Homebrew's `node`, `codex` and an old `mama` are on this account's PATH, through
  `/etc/paths.d/homebrew`.

The steps:

1. **Leg A.**
   1. The person says "install MAMA" to Claude Code.
   2. The agent asks for the backend (`claude`, itself), the model and the bot token, then runs
      `install.sh` from the candidate in the background.
   3. The agent passes on the pairing lines. The person messages the bot, gives the agent the code,
      adds the bot to the group and sends `/bind`.
   4. Init starts the service, and the person's DM gets a reply.

   Checks entry: what the person typed, and where (conversation, Telegram, browser, terminal; the
   terminal count must be 0), the minutes taken, and every place the agent left the docs.

2. `mama doctor` is clean, and `start.sh` names the managed Node.
   - `start.sh`'s PATH has no per-terminal folder, such as a cmux shim's (finding A).
   - `mama update --dry-run` prints "(npm install, prefix ~/.mama/npm)" (`update.ts:664`).
   - The checks entry records which `claude` the run used.
3. A member session's shell runs `node --version`. Members are denied HOME
   (`s/runtime/backend-security.ts:75`) and take the daemon's PATH
   (`s/runtime/native-session.ts:231`), so the managed Node may be unreadable there; a refusal
   becomes a new row.
4. W2.3's candidate proof, which needs PR 1, PR 2 and PR 5: N → N+1; the backend signed out, then
   `/update` (R7); N+2 rolls back.
5. A re-run with another patch pin moves Node, and the service comes back.
   - The agent runs the install command as `mama update` prints it, with no flags.
   - A move killed after its first rename, then a reboot, starts nothing; the next run undoes it.
6. After W2.4.5e, the person asks for Gmail in the conversation, with no gws installed.
   - The agent's first `--section connectors --non-interactive` is refused with the install command
     and the login, and nothing is saved.
   - The agent installs gws as printed, and the person completes `gws auth login -s gmail` in the
     browser.
   - The section then enables Gmail, `mama doctor --json` passes, and `mama service start` boots
     with the source.
   - The checks entry says whether the gws login completed from the agent's shell, and whether gws
     needed an OAuth client set up first (`gws auth setup`).
   - The toolkit's `brew install` on this Standard account is recorded (I7).
7. **Leg B.** `mama uninstall --data` is run at a terminal (it needs one, `uninstall.ts:304`).
   Claude Code then installs with the `codex` backend. The managed home is signed in from the
   agent's background shell with `codex login`, or with `--device-auth` and device code login on.
8. **Leg C.** `mama uninstall --data` and `claude auth logout` are run. The person asks Codex to
   install MAMA by following owner-setup.md on `main` (W2.4.5c; Codex has no plugin), with the
   `claude` backend:
   - `claude auth login` from Codex's shell (Q2 if it cannot complete);
   - whether Codex's background run survives the turns of the pairing relay.

**After the release:** W2.3's registry update. Then `mama uninstall --data`, the backend removed
by its vendor's steps, and leg A against npmjs.

**Wave 3:** the same run on the Linux host that L5 settles, with the `sudo` step.

## Done when

- **I1 (macOS):** on the clean account, from "install MAMA" said to Claude Code, the person reaches
  a DM reply without typing anything in a terminal.
  - In the conversation they choose the backend and model, and give the bot token and the bot's
    pairing code.
  - In Telegram they make the bot and the group, message the bot, and send `/bind`.
  - In a browser they sign in a backend that is not the installing agent's.

  `start.sh` pins `~/.mama/node/bin/node`. Legs B and C reach the same reply, or leg C's result goes
  to Q2. Linux closes with wave 3, Docker with wave 4.

- **I4 (the command part):** enabling a Google source without gws is refused before anything is
  written, with commands that work. The agent runs them, the person logs in, and the section then
  enables the source and boot starts it. Doctor names the same commands for an enabled source whose
  tool went missing. The image half is wave 4's.
- **I5 (Node, backend, macOS rows):** the guide lists them with sources, and the run used those.

## Failure modes

| Failure                                                                      | Handling                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| npm install fails (network, registry, a build)                               | npm's code shown; `~/.mama/npm` left for the re-run, which reinstalls                                                                   |
| The vendor installer fails                                                   | Its output shown, exit 1; the vendor's page named                                                                                       |
| The backend `command -v` finds does not run (a shim, no real one)            | The vendor installer runs; the installed one must run, or exit 1                                                                        |
| A shim that forwards to a real backend elsewhere wins `command -v`           | `start.sh` names the shim's folder; init's real turn fails if the service cannot run it (`init.ts:706-709`); the live proof checks PATH |
| The backend is signed out                                                    | Init refuses before any write and names the login with the binary's path; the agent runs it, then the install command again             |
| Device code login is off, or its code expires (15 min)                       | `codex login --device-auth` exits 1 and says so; the browser login, or the setting turned on and the command run again                  |
| Init sees a login the service lacks (`CLAUDE_CONFIG_DIR`, an API key in env) | The daemon's real turn fails and init says so (`init.ts:706-709`); fixed, the install command again                                     |
| The install run in the foreground                                            | Claude Code stops it at 10 min at most, mid-pairing or boot; the skill runs it in the background, and a rerun resumes                   |
| The token on the install command's own line                                  | It stays in `ps` for the run; the skill hands it over through a 0600 file                                                               |
| No pairing code arrives                                                      | Init waits, as the terminal prompt did; stopping it writes nothing, since pairing comes before every write                              |
| A wrong code is written                                                      | "That is not a code the bot sent"; init waits for the file again                                                                        |
| No `/bind` within 15 minutes                                                 | Init stops without writing; the install command again pairs again                                                                       |
| `sudo` needs a password in an agent's shell (Linux)                          | The command printed; init refuses the default folders until it runs, or takes the two `MAMA_INIT_*_ROOT` folders; wave 3 settles it     |
| Moving Node fails to boot                                                    | The old folders back and started, exit 1                                                                                                |
| A Node move is killed midway                                                 | The hold keeps it stopped; the next run finishes or undoes the move                                                                     |
| A source is enabled while its tool is missing                                | Refused before any write (W2.4.5e); otherwise boot fails on its `init()` (`daemon.ts:1308-1323`), and doctor names the commands         |
| The toolkit cannot install on a fresh Mac                                    | Init goes on without it (`init.ts:610-627`); see I7                                                                                     |

## Order of work

PR 1 → PR 2 → PR 5, with PR 3 in parallel → leg A, steps 1–5 (W2.3's candidate proof among them)
→ PR 3 merged → W2.4.5e → step 6 → legs B and C → PR 4 → the wave 2 release → the post-release runs → I1, I4
and I5 marked for macOS in v1.md, evidence in checks.md.

## Plan corrections

- W2.4's Docker sentence belongs to wave 4: no image exists (D1) and G4 forbids offering a command
  that has not run. I1's and I4's Docker halves close there, on `mama init --non-interactive`
  pairing through the code file. This replaces I1's `docker compose run --rm mama init`.
- I5 closes with waves 3 and 4, which fill the Linux and Docker rows.
- W2.3's `mama update` changes in PR 2: it has no `engines` check today, and it gains the
  `--node` move and the pin note.
- v1-plan W2.4's "so `mama init` only signs it in": PR 2 made init run the sign-in on a terminal.
  PR 5 leaves init signing nothing in: it names the login, and the agent runs it.
- v1.md's wording, edited when the rows close:
  - B1's "the install command" becomes "install MAMA" said to the agent.
  - B2's "confirming it in the terminal" becomes relaying it to the agent, which hands it to init.
  - I4's "in init" becomes the enabling section, which refuses, and doctor.
- New row I7: the macOS toolkit runs `brew install` and needs python3 3.10 or newer
  (`s/tools/document-toolkit.ts:292-300,397-405`). An account without its own Homebrew cannot
  install it. The script does not install Homebrew, a machine-wide manager; the clean-account run
  records what happens.
- This file's own lines, corrected: `update.ts:553` is `:583`; "status shows the npm kind" was never
  true (`s/cli/commands/control.ts` prints no kind), and `mama update --dry-run` shows it
  (`update.ts:664`).

## Open owner decisions

- **Q1.** Sources are settled: the owner said they are chosen in the conversation (W2.4.5e). Does
  "the person never touches a terminal" also cover the rest of what comes after the first reply?
  The other `mama init --section` parts (Discord, Slack, Jev, a new bot token, model, timezone),
  `mama secret set` and `mama uninstall` each need a terminal (`init-section.ts:64`, `secret.ts:18`,
  `uninstall.ts:304`).
  - If yes, they take the agent's input as init does: a new row, not W2.4.
  - If no, the guide sends the person to a terminal for those.
- **Q2, only if leg C fails.** Should the person run one terminal step to sign Claude in, or should
  a Claude backend be installed by Claude Code only? This applies when Codex installs MAMA with the
  `claude` backend and `claude auth login` cannot complete from Codex's shell.

The clean macOS account and its test bot are owner actions already needed by B2 and W2.3.

## Sources

All read 2026-10-30.

- https://code.claude.com/docs/en/setup
- https://code.claude.com/docs/en/authentication
- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/auth.md (device code login, the fallbacks, `cli_auth_credentials_store`)
- https://learn.chatgpt.com/docs/config-file/environment-variables
- https://github.com/openai/codex (`codex-rs/login/src/device_code_auth.rs`, `codex-rs/cli/src/login.rs`,
  `codex-rs/core/src/unified_exec/mod.rs`)
- https://chatgpt.com/codex/install.sh (`prompt_yes_no`, `CODEX_NON_INTERACTIVE`, `CODEX_HOME`)
- https://github.com/googleworkspace/cli; https://registry.npmjs.org/@googleworkspace/cli/latest
- https://nodejs.org/dist/latest-v22.x/
- https://github.com/nodejs/node#verifying-binaries; https://github.com/nodejs/release-keys
- https://github.com/nodejs/Release

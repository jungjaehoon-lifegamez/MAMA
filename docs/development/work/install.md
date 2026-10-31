# Install command (1.0 W2.4)

Rows I1, I4 and I5 of [v1.md](v1.md); plan [W2.4](v1-plan.md#w24-install-command-i1-i4-i5). Code
read at `17dcbcafb`, revised for the owner decisions of 2026-10-30; every line number is against
`origin/main` at `1afb3fa3b`, and PR 3's against its head `3696b7041`. `s/` is
`packages/standalone/src`. Vendor
pages were read on 2026-10-30 ([Sources](#sources)). Measurements and reasons:
[install-notes.md](install-notes.md).

## Why

A person installs Node, runs `npm install -g`, installs and signs in a backend, then runs
`mama init` (I1). `start.sh` pins whatever Node ran init (`s/cli/commands/service.ts:161`), so an
upgrade or an nvm switch can still break the service. Nothing says how to get `gws` (I4) or which
versions are supported (I5).

Owner, 2026-10-30: the person's agent (Claude Code or Codex) installs MAMA through conversation,
and the person never touches a terminal. Secrets and the pairing code are entered in a browser
page init opens on this machine, like Claude's sign-in. They are stored in `~/.mama/auth.env`
(0600) by the existing writer.

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
  `~/.mama/node/bin/npm` with that prefix (`s/cli/commands/update.ts:190,579`) and renames inside
  its scope folder (`s/cli/runtime/update-journal.ts:130-139`), never touching Node.
- The wrapper: the bin starts with `#!/usr/bin/env node` (`s/cli/index.ts:1`). On a clean account
  no `node` is on PATH, so npm's link cannot run at all; with another Node first, a later
  `mama service install` would pin that Node. The person's own `node` and `npm` stay first.
- The path has no version folder: `stableNodePath` keeps it (`s/cli/launch-files.ts:24-36`) and
  doctor's `versionedNodePath` warning stays off (`:39-43`).
- `umask 077` first: init makes the home 0700 only when it creates it (`s/cli/commands/init.ts:522`).
  Init refuses only on `config.yaml`, `connectors.json` and `start.sh` (`init.ts:395-398,435-438`).

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
   (`s/cli/runtime/diagnostics.ts:567-600`). A copy, because a rollback needs the old prefix
   untouched; a rebuild, not a reinstall, because the published core range is a caret
   (`release.yml:297`; 0.78.0 depends on `^8.8.0`), so a reinstall could bring a newer core.
3. `mama stop` (it drains, #533), then `runtime/update.hold`, which `start.sh` honours
   (`s/cli/launch-files.ts:54`), so a reboot mid-move starts nothing. Renames, in this order:
   `node` → `node.old`, `node.new` → `node`, then (major only) `npm` → `npm.old`,
   `npm.new` → `npm`. `start.sh` is unchanged, since the paths stay.
4. Doctor's Node check under the new Node; remove the hold; `mama service start`; `waitForBoot`
   (`init.ts:299`). Then `phase: committed`, the `.old` folders deleted, the journal closed. A
   failure before `committed` renames back, removes the hold, starts the old Node and exits 1.

A run killed midway leaves the journal and the hold. The script checks for them before anything
else, in plain `sh`, since `~/.mama/npm` may be missing then: at `committed` it deletes the `.old`
folders; otherwise it renames each `.old` back over whatever is in its place, removes the hold
and starts the service. It then says the move was undone, and a further run tries again. Doctor
reports an open `node-move.json` and says to run the install command again.

`mama update` reads the new package's `install/node.json`; when it differs from the running Node,
`finishCommitted` (`update.ts:978`) ends the report with "run the install command again", and
doctor's Node check (`diagnostics.ts:547`) warns the same. A target whose `engines` excludes the
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

| Installing agent | Backend | Sign-in                                                                                                                                                                                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | claude  | None: the account's Claude login is the one the installer uses; `claude auth status --json` reads it from an agent's shell ([notes](install-notes.md#backend-sign-in-measured))                                                       |
| Claude Code      | codex   | The managed home: `CODEX_HOME=~/.mama/.codex <codex> login` (opens the browser on this machine) or `login --device-auth` (prints a page and a code; the person turns on device code login in ChatGPT first)                           |
| Codex            | codex   | The same: Codex's own `~/.codex` login is not MAMA's (`init-questions.ts:234`)                                                                                                                                                        |
| Codex            | claude  | `claude auth login` in the background; the person signs in in the browser, and the localhost callback completes it. If the CLI asks for a code, the person relays it and the agent writes it to the login's stdin (owner, 2026-10-30) |

## Linux

- One `sudo` call, shown first and asked once:
  `sudo sh -c 'umask 022; install -d -m 0755 /var/lib/mama; install -d -o <user> -m 0700 /var/lib/mama/<user>; loginctl enable-linger <user>'`.
  `sudo` keeps the caller's umask 077, so without `umask 022` the parent would be 0700 and
  `prepareRoot` would fail (`s/cli/runtime/default-roots.ts:46-59`). Root-owned at 0755 it passes
  `assertRootAncestors` (`s/runtime/tools-paths.ts:25-42`); init makes `members/` and `tools/`
  (`default-roots.ts:27`). Linger is what init tries and only reports (`init.ts:650-660`). The
  member temp roots sit under `/tmp` (`s/runtime/backend-security.ts:35,37`).
- In an agent's shell `sudo` has no terminal to ask the password on (`install.sh:210` runs it
  `</dev/null`), so it runs only where no password is asked; otherwise the script prints the
  command. How a person runs it without a terminal is wave 3's (L5).
- The setup page binds `127.0.0.1` on the machine that runs init. Over SSH, the person's browser
  needs a forwarded port, which the page's Host rule allows on any local port. Until wave 3 (L5),
  SSH and headless Linux have no setup path; PR 4 says so, since Linux is not in wave 2's
  supported versions.
- W2.4 assumes Ubuntu 24.04: glibc, systemd user units, a writable `/var`, `sudo` for the person.
  Wave 3 measures SteamOS (L5) and confirms each, and owns `bwrap`, `socat` and LibreOffice (L2,
  I3); the script installs no system packages.

## How it is delivered and run

- `create-release` attaches `install.sh` (`release.yml:529-531`). The command, which the agent runs:

  ```sh
  curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh -s -- --backend claude --non-interactive
  ```

- `MAMA_OS_VERSION=` and the pin are written by `sync-versions.js`, which the release and the
  pre-commit hook run (`release.yml:127`, `.husky/pre-commit:55`); no CI step runs `--check`.
  So `create-release` refuses a script whose version is not the tag's, and waits until
  `npm view @jungjaehoon/mama-os@<version> version` answers before it uploads.
- The body is one function called on the last line, so a cut-off download runs nothing.
- No terminal is read. A new install needs `--backend` and either `--non-interactive` (init reads
  `MAMA_INIT_*` and opens the setup page) or `--no-init`, which prints the init command. A set-up
  install needs no flag and keeps accepting these, so the bare command that `mama update`, doctor
  and status print
  (`s/cli/runtime/node-move-journal.ts:61-62`) runs as is.
- Init gets `MAMA_INIT_BACKEND` from `--backend`. No secret goes through the script, its flags or
  its environment: init's setup page takes them (W2.4.5b).
- npm and init run by full path with `~/.mama/node/bin` first on PATH, as `npmEnvironment` does
  (`update.ts:202`). npm honours `npm_config_registry`; the script has no registry flag.
- Startup block, by `$SHELL`: zsh `~/.zshrc`; bash `~/.bashrc` on Linux, `~/.bash_profile` on macOS
  (or `~/.profile` when only that exists); fish: the `fish_add_path` line is printed, nothing
  written; other `~/.profile`. Each run rewrites the text between `# >>> mama >>>` and
  `# <<< mama <<<`. The agent's shell does not read it, so the agent uses full paths.

| On a run, when                                                             | The script                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.mama/runtime/node-move.json` exists                                    | Finishes or undoes that move first, as above                                                                                                  |
| `~/.mama/config.yaml` or `start.sh` exists and `~/.mama/npm` holds no MAMA | Refuses before any change: another install owns this account; `mama update --dry-run` shows how it updates                                    |
| `~/.mama/config.yaml` exists and `~/.mama/npm` holds MAMA                  | Needs no flag; moves Node if the pin differs, then runs `mama init --non-interactive`, which resumes (`init.ts:420-431`) or says it is set up |
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
  2. verdaccio (moved from `packages/standalone/scripts/upgrade-check/update.mjs` into the shared
     `packages/standalone/scripts/local-registry.mjs`) serves this build. `install.sh --backend codex --no-init` runs with
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
  only its "left out" line about the program went (#539). Restore
  switches only archived entries (`s/cli/runtime/restore.ts:702-745`).
- `mama uninstall` (`s/cli/commands/uninstall.ts:1-9`, "the program is an npm package, which npm
  removes"): with `--data` the plan lists the managed program and removes it with the home, last;
  without it the program stays and is named. Both print the startup block to remove.
- Init: the only backend on PATH is the default answer (`init-questions.ts:384-385`); the terminal
  sign-in, which PR 5 takes out of the whole setup again; "already set up" also names
  `mama update` (`init.ts:427`).
- `service install`: for an npm install, `start.sh`'s PATH also names `<prefix>/bin`
  (`launch-files.ts:102-118`), where npm puts commands installed beside MAMA.

## PR 3: tools a source needs (I4)

In progress on `feat/source-tools`, by another worker. Its follow-up, naming the OAuth client step
in gws's requirement, is one of W2.4.5e's changed lines.

- A source names its tool with `type: 'cli'` (`s/connectors/gmail/index.ts:68-77`, and calendar,
  drive, sheets). gws's requirement, with its install methods, moves to one export in
  `s/connectors/framework/gws-utils.ts`.
- One helper returns, for the sources being enabled, each tool missing from the service's PATH
  with its methods and login. Callers on `main`: `mama init` (`init.ts:594-597`, a fixed name set,
  `init-questions.ts:43`), `init --section connectors` (`s/cli/commands/init-section.ts:193-194`,
  login only) and doctor's fix (`diagnostics.ts:766-898`). It reports and never refuses;
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
      given (`packages/standalone/scripts/install-check/run.mjs:369` passes both flags).
  - A backend `command -v` finds counts only when `"$backend_path" --version </dev/null` exits 0
    and prints a version; otherwise the vendor installer runs, and the installed one must pass the
    same check (`install.sh:334-371`).
  - Init gets `MAMA_INIT_BACKEND=$backend` (`install.sh:438`).
  - The Linux lines that say init asks for or offers other folders (`install.sh:201,213`) name
    `MAMA_INIT_MEMBER_ROOT` and `MAMA_INIT_TOOLS_ROOT` instead, since no question is left.
  - Tests in `tests/cli/install-script.test.ts`:
    - a `claude` first on PATH that exits 127 makes the vendor installer run;
    - a set-up install with no flags runs init;
    - the "without a terminal" case is rewritten.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the install script asks
    nothing and runs from an agent's shell. A found backend must run before the installer is
    skipped. A set-up install needs no flags.
  - Done: `cd packages/standalone && npx vitest run tests/cli/install-script.test.ts && cd ../.. && pnpm lint:sh`.

- **W2.4.5b The setup page: the bot token and the pairing code** ([why](install-notes.md#the-setup-page-the-token-and-the-pairing-code)).
  The page is the one new piece. In `telegram-pairing.ts` only `ask`'s input and three lines of
  text change.
  - `environmentAnswers` (`init.ts:245-293`) reads no secret and no ID. `MAMA_TELEGRAM_TOKEN`
    (`:262`), `MAMA_INIT_COMMON_CHAT_ID` (`:263`) and `MAMA_INIT_OWNER_TELEGRAM_ID` (`:283`) go.
    Every other answer is checked before the page opens: the backend, the model, the timezone, the
    folders and the tunnel. So a missing `MAMA_INIT_MODEL` is refused before the person pairs.
  - The page, `s/cli/runtime/setup-page.ts` (new), is served by the running init and takes a list
    of named fields. Each field has a name, a label, whether it is secret, and the check that
    accepts it, and the page shows them in order. This item's list is the bot token, then the
    pairing code; W2.4.5e and W2.4.6 pass their own.
    - It binds `127.0.0.1` on a random port, at the path `/<nonce>`, where the nonce is 32 random
      bytes.
    - It is opened through a redirect file, as Jupyter's `use_redirect_file` does:
      - Init writes `open.html` (0600) into a `mkdtemp` folder (0700) under `os.tmpdir()`. On
        macOS that is the per-user `$TMPDIR`, measured at 0700; on Linux, `mkdtemp` makes its own
        folder in `/tmp`. The file sends the browser to the page.
      - Init runs `open` (macOS) or `xdg-open` (Linux) on the file's path. MAMA has no opener today.
      - The URL with its nonce goes nowhere else: not on stdout, and not in any process's
        arguments.
      - A failed open is reported, and the file's printed path stays the way in.
      - The folder is removed when the page closes. A killed init leaves the folder behind, which
        is harmless, since the nonce dies with the server.
      - Ubuntu's snap Firefox cannot read `/tmp` (Launchpad 1959417, jupyter/notebook#4500); that is
        wave 3's.
    - GET `/<nonce>` shows the current field's form. POST `/<nonce>` (form-encoded) takes that
      field.
    - **The bot token.** Init runs `checkTelegram` (`init-questions.ts:295-317`). A refused token
      gets the same sentence on the page, and the form again. An accepted one stays in memory.
      `updateSecrets` (`s/cli/secrets.ts:67`) writes it at the existing write point (`init.ts:577`),
      once every answer is in.
    - **The pairing code.** `checks.pair` (`init.ts:490-513`) is reused, and its `ask` (`:497`) is
      answered by this POST. The POST's reply waits for `pairOwner`:
      - another `ask` means a wrong code (`telegram-pairing.ts:161-164`), and the page shows that
        line;
      - a return means accepted, and the page says to add the bot to the group and send `/bind`.
    - Once the code is accepted, the nonce is dead and the server stops. `bindCommonGroup` needs no
      page.
  - The page lives 15 minutes from its start, the same as `/bind`'s wait (`telegram-pairing.ts:32`)
    and Codex's device code. At expiry the server stops, and init exits 1 having written nothing.
    The server also stops whenever init exits.
  - What the agent reads on stdout, in order:
    1. `setup page: opened in the browser from <folder>/open.html; it closes at <time>`;
    2. `bot token accepted for @<bot>`, or the refusal sentence, after which the page waits again;
    3. `pairOwner`'s line (`:106`), which now ends "enter it on the setup page";
    4. `pairing code accepted`, then `bindCommonGroup`'s line (`:200`);
    5. `setup page closed`, then init's steps as today.

    At expiry it reads `the setup page expired at <time>; nothing was written`, and the install
    command, run again, starts over. Neither the token nor the URL appears on stdout, on a page or
    in an error.

  - Security, each item with its reason:
    - `127.0.0.1` only: the page takes a secret, and no other machine may reach it.
    - Other local accounts: loopback is shared by every account, so the nonce is the barrier.
      - It lives only in the 0600 redirect file and in this account's browser.
      - It never reaches stdout or `ps`: macOS shows other accounts' process arguments, and Linux's
        `/proc/<pid>/cmdline` is world-readable.
    - The nonce in the path: another site's page can POST a form to localhost without CORS, but it
      cannot guess the path.
    - Host's name must be `localhost`, `127.0.0.1` or `[::1]`, on any port, with one Host header.
      This is the viewer's rule without its configured names
      (`s/api/viewer-request-security.ts:11-52`). It stops DNS rebinding and allows an SSH forward
      on another local port.
    - POST only, for the token and the code: a GET would put them in history and logs.
    - `Cache-Control: no-store`: the browser keeps no copy once the server stops.
    - `Referrer-Policy: no-referrer`, and no external resources on the page: the URL and its nonce
      are not sent to another host.
    - One token and one code are accepted, then the page closes: a later submission cannot change
      the owner.
    - Nothing secret is logged or echoed: the page and stdout name the bot, never the token.
    - A fixed lifetime: a forgotten background init does not keep a page that accepts a token.
  - Proof of person: a code reaches only the chat it was sent to (`telegram-pairing.ts:88-94`).
    Being reachable only from this machine is not being reachable only by this person, and only this
    account can read the redirect file. So the code entered on the page proves that a process of
    this account, given the DM's code, entered it. Nothing inside one account stops that account's
    agent from doing so: CI's `managed.mjs` does it on purpose. The skill forbids it (W2.4.5d).
    Neither the code nor the token passes through the conversation.
  - `telegram-pairing.ts` text: `:106` and `:134` say "enter it on the setup page"; `:163` drops
    "type".
  - Tests in `tests/cli/setup-page.test.ts` (new) and `onboarding.test.ts`. The ID cases are
    rewritten (`onboarding.test.ts:405-406,541-542,791-802`).
    - a refused token, then an accepted one;
    - a wrong code, then the right one;
    - `/bind` before the code, and after it;
    - a wrong nonce gets 404;
    - `localhost:<another port>` is served, while a foreign name and a duplicate Host get 421;
    - a token sent by GET is not taken;
    - a POST after the code is refused;
    - expiry exits 1 with nothing written;
    - the redirect file is 0600 in a 0700 folder;
    - the URL is in no stdout line and no `open` argument, and the token is in no stdout line and
      no response body.
  - CI: `packages/standalone/scripts/install-check/run.mjs:275-277` drops the token and the two IDs. `managed.mjs`
    reads the redirect file's path from init's output, takes the URL from the file and POSTs the
    token. Its Telegram stand-in serves `getUpdates` and `sendMessage`, and the check POSTs the code
    from the DM it was asked to send.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`:
    - `### Added`: `mama init --non-interactive` opens a setup page on this machine for the bot
      token and the pairing code.
    - `### Removed`: the init variables `MAMA_INIT_OWNER_TELEGRAM_ID` and `MAMA_INIT_COMMON_CHAT_ID`,
      and `MAMA_TELEGRAM_TOKEN` as an init variable (the secret name stays).
  - Done: `cd packages/standalone && npx vitest run tests/cli/setup-page.test.ts tests/cli/onboarding.test.ts tests/cli/telegram-pairing.test.ts`, and CI `install-check` green on macOS and Ubuntu.

- **W2.4.5c The terminal setup goes** ([why, and the count](install-notes.md#the-terminal-setup-why-it-goes)).
  - Delete:
    - `askAnswers` (`init.ts:141-237`);
    - the whole setup's `requireTTY` and terminal prompt (`:380-381`);
    - its `signIn` option (`:85`, `:461`).

    Bare `mama init` then fails the usage check (`:377-378`). Both usage strings, `init.ts:367` and
    `cli/index.ts:120`, drop `[--non-interactive]`'s brackets and name `--non-interactive` and
    `--section`. The flag keeps its name, which the owner's decision, `install.sh` and the Docker
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
      - the command and its variables, and the setup page;
      - the sign-in table above;
      - running in the background, passing on init's lines, and running again;
      - done when MAMA answers. It lands here because the live run's agent reads it from `main`.
  - `terminalSignIn` stays for `--section model` (`init-section.ts:96-101`).
  - Bare `mama init` becomes a usage error, and `mama` in the agent's shell may be another program
    (finding D). These messages change "run mama init again" to "run the install command again":
    - `init.ts:312,349,525,604,699,704,708`, and the comment at `:690`;
    - `telegram-pairing.ts:46,67,231`;
    - `init-section.ts:70`, which says "run the install command first".

  - `init-questions.ts:250,267,283,290,308` are shared with `--section model` and
    `--section telegram` (`init-section.ts:84-101`). On a set-up install the install command stops
    at "already set up" (`init.ts:425-429`). So the caller passes its next step: the whole setup's
    "run the install command again", or a section's "run this again".

  - Tests: the `runInit([])` cases in `onboarding.test.ts` (35 calls) move to the environment
    answers. A case that tests a question only the deleted path asked goes. A tunnel case is added.
    The `--section` cases stay.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Removed`: the interactive whole
    setup. `mama init --non-interactive` is the setup, run by the person's agent (owner-setup.md).
    The tunnel settings are read from the environment.
  - Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts && pnpm typecheck`.
    Then `grep -n "askAnswers\|requireTTY" src/cli/commands/init.ts`,
    `grep -rn "mama init again\|run mama init first" src/cli` and
    `grep -n "Run onboarding in your terminal\|MAMA_INIT_OWNER_TELEGRAM_ID\|^| \`MAMA_TELEGRAM_TOKEN\`" ../../docs/start/owner-setup.md`
    each print nothing.

- **W2.4.5d The mama-install skill and its test.**
  - `packages/claude-code-plugin/skills/mama-install/SKILL.md` drops "Never ask for a token, key or
    password in the conversation" and "the owner runs it in their own terminal". In their place it
    says plainly: the person enters secrets and the pairing code only in the page MAMA opens, never
    in the chat. The conversation reaches the model provider and this agent's transcript.
  - It drops its step 1, `npm i -g @jungjaehoon/mama-os` and `mama --help` (`SKILL.md:13-14`). On
    the clean account Homebrew's npm cannot write its prefix from a Standard account (EACCES:
    `/opt/homebrew/lib/node_modules` is 0755, owned by another account). `mama --help` would also run
    Homebrew's `mama` 0.53.2 (finding D).
  - Then, briefly, with owner-setup.md as the procedure:
    1. Ask which backend (yourself unless the person picks the other) and which model.
    2. Run the install command in the background, with its output in a file. Tell the person the
       setup page has opened in their browser, or give them the redirect file's path from it.
    3. Pass on the sign-in lines and the page's steps. Codex's device page warns to cancel a code
       "another person gave you"; say that this code comes from the login the agent started on the
       person's machine.
    4. After a sign-in, run the same install command again. Use full paths.
    5. The setup is done when MAMA answers the person's message.
  - Never read `open.html` and never POST to the setup page. The page is the person's.
  - Sources are chosen in the conversation. The tool is installed with its printed command. For
    gws, the person creates its OAuth client and the agent moves the JSON into place. The person
    completes its login in the browser, and only then is the source enabled with the
    non-interactive section (W2.4.5e). The Jev paragraph says Jev is turned on later with
    `mama init --section jev` (W2.4.6).
  - `tests/skills/mama-install-skill.test.js` asserts these; its `:22-23` move from `npm i -g` and
    `mama --help` to the install command, and `:32-39` follow:
    - the install command, and no `npm i -g`;
    - the setup-page sentence;
    - no "own terminal" and no token asked for in the chat;
    - `--non-interactive`;
    - the rule "never read open.html, never POST to the page";
    - the guide link and "MAMA answers" stay.
  - `packages/claude-code-plugin/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the skill installs
    MAMA OS through the conversation. The plugin's `package.json` and `.claude-plugin/plugin.json`
    move together at the release.
  - Done: `cd packages/claude-code-plugin && npx vitest run tests/skills/mama-install-skill.test.js`.

- **W2.4.5e A source enabled from the conversation** (after PR 3). The person chooses the source
  in the conversation. The agent then:
  1. installs the tool with the command `sourceTools()` gives (on a script-made install, the
     managed-Node `npm install --prefix ~/.mama/npm`);
  2. for gws, has the person create a Desktop OAuth client in Google Cloud Console:
     - a project, with the APIs its sources use enabled: `gmail.googleapis.com`,
       `calendar-json.googleapis.com`, `drive.googleapis.com` and `sheets.googleapis.com`. gws
       names any one still missing with an `enable_url` (`accessNotConfigured`);
     - its consent screen: External in testing mode, with the person as a test user, or Internal
       for a Workspace account.

     The agent then moves the downloaded JSON to `~/.config/gws/client_secret.json` (0600). This
     is the tool's own credential, like a backend login, not a MAMA secret, so it does not go
     through the setup page. Without it, `gws auth login` exits at once with
     `401 No OAuth client configured`
     ([notes](install-notes.md#sources-from-the-conversation-pr-3-and-w245e)). A testing-mode
     client's refresh token expires after 7 days (Q3);

  3. has the person complete the tool's login in the browser;
  4. enables the source.

  Enabling with the tool missing must not be possible: a Google source's `init()` runs
  `gws --version` (`s/connectors/gmail/index.ts:46-53`), and boot rethrows its failure
  (`s/runtime/connectors.ts:236-240`, `s/cli/commands/daemon.ts:1311-1326`), so MAMA would not
  start.
  - `runInit`'s parsing takes `--section <part> --non-interactive` (`init.ts:367,373-374`, usage and
    the two-argument check).
  - `mama init --section connectors --non-interactive` takes `MAMA_INIT_CONNECTORS`: a JSON object
    of connector blocks in `connectors.json`'s own shape (`s/connectors/framework/types.ts`), the
    shape `collectConnectors` builds. The tokens the blocks name (`auth.tokenName`, and Slack's
    app token) are entered on the setup page (W2.4.5b), one field each.
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
    - gws's requirement names the OAuth client step, `~/.config/gws/client_secret.json`, before
      the login. This is PR 3's follow-up.
    - The whole setup's caller goes (W2.4.5c). PR 3's doctor lines stay.
  - Doctor's token fix is `mama secret set` (`diagnostics.ts:174-178`), which needs a terminal. For
    a source token, the agent runs this section again and the page takes the token; the fix names
    that.
  - Tests in `onboarding.test.ts`:
    - Gmail with gws on the service's PATH is enabled;
    - with gws only on the shell's PATH, or nowhere, the section is refused and `connectors.json`
      is unchanged;
    - a Notion block's token, entered on the page, lands in `auth.env`;
    - a block boot would refuse is refused;
    - the terminal form refuses a missing tool too;
    - a Google source's lines name the OAuth client file before the login.
  - `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Added`:
    `mama init --section connectors --non-interactive` reads `MAMA_INIT_CONNECTORS`, and a source
    whose tool the service cannot find is no longer enabled (both forms). A Google source's lines
    name gws's OAuth client file.
  - Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts tests/cli/doctor.test.ts`.

## W2.4.6: later setup changes from the conversation (follow-up, not PR 5)

The owner, 2026-10-30: the person never touches a terminal after the first reply either.

- These need a form without a terminal:
  - the other `mama init --section` parts: `telegram`, `model`, `timezone`, `discord`, `slack`
    and `jev`;
  - `mama secret set`;
  - `mama uninstall`.

  Each needs a terminal today (`init-section.ts:64`, `secret.ts:18`, `uninstall.ts:304`).

- Answers that are not secret come from the environment, as W2.4.5e's do.
- Each secret is entered on W2.4.5b's setup page: a new bot token, the Discord and Slack tokens, the
  Jev key, a rotated secret.
- `uninstall --data` takes no secret. It is confirmed by `--confirm-home <MAMA home path>`, which
  the agent passes after showing the plan in the conversation. That is the same path the terminal
  prompt asks the person to type back (`uninstall.ts:306-309`).
- `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Added`:
  - `mama init --section <part> --non-interactive` for every part, and
    `mama secret set --non-interactive`, with their secrets on the setup page;
  - `mama uninstall --data --confirm-home <path>`.
- Done: `cd packages/standalone && npx vitest run tests/cli/onboarding.test.ts tests/cli/uninstall.test.ts`.
  The new cases run each command with stdin and stdout not a TTY: onboarding's `mama init --section`
  and "secret rotation" (`mama secret set`) blocks, and uninstall's `--data` confirmation.

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
  - the release notes (`release.yml:490-504`).

  The release notes and owner-setup.md also say there is no setup path for SSH or headless Linux
  until wave 3.

- Bare `mama init` in the docs becomes the install command, `mama init --non-interactive`, or
  "setup". The grep below finds 36 lines on `main`:
  - `README.md`;
  - `docs/reference/cli.md`, including `:36-71`;
  - `docs/start/tutorial.md`, including `:42,84`;
  - the parts of `docs/start/owner-setup.md` that W2.4.5c leaves, including `:105`;
  - `packages/standalone/README.md`, including `:15,19-22,31`;
  - `docs/reference/configuration.md`;
  - `docs/guides/` `backends`, `connectors`, `messengers`, `people`, `replay`, `security`,
    `telegram`, `troubleshooting` and `viewer`;
  - `docs/explanation/architecture.md:62`.

- `docs/guides/viewer.md:26`: the tunnel variables come from the environment. `docs/guides/connectors.md:43-44`:
  PR 3's methods.
- `packages/standalone/CHANGELOG.md` `## [Unreleased]`, `### Changed`: the package README and the
  install guide describe setup through the person's agent and list the supported versions.
- Done: `pnpm lint` and `pnpm exec prettier --check README.md docs packages/standalone/README.md`
  pass. `grep -rn "MAMA_INIT_OWNER_TELEGRAM_ID\|MAMA_INIT_COMMON_CHAT_ID\|hidden prompt" README.md docs/start docs/reference packages/standalone/README.md`
  prints nothing; this catches `cli.md:84`. `grep -c MAMA_TELEGRAM_TOKEN docs/start/owner-setup.md`
  prints 1, the rotation line; the variable row at `:117` is gone.
  `grep -rnE 'mama init([^ -]|$| [^-])' README.md docs/start docs/reference docs/guides docs/explanation packages/standalone/README.md`
  prints nothing: no bare `mama init`, only `--section` and `--non-interactive`.

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
   2. The agent asks for the backend (`claude`, itself) and the model, then runs `install.sh` from
      the candidate in the background. Init opens the setup page.
   3. The person pastes the bot token on the page, messages the bot, and enters the bot's code on
      the page. They then add the bot to the group and send `/bind`.
   4. Init starts the service, and the person's DM gets a reply.

   Checks entry: what the person typed, and where (conversation, Telegram, browser, terminal; the
   terminal count must be 0), the minutes taken, and every place the agent left the docs.
   - The token, the page's nonce and the pairing code appear nowhere in the agent's transcript file.
   - Neither the token nor the nonce appears in `ps -axww`, run in a loop from another account
     during the run. A single snapshot is evidence only; W2.4.5b's unit test is the proof.
   - The checks entry records the installing agent's own sandbox.

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
6. After W2.4.5e, the person asks for Gmail in the conversation. Starting state:
   - Homebrew's `gws` 0.11.1 is on every account's PATH (`/etc/paths.d/homebrew`).
   - `start.sh`'s PATH names `/opt/homebrew/bin` (`launch-files.ts:96`), so the service finds it
     and the section's refusal cannot fire on this Mac.

   The live path here is the found tool, then the client, then the login, then enabling:
   - the person creates the Desktop OAuth client in Google Cloud Console, and the agent moves its
     JSON to `~/.config/gws/client_secret.json` (0600);
   - the person completes `gws auth login -s gmail` with the found gws, in the browser;
   - the agent then runs the section, which enables Gmail; `mama doctor --json` passes, and
     `mama service start` boots with the source.

   The refusal is proven by W2.4.5e's tests and on the wave 3 host. The checks entry says whether
   the gws login completed from the agent's shell, and how long the client step took a new person.
   A second entry eight days later records whether the testing-mode client's polls still work.
   The toolkit's `brew install` on this Standard account is recorded (I7).

7. **Leg B.** `mama uninstall --data` is run at a terminal (it needs one until W2.4.6).
   Claude Code then installs with the `codex` backend. The managed home is signed in from the
   agent's background shell with `codex login`, or with `--device-auth` and device code login on.
8. **Leg C.** `mama uninstall --data` and `claude auth logout` are run. The person asks Codex to
   install MAMA by following owner-setup.md on `main` (W2.4.5c; Codex has no plugin), with the
   `claude` backend:
   - `claude auth login` from Codex's shell: the browser sign-in, and a code written to its stdin
     if the CLI asks for one;
   - whether Codex's background run survives across turns until init ends;
   - Codex's sandbox and approval mode, which may deny the page's listener and `open`.

**After the release:** W2.3's registry update. Then `mama uninstall --data`, the backend removed
by its vendor's steps, and leg A against npmjs.

**Wave 3:** the same run on the Linux host that L5 settles, with the `sudo` step.

## Done when

- **I1 (macOS):** on the clean account, from "install MAMA" said to Claude Code, the person reaches
  a DM reply without typing anything in a terminal.
  - In the conversation they choose the backend and model, and give any code a backend's sign-in
    asks for.
  - On the setup page MAMA opens they enter the bot token and the bot's pairing code. The token
    appears nowhere in the agent's transcript.
  - In Telegram they make the bot and the group, message the bot, and send `/bind`.
  - In a browser they sign in a backend that is not the installing agent's.

  `start.sh` pins `~/.mama/node/bin/node`. Legs B and C reach the same reply. Linux closes with
  wave 3, Docker with wave 4.

- **I4 (the command part):**
  - Enabling a Google source without gws is refused before anything is written, with commands that
    work. The tests and the wave 3 host prove it.
  - On the clean Mac, with gws found, the agent goes from the OAuth client (the person, in Google
    Cloud Console) and the login to an enabled source that boot starts. With a testing-mode client
    this holds for 7 days; the lasting route is Q3.
  - Doctor names the same commands for an enabled source whose tool went missing.
  - The image half is wave 4's.
- **I5 (Node, backend, macOS rows):** the guide lists them with sources, and the run used those.

## Failure modes

| Failure                                                                                                                        | Handling                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm install fails (network, registry, a build)                                                                                 | npm's code shown; `~/.mama/npm` left for the re-run, which reinstalls                                                                                                                                |
| The vendor installer fails                                                                                                     | Its output shown, exit 1; the vendor's page named                                                                                                                                                    |
| The backend `command -v` finds does not run (a shim, no real one)                                                              | The vendor installer runs; the installed one must run, or exit 1                                                                                                                                     |
| A shim that forwards to a real backend elsewhere wins `command -v`                                                             | `start.sh` names the shim's folder; init's real turn fails if the service cannot run it (`init.ts:706-709`); the live proof checks PATH                                                              |
| The backend is signed out                                                                                                      | Init refuses before any write and names the login with the binary's path; the agent runs it, then the install command again                                                                          |
| A found backend runs but is older than the minimum (Homebrew's codex is exactly 0.160.1 today)                                 | The script keeps it, and init refuses "older than …; update it" before writing. The agent puts the vendor's build in `~/.local/bin`, which the script puts first, and runs the install command again |
| Device code login is off, or its code expires (15 min)                                                                         | `codex login --device-auth` exits 1 and says so; the browser login, or the setting turned on and the command run again                                                                               |
| Init sees a login the service lacks (`CLAUDE_CONFIG_DIR`, an API key in env)                                                   | The daemon's real turn fails and init says so (`init.ts:706-709`); fixed, the install command again                                                                                                  |
| The install run in the foreground                                                                                              | Claude Code stops it at 10 min at most, mid-pairing or boot; the skill runs it in the background, and a rerun resumes                                                                                |
| Nothing is entered on the setup page                                                                                           | It closes after its 15 minutes; init exits 1 with nothing written; the install command again opens a new one                                                                                         |
| Telegram refuses the token, or a wrong code is entered                                                                         | The page shows the refusal, or "That is not a code the bot sent", and its form again                                                                                                                 |
| The browser does not open (no `open` or `xdg-open`, no display)                                                                | Init says so. The agent gives the person the printed `file://` path of `open.html` to paste into the browser's address bar; the path holds no secret                                                 |
| The person's browser is on another machine (SSH)                                                                               | `127.0.0.1` there is out of reach; a forwarded port is wave 3's (L5)                                                                                                                                 |
| The installing agent's sandbox forbids a listener (Claude Code on macOS listens only with `sandbox.network.allowLocalBinding`) | Init's bind fails and says so; the person allows it, or approves the command outside the sandbox. Leg A and leg C record which                                                                       |
| No `/bind` within 15 minutes                                                                                                   | Init stops without writing; the install command again pairs again                                                                                                                                    |
| `sudo` needs a password in an agent's shell (Linux)                                                                            | The command printed; init refuses the default folders until it runs, or takes the two `MAMA_INIT_*_ROOT` folders; wave 3 settles it                                                                  |
| Moving Node fails to boot                                                                                                      | The old folders back and started, exit 1                                                                                                                                                             |
| A Node move is killed midway                                                                                                   | The hold keeps it stopped; the next run finishes or undoes the move                                                                                                                                  |
| A source is enabled while its tool is missing                                                                                  | Refused before any write (W2.4.5e); otherwise boot fails on its `init()` (`daemon.ts:1311-1326`), and doctor names the commands                                                                      |
| A testing-mode client's refresh token expires after 7 days                                                                     | MAMA still starts: Calendar's read check is its sign-in check, not its start (#548). Polls fail, and doctor's sign-in check names `gws auth login -s <services>`, which the person runs again (Q3)   |
| The toolkit cannot install on a fresh Mac                                                                                      | Init goes on without it (`init.ts:610-627`); see I7                                                                                                                                                  |

## Order of work

PR 1 → PR 2 → PR 5, with PR 3 in parallel → leg A, steps 1–5 (W2.3's candidate proof among them)
→ PR 3 merged → W2.4.5e → step 6 → legs B and C → PR 4 → the wave 2 release → the post-release runs → I1, I4
and I5 marked for macOS in v1.md, evidence in checks.md.

## Plan corrections

- W2.4's Docker sentence belongs to wave 4: no image exists (D1) and G4 forbids offering a command
  that has not run. I1's and I4's Docker halves close there, on `mama init --non-interactive`
  with the setup page. This replaces I1's `docker compose run --rm mama init`. Wave 4 decides how
  the host's browser reaches the page: a page on the container's `127.0.0.1` is not reachable
  through `-p`.
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

The owner answered Q1 and Q2 on 2026-10-30:

- Q1: setup changes after the first reply are made without a terminal too (W2.4.6).
- Q2: Claude's sign-in under Codex goes through the browser (the [Backend CLI](#backend-cli)
  table, leg C).

- **Q3. Which lasting Google client does MAMA rely on?** Until there is one, a Gmail, Calendar,
  Drive or Sheets source needs a re-login every 7 days, because the person's own client sits in
  testing mode ([notes](install-notes.md#sources-from-the-conversation-pr-3-and-w245e)). The routes:
  - **(a)** The person publishes their own client "In production" without verification. Google's
    personal-use exception allows it (verified). Users see the unverified-app warning, and there is
    a 100-user cap (verified). Whether that lifts the 7-day expiry for Gmail's restricted scopes is
    not verified: Google states the rule for Testing only.
  - **(b)** MAMA ships a verified client. Gmail's read scopes are restricted (verified), so it needs
    Google's verification. The security assessment applies when restricted data passes through a
    developer's server (verified). Whether a local-only app such as MAMA needs it is not verified.
  - **(c)** A Workspace account uses Internal, which has neither the test-user step nor the expiry
    (verified for the user type; not run here).

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

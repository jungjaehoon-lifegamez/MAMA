# Install command (1.0 W2.4)

Rows I1, I4 and I5 of [v1.md](v1.md); plan [W2.4](v1-plan.md#w24-install-command-i1-i4-i5). Code
read at `17dcbcafb`. `s/` is `packages/standalone/src`. Vendor pages were read on 2026-10-30
([Sources](#sources)).

## Why

Today a person installs Node 22.13 or newer, runs `npm install -g`, installs and signs in a backend
CLI, then runs `mama init` (I1). Whatever Node ran `mama init` is the one `start.sh` pins
(`stableNodePath(process.execPath)`, `s/cli/commands/service.ts:161`), so a Homebrew upgrade or an
nvm switch can still break the service (I6 only warns, `s/cli/runtime/diagnostics.ts:585-594`). A
Google source needs `gws`, and nothing says how to get it (I4). No page says which versions are
supported (I5).

## What the script makes

| Path                                                  | What                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `~/.mama/node`                                        | The Node.js 22 release the script pins, unpacked from the official `.tar.gz`    |
| `~/.mama/npm`                                         | npm's global prefix for MAMA: `lib/node_modules/@jungjaehoon/mama-os`, `bin/`   |
| `~/.mama/bin/mama`                                    | A two-line wrapper: `exec` the managed Node on the package's CLI, by full paths |
| A marked block in the shell's startup file            | Puts `~/.mama/bin` (and `~/.local/bin` when a backend went there) first on PATH |
| `/var/lib/mama/<user>` (Linux only, with `sudo` once) | The parent of the default `member_root` and `tools_root`                        |

- `start.sh` then runs `~/.mama/node/bin/node` on
  `~/.mama/npm/lib/node_modules/@jungjaehoon/mama-os/dist/cli/index.js`. `installKind` reads that
  as `npm` with prefix `~/.mama/npm` (`s/cli/runtime/install-kind.ts:56-57`); `mama update` runs
  `~/.mama/node/bin/npm` with that prefix (`s/cli/commands/update.ts:172,549`) and renames inside
  its scope folder (`s/cli/runtime/update-journal.ts:130-139`). W2.3 needs no change.
- Two folders, so a Node patch release replaces `~/.mama/node` alone and `mama update`'s rename
  never touches Node. A Node major change also needs the SQLite module rebuilt
  (`s/cli/runtime/diagnostics.ts:557-583`), so it ships with a release that reinstalls the package.
- The wrapper: the bin starts with `#!/usr/bin/env node` (`s/cli/index.ts:1`), so through npm's
  link a later `mama service install` from a shell with another Node first would pin that Node
  (`service.ts:161`). The person's own `node` and `npm` stay first on their PATH.
- The managed path has no version folder: `stableNodePath` keeps it (`s/cli/launch-files.ts:24-36`)
  and doctor's `versionedNodePath` warning stays off (`:39-43`).
- `umask 077` comes first: init makes the home 0700 only when it creates it
  (`s/cli/commands/init.ts:506`). Init refuses only on `config.yaml`, `connectors.json` and
  `start.sh` (`init.ts:390-393,427-430`), so the program folders do not trip it.

## Node

- Version: the latest 22.x patch when the pin changes, 22.23.4 today. `engines` says `>=22.13.0`
  (`packages/standalone/package.json:38-40`) and CI and the release run Node 22
  (`.github/workflows/ci.yml:47`, `release.yml:55`). MAMA ships what a release was verified on
  (plan decision 4), so the pin follows CI. Node 22 is in maintenance until 2027-04-30; moving to 24
  changes CI's pin, `engines` and the script's constants together, with a verification.
- The script holds the version and the SHA-256 of the four files it uses (`darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`, `.tar.gz`: fresh Linux images may lack `xz`). It
  downloads from `https://nodejs.org/dist/v<version>/`, checks the hash with `shasum -a 256` or
  `sha256sum`, unpacks into `~/.mama/node.<pid>.tmp` and renames it into place. A wrong hash
  deletes the download and exits 1, naming both hashes. No `gpg` on the person's machine.
- The hashes are checked once, in CI: a `node-pin` step fetches `SHASUMS256.txt.asc`, verifies it
  with `gpgv` against the keyring from `nodejs/release-keys`, and fails if the script's hashes
  differ. A pin change cannot merge unverified.

## Backend CLI

- The script asks which backend MAMA uses (`claude` or `codex`), or takes `--backend`. When
  `command -v` finds it, nothing is installed; init checks its version and login
  (`s/cli/commands/init-questions.ts:223-255`).
- Otherwise it runs the vendor's documented installer for macOS and Linux, unchanged:
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`. It installs
    `~/.local/bin/claude` and updates itself in the background.
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` into `~/.local/bin`, without
    `CODEX_HOME` set: its cache goes under `CODEX_HOME/packages/standalone`, and MAMA's managed
    home (`~/.mama/.codex`) holds only the login.
- `~/.local/bin` joins the script's PATH before init, because init and `mama service install` find
  the backend on PATH (`init-questions.ts:229`, `service.ts:154-159`) and `start.sh` then carries
  its folder (`launch-files.ts:102-118`).
- Signing in stays in init. Today init refuses a signed-out backend and names the command
  (`init-questions.ts:231,252-254`). On a terminal it now runs that command itself, attached to
  the terminal, then probes again: the only backend step init has left (B1). `--non-interactive`
  still refuses.

## Linux

- The one `sudo` is the folder step `prepareRoot` names today, `install -d -o "$USER" -m 0700` on
  `/var/lib/mama/<user>` (`s/cli/runtime/default-roots.ts:27,54`). Init makes `members/` and
  `tools/` inside it. `/var/lib/mama`, made by root with mode 0755, passes `assertRootAncestors`
  (`s/runtime/tools-paths.ts:25-42`).
- The same `sudo` call runs `loginctl enable-linger <user>`, which init tries and only reports
  when it cannot (`init.ts:634-644`). The script shows both commands and asks once; a folder
  already right is left alone. No other root: the member temp roots sit under `/tmp`
  (`s/runtime/backend-security.ts:35,37`) and the daemon makes them.
- W2.4 assumes Ubuntu 24.04 (G1's proposed host): glibc, systemd user units, a writable `/var`, and
  `sudo` for the person. Wave 3 measures SteamOS (L5) and confirms or corrects each of these. It
  also owns `bwrap`, `socat` and LibreOffice (L2, I3); the script installs no system packages.

## Docker

W2.4 ships nothing for Docker. No image exists (D1), and G4 forbids offering a command that has not
run. `docker compose run --rm mama init` once and `docker compose up -d` are written with the wave
4 image and compose file, on `mama init --non-interactive` (`init.ts:234-288`).

## How it is delivered and run

- The release attaches `install.sh` to its GitHub release (`gh release create`, `release.yml:490`).
  The documented command:

  ```sh
  curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh
  ```

  The script names its own MAMA OS version (`MAMA_OS_VERSION=`), written by
  `scripts/sync-versions.js` as the release and the pre-commit hook already run it
  (`release.yml:127`, `.husky/pre-commit:51-52`). Nothing in CI runs its `--check` today, so the
  release job refuses to upload a script whose version is not the tag's. The upload comes after
  the npm publish (`release.yml:429-449`), so the asset never names an unpublished version.

- Not `npx`, which needs Node first; not the raw file at a tag, whose command changes each release.
- `curl … | sh` gives the script a pipe as stdin. Its question and init read from `/dev/tty`: init
  runs as `<node> <cli> init </dev/tty` (it requires a terminal, `init.ts:376`). Without a terminal
  the script needs `--backend` and either `--non-interactive` (init reads `MAMA_INIT_*`,
  `init.ts:240-288`) or `--no-init`, which prints the init command.
- No secret goes through the script or its flags; init asks at hidden prompts or reads variables
  (`init.ts:234-239`). npm and init run by full path with `~/.mama/node/bin` first on PATH, as `npmEnvironment` does
  (`update.ts:181-186`), so the SQLite module is chosen for the managed Node. npm honours
  `npm_config_registry`, which the CI leg sets; the script has no registry flag.

| On a run, when                                                             | The script                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `~/.mama/config.yaml` or `start.sh` exists and `~/.mama/npm` holds no MAMA | Refuses before any change: another install owns this account; `mama update --dry-run` shows how it updates       |
| `~/.mama/config.yaml` exists and `~/.mama/npm` holds MAMA                  | Changes no program file and runs that install's `mama init`: it resumes (`init.ts:415-423`) or says it is set up |
| `~/.mama/node` has the pinned version (`node --version`)                   | Skips Node                                                                                                       |
| `npm ls -g --prefix ~/.mama/npm` shows the script's version                | Skips the package; another version is reinstalled (no setup exists yet)                                          |
| `command -v mama` names another program                                    | Names it, and says the startup block puts the wrapper first                                                      |
| The startup block is already there                                         | Leaves the file alone                                                                                            |
| A checkout on this account with no `~/.mama`                               | Installs normally; the checkout is not touched                                                                   |

## PR 1: `install.sh` and its CI leg

- `packages/standalone/install/install.sh`, POSIX `sh`, `set -eu`, in this order: refusal checks;
  platform and architecture (macOS or Linux, x64 or arm64, else exit 1 naming them); Linux root and
  linger; Node; `npm install -g --prefix ~/.mama/npm @jungjaehoon/mama-os@<version>`; the wrapper;
  the backend; the startup block; `mama init </dev/tty`.
- Startup file: `~/.zshrc` for zsh, `~/.bash_profile` for bash on macOS, `~/.bashrc` for bash on
  Linux, else `~/.profile`, between `# >>> mama >>>` and `# <<< mama <<<`.
- `scripts/sync-versions.js` gains the script's `MAMA_OS_VERSION=` line, and the pre-commit hook
  stages the script with the READMEs. `create-release` checks the version, then passes the script
  to `gh release create`.
- CI job `install-check`, macOS and Ubuntu runners, each with a fresh `HOME` under the runner temp:
  1. `node-pin` (Ubuntu only): the hashes against the signed `SHASUMS256.txt.asc`.
  2. verdaccio (the pin and setup of `scripts/upgrade-check/update.mjs:36`, moved into a shared
     module) serves this build. `install.sh --backend codex --no-init` runs with
     `npm_config_registry` set and `npm_config_node_gyp=/bin/false`, so a source build of a native
     module fails: the prebuilt binaries must cover the platform.
  3. The installed package's init runs under the managed Node with `writer.mjs`'s answers and stub
     backend, then `mama service install` through `fake-service.cjs`. Asserts: `start.sh` names the
     managed Node and the prefix's CLI; `installKind` is `npm` at `~/.mama/npm`; doctor's Node
     check is `ok`; `mama update --dry-run` against verdaccio shows N → N+1.
  4. A second run refuses and changes no file. A run cut off after Node skips Node when run again.
  5. A Node file with another hash is refused and nothing is unpacked. The script's download and
     check are a function the test sources and runs on a local file; the script has no mirror
     setting.
  6. Each vendor installer as the script runs it, with no terminal; `codex --version` and
     `claude --version` meet `s/cli/runtime/backend-probe.ts:8-11`. If an installer waits for an
     answer there, the script sets the vendor's non-interactive variable (Codex:
     `CODEX_NON_INTERACTIVE=1`) only when it has no terminal, and this step says so.
- Shell tests (`shellcheck` in lint): the startup block once only; a username outside
  `default-roots.ts:22`'s pattern refused before `sudo`; no `sudo` on macOS.

## PR 2: `mama` around the managed program

- `s/cli/runtime/backup.ts`: `node`, `npm` and `bin` join a program set left out of the archive
  without the "left out" line (`backup.ts:345-358`, `s/cli/commands/backup.ts:200-201`); the summary
  says the program is not backed up. Restore switches only the archive's entries
  (`s/cli/runtime/restore.ts:702-745`), so the program survives a restore.
- `mama uninstall`: the header's "the program is an npm package, which npm removes"
  (`s/cli/commands/uninstall.ts:1-9`) gains the managed case. With `--data`, the plan lists the
  program and removes it with the home, last. Without it, the program stays and is named. Both
  print the startup block to remove; the dry run lists it.
- Init: when only one backend is on PATH, the backend question shows it as the answer to accept
  (`init-questions.ts:345`); when the backend is signed out on a terminal, init runs the login as in
  [Backend CLI](#backend-cli). "Already set up" also names `mama update` (`init.ts:419-422`).
- `mama service install`: for an npm install, `start.sh`'s PATH also names `<prefix>/bin`, where npm
  puts commands installed beside MAMA (`launch-files.ts:102-118`).
- Tests: a backup of a managed install neither archives nor reports the program; uninstall's dry
  run with and without `--data`; init's login run, and its refusal under `--non-interactive`.

## PR 3: tools a source needs (I4)

- A source names its tool with `type: 'cli'` (`s/connectors/gmail/index.ts:68-77`, and calendar,
  drive, sheets). The requirement gains the methods to install it, from one place:
  `s/connectors/framework/gws-utils.ts` exports gws's requirement, and the four sources use it.
- One helper reads the requirements of the sources being enabled and returns, for each tool missing
  from the PATH the service will use, its install methods and its login. Callers: `mama init`
  (`init.ts:578-581`, which checks a fixed set of names today, `init-questions.ts:42`),
  `init --section connectors` (`s/cli/commands/init-section.ts:188-189`, which only prints the
  login) and doctor's fix text (`diagnostics.ts:787-811`). It reports and never refuses: a source
  may be set up before its tool.
- gws methods (github.com/googleworkspace/cli, 2026-10-30): for an npm install, the npm beside the
  service's Node with the service's prefix, so the command lands on `start.sh`'s PATH (PR 2);
  otherwise `npm install -g @googleworkspace/cli` or `brew install googleworkspace-cli`. Then
  `gws auth login` by its full path, with the scopes the sources need.
- Doctor's backend fix (`diagnostics.ts:334-341`) names the same vendor installers as the script.
  A test reads both and fails if they differ.
- Tests: each caller with gws missing, present on the shell's PATH only, and on the service's PATH.

## PR 4: docs (I1, I5)

- `docs/start/owner-setup.md` install section: the command, what it makes and asks, Linux's one
  `sudo`, and **Supported versions**:

  | What        | Supported                              | Source                                                        |
  | ----------- | -------------------------------------- | ------------------------------------------------------------- |
  | Node.js     | 22.x, installed by the script          | `engines`, the script's pin, CI                               |
  | Own Node    | 22.13 or newer (npm installs)          | `engines`                                                     |
  | Claude Code | 2.1.299 or newer                       | `backend-probe.ts:8-11`                                       |
  | Codex       | 0.160.1 or newer                       | `backend-probe.ts:8-11`                                       |
  | macOS       | the version the clean-account run used | that run's checks entry; Claude Code itself needs 13 or newer |
  | Linux       | set by wave 3 (L5)                     | wave 3's checks entry                                         |
  | Docker      | set by wave 4                          | wave 4's checks entry                                         |

- README "Getting started", `docs/start/tutorial.md:19`, `docs/reference/cli.md:30,173`,
  `packages/standalone/README.md:8,14`, the release notes' install block (`release.yml:469-478`):
  the command first, `npm install -g` as the way for a person who keeps their own Node.
- The plugin's `mama-install` skill installs with the command, and its test moves with it (it
  asserts the `npm i -g` text, `packages/claude-code-plugin/tests/skills/mama-install-skill.test.js:21`).
- `docs/guides/connectors.md:43-44`: the gws methods of PR 3.

## Live proof

- **The clean macOS account** (the one W2.3's candidate proof and B2 need), one run for both:
  1. verdaccio serves candidate N, and the account's `~/.npmrc` names it as `registry=`: the
     daemon's `mama update` reads npm's config (`update.ts:553`), not the script's environment.
     It is removed before the post-release run. `install.sh` from the PR's tree installs Node, N
     and the chosen backend; init signs it in, pairs the test bot and starts the
     service. The DM gets a reply. Checks entry: steps, minutes, every place the docs were left.
  2. `mama doctor` is clean; `start.sh` names the managed Node; status shows the npm kind.
  3. `mama init --section connectors` with Gmail and no gws names the methods; installing gws as
     printed, `mama doctor`'s source check passes.
  4. Then W2.3's candidate proof on this install: N → N+1, `/update`, N+2 rolls back.
- **After the release:** W2.3's registry update runs on that install first. Then
  `mama uninstall --data`, and the published command from nothing, against npmjs, to a DM reply.
- **Wave 3:** the same run on the Linux host L5 settles.

## Done when

- **I1 (macOS):** on the clean account, the published command takes a person from nothing to a DM
  reply with only the backend sign-in, the bot token and pairing typed; `start.sh` pins
  `~/.mama/node/bin/node`. Linux closes with wave 3 and Docker with wave 4.
- **I4 (the command part):** enabling a Google source without gws prints its methods in init,
  `--section` and doctor; the image half is wave 4's.
- **I5 (the Node, backend and macOS rows):** the guide lists them with their sources, and the
  clean-account run used exactly those.

## Failure modes

| Failure                                        | Handling                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Unsupported OS or architecture                 | Exit 1 before any change, naming them                                   |
| Node download fails or its hash differs        | Download removed, nothing unpacked, both hashes named; a re-run retries |
| npm install fails (network, registry, a build) | npm's code shown; `~/.mama/npm` left for the re-run, which reinstalls   |
| The vendor installer fails                     | Its output shown, exit 1; the vendor's page named                       |
| `sudo` refused or missing (Linux)              | The two commands printed; init then offers other folders                |
| No terminal                                    | Needs `--backend` and `--non-interactive` or `--no-init`; says so       |
| Init fails or is cut off                       | Its own message; running the script again resumes init                  |
| An install already on the account              | Refused before any change; `mama update --dry-run` named                |
| The toolkit cannot install on a fresh Mac      | Init goes on without it (`init.ts:605-611`); see the plan correction    |

## Order of work

PR 1 → PR 2 → PR 3 → PR 4 → the clean-account run (W2.4, then W2.3's candidate proof on the same
install) → the wave 2 release → W2.3's registry run → `mama uninstall --data` and the published
command → I1, I4 and I5 marked for macOS in v1.md, evidence in checks.md. W2.3's candidate proof
waits for PR 1–3, since it runs on the install the script makes.

## Plan corrections

- W2.4's Docker sentence belongs to wave 4 (D1): nothing runs it before the image. I1's and I4's
  Docker halves close there.
- I5 cannot close in W2.4: the Linux and Docker rows come from waves 3 and 4. W2.4 fills the
  Node, backend and macOS rows.
- "So `mama init` only signs it in" is not true today: init refuses a signed-out backend
  (`init-questions.ts:252-254`). PR 2 makes init run the login.
- New row I7: the macOS toolkit runs `brew install` and needs python3 3.10 or newer
  (`s/tools/document-toolkit.ts:292-300,397-405`). An account with no Homebrew, or on a Mac whose
  Homebrew belongs to another account, cannot install it; init goes on without it. The script
  does not install Homebrew (a machine-wide manager, not MAMA's runtime). The clean-account run
  records what happens, and I7 takes the fix.

## Open owner decisions

None: the code, the plan and the rules settle each choice above. The clean macOS account and its
test bot are owner actions already needed by B2 and W2.3.

## Sources

Read 2026-10-30.

- Claude Code setup, https://code.claude.com/docs/en/setup: the installer command, `~/.local/bin`
  and `~/.local/share/claude/versions/`, background updates, macOS 13+ and Ubuntu 20.04+. The page
  signs in by running `claude`; `claude auth login` is the command init and doctor use (I2, #524).
- Codex: https://learn.chatgpt.com/docs/codex/cli (the standalone installer);
  https://learn.chatgpt.com/docs/config-file/environment-variables (`CODEX_INSTALL_DIR`, default
  `~/.local/bin`; the cache under `CODEX_HOME/packages/standalone`); https://github.com/openai/codex
  (npm, Homebrew and release archives as other methods).
- Google Workspace CLI, https://github.com/googleworkspace/cli: npm (Node 18+), Homebrew, release
  binaries; `gws auth login`.
- Node.js 22.23.4 files and `SHASUMS256.txt.asc`, https://nodejs.org/dist/latest-v22.x/;
  verification with `gpgv` and `nodejs/release-keys`, https://github.com/nodejs/node#verifying-binaries.
- Node.js schedule, https://github.com/nodejs/Release: 22 in maintenance from 2025-10-21, end of
  life 2027-04-30; 24 active.

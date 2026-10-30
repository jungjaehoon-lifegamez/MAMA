# Install command: notes (1.0 W2.4)

Measurements and reasons behind [install.md](install.md), which stays the work list. Everything
here was measured or read on 2026-10-30 at `4b25f4b45`. `s/` is `packages/standalone/src`.

## The owner decision this follows

Owner, 2026-10-30 (dev memory `w2_4_agent_led_install`): the person's agent, Claude Code or Codex,
installs MAMA through conversation, and the person never touches a terminal. The secret path
stays the existing one: `MAMA_TELEGRAM_TOKEN` in init's environment, stored in `~/.mama/auth.env`
(0600). A local web page for secrets was proposed and withdrawn as reinventing that path.

## The agent's shell

- **No terminal.** Claude Code's Bash and Codex's shell run commands without a TTY. Init today
  requires one for every mode except `--non-interactive` (`s/cli/commands/init.ts:380-381`), and
  `install.sh` refuses its terminal mode without `/dev/tty` (`install.sh:76-83`).
- **Time limits.** A foreground Bash call in Claude Code stops after 2 minutes by default, and 10
  at most. A background call keeps running across turns, and the agent is told when it exits. Init
  can run far longer than 10 minutes:
  - `/bind` waits up to 15 minutes (`s/cli/runtime/telegram-pairing.ts:32`);
  - the boot wait takes up to 10 minutes (`init.ts:684`);
  - the daemon's real turn takes up to `agent.max_turn_ms` plus 60 s (`init.ts:694`), which is an
    hour by default (`init.ts:549`).

  So in every design the agent starts the install in the background and reads its output.

- **Codex** keeps long-running commands as unified-exec processes: up to 64, with `exec_command`
  and `write_stdin`, and a `tty` field on each. This was read in
  `codex-rs/core/src/unified_exec/mod.rs`. Whether such a process survives the end of a turn was
  not verified; leg C of the live proof measures it.
- **The command text is in `ps`.** Claude Code runs each command as `zsh -c '<command text>'`.
  `MARKER_X=probe-1234 true`, then `ps -ww -o args= -p $$`, printed `MARKER_X=probe-1234`. So
  `MAMA_TELEGRAM_TOKEN=… sh install.sh` keeps the token in that shell's arguments for the whole
  install. Linux lets other local users read `/proc/<pid>/cmdline` by default. Init's own rule is
  "secrets come only from variables, never from flags, which `ps` shows" (`init.ts:241-243`). Hence
  the skill's hand-off: a short command writes the token into a 0600 file, and the install command
  loads it from there.
- **The startup block is not read.** The agent's shell does not read the PATH block `install.sh`
  writes. Claude Code's Bash sources a snapshot taken when the session started. This is finding C
  again, in the agent's flow. So the agent runs `~/.mama/bin/mama` and the backend by full path,
  and runs `install.sh` again rather than `mama init`: the script puts `~/.local/bin` first
  (`install.sh:173`).

## Backend sign-in, measured

- **Claude Code's own login reaches init's check.** From this agent's Bash (CLI 2.1.314,
  `CLAUDECODE` set, no TTY), `claude auth status --json` answered `loggedIn: true`. That is the
  call `probeBackend` makes (`s/cli/runtime/backend-probe.ts:77-90`).
  - Credentials live in the macOS Keychain, keyed to `CLAUDE_CONFIG_DIR`, or in
    `~/.claude/.credentials.json` (0600) on Linux ([Claude Code authentication][cc-auth]).
  - Every `claude` binary of the account reads the same entry.
  - `backendEnvironment` drops names that contain `TOKEN`, `KEY`, `SECRET`, `PASSWORD` or
    `CREDENTIAL` (`s/runtime/backend-security.ts:122-131`). It keeps `CLAUDE_CONFIG_DIR`.
- **`claude auth login` starts without a terminal.** The run used a scratch `CLAUDE_CONFIG_DIR`,
  stdin `/dev/null`, `BROWSER=/usr/bin/true`, and a stop after 10 s. It printed "Opening browser to
  sign in…", a sign-in URL whose `redirect_uri` is `platform.claude.com/oauth/code/callback`, and
  "Paste code here if prompted >". It was still running at 10 s. There was no `kqueue` error, so
  finding B belongs to `/dev/tty` itself.
  - On the clean account the sign-in completed through the browser's localhost callback with no
    code pasted ("Paste code here if prompted > Login successful."). That is the coordinator's
    report of the owner's run.
  - The pasted-code route needs the login's stdin. Codex can write a running process's stdin.
    Another agent starts the login reading a pipe it can write later.
  - The docs give no device flag for Claude ([Claude Code authentication][cc-auth]).
- **`codex login --device-auth` runs without a terminal.** The run used codex-cli 0.160.1, a
  scratch `CODEX_HOME`, stdin `/dev/null` and stdout to a file, and was stopped after 12 s. It
  printed the device page (`auth.openai.com/codex/device`) and a one-time code that "expires in 15
  minutes", then kept polling. It ends with "Continue only if you started this login in Codex. If
  a website or another person gave you this code, cancel." Relayed by an agent, that line needs
  the agent to say whose login it is.
  - Source (`codex-rs/login/src/device_code_auth.rs`, `codex-rs/cli/src/login.rs`): the prompt is a
    `println!`, no path checks for a terminal, and polling stops after 15 minutes.
  - A 404 from the server prints "device code login is not enabled for this Codex server". The
    plain command does not fall back to the browser.
  - The browser login (`codex login`) prints its URL unconditionally and checks for no terminal
    either. Its callback is on this machine.
  - The docs ask the person to turn on device code login in ChatGPT's security settings, or an
    admin to allow it for a workspace ([Codex authentication][codex-auth]).
- **Codex's own login is not MAMA's.** MAMA runs Codex on the managed home `~/.mama/.codex`
  (`s/cli/commands/init-questions.ts:234`), so the person's `~/.codex` login does not carry over.
  Copying `auth.json` would leave two homes refreshing one token. Codex refuses a `CODEX_HOME` that
  does not exist (`init-questions.ts:275`).

## Finding A: what the cmux shim does

`~/.cmuxterm/cmux-cli-shims/<id>/claude` execs the cmux app's `cmux-claude-wrapper`, which looks up
the real `claude` with the shim folders left out of PATH.

- With no real `claude` on PATH, it exits 127 with "claude not found in PATH". So `--version` fails,
  which is the clean account's case.
- With a real `claude` elsewhere, it forwards to it, and `--version` passes. Init's `findExecutable`
  (`s/cli/launch-files.ts:5-17`) then returns the shim. `start.sh`'s PATH would name the shim's
  per-terminal folder (`launch-files.ts:102-118`), and the service runs without cmux.

Inside `install.sh`, `~/.local/bin` comes first (`install.sh:173`), so a backend the vendor
installer put there wins over the shim. Coding knowledge of cmux into MAMA is not the fix. The
daemon's real turn at the end of init (`init.ts:688-713`) is the check that fails when the service
cannot run the backend it pinned.

## Pairing: why one running init reads the code from a file

What the code requires (`s/cli/runtime/telegram-pairing.ts`):

- The only input to `pairOwner` is `ask(label, signal)` (`:95-100`).
- The code→sender map, the update offset and the group messages seen so far live in that run's
  memory (`:104`, `:108-111`), and `bindCommonGroup` continues from that offset and those messages
  (`:188-205`).
- Held updates are dropped once, at the start (`:103`).
- The bot sends a code to whoever writes privately while the run polls (`:115-146`). With no run
  polling, nobody answers the person's message.

So the smallest change keeps one process from the token check to the end, and changes only where
`ask` reads. The agent can reach a running background process only through files, which both
agents can write. Init names the file, and only the text written there is compared with the codes.

Rejected:

- **Two invocations, with state in the step record.**
  - The first run would have to keep polling anyway, or a later run would answer the message late.
  - The code→sender map would have to be on disk, which writes the proof itself to disk.
  - The step record without `config` means a setup cut off while writing, and its files are removed
    (`init.ts:411-419`).
  - Each new run drops held updates again (`:103`).
- **Stdin or a FIFO.** Claude Code's background Bash cannot write to a running process's stdin, and
  `install.sh` gives init `</dev/null` (`install.sh:438`). A FIFO blocks its writer for as long as
  init is gone.
- **The code going the other way**, init printing one for the person to send to the bot. That code
  would sit in the transcript and the provider's logs before it reaches Telegram, and anyone who
  saw it could send it first. Today's direction ties the code to the chat it was sent to (`:88-94`),
  so seeing it gives nothing.

Why the folder is new and outside the MAMA home:

- Init makes the MAMA home only once the answers are in (`init.ts:519-526`).
- `mama init --non-interactive` can also run without `install.sh`, on a home that does not exist.
- A fresh `mkdtemp` folder (0700) holds no stale code.
- On macOS the per-user temp folder is private; on Linux the folder's mode keeps other users out.

Why `MAMA_INIT_OWNER_TELEGRAM_ID` and `MAMA_INIT_COMMON_CHAT_ID` go:

- With them, an agent holding the token can read `getUpdates` itself and fill in whoever wrote, and
  no code ever comes back through the person.
- B2 says no numeric ID is typed.
- No caller needs them: the CI leg (`scripts/install-check/run.mjs:276-277`) passes them only
  because its Telegram stand-in has no `getUpdates`.

## The terminal setup: why it goes

From the code and the owner's direction:

- Every MAMA backend is one of the two agents (`init.ts:258-260`), so every person running MAMA has
  an agent that can install it.
- SSH and headless Linux run Claude Code or Codex in the remote shell. The flow is the same; only
  sign-in differs, as above.
- The Docker plan already closes on `--non-interactive` (install.md, Plan corrections). With the
  code file, Docker pairs the same way.
- What only the terminal setup asked has another home. See the relocations in
  [install.md, W2.4.5c](install.md#pr-5-setup-through-the-persons-agent).
- Findings B and C on the clean account came only from the terminal path. AGENTS.md allows no
  second path "just because you are unsure".

Kept as a secondary path, it would need two input paths for one setup (`askAnswers` beside
`environmentAnswers`), B's fix (a real terminal device in place of `/dev/tty`), and a docs line for
C. No consumer is named for it.

What goes, by the line ranges at `4b25f4b45`:

| Where                                             | What                                                                             | Lines            |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| `init.ts:141-237`                                 | `askAnswers`; its tunnel block (`:186-214`) moves to the environment answers     | 97 (29 moved)    |
| `init.ts:85`, `:380-381`, `:461`                  | The whole setup's `signIn` option and `requireTTY`                               | 4                |
| `init.ts:263`, `:283`                             | The two ID variables                                                             | 2                |
| `install.sh:76-83`, `:175-187`, `:440-444`        | The `/dev/tty` probe, the backend question, `init </dev/tty >/dev/tty`           | 26               |
| `tests/cli/onboarding.test.ts`                    | The cases that run `runInit([])` (35 calls), moved to the environment or deleted | to be counted    |
| `scripts/install-check/run.mjs:276-277`           | The ID answers                                                                   | 2                |
| `docs/start/owner-setup.md:36-62,109-122`         | "Run onboarding in your terminal" and the ID rows                                | rewritten (PR 5) |
| `packages/claude-code-plugin/skills/mama-install` | "Never ask for a token…", "the owner runs it in their own terminal"              | 2 rules          |
| install.md's PR 4                                 | "`--no-init`, then the owner runs `mama init` in their own"                      | 1 sentence       |

Stays:

- `terminalSignIn`, for `mama init --section model` (`init-section.ts:96-101`);
- the questions `--section` reuses (`init-questions.ts`);
- `createTerminalPrompt` (`s/cli/prompt.ts`), for `--section`, `secret set` and `uninstall`;
- `install.sh --no-init`, which the CI leg runs.

Those three commands still need a terminal (`init-section.ts:64`, `secret.ts:18`,
`uninstall.ts:304`). The connectors section gets a form without one (W2.4.5e); the rest follows in
W2.4.6, by the owner's answer to Q1.

## Sources from the conversation (PR 3 and W2.4.5e)

The owner, 2026-10-30, after the first revision: "gws는 사용자가 대화를 통해 설치 할지
결정하는건데 왜 문제가 되지?" ("Whether to install gws is the person's choice in the
conversation; why is that a problem?") A source and the tool it needs are chosen in the
conversation. The agent installs the tool, the person completes its login in the browser, and only
then is the source enabled.

What makes the order matter:

- A Google source's `init()` runs only `gws --version` (`s/connectors/gmail/index.ts:46-53`). The
  connector runtime awaits each `init()` (`s/runtime/connectors.ts:236-240`), and boot rethrows the
  failure (`s/cli/commands/daemon.ts:1308-1323`). So a Google source enabled with gws missing stops
  MAMA from starting.
- A missing login does not stop boot. Polls fail, and doctor's online check asks the source's
  credentials (PR 3's `diagnostics.ts:859-861`). So the host check that enabling needs is the
  tool's place on the service's PATH, which `sourceTools()` already computes against `start.sh`
  (`serviceSight`).
- No path an agent can use enables a source today:
  - `--section` needs a terminal (`init-section.ts:64`);
  - `--non-interactive` writes no connectors (`init.ts:286`; `:288` on PR 3's branch).
- Doctor sees only enabled sources (PR 3's `diagnostics.ts:760-858`). It cannot warn before
  enabling; the enabling step has to.

Why the non-interactive section takes connector blocks rather than one variable per question:

- `collectConnectors` exists only to turn typed answers into `connectors.json` blocks
  (`init-questions.ts:62-206`).
- The section already validates the merged file with boot's own `planConnectors` before renaming
  it (`init-section.ts:170-192`).
- Tokens already have names: a block's `auth.tokenName`, which init's secret store keys on.

So the blocks need no new vocabulary. One variable per question would add a name for each field of
each connector.

PR 3 (`feat/source-tools`, #543, head `8a7dbca7a`) states commands, which an agent can run as
printed. Three of its lines were written for a person who enables first and installs after, at a
terminal:

- the section's report, printed after the save;
- "mama service restart then applies it", while the section runs with MAMA stopped;
- a bare `gws auth login` with the scopes in prose.

gws documents `-s` to narrow its scope picker (`gws auth login -s drive,gmail,sheets`, gws README).
Whether a scope picker still asks for input in a shell without a terminal is not documented. The
same goes for whether `gws auth login` needs an OAuth client set up first (`gws auth setup`, which
needs `gcloud`). Leg A's step 6 records both.

Doctor's token fix, `mama secret set <name>` (`diagnostics.ts:174-178`), needs a terminal
(`secret.ts:18`). It predates PR 3. For a source's token, the non-interactive section with the
variable set replaces it.

## The clean-account run's findings

Notes kept with the clean-account kit, run 2026-10-30.

- **A**, the cmux shim taken for `claude`: W2.4.5a, and a live-proof check on `start.sh`'s PATH.
- **B**, Bun's `kqueue` EINVAL on `/dev/tty` during `claude auth login`: the terminal path goes
  (W2.4.5c). Without a terminal the login starts without that error (above).
- **C**, an old window without the PATH block: the agent's shell has the same gap. The agent uses
  full paths and runs `install.sh` again (W2.4.5d).
- **D**, the facts of this Mac:
  - `/etc/paths.d/homebrew` puts Homebrew's node 25.8.0, `codex` and an old `mama` 0.53.2 on every
    account's PATH. Under the agent the backend is passed with `--backend`, not asked. The live proof
    records which binaries the run used.
  - `mama status` has no install-kind line (`s/cli/commands/control.ts:108-175`). The kind shows in
    `mama update --dry-run`'s plan line, "(npm install, prefix …)" (`update.ts:664`).
  - The registry read is at `update.ts:583`, not `:553`.
- **E**, the toolkit's `brew install` on a Standard account (I7): not reached. The live proof
  records it.

[cc-auth]: https://code.claude.com/docs/en/authentication
[codex-auth]: https://learn.chatgpt.com/docs/auth.md

# Install command: notes (1.0 W2.4)

Measurements and reasons behind [install.md](install.md), which stays the work list. Everything
here was measured or read on 2026-10-30; line numbers are against `origin/main` at `1afb3fa3b`,
and PR 3's against its head `3696b7041`. `s/` is `packages/standalone/src`.

## The owner decision this follows

Owner, 2026-10-30 (dev memory `w2_4_agent_led_install`): the person's agent, Claude Code or Codex,
installs MAMA through conversation, and the person never touches a terminal.

The first revision kept the token as `MAMA_TELEGRAM_TOKEN` in init's environment. A local web page
had been proposed as a new place to store secrets and was withdrawn, because the store already
exists.

Later the same day the owner asked for a browser page to enter the token: "토큰입력은 별도
브라우저를 생성하면 되지않나?" ("Can't token entry just open a separate browser?"). This was after
Claude's browser sign-in was settled. Secrets and the pairing code are entered in a page init opens.
Storage is unchanged: `~/.mama/auth.env` (0600), through `updateSecrets` (`s/cli/secrets.ts:67`).
So the page is only the way in.

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
  no secret goes on a command line or into an environment the agent sets: the setup page takes them.
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

## The setup page: the token and the pairing code

What the code requires (`s/cli/runtime/telegram-pairing.ts`):

- The only input to `pairOwner` is `ask(label, signal)` (`:95-100`).
- The code→sender map, the update offset and the group messages seen so far live in that run's
  memory (`:104`, `:108-111`). `bindCommonGroup` continues from that offset and those messages
  (`:188-205`).
- Held updates are dropped once, at the start (`:103`).
- The bot sends a code to whoever writes privately while the run polls (`:115-146`). With no run
  polling, nobody answers the person's message.

So one process runs from the token to the end, and only `ask`'s input changes. The page lives in
that process, so it answers `ask` directly.

Nothing in MAMA takes a secret in a browser today:

- the viewer has no route or page for one;
- MAMA has no browser opener (no `open` or `xdg-open` use in `packages/*/src`).

The viewer's Host check (`s/api/viewer-request-security.ts:35-52`) is the pattern the page's check
follows. The viewer itself is not reused: it starts with the daemon, after setup.

What it proves. A code reaches only the chat it was sent to (`:88-94`). Reachable only from this
machine is not reachable only by this person, because loopback is shared by every account on it.

- The port is easy to find, so the nonce is the only barrier.
- The page takes the first code it gets.
- Pairing gives a code to any sender (`:115-146`).

So an account that read the URL could fetch the page for the bot's name, DM the bot, and submit its
own code first (review of `906d72b7c`). The URL must therefore reach no other account:

- `open` and `xdg-open` take their target as an argument. On this Mac,
  `ps -axww -o user=,args=` lists other accounts' arguments (`_usbmuxd … -launchd`, among others).
  On Linux `/proc/<pid>/cmdline` is world-readable, and a browser that `xdg-open` starts keeps its
  argument there.
- A stdout line goes into whatever file the agent chose, which under umask 022 can be
  world-readable.

The redirect file solves both. It is 0600 in a 0700 folder, and `open` gets only its path, as
Jupyter's `use_redirect_file` does. So no other account learns the nonce.

The code entered on the page then proves that a process of this account, given the DM's code,
entered it. That is not proof that the person did: the agent runs as the same account and could
read the file and POST, as CI's `managed.mjs` does on purpose. The skill forbids it, and nothing
else inside one account can.

The Host rule is the viewer's (`s/api/viewer-request-security.ts:11-52`) without its configured
names: `localhost`, `127.0.0.1` or `[::1]` on any port, one Host header. A rebinding site still
sends its own name, and an SSH forward on another local port still works.

Rejected:

- **The code file and the token file.** This design's first revision had them, and the owner
  replaced them the same day. The code passed through the agent's transcript, and the token through
  the conversation and the provider.
- **Two invocations, with state in the step record.**
  - The first run would have to keep polling anyway, or a later run would answer the message late.
  - The code→sender map would have to be on disk, which writes the proof itself to disk.
  - A step record without `config` means a setup cut off while writing, and its files are removed
    (`init.ts:411-419`).
  - Each new run drops held updates again (`:103`).
- **The code going the other way**, with init printing a code for the person to send to the bot.
  The code would be shown before it reaches Telegram, and anyone who saw it could send it first.

Why `MAMA_TELEGRAM_TOKEN`, `MAMA_INIT_OWNER_TELEGRAM_ID` and `MAMA_INIT_COMMON_CHAT_ID` go as init
answers:

- With the IDs, a script holding the token could fill in whichever sender wrote, so no proof would
  be asked for. B2 says no numeric ID is typed.
- The code protects against the wrong Telegram sender, not against the agent. An agent can still
  register any ID with `mama register-owner <id>` while MAMA is stopped.
- A token variable beside the page would be a second way in, and it is the way the token reached
  the transcript.
- The only caller is the CI leg (`scripts/install-check/run.mjs:275-277`), whose Telegram stand-in
  has no `getUpdates`. It drives the page instead (W2.4.5b).

What this revision removes and adds:

| Removed                                                                                                  | Added                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The code file: the `mkdtemp` folder, its polling reader, its unlink and cleanup, and CI writing the file | One module, `s/cli/runtime/setup-page.ts`: one GET, one POST, two forms, the Host and nonce checks, the lifetime, `open`/`xdg-open`; an estimated 120–160 lines with its HTML |
| The token file: the skill's 0600-file step and its notes                                                 | `tests/cli/setup-page.test.ts`                                                                                                                                                |
| The skill's `npm i -g` and `mama --help` step, and its two test lines                                    | The redirect file: a `mkdtemp` folder and one 0600 HTML file, about 10 lines                                                                                                  |
| W2.4.5a's refusal of a different `MAMA_INIT_BACKEND`, and its test                                       |                                                                                                                                                                               |
| The init variable `MAMA_TELEGRAM_TOKEN` (`init.ts:262`, `run.mjs:275`)                                   | CI POSTs the token and the code to the page in place of the variable and the file                                                                                             |
| `install.sh` unsetting the token for npm and the vendor installers, and its test                         |                                                                                                                                                                               |

In code, the page adds more lines than the two handovers took. The design text gets shorter: the
skill drops a step, and `install.sh` drops a step and a test.

## The terminal setup: why it goes

From the code and the owner's direction:

- Every MAMA backend is one of the two agents (`init.ts:258-260`), so every person running MAMA has
  an agent that can install it.
- SSH and headless Linux have no setup path until wave 3 (L5). The setup page needs a browser on
  this machine, or a forwarded port. Linux is not in wave 2's supported versions.
- The Docker plan already closes on `--non-interactive` (install.md, Plan corrections). With the
  setup page, Docker pairs the same way; wave 4 decides how the host's browser reaches it.
- What only the terminal setup asked has another home. See the relocations in
  [install.md, W2.4.5c](install.md#pr-5-setup-through-the-persons-agent).
- Findings B and C on the clean account came only from the terminal path. AGENTS.md allows no
  second path "just because you are unsure".

Kept as a secondary path, it would need two input paths for one setup (`askAnswers` beside
`environmentAnswers`), B's fix (a real terminal device in place of `/dev/tty`), and a docs line for
C. No consumer is named for it.

What goes, by the line ranges at `1afb3fa3b`:

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
  failure (`s/cli/commands/daemon.ts:1311-1326`). So a Google source enabled with gws missing stops
  MAMA from starting.
- A missing login does not stop boot. Polls fail, and doctor's online check asks the source's
  credentials (PR 3's `diagnostics.ts:859-861`). So the host check that enabling needs is the
  tool's place on the service's PATH, which `sourceTools()` already computes against `start.sh`
  (`serviceSight`).
- No path an agent can use enables a source today:
  - `--section` needs a terminal (`init-section.ts:64`);
  - `--non-interactive` writes no connectors (`init.ts:286`; `:292` on PR 3's branch).
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

PR 3 (`feat/source-tools`, #543, head `3696b7041`) states commands, which an agent can run as
printed. Three of its lines were written for a person who enables first and installs after, at a
terminal:

- the section's report, printed after the save;
- "mama service restart then applies it", while the section runs with MAMA stopped;
- a bare `gws auth login` with the scopes in prose.

**The OAuth client comes before the login.** Measured: Homebrew's `gws` 0.11.1, run with a scratch
`HOME` and no terminal, ran `gws auth login`. It exited 1 at once with `401 "No OAuth client
configured"` and named three ways out:

- `gws auth setup`;
- `client_secret.json` saved to `~/.config/gws/client_secret.json`;
- `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`.

The README (0.22.5, its Prerequisites and "Manual OAuth setup") requires a Google Cloud project, and
`gws auth setup` needs `gcloud`, which the clean account lacks. The manual route, in the browser:

1. create a project;
2. configure its OAuth consent screen as External, in testing mode;
3. add the person as a test user;
4. create an OAuth client of type Desktop app (another type gives `redirect_uri_mismatch`);
5. download its JSON.

The README lists no APIs to enable up front. It says to enable each one from the `enable_url` of an
`accessNotConfigured` error.

The program's decision: `client_secret.json` is the tool's own credential, like a backend login, so
the agent moves it into place (0600) and it does not go through the setup page. This is a heavy step
for a new person, and the earlier view of a printed URL came only from a home that already had a
client. Whether MAMA should ship its own verified client is Q3.

gws documents `-s` to narrow its scope picker (`gws auth login -s drive,gmail,sheets`, gws README).
Whether a scope picker still asks for input in a shell without a terminal is not documented; leg
A's step 6 records it.

Doctor's token fix, `mama secret set <name>` (`diagnostics.ts:174-178`), needs a terminal
(`secret.ts:18`). It predates PR 3. For a source's token, the non-interactive section replaces it,
with the token entered on the setup page.

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
  - Homebrew's `gws` 0.11.1 (`/opt/homebrew/bin/gws`, a Node script) is on every account's PATH too.
    `start.sh`'s PATH names `/opt/homebrew/bin` (`s/cli/launch-files.ts:96`), so the service finds
    it, and W2.4.5e's refusal cannot fire on this Mac. Its tests and the wave 3 host prove the
    refusal.
  - Homebrew's `codex` is 0.160.1, exactly the minimum (`backend-probe.ts:8-11`). Once the minimum
    rises, the script keeps it and init refuses it as too old.
- **E**, the toolkit's `brew install` on a Standard account (I7): not reached. The live proof
  records it.

[cc-auth]: https://code.claude.com/docs/en/authentication
[codex-auth]: https://learn.chatgpt.com/docs/auth.md

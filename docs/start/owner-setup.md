---
title: Set up the owner agent
parent: Start
nav_order: 4
---

# Set up the owner agent

MAMA OS keeps work history, answers the owner on Telegram, and publishes a board and
reports. For coding-session decisions and checkpoints, use the separate
[Claude Code plugin](claude-code-plugin.md).

## Install

On the Mac that will run MAMA, open Claude Code or Codex and say:

> Install MAMA OS from https://github.com/jungjaehoon-lifegamez/MAMA by following its owner setup
> guide, docs/start/owner-setup.md.

Name the repository. "Install MAMA" alone can send the agent to other programs called mama. The
agent then runs the install command, which comes with each MAMA OS release:

```sh
curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | MAMA_INIT_MODEL=<model> sh -s -- --backend <claude|codex> --non-interactive
```

In Claude Code you can add MAMA's plugin instead and say "install MAMA OS": run
`/plugin marketplace add jungjaehoon-lifegamez/claude-plugins`, then `/plugin install mama`. Its
`mama-install` skill follows this guide.

You never type in a terminal. You choose the backend and the model in the conversation. You enter
the bot token and a pairing code on a page MAMA opens in your browser, and send `/bind` in
Telegram. The next section is what the agent follows.

macOS is supported today. Linux over SSH, or on a machine without a desktop, has no setup path
yet: the setup page opens only in a browser on the machine that runs MAMA. See
[Supported versions](#supported-versions). To keep your own Node.js, see
[Install with your own Node.js](#install-with-your-own-nodejs).

## Set up through your agent

Ask Claude Code or Codex, on the machine that will run MAMA, to install MAMA OS as above. The agent
runs the install command and you never type in a terminal. Claude Code's MAMA plugin has a
`mama-install` skill for this; Codex follows this section. Either way, these are the steps.

### What you make first

In Telegram:

- a bot, from BotFather. Use a bot only this install uses: Telegram hands a bot's messages to one
  program at a time, so a bot another MAMA already reads cannot be paired;
- a group for common work, even if you are the only owner.

### The command

The agent asks you which backend MAMA runs (`claude` or `codex`; usually the agent itself) and
which model, then runs this in the background, with its output in a file:

```sh
curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | MAMA_INIT_MODEL=<model> sh -s -- --backend <claude|codex> --non-interactive
```

The setup reads these variables. None of them is a secret:

| Variable                                                               | Value                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MAMA_INIT_BACKEND`                                                    | `claude` or `codex`; the install command sets it from `--backend`             |
| `MAMA_INIT_MODEL`                                                      | The model                                                                     |
| `MAMA_INIT_TIMEZONE`                                                   | Time zone (optional; the machine's otherwise)                                 |
| `MAMA_INIT_MEMBER_ROOT`                                                | Member workspaces folder, outside your home (optional; the default otherwise) |
| `MAMA_INIT_TOOLS_ROOT`                                                 | Document tools folder, outside your home (optional; the default otherwise)    |
| `MAMA_CF_ACCESS_ISSUER`, `MAMA_CF_ACCESS_AUD`, `MAMA_VIEWER_HOSTNAMES` | The viewer behind a Cloudflare Access tunnel (optional; all three together)   |
| `MAMA_VIEWER_OWNER_EMAILS`                                             | Owner emails for access monitoring (optional, with the tunnel)                |

### The setup page

Setup checks the backend, the model, the time zone, the folders and the tunnel first. Then it
opens a setup page in your browser on this machine, and the agent tells you so. If no browser
opened, the agent gives you the `file://` path of `open.html` that setup printed; paste it into
the browser's address bar. The path holds no secret. On the page:

1. paste the bot token;
2. send the bot a new private message in Telegram (one sent before setup started is dropped). It
   answers with a pairing code; enter it on the page;
3. add the bot to the common group and make it an administrator, so it reads the group. Telegram's
   member picker does not list bots: search for the bot's @username there, or open the bot's
   profile and choose Add to Group. Then send `/bind` in that group.

Enter the token and the code only on the page, never in the chat with the agent: the conversation
reaches the model provider and the agent's transcript. The agent never opens `open.html` and never
sends anything to the page.

The page takes one token and one code, then closes. Everyone who messages the bot privately while
setup waits gets a code, but only the code entered on the page counts, and only that person's
`/bind` names the group. A `/bind` sent as an anonymous administrator cannot count; setup says so.
The page lives 15 minutes, and setup waits 15 minutes for `/bind`; after either, setup stops
without writing the setup (only the two folders stay), and the install command run again starts
over.

### Signing in the backend

Setup signs nothing in. A missing, old or signed-out backend stops it before anything is written,
and it names the login with the backend's full path. The agent runs that login in the background,
gives you its URL and code, then runs the install command again.

| Installing agent | Backend | Sign-in                                                                                                                                                                                        |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | claude  | None: the account's Claude login is the one Claude Code uses                                                                                                                                   |
| Claude Code      | codex   | MAMA's own Codex home: `CODEX_HOME=~/.mama/.codex <codex> login` (opens the browser on this machine), or `login --device-auth` (a page and a code; turn on device code login in ChatGPT first) |
| Codex            | codex   | The same: Codex's own `~/.codex` login is not MAMA's                                                                                                                                           |
| Codex            | claude  | `claude auth login` in the background; you sign in in the browser. If it asks for a code, you give it to the agent, which passes it to the login                                               |

Codex's device page warns to cancel a code "another person gave you". The code the agent passes on
comes from the login it started on your machine.

### While it runs

- The agent reads the command's output as it comes and passes on each line meant for you: the
  setup page, a sign-in, a fix.
- When the command stops for a sign-in or a fix, the agent runs the same install command again;
  setup continues from where it stopped.
- The agent's shell does not read the PATH block the installer writes, so it runs
  `~/.mama/bin/mama` and the backend by their full paths.
- Setup is done when MAMA answers your message to the bot. The agent offers no source before then.

### Sources, after MAMA answers

Once MAMA has answered you, the agent asks which work sources MAMA should watch. It names each
source the [sources guide](../guides/connectors.md) lists, with what it reads. Pick the ones you
want, or say "later": you can ask for a source at any time. For each one you pick:

1. You and the agent agree on what it reads: the rooms, channels, folders or calendars.
2. The agent stops MAMA and runs `~/.mama/bin/mama init --section connectors --non-interactive`
   with the source's settings in `MAMA_INIT_CONNECTORS` (with your own Node.js, it runs the `mama`
   npm installed). A source with a token opens the setup page again; enter the token there.
3. The command saves nothing until the source's settings pass MAMA's checks, and a Google source's
   tool and sign-in work. It does not try a token with its service. It leaves MAMA stopped however
   it ends, and the agent starts MAMA again after each run.

Gmail, Calendar, Drive and Sheets also need Google's `gws` command and an OAuth client of your own.
You create the client in Google Cloud Console, the agent puts its file in place, and you sign in
in your browser. With a client in testing mode, Google ends that sign-in after 7 days. See
[Google sources](../guides/connectors.md#google-sources).

Discord or Slack as the messenger you talk to MAMA in, and Jev, still need a terminal:
`mama init --section` (below).

### What setup checks and writes

Before writing anything, setup checks three things:

- the backend is installed, is at least the version MAMA was verified on, and is signed in;
- Telegram accepts the token;
- the folders are outside your home and the MAMA home.

If a check fails, setup stops and says what to do, and nothing has been written.

The folders have defaults; `MAMA_INIT_MEMBER_ROOT` and `MAMA_INIT_TOOLS_ROOT` name others:

| Platform | Member workspaces                                                   | Document tools              |
| -------- | ------------------------------------------------------------------- | --------------------------- |
| macOS    | `Shared/mama-<you>/members` (the Shared folder beside home folders) | `Shared/mama-<you>/tools`   |
| Linux    | `/var/lib/mama/<you>/members`                                       | `/var/lib/mama/<you>/tools` |

Setup makes them before the setup page opens, and refuses one that another account owns or can
write. On Linux they must exist first. The installer creates them once with `sudo`.

Jev (TypeSafe) stays off in setup. With it, the agent can ask Jev typed questions inside its
scripts (the `judge` action) to narrow many messages or items without reading them all. Owner text
in those calls goes to the Jev service, so it is off unless you choose it. `mama init --section jev`
turns it on, asks for a Jev API key, stored in `~/.mama/jev-key` (0600), and sets
`jev.enabled: true` in `config.yaml`; the same section turns it off. MAMA works the same without it.

The optional tunnel variables name the Cloudflare Access issuer, audience and viewer hostname.
Configure that Access application and tunnel separately; see [Viewer](../guides/viewer.md).

After the setup page, setup takes these steps in order:

1. writes the setup;
2. registers you as the first owner;
3. installs the document tools;
4. installs and starts the service (a LaunchAgent on macOS, a systemd user unit kept running
   after logout on Linux);
5. waits until MAMA reports it is running;
6. asks MAMA for one real turn of the backend, run as the service runs it. If it does not answer,
   setup says so and points to `mama logs` and `mama doctor`; after a fix, the install command
   checks again. This proves the backend as the common session runs it; your first message to the bot
   proves your personal session.

If a step fails, run the install command again: setup continues from that step.
Once setup is complete it does not run again. It also refuses to start while a MAMA daemon holds
the install.

Setup writes these files under `~/.mama/`:

| File              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `config.yaml`     | Backend, database, common Telegram channel, folders and wiki |
| `connectors.json` | Source channels, roles and credential variable names         |
| `auth.env`        | Tokens, mode 0600; includes a generated viewer bearer token  |
| `start.sh`        | Written by the service step: loads credentials, starts MAMA  |
| `jev-key`         | Jev API key, mode 0600; only when you chose Jev              |
| `workspace/`      | Agent files and the default `wiki/` directory                |
| `logs/`           | Daemon and security logs                                     |

The OS database defaults to `~/.mama/memory.db`. Development memory uses
`~/.claude/mama-memory.db`; keep the two data homes separate.

Each owner gets a personal member session; the common group keeps the common session. Private
chats cannot serve as the common channel: they always enter that person's intake. To add more
owners or members later, see [People and their DMs](../guides/people.md).

## What the install command makes

| Path                                        | What                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `~/.mama/node`                              | Node.js 22, the release the install command pins, checked against its SHA-256 hash  |
| `~/.mama/npm`                               | MAMA OS, installed with that Node's npm                                             |
| `~/.mama/bin/mama`                          | The `mama` command: MAMA OS run on that Node                                        |
| A marked block in your shell's startup file | Puts `~/.mama/bin` first on PATH, and `~/.local/bin` when the backend was put there |
| `/var/lib/mama/<you>` (Linux only)          | The parent of the member workspaces and document tools folders                      |

MAMA's service runs its own Node, so upgrading your Node or switching it with nvm does not stop
MAMA. Your own `node` and `npm` stay as they are.

- **The PATH block** sits between `# >>> mama >>>` and `# <<< mama <<<`. It goes in `~/.zshrc` for
  zsh; for bash, in `~/.bash_profile` on macOS or `~/.bashrc` on Linux; otherwise in `~/.profile`.
  For fish nothing is written, and the installer prints the line to add. Each run rewrites the
  block. New terminals read it; the agent's shell does not, so the agent uses full paths.
- **The backend.** A `claude` or `codex` that is on PATH and runs is used as it is. Otherwise the
  vendor's own installer puts it in `~/.local/bin`.
- **Linux** needs one `sudo` command, which the installer shows and runs once. It makes
  `/var/lib/mama/<you>` and turns on linger, so MAMA keeps running after you log out. If it cannot
  run, the installer prints it. Until it runs, setup needs `MAMA_INIT_MEMBER_ROOT` and
  `MAMA_INIT_TOOLS_ROOT` to name two other folders outside your home.

The installer can run again at any time. It skips what is in place, and on an install that is set
up it needs no options.

## A new Node.js release

`mama update` updates MAMA OS, not its Node. When a new release pins another Node.js, `mama update`
and `mama doctor` say to run the install command again. The agent runs it with no options.

- It downloads the new Node and checks its hash.
- It lets running turns finish, stops MAMA, swaps the new Node in and checks that MAMA starts on
  it.
- A new major version first rebuilds MAMA's packages for that Node, before anything stops.
- If a step fails, the old Node is put back and started.
- If the move is cut off, the next run of the install command finishes or undoes it.

Node.js 22 reaches its end of life on 2027-04-30.

## Install with your own Node.js

If you keep your own Node.js (22.13 or newer), install MAMA OS with npm instead:

```bash
npm install -g @jungjaehoon/mama-os
```

Then you or your agent run setup with its variables, and setup goes on as above from the setup
page:

```bash
MAMA_INIT_BACKEND=claude MAMA_INIT_MODEL=<model> mama init --non-interactive
```

If the backend is not signed in, setup names the sign-in: `claude auth login`, or for Codex,
`CODEX_HOME="$HOME/.mama/.codex" codex login` (MAMA's own Codex home, not the usual one). Run it,
then the same command again. See [Backends](../guides/backends.md).

MAMA's service runs the Node that ran setup. An upgrade or an nvm switch can take that Node away;
`mama doctor` checks it. `mama update` updates this install with npm.

To work from a checkout instead, run `pnpm install` and `pnpm build` at the repository root and
use `node packages/standalone/dist/cli/index.js` wherever the guides say `mama`.

## Supported versions

| What                         | Supported                                              | Source                                                                                                                           |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js (install command)    | Node.js 22, the release the install command pins       | [`install/node.json`](../../packages/standalone/install/node.json), installed and run in CI on macOS and Ubuntu                  |
| Node.js (your own, with npm) | 22.13 or newer                                         | `engines` in [`package.json`](../../packages/standalone/package.json)                                                            |
| Claude Code                  | 2.1.299 or newer                                       | [`backend-probe.ts`](../../packages/standalone/src/cli/runtime/backend-probe.ts); setup refuses an older one                     |
| Codex                        | 0.160.1 or newer                                       | [`backend-probe.ts`](../../packages/standalone/src/cli/runtime/backend-probe.ts); setup refuses an older one                     |
| macOS                        | 26.6 on Apple silicon, the version setup was proven on | A clean Mac account, set up through Claude Code ([checks](../development/checks.md)); Claude Code itself needs macOS 13 or newer |
| Linux                        | Not yet: a later release adds it                       | —                                                                                                                                |
| Docker                       | Not yet: there is no image; a later release adds it    | —                                                                                                                                |

Known limits:

- **SSH and headless Linux.** There is no setup path yet. The setup page listens only on the
  machine that runs MAMA, so a browser on another machine cannot reach it.
- **Document tools on a Mac without Homebrew.** The tools for office files and charts install with
  Homebrew and need python3 3.10 or newer. macOS ships python3 3.9.6. On a Mac account without its
  own Homebrew they fail to install: setup goes on without them, and `mama doctor` warns. Once
  Homebrew and a newer python3 are there, `mama tools install` adds them.

## Change one part later

`mama init --section <part>` asks one part of the setup again and saves it:

| Part               | What it asks                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `telegram`         | A new bot token; the bot must already be in the common group              |
| `model`            | The backend and model, checked as setup checks them                       |
| `timezone`         | Your time zone                                                            |
| `connectors`       | Sources to set up; those you name are set up again, the others stay as is |
| `discord`, `slack` | Owner messages on Discord or Slack, on or off; other settings stay        |
| `jev`              | Jev on or off; its key file stays when you turn it off                    |

Stop MAMA first with `mama stop`. Afterwards, `mama doctor` checks the install as MAMA will start
it (for example, that the service finds a backend you switched to), then `mama service start`
starts it. Answers are
checked before anything is saved, as MAMA checks its settings when it starts, so a change that
leaves a delivery route on a messenger you turned off is refused. Tokens go only to `auth.env`.
The folders cannot be changed this way, since member data lives in them. A `config.yaml` written
by hand is written again in plain YAML without its comments, and the command says so.

Each part asks its questions at a terminal, except sources: `--section connectors
--non-interactive` is the form your agent runs ([Sources, after MAMA answers](#sources-after-mama-answers)).

## The running service

`mama status` shows the daemon's boot stage, running turns, connectors and last error.
`mama stop` stops it and it stays stopped; after a failure the service manager restarts it.
`mama service restart` restarts it after a change. Only one daemon runs per install: a second
one is refused.

## Confirm the first useful answer

Send the bot a question about a known piece of work, with an original message or
file if needed. Confirm that the reply reaches Telegram, refers to the right work,
and distinguishes missing information from confirmed facts. Ask what evidence it
used and compare its answer with the original. Open
[the viewer](../guides/viewer.md) to inspect the task and board.

Setup through Claude Code has reached a Telegram reply on a clean Mac account; Linux and Docker
have not been verified. A running process or healthy HTTP response does not establish that login,
source collection or Telegram delivery works. Add a [source](../guides/connectors.md) and check an
actual source-backed answer before relying on reports.

To rotate a token, run `mama secret set MAMA_TELEGRAM_TOKEN` (or another supported
secret name) in your terminal, then restart the daemon. `mama secret list` prints
names only. For launchd restart/stop and setup errors, see
[Troubleshooting](../guides/troubleshooting.md).

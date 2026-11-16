---
title: Run MAMA OS in Docker
parent: Start
nav_order: 5
---

# Run MAMA OS in Docker

MAMA OS also runs as a container on Docker Engine on Linux. The image has everything MAMA needs:
Node.js, MAMA OS, Claude Code, Codex, `gws` and the document tools. Your data, settings and
sign-ins stay in two Docker volumes, so a new image keeps them.

Your agent runs the commands below. As in the [owner setup](owner-setup.md), you never paste a
token or a code into the chat with the agent.

## What you need

- Linux on x86-64 with Docker Engine and Docker Compose. It is tested on Ubuntu 24.04 with Docker
  Engine 29. Docker Desktop and arm64 are not tested yet.
- A user whose ID is 1000 (the first user on most Linux installs). The container's user is 1000,
  and the setup page's file must be readable by you.
- A browser on the same machine, for the setup page.
- A Telegram account, and a new bot from BotFather (see
  [The bot, before the command](owner-setup.md#the-bot-before-the-command)).

## Set up

1. Make a folder and fetch the compose file and the sandbox profile from the latest release:

   ```bash
   mkdir -p ~/mama/setup && cd ~/mama
   curl -fsSLO https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/compose.yaml
   curl -fsSLO https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/seccomp.json
   ```

2. Write `.env` beside them. `TZ` is your time zone: the container cannot read the host's, and
   setup and the report schedule use it. The model and backend are as in the
   [owner setup](owner-setup.md#the-command).

   ```bash
   printf 'TZ=%s\nMAMA_INIT_BACKEND=claude\nMAMA_INIT_MODEL=<model>\n' "$(timedatectl show -p Timezone --value)" > .env
   ```

3. Pull the image and sign in the backend inside it. The sign-in is kept in the volume.

   ```bash
   docker compose pull
   docker compose run --rm mama claude auth login
   ```

   The login prints a link. You open it in a browser and sign in. If the page then shows a code,
   you give it to your agent, which pastes it into the waiting login. The image also has Codex,
   but MAMA on Codex has not been tested in the image yet; use Claude.

4. Run setup:

   ```bash
   docker compose run --rm mama mama init --non-interactive
   ```

   Setup prints `setup page: open file:///…/setup/mama-setup-…/open.html`. You open that file in
   your browser. On the page you paste the bot token, send the bot a private message, and enter the
   code it answers with. Then add the bot to your work group as an administrator and send `/bind`
   there. These are the same steps as in the
   [owner setup](owner-setup.md#the-setup-page). Setup ends with
   `Setup written. Start MAMA with docker compose up -d`.

5. Start MAMA:

   ```bash
   docker compose up -d
   ```

   `docker compose ps` shows `healthy` once MAMA has started. Send your bot a message: setup is
   done when MAMA answers.

## Every day

| To                         | Run                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| See MAMA's state           | `docker compose exec mama mama status`                                                                                               |
| Check the install          | `docker compose exec mama mama doctor`                                                                                               |
| Read the log               | `docker compose exec mama mama logs`                                                                                                 |
| Change a part of the setup | `docker compose stop`, then `docker compose run --rm mama mama init --section <part> --non-interactive`, then `docker compose up -d` |
| Stop and start             | `docker compose stop`, `docker compose up -d`                                                                                        |
| Update to a new release    | `docker compose pull && docker compose up -d`                                                                                        |

`mama update` and `/update` do not run in the container. They name the pull above.

## What the container keeps and allows

- **Volumes.** `mama-home` holds the MAMA home (`~/.mama`) and the backends' sign-ins.
  `mama-data` holds the member and tools folders. Removing the container keeps both:
  `docker compose down` removes the container only, and `docker compose down -v` also deletes the
  data.
- **Network.** The container uses the host's network. The setup page and the
  [viewer](../guides/viewer.md) answer only on this machine's `127.0.0.1`, as on a Linux install.
- **The shell sandbox.** Every agent shell runs inside Claude's sandbox, as on a Linux install. It
  has no network except through MAMA's own proxy, which refuses every connection. It also cannot
  read MAMA's data or other people's folders. The sandbox needs user namespaces, which Docker's
  default seccomp profile blocks. `seccomp.json` is Docker's default profile with five more calls
  allowed (`clone`, `mount`, `pivot_root`, `umount2`, `unshare`). Everything else it blocks stays
  blocked. Do not replace it with `seccomp=unconfined`.

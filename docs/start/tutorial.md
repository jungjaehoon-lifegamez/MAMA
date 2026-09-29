---
title: Your first day with MAMA
parent: Start
nav_order: 1
---

# Your first day with MAMA

This walkthrough builds MAMA OS from source, connects Telegram and one work source, and shows
where to inspect the results. Examples use fictional work and synthetic identifiers. This walkthrough uses Telegram;
Discord and Slack work the same way. See the [messengers guide](../guides/messengers.md).

## 1. Install dependencies and build

Use Node.js 22.13 or later, pnpm, and an authenticated Claude or Codex CLI. From the repository
root, type:

```bash
node --version
pnpm install
pnpm build
```

For this unreleased rebuild, run the command from the checkout:

```bash
node packages/standalone/dist/cli/index.js
```

**You should see:** the `mama` usage line listing `init`, `secret`, `daemon`, `replay`, `status`,
and `stop`.

**Check:** confirm Node is at least 22.13 and the build completed. Running `mama` without a
command prints the same usage.

**If not:** install the Node and pnpm versions required above, run `pnpm install`, then `pnpm
build` again. For package-specific setup, see [Owner setup](owner-setup.md).

## 2. Create the local installation

Create a Telegram bot and open a private chat with it. Have the numeric owner chat id and sender
user id ready. In your terminal, type:

```bash
node packages/standalone/dist/cli/index.js init
```

At the prompts, enter `claude` or `codex`, the model name, your timezone (press Enter to keep this
machine's timezone), the Telegram bot token, chat id, and user id. Tokens are typed into hidden prompts. Do not paste them into chat or a configuration
file. When asked which connectors to enable, type `slack` (or `chatwork`) and enter its token
and channel ids. To skip a source for now, leave the connector list blank. Enable the launch agent
if you want macOS to manage the daemon.

**You should see:** `Setup written. Credentials are stored only in auth.env (0600).` The final
lines tell you how to log into the selected model CLI and how to start MAMA.

**Check:** `~/.mama/config.yaml` contains no tokens; `~/.mama/auth.env` holds credentials and
has mode 0600. `mama init` writes source selections into `connectors.json`.

**If not:** `init` requires a real terminal and will refuse to overwrite an existing installation.
For an existing `~/.mama/config.yaml`, stop and review the [setup guide](owner-setup.md) before
changing files. For missing or invalid prompts, correct the value and run `init` again only after
reviewing its no-overwrite message.

## 3. Start MAMA

First authenticate the model CLI if needed. Then use the start command printed by `init`. If you
chose a launch agent, type the printed `launchctl bootstrap` command. Otherwise start the generated
script:

```bash
~/.mama/start.sh
```

In another terminal, check the process:

```bash
node packages/standalone/dist/cli/index.js status
```

**You should see:** `running` from `status`; the daemon logs startup in `~/.mama/logs/daemon.log`.

**Check:** the next step is the real check: send a message to the bot and confirm a reply reaches
your Telegram chat. A running process by itself does not prove the owner flow works.

**If not:** use `node packages/standalone/dist/cli/index.js status`, then read the daemon log for
the failed startup stage. Check the backend login and the environment path in `~/.mama/start.sh`.

## 4. Ask your first question in Telegram

Send a simple message to confirm the bot can reply, for example:

> Can you receive this message? Please reply when you are ready.

**You should see:** a short reply such as, “I’m ready. What would you like help with?”

**Check:** confirm the reply reaches the same Telegram chat and answers your message.

**If not:** verify that the chat id and sender user id match the values entered during `init`, the
bot token is present, and the daemon log shows Telegram polling. See [Telegram troubleshooting](../guides/telegram.md).

## 5. Connect one source and ask about a work item

If you selected Slack or Chatwork during `init`, confirm that its account and channel are
available to the token you entered. If you did not select a source, `mama init` will not overwrite
the installation: follow [connector configuration](../guides/connectors.md) to add one to
`connectors.json` and set its token with `mama secret set MAMA_SLACK_TOKEN` or
`mama secret set MAMA_CHATWORK_TOKEN` in a terminal.

After the source has been collected, ask in Telegram:

> What changed on the sample launch checklist, and what is still open?

**You should see:** a concise answer grounded in the source messages and the work history, for
example, “The draft is ready for review; the image approval is still open.”

**Check:** open the viewer at `http://127.0.0.1:3847` and inspect the board and work item. Compare
the answer with the source conversation.

**If not:** check the source token, channel id, connector configuration, and daemon log. A
connected account alone does not prove MAMA has collected the relevant messages.

## 6. Correct an answer and approve a workflow

When an answer needs a correction, reply in Telegram with the accurate detail and how it should
apply. For example:

> The sample checklist is reviewed by the design group. For future launch checklists, ask for
> design review before calling the draft ready.

When MAMA asks whether to keep this as a way of working, confirm. You can also ask directly:

> Save that as the workflow for future launch checklists.

**You should see:** MAMA confirms that it saved the guidance or workflow. The wording will vary.

**Check:** ask a related question in a later owner conversation and see whether the guidance is
used for a launch checklist. Open the viewer's memory view to inspect saved guidance.

**If not:** clarify the situations where the rule applies and ask MAMA to save it again. Verify
the next related answer; a confirmation message alone does not prove the guidance changed a later
answer.

## 7. Receive a delta notification and a full report

When a connected source adds a new message, MAMA can send a delta notification to the owner. A
full report is scheduled for 08:00, 13:00, and 18:00 in your timezone by default. If your
timezone changes, tell MAMA in the owner chat, for example "My timezone is Europe/Berlin"; the
next report follows it without a restart. There is no report
command in the current CLI; ask for the full report in the owner chat in your own words, or leave
the daemon running and wait for the next source change or report time.

**You should see:** a Telegram notification summarizing a new change, and a scheduled report with
sections such as briefing, actions needed, decisions, and pipeline. These are example shapes, not
guaranteed output.

**Check:** compare a notification with the source message and open the viewer board to see the
updated work. Check Telegram delivery and the daemon log for the scheduled report.

**If not:** confirm the daemon remains running, the source is polling, and the report window is
enabled in `config.yaml`. Scheduled report delivery has not yet been verified on a fresh machine;
see [reports and the board](../guides/reports-and-board.md).

## 8. Open the board, work history, wiki, and send a file

Open the local viewer at `http://127.0.0.1:3847`. Use the navigation to view the board, a work
item, memory, and wiki. In Telegram, send a small sample document with a request such as:

> Summarize this sample agenda and send me the result as a file.

**You should see:** the viewer pages show saved work and wiki content. If the agent can read the
document and complete the request, it replies in Telegram and sends the result file there.

**Check:** compare the returned file with the request and original. The inbound attachment is
downloaded under `~/.mama/downloads/`; the agent's working copy belongs in its workspace. Check the
viewer and the Telegram message for the final result.

**If not:** confirm the Telegram message reached the bot and inspect the daemon log for attachment
or delivery errors. The first live download-copy-deliver run has not yet been observed; see the
[viewer guide](../guides/viewer.md) and [messengers guide](../guides/messengers.md).

To stop a manually started daemon, use:

```bash
node packages/standalone/dist/cli/index.js stop
```

See the full [CLI reference](../reference/cli.md) and [security guide](../guides/security.md).

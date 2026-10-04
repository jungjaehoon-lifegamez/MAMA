---
title: Telegram
parent: Guides
nav_order: 5
---

# Telegram owner gateway

For setup and shared Telegram, Discord, and Slack delivery rules, see the [messengers guide](messengers.md).

Telegram is an owner conversation gateway. Its direct replies return to the Telegram chat;
reports, notifications, and security alerts use the routes in `delivery`. Set it up with
[`mama init`](../start/owner-setup.md), using a bot token entered in your terminal.
The daemon reads `MAMA_TELEGRAM_TOKEN` from the environment loaded by
`~/.mama/start.sh`. A `telegram.token` entry in YAML is rejected.

## Set the owner identity

The `telegram` section of `~/.mama/config.yaml` contains:

| Setting          | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `enabled`        | Start the Telegram gateway                                          |
| `owner_chat_id`  | Destination for owner reports and files                             |
| `allowed_chats`  | Chats allowed to reach the owner check; must include the owner chat |
| `owner_user_ids` | Senders accepted as the owner                                       |
| `polling`        | Receive messages; defaults to `true`                                |
| `file_delivery`  | Let MAMA send files to the owner chat; defaults to `true`           |

Both the chat and sender must pass the owner check. Other messages are dropped;
logs contain hashed chat and sender IDs, without their message content. Setup
writes the explicit owner sender ID. In a manual configuration without
`owner_user_ids`, one positive allowlisted chat ID can supply that owner identity.
Use explicit IDs when the chat and sender are different.

Send a private message to the bot and confirm the reply. `polling: false` stops
inbound polling but does not prove another process is receiving messages.

## Send originals and receive results

Send a document or image with a caption explaining the request. Accepted files are
stored under `~/.mama/downloads/telegram/` and attached to the owner turn.
The agent can read this directory but cannot write to it. Before modifying, unzipping,
or delivering a download, copy it into `~/.mama/workspace/files/`. Telegram downloads
are limited to 20 MiB.

For a source attachment, ask MAMA to find the original message and inspect its
files. The current attachment actions list and download Chatwork and Slack files;
shared connector downloads go to `~/.mama/downloads/<source>/<safe room>/` and are
limited to 50 MiB.

Ask MAMA to save edited output as a new file and send it back. The
`deliver.telegram.file` action sends a regular file inside the workspace's
`files/` directory to `owner_chat_id`. Its size check allows at most 50 MiB;
recognized image extensions are sent as photos and other files as documents.
Provider-specific restrictions can still reject a file.

Delivery is recorded in the Telegram message ledger. If a send is uncertain,
check the original receipt before requesting another send. Confirm the file is
visible in the owner chat and opens correctly.

## Rotate the bot token

```bash
mama secret set MAMA_TELEGRAM_TOKEN
mama secret list
```

Enter the replacement with echo off, then
[restart the daemon](troubleshooting.md#restart-or-stop-a-launchd-service).
The list command shows names, never values. For a silent bot, check the owner
identity, polling state and recent daemon errors before changing credentials.

---
title: Telegram
parent: Guides
nav_order: 5
---

# Telegram conversations

For setup and shared Telegram, Discord, and Slack delivery rules, see the [messengers guide](messengers.md).

Telegram admits registered members in their own DMs and owners in the common group. Replies return to the input chat;
reports, notifications, and security alerts use the routes in `delivery`. Set it up with
[`mama init`](../start/owner-setup.md), using a bot token entered in your terminal.
The daemon reads `MAMA_TELEGRAM_TOKEN` from the environment loaded by
`~/.mama/start.sh`. A `telegram.token` entry in YAML is rejected.

## Register people and set the common channel

The `telegram` section of `~/.mama/config.yaml` contains:

| Setting         | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `enabled`       | Start the Telegram gateway                                     |
| `owner_chat_id` | Common destination for reports, notices, alerts and files      |
| `allowed_chats` | Allowed common group channels; must include the common channel |
| `polling`       | Receive messages; defaults to `true`                           |
| `file_delivery` | Let MAMA send files; defaults to `true`                        |

Set `member_root` outside HOME and stop the daemon. Remove `telegram.owner_user_ids` if present,
then run `mama register-owner <telegram id>` for each owner. Each person becomes a member with
the `owner` role and a separate session, workspace and personal records. The first owner's older
DM chat and checkpoints move to its personal scope; group chat stays common.

An active member's private DM is admitted through the registry even when absent from
`allowed_chats`. An allowed group admits only active members with the `owner` role. Unregistered
and inactive senders get no reply. Owner DMs can read common records through MAMA actions;
common changes must be requested in the common channel. DM sessions use member tools without
web access. Enrolling members is not available yet.

Send a private message to the bot and confirm the reply. `polling: false` stops
inbound polling but does not prove another process is receiving messages.

## Send originals and receive results

Send a document or image with a caption explaining the request. Accepted files are
stored under that person's `member_root/<principal>/downloads/telegram/` for a DM, or
`~/.mama/downloads/telegram/` for a group, and attached to that room's turn.
The agent can read this directory but cannot write to it. Before modifying, unzipping,
or delivering a download, copy it into that session's workspace `files/` directory. Telegram downloads
are limited to 20 MiB.

For a source attachment, ask MAMA to find the original message and inspect its
files. The current attachment actions list and download Chatwork and Slack files;
shared connector downloads go to `~/.mama/downloads/<source>/<safe room>/` and are
limited to 50 MiB.

Ask MAMA to save edited output as a new file and send it back. The
`deliver.telegram.file` action sends a regular file inside the workspace's
`files/` directory to the person's registry DM from a member session, or to `owner_chat_id`
from the common session. Its size check allows at most 50 MiB;
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

---
title: Messengers
parent: Guides
nav_order: 1
---

# Talk to MAMA on Telegram, Discord, or Slack

MAMA accepts owner messages through enabled Telegram, Discord, and Slack gateways. A direct reply returns through the gateway that accepted the message. Scheduled reports, `[notify]` results, and viewer security alerts each use their configured single messenger route.

## Configure an owner gateway

`mama init` asks whether to enable optional Discord and Slack owner gateways and stores their credentials in `~/.mama/auth.env`, never in YAML. Telegram uses `MAMA_TELEGRAM_TOKEN`; Discord uses `MAMA_DISCORD_TOKEN`; Slack uses `MAMA_SLACK_TOKEN` and `MAMA_SLACK_APP_TOKEN` for Socket Mode. Set or rotate these with the CLI secret command when needed.

Each enabled gateway requires an owner destination and allowlists. Telegram uses a negative
group or supergroup ID in `owner_chat_id`, also listed in `allowed_chats`, for the common channel.
A solo owner creates a group with the bot for common changes. Positive private chat IDs are
rejected because private chats always enter the person's intake. Registered members
use their own DMs, and the `owner` role admits a person in an allowed group. Register each owner
with `mama register-owner <telegram id>` while the daemon is stopped. Discord and Slack use `owner_channel_id`, `allowed_channels`, and `owner_user_ids`. Discord and Slack keep their common owner intake. Messages from other senders are dropped before the owner session and the daemon logs hashed channel and sender IDs.

Member management needs a registered person's message turn from an active owner-role member.
Use that owner's Telegram DM or an allowed Telegram common channel. Discord and Slack common
turns do not record a registered sender, so enrollment and member-management actions are refused
there. Management receipts are kept in the common record; every owner can list enrollment results
from either their own Telegram DM or the common channel.

```yaml
discord:
  enabled: true
  owner_channel_id: 'channel_test'
  allowed_channels: ['channel_test']
  owner_user_ids: ['user_test']
slack:
  enabled: false
  owner_channel_id: ''
  allowed_channels: []
  owner_user_ids: []
delivery:
  reports: telegram
  notifications: discord
  security_alerts: telegram
```

Every delivery route must name an enabled gateway with an allowlisted owner destination. A bad route stops daemon startup instead of sending through another gateway.

A file over the messengers' 50 MB limit can go to a Google Drive folder instead (`deliver.drive.file`, up to 2 GiB, through the gws CLI the Drive reader uses). Name the folder and who may read each delivered file; without this section the action is not offered:

```yaml
delivery:
  drive:
    folder: 'drive-folder-id'
    readers:
      - domain: example.com # everyone in a Workspace domain
      - group: team@example.com # or a Google group
      - user: someone@example.com # or one account
```

Readers are set on each file as it is sent, so changing the list affects later files only, and each receipt names the readers MAMA set. No public link is made. A Workspace whose default sharing gives its domain read access adds that reader to every new file and folder as well, so a list narrower than the domain also needs that default turned off for the account. A retry of the same operation returns the file already sent instead of uploading it again; the receipt carries the link, size, md5 and sha256.

The owner turn names the output format for its destination: Telegram uses the supported HTML tag subset and no Markdown, Discord uses Markdown, and Slack uses mrkdwn. Direct replies use the messenger that received the message; scheduled reports and `[notify]` results use their configured route.

## Attachments and replies

Owner attachments are saved to the daemon-owned `~/.mama/downloads/<messenger>/` directory. The owner agent can read those files but cannot write there. Copy a file into `~/.mama/workspace/files/` before modifying or sending it. Use the matching `deliver.telegram.file`, `deliver.discord.file`, or `deliver.slack.file` action; its receipt prevents a completed operation from being sent again. A messenger's file action exists only while that messenger is enabled and its `file_delivery` setting is on (the default); set `file_delivery: false` under `telegram`, `discord` or `slack` to stop MAMA sending files there, and restart the daemon.

The daemon records accepted input, response state, chunk progress, destinations, and send uncertainty in one durable owner-message ledger. Slack acknowledges a Socket Mode event only after the owner input is accepted durably. On restart, each gateway recovers only its own ledger entries: known-unsent replies resume, abandoned owner turns receive an interruption notice, and ambiguous sends remain marked uncertain for reconciliation. One failed recovery entry is logged without stopping recovery of later entries or gateway startup.

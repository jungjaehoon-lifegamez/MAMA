---
title: Messengers
parent: Guides
nav_order: 1
---

# Talk to MAMA on Telegram, Discord, or Slack

MAMA accepts owner messages through enabled Telegram, Discord, and Slack gateways. A direct reply returns through the gateway that accepted the message. Scheduled reports, `[notify]` results, and viewer security alerts each use their configured single messenger route.

## Configure an owner gateway

`mama init` asks whether to enable optional Discord and Slack owner gateways and stores their credentials in `~/.mama/auth.env`, never in YAML. Telegram uses `MAMA_TELEGRAM_TOKEN`; Discord uses `MAMA_DISCORD_TOKEN`; Slack uses `MAMA_SLACK_TOKEN` and `MAMA_SLACK_APP_TOKEN` for Socket Mode. Set or rotate these with the CLI secret command when needed.

Each enabled gateway requires an owner destination and allowlists. Telegram uses `owner_chat_id`, `allowed_chats`, and `owner_user_ids`. Discord and Slack use `owner_channel_id`, `allowed_channels`, and `owner_user_ids`. A DM channel is a channel for the owner check. Messages from other senders are dropped before the owner session and the daemon logs hashed channel and sender IDs.

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

Readers are set on each file as it is sent, so changing the list affects later files only, and each receipt names exactly who can read that file. No public link is made, and the folder itself is shared with no one. A retry of the same operation returns the file already sent instead of uploading it again; the receipt carries the link, size, md5 and sha256.

The owner turn names the output format for its destination: Telegram uses the supported HTML tag subset and no Markdown, Discord uses Markdown, and Slack uses mrkdwn. Direct replies use the messenger that received the message; scheduled reports and `[notify]` results use their configured route.

## Attachments and replies

Owner attachments are saved to the daemon-owned `~/.mama/downloads/<messenger>/` directory. The owner agent can read those files but cannot write there. Copy a file into `~/.mama/workspace/files/` before modifying or sending it. Use the matching `deliver.telegram.file`, `deliver.discord.file`, or `deliver.slack.file` action; its receipt prevents a completed operation from being sent again. A messenger's file action exists only while that messenger is enabled and its `file_delivery` setting is on (the default); set `file_delivery: false` under `telegram`, `discord` or `slack` to stop MAMA sending files there, and restart the daemon.

The daemon records accepted input, response state, chunk progress, destinations, and send uncertainty in one durable owner-message ledger. Slack acknowledges a Socket Mode event only after the owner input is accepted durably. On restart, each gateway recovers only its own ledger entries: known-unsent replies resume, abandoned owner turns receive an interruption notice, and ambiguous sends remain marked uncertain for reconciliation. One failed recovery entry is logged without stopping recovery of later entries or gateway startup.

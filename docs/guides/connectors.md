---
title: Connect work sources
parent: Guides
nav_order: 3
---

# Connect work sources

Sources collect evidence for the owner agent. Once MAMA has answered you, your agent asks which
sources MAMA should watch and sets up the ones you pick; you can also ask for one at any time
([owner setup](../start/owner-setup.md#sources-after-mama-answers)).

- With MAMA stopped, the agent runs `mama init --section connectors --non-interactive` (on an
  install the install command made, `~/.mama/bin/mama`), with the sources' blocks, in the shape
  shown below, as one JSON object in `MAMA_INIT_CONNECTORS`.
- A block replaces that source's whole entry in `connectors.json`, and channels it leaves out stop
  being collected. To add a channel to a source that is already on, the block lists its current
  channels too.
- A block names its secrets and never holds one. You enter the tokens on the setup page MAMA opens
  in your browser, never in the chat, and they go only to `auth.env`.
- The Slack and Discord sources read the same token as MAMA's Slack and Discord messengers
  (`MAMA_SLACK_TOKEN`, `MAMA_DISCORD_TOKEN`). If you use both, enter that same bot's token: another
  one replaces the messenger's.
- The command checks each block as MAMA's start does, and a Google source's `gws` and sign-in, and
  saves nothing until those pass. A token is not tried with its service, so check on the viewer's
  Connectors page that the source collects. The command leaves MAMA stopped, and the agent starts
  it again.

A `connectors.json` edited by hand is checked only when MAMA starts.

| Connector     | What it collects                                                  | Authentication                         | Channel settings                                    |
| ------------- | ----------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| `chatwork`    | Configured room messages and attachments                          | `MAMA_CHATWORK_TOKEN`                  | Room IDs                                            |
| `slack`       | Configured channel messages and attachments                       | `MAMA_SLACK_TOKEN`                     | Channel IDs                                         |
| `trello`      | Configured boards, cards and activity                             | `MAMA_TRELLO_KEY`, `MAMA_TRELLO_TOKEN` | `boardId`                                           |
| `kagemusha`   | Retained messages and tasks from the local database               | Read-only database access              | Retained source IDs                                 |
| `calendar`    | Primary-calendar events, including cancellations                  | Logged-in `gws` CLI                    | The key `calendar`                                  |
| `gmail`       | Message IDs, subject, sender and snippet for new mail             | Logged-in `gws` CLI                    | The key `inbox`                                     |
| `drive`       | File changes, metadata and removals in selected folders or drives | Logged-in `gws` CLI                    | `folderId` or `driveId`                             |
| `sheets`      | Current rows and row changes in selected ranges                   | Logged-in `gws` CLI                    | `spreadsheetId`, `sheetRange`, optional `dataRange` |
| `ical`        | Events in the calendar feeds you add                              | `MAMA_ICAL_URL_<NAME>`, the feed's URL | A feed key, `name` and `feedName`                   |
| `notion`      | Shared page titles and block text                                 | `MAMA_NOTION_TOKEN`                    | One workspace channel                               |
| `obsidian`    | Markdown notes in selected vault paths                            | None                                   | `vaultPath` on each channel                         |
| `discord`     | Messages from selected channels                                   | `MAMA_DISCORD_TOKEN`                   | Channel IDs                                         |
| `telegram`    | Text messages from selected chats                                 | `MAMA_TELEGRAM_SOURCE_TOKEN`           | Chat IDs                                            |
| `imessage`    | Text messages from selected chats                                 | None                                   | Chat IDs                                            |
| `claude-code` | User and assistant messages in selected Claude Code projects      | None                                   | Project directory names and display aliases         |

Tokens belong in `~/.mama/auth.env`, never in `connectors.json`. Restart through `start.sh` after
changing credentials so the daemon loads them. Telegram is the owner messenger today; Discord
and Slack are selectable messengers. See the [Telegram guide](telegram.md). The owner messenger
uses `MAMA_TELEGRAM_TOKEN`;
the Telegram source connector uses a separate bot and `MAMA_TELEGRAM_SOURCE_TOKEN` so both do not
poll the same update stream.

Supported channel roles are `truth`, `hub`, `deliverable`, `spoke`, `reference`, and `ignore`.
`ignore` excludes a configured channel from collection. Roles describe a source; they do not assign
work or decide completion. The agent judges those from evidence.

## Google sources

Gmail, Calendar, Drive and Sheets run Google's `gws` command, signed in through an OAuth client of
your own. They need no MAMA token. Your agent sets one up in this order:

1. **The OAuth client.** In Google Cloud Console you create a project and enable the APIs your
   sources use: `gmail.googleapis.com`, `calendar-json.googleapis.com`, `drive.googleapis.com` and
   `sheets.googleapis.com`. You set up the OAuth consent screen by account:
   - **A gmail.com account:** user type External. Fill in the app name and support email, add
     yourself as a test user while setting up, then press "Publish app" so the app is In
     production. Google may also want a homepage and a privacy policy URL before it publishes;
     that has not been measured yet. The first sign-in shows "Google hasn't verified this app":
     choose Advanced, then continue. After that the sign-in does not end after 7 days. Google's
     [personal-use exception](https://support.google.com/cloud/answer/13464323) lets an app with
     fewer than 100 users run unverified this way.
   - **A Google Workspace account:** user type Internal. There is no warning, no test user and no
     7-day end.

   Then you create an OAuth client of type Desktop app and download its JSON. The agent saves that
   file as `~/.config/gws/client_secret.json` (mode 0600). It is gws's own credential, not a MAMA
   secret, so it does not go through the setup page.

2. **gws.** While MAMA's service cannot find `gws`, the enabling command saves nothing and prints
   the command that installs it. On an install the install command made, that command uses MAMA's
   own Node and puts `gws` in `~/.mama/npm`; otherwise it is `npm install -g @googleworkspace/cli`
   or `brew install googleworkspace-cli`. The agent runs it.
3. **The sign-in.** While `gws` cannot read for the new source, the enabling command saves nothing
   and prints the login, `gws auth login -s <services>`. It names the service of every Google
   source that is on, since one sign-in serves them all. The agent runs it, and you complete
   Google's consent in your browser.
4. **Enabling.** The agent runs the enabling command again. It saves the source, and the agent
   starts MAMA.

If the client is left in Testing, Google ends the sign-in after 7 days. MAMA keeps running, but the
Google sources' polls fail, and `mama doctor` names the login to run again.

### Gmail

Gmail polls messages after the last successful poll and keeps the Gmail message ID and provider
event time. It reads the subject, sender and snippet. Configure exactly one channel named `inbox`.

```json
{
  "gmail": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "inbox": { "role": "hub" } },
    "auth": { "type": "cli", "cli": "gws" }
  }
}
```

### Drive

Drive records file changes and removals in configured folders or shared drives. It stores file IDs as
source identity and does not download file contents. Use `folderId` for a folder in My Drive or
`driveId` for a shared drive.

For a current file, the agent can use `drive.read` to list shared drives, browse a folder, inspect
a file by ID or link, or search across drives. `drive.download` saves a requested file in the
downloads directory; in an owner's DM, in that person's own downloads. Google Docs, Sheets and Slides are exported as docx, xlsx and pptx; folders and
other Google-native types are refused. These live reads do not
keep a copy of Drive state. The separate connector above stores file change observations only when
it is enabled.

```json
{
  "drive": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "folder-fixture": { "role": "reference", "folderId": "folder-fixture" }
    },
    "auth": { "type": "cli", "cli": "gws" }
  }
}
```

### Sheets

Sheets compares snapshots and reports changed, new and deleted rows. A row's identity is its first
nonempty cell; its source ID also includes the spreadsheet and configured channel so equal row keys
from separate ranges do not collide. The source timestamp is the poll time. If that cell changes,
the connector sees a new row identity; choose a stable key column for the range.

```json
{
  "sheets": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "sheet-fixture": {
        "role": "truth",
        "spreadsheetId": "spreadsheet-fixture",
        "sheetRange": "Records!A1:C",
        "dataRange": "Records!A2:C"
      }
    },
    "auth": { "type": "cli", "cli": "gws" }
  }
}
```

When `dataRange` is omitted, `sheetRange` includes the header row and the data rows.

### Calendar

Calendar reads upcoming events through 90 days ahead. On its first poll it collects
the whole window, including events created earlier; later polls use the change cursor.
Add calendars under `channels` with their Google calendar id and a display name. This
also lets a holiday calendar appear in `schedule.upcoming`.

```json
{
  "calendar": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "primary": { "role": "reference", "calendarId": "primary", "name": "Main calendar" },
      "holidays": {
        "role": "reference",
        "calendarId": "holiday-calendar-id",
        "name": "Public holidays"
      }
    },
    "auth": { "type": "cli", "cli": "gws" }
  }
}
```

### iCal feeds

An iCal feed is configured as a channel. Its private URL is a secret: you enter it on the setup
page, and it is never written into connector configuration or poll logs. Use an uppercase feed key
for the matching secret name.

Date-only and floating event times use the owner's configured time zone when read. The connector
retains each DTSTART and DTEND value and its value kind, so changing the owner time zone does not
change the archived event. DTSTART with DURATION is supported; an event without DTEND or DURATION
ends at its start, except that a date-only start lasts one day. RRULE and EXDATE recurrence
expansion is not supported.

```json
{
  "ical": {
    "enabled": true,
    "pollIntervalMinutes": 30,
    "channels": {
      "stays": { "role": "reference", "name": "Reservations", "feedName": "Stay calendar" }
    },
    "auth": { "type": "token", "tokenName": "MAMA_ICAL_URL_STAYS" }
  }
}
```

The feed key `stays` maps to `MAMA_ICAL_URL_STAYS`. MAMA stores event revisions
by UID, removes the latest cancelled revision from upcoming results, and reports
fetch or parse failures with the configured feed name. `schedule.upcoming` combines
these events with every configured Google calendar.

## Messaging sources

### Chatwork

Chatwork collects messages and attachment references from each configured room.

```json
{
  "chatwork": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "room-fixture": { "role": "hub" } },
    "auth": { "type": "token", "tokenName": "MAMA_CHATWORK_TOKEN" }
  }
}
```

### Slack

Slack collects messages and attachment references from configured channels.

```json
{
  "slack": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "channel-fixture": { "role": "hub" } },
    "auth": { "type": "token", "tokenName": "MAMA_SLACK_TOKEN" }
  }
}
```

### Discord

Discord collects messages from the selected channel IDs. The token is read from `auth.env`.

```json
{
  "discord": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "channel-fixture": { "role": "hub" } },
    "auth": { "type": "token", "tokenName": "MAMA_DISCORD_TOKEN" }
  }
}
```

### Telegram source

The source connector collects text messages from selected chats. It does not collect attachments.
Give it a separate source bot token; the owner messenger continues to use `MAMA_TELEGRAM_TOKEN`.
It commits one page of up to 100 updates per poll; a larger backlog continues on later polls after
the current page has been captured.

```json
{
  "telegram": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "chat-fixture": { "role": "hub" } },
    "auth": { "type": "token", "tokenName": "MAMA_TELEGRAM_SOURCE_TOKEN" }
  }
}
```

## Work and knowledge sources

### Trello

Trello reads configured boards, their cards and activity. Set `boardId` to the board ID.

```json
{
  "trello": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "board-fixture": { "role": "truth", "boardId": "board-fixture" } },
    "auth": { "type": "token", "tokenName": "MAMA_TRELLO_TOKEN" }
  }
}
```

Trello also reads `MAMA_TRELLO_KEY`; the setup page takes it beside the token.

For current board state, the agent uses `trello.read` to list configured boards, read open cards,
inspect a card, or search cards. These reads go to Trello and do not keep a board snapshot. The
connector stores board actions as source history; the agent searches that history with
`source.search` and opens a cited action with `source.read` when it needs to explain a past change.

### Notion

Notion reads pages shared with the integration, including page titles and block text. It does not
search pages the integration cannot access. Create an integration, share the pages with it, and store
the integration token in `MAMA_NOTION_TOKEN`.

```json
{
  "notion": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "workspace": { "role": "hub", "name": "Notion workspace" } },
    "auth": { "type": "token", "tokenName": "MAMA_NOTION_TOKEN" }
  }
}
```

### Obsidian

Obsidian reads Markdown files from each configured vault path. The source metadata uses paths
relative to that vault; it does not publish the absolute vault path.

```json
{
  "obsidian": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "vault-fixture": {
        "role": "reference",
        "name": "Notes",
        "vaultPath": "/path/to/vault"
      }
    },
    "auth": { "type": "none" }
  }
}
```

### iMessage

iMessage reads text messages from selected chats in `~/Library/Messages/chat.db`. The daemon process
needs Full Disk Access in System Settings > Privacy & Security. Select chat identifiers explicitly.

```json
{
  "imessage": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "chat-fixture": { "role": "reference" } },
    "auth": { "type": "none" }
  }
}
```

### Claude Code

Claude Code reads user and assistant messages from selected project directories under
`~/.claude/projects`. Give each selected directory a display alias; normalized source metadata uses
that alias instead of the encoded local project directory name. Complete message content is retained.

```json
{
  "claude-code": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": {
      "project-fixture": { "role": "reference", "name": "Project notes" }
    },
    "auth": { "type": "none" }
  }
}
```

## Local retained sources

### Kagemusha bridge

The bridge opens `~/.kagemusha/kagemusha.db` read-only. Channel keys can use
`kagemusha:<origin>:<channel-id>` for configured retained message sources.

```json
{
  "kagemusha": {
    "enabled": true,
    "pollIntervalMinutes": 5,
    "channels": { "kagemusha:fixture-origin:fixture-channel": { "role": "reference" } },
    "auth": { "type": "none" }
  }
}
```

## Check collection

Open the viewer's Connectors page or request `GET /api/connectors/status` on the local viewer.
Inspect `healthy`, `lastPollTime`, `lastPollCount`, and `error`, then ask the owner agent about a
known recent source change and compare it with the original. Failed page fetches are surfaced as poll
errors; do not read an empty batch as proof that no source changed.

Without a saved cursor, live collection starts with a one-day lookback. Historical imports use the
separate [replay workflow](replay.md). Chatwork returns only its latest 100 messages per room, so a
busier room can lose coverage between polls.

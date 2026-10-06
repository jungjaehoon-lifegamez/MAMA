---
title: Backfill a past period
parent: Guides
nav_order: 9
---

# Backfill a past period

Backfill records a past period in one go. Each piece of work goes in with its whole history, from
start to end, together with what was learned and the wiki pages for that period. Someone reads the
period's originals and writes one file. `mama backfill` checks the file and writes it through the
owner's own actions. It decides nothing itself.

Use [replay](replay.md) when you want the owner agent to read the period day by day. Use backfill
when the whole period has already been read and you want to record what happened.

There are three steps: import the originals, write the file, run the command.

## 1. Import the period's originals

Every record cites the originals it came from, so they must be in MAMA first. Stop the daemon, then
import the period with an explicit start and end (the end is not included):

```bash
launchctl bootout gui/$(id -u)/com.mama.server
node scripts/replay/import-september.mjs \
  --mama-db ~/.mama/mama-memory.db \
  --raw-root ~/.mama/connectors \
  --connectors-config ~/.mama/connectors.json \
  --manifest ~/.mama/runtime/backfill/2026-08-import-manifest.json \
  --from 2026-08-01T00:00:00+09:00 --until 2026-09-01T00:00:00+09:00
```

The script imports the local message archive and the Trello board actions for the period. It needs
`TRELLO_API_KEY` and `TRELLO_TOKEN` in its environment. Pass `--mama-db` as the database path in
your `config.yaml`, and give each period its own manifest so the replay manifest is left alone.
Importing the same messages a second time adds nothing.

## 2. Write the file

The file is JSON in the `mama-backfill/1` format:

```json
{
  "format": "mama-backfill/1",
  "period": { "from": "2026-08-01T00:00:00+09:00", "until": "2026-09-01T00:00:00+09:00" },
  "items": [
    {
      "key": "poster-a",
      "topic": "poster A",
      "revisions": [
        {
          "at": "2026-08-03T09:55:00+09:00",
          "summary": "Files received; work assigned",
          "set": { "title": "Poster A", "status": "pending" },
          "sources": ["chat:room-1:101"]
        },
        {
          "at": "2026-08-24T16:04:00+09:00",
          "summary": "Client approved the final version",
          "set": { "status": "done" },
          "sources": ["chat:room-2:240"]
        }
      ],
      "mentions": [{ "reason": "progress notes", "sources": ["chat:room-1:130"] }]
    },
    {
      "key": "poster-b",
      "commitmentId": "commitment_...",
      "revisions": [
        {
          "at": "2026-08-26T17:43:00+09:00",
          "summary": "Files for next month received",
          "set": { "title": "Poster B", "status": "pending" },
          "sources": ["chat:room-1:180"]
        }
      ]
    }
  ],
  "links": [],
  "lessons": [
    {
      "key": "source-images",
      "at": "2026-08-18T18:44:00+09:00",
      "topic": "source images",
      "summary": "Workers do not edit the source images",
      "details": "Stated by the coordinator when a worker asked.",
      "appliesWhen": "when a worker sets up a still",
      "sources": ["chat:room-1:150"]
    }
  ],
  "wiki": [
    {
      "path": "daily/2026-08/2026-08-03.md",
      "title": "2026-08-03",
      "type": "daily",
      "content": "## Summary\n- ..."
    },
    {
      "path": "projects/posters.md",
      "append": [{ "section": "## Decisions", "text": "- Delivery is monthly." }]
    }
  ],
  "noUpdate": [{ "reason": "greetings and receipts", "sources": ["chat:room-1:102"] }]
}
```

### What goes where

| Part               | What it holds                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items`            | One entry per piece of work, with every change in the order it happened.                                                                                       |
| `items[].mentions` | Lines about the work that change nothing, grouped by why they matter.                                                                                          |
| `items[].links`    | Links to other items in the file, with a work link relation such as `builds_on` or `blocks`.                                                                   |
| `links`            | Links that start from work already in MAMA, for example a later case that builds on one from this period.                                                      |
| `lessons`          | What was learned, each with `appliesWhen`. These are lessons, not owner rules; only the owner sets rules.                                                      |
| `wiki`             | New pages with `title`, `type` and `content`, or sections to `append` to an existing page. The type is required. Existing pages are added to, never rewritten. |
| `noUpdate`         | Lines that are not work, grouped by reason, so every line of the period is accounted for. They are checked, not stored.                                        |

### Rules for writing it

- **Time.** `at` is when the change happened, with its offset, inside the period. MAMA keeps it as
  the event time; the time of the push is kept as the write time. Questions about a date read the
  event time.
- **One change, one revision.** A revision stands at the last message of the exchange that settled
  it. Later messages do not move it; cite them on a later revision or as a mention.
- **Only what was known then.** A revision says what was known at its time, not what you know now.
- **New or existing work.** The first revision of every item sets the `title`. New work names a
  `topic`. Work that continues after the period uses the existing `commitmentId`. Its revisions are bounded
  by its first later change (or `appliesUntil`), so its current state stays current.
- **Sources** are the source ids from the import. A line the import leaves out cannot be cited.
- **Every line has a home**: a revision, a mention, a lesson or `noUpdate`.

How to read a period well:

- Export each channel as lines of time, author, text and source id.
- Read whole conversations, not single lines. If the work has a board, read it beside the chats:
  it shows each stage change to the minute.
- A change stands at the message that made it, such as your submission or the received feedback,
  not at a reply that came hours or days later. Cite the reply on a later revision or as a mention.
- Give each line its home.
- Then check that no revision cites a line later than its own time.

## 3. Run it

```bash
mama backfill ~/.mama/runtime/backfill/2026-08/august.backfill.json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
```

The command lists every problem in the file and writes nothing until the file is valid and every
source is found. It prints what it wrote: work created and revised, mentions, links, lessons and
pages.

## Running it again

- Work, links and lessons carry fixed ids, so a second run writes nothing new.
- A changed entry under the same id is refused. To correct a record after the push, revise it in
  MAMA instead of editing the file.
- Pages already written are listed in `~/.mama/runtime/backfill/<period start>.pages.jsonl` and
  skipped. If that list is lost, the appends are written a second time.

## Check the result

Ask about the period by date: work as of a day in the period should show that day's state, and work
that continued afterwards should still show its current state. Compare a few pieces of work with
the originals, then ask the owner agent about the period in a fresh session.

Sources: [file format](../../packages/standalone/src/backfill/format.ts),
[push](../../packages/standalone/src/backfill/push.ts),
[command](../../packages/standalone/src/cli/commands/backfill.ts)

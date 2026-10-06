---
title: Replay retained history
parent: Guides
nav_order: 6
---

# Replay retained history

Use replay to process already imported originals chronologically through the owner
runtime. It rebuilds work history, daily journals, wiki pages and board views from
the evidence available at each historical day. This is an operator workflow;
`mama init` does not import historical sources. To record a period that has already been read
as a whole, use [backfill](backfill.md) instead.

## Prepare the input

The current `mama replay` command has no date-range or import flags. It expects
prepared raw observations and their core index, plus these default runtime files:

- `~/.mama/runtime/september-import-manifest.json`: import range and coverage counts.
- `~/.mama/runtime/september-replay-cursor.json`: progress; created and updated by replay.
- `~/.mama/runtime/september-replay-ledger.jsonl`: replay attempt and result records.

The names are the current defaults even for another period. The manifest supplies
`fromMs` (inclusive) and `untilMs` (exclusive), maximum source time and import
counts. The replay queue also requires the configured `jev.keyFile` and
`jev.vocabFile`. Keep provider credentials private. There is no general-purpose
historical import CLI yet. Prepare the originals and manifest before starting replay, then compare
the resulting work records with those originals when it finishes.

## Run without a live daemon

Stop the supervised daemon first:

```bash
launchctl bootout gui/$(id -u)/com.mama.server
mama status
mama replay
```

For an unsupervised daemon, use `mama stop` and confirm it stopped. Replay starts
its own owner runtime and read-only viewer, skips live connector polling and
Telegram delivery, and stops after completion. Do not run it beside the live
service.

Each window follows source occurrence time with day boundaries in your configured timezone. The owner
reads the day's work, reconciles changes and child results, and is instructed to
write the journal, board, wiki table of contents and applicable lessons. Source
reads are capped at the window's end so later evidence cannot leak into an earlier
day. The cursor preserves progress; inspect a failed window's ledger and durable
writes before retrying it.

The queue groups source lines by likely work item, possible match, possible new work and unresolved
lines. These are hints for the agent, which decides what belongs together. It assigns distinct work
to child agents, reads their receipts back against the ledger and settles gaps before publishing
the window's summary. A window does not advance until all its inputs settle.

## Return to live collection

On successful completion, replay resets the owner session and sets enabled live
connector cursors to the manifest's `untilMs` fence. It does not start live
collection automatically. Start the launch agent again:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
```

Compare a replayed task's chronology, feedback and roles with the originals; check
that its daily journal and board agree. Then ask about that history in a fresh
owner session. Completion counts alone do not establish that history was
understood correctly.

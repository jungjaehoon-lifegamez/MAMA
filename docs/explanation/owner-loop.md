---
title: The owner loop
parent: Explanation
nav_order: 5
---

# The owner loop

MAMA should answer what is happening, how it got there and what changed after a correction.
The five checks in [INTENT](../../INTENT.md) define that outcome. Code provides the path; a real
owner turn establishes whether the result is useful.

## Understand work in source messages

Connectors retain source content and emit deltas with observation references, source time and
observation time. The runtime accepts those deltas into its mailbox. The owner agent receives a
bounded view and can use `source.search` and `source.read` to investigate the originals.

The agent distinguishes a request, handoff, submission, feedback or delivery from chatter.
Source text is quoted as untrusted evidence. Its instructions do not become owner instructions.
Collection coverage is separate from work status: no collected update does not establish that
nothing changed or that a task finished.

## Keep changes with their work item

The owner guidance tells the agent to read existing work before creating a new item. A change
belongs on that item's next revision, with a summary, evidence links, source event time and the
roles supported by the conversation. Other tools' assignments and statuses are evidence for
this judgment.

The [work ledger](work-ledger.md) stores the current state and its revision history. This is the
case container used by the current owner product. It preserves what was requested, what moved,
who did what and what remains. File references can retain the locator, version and content hash;
originals and generated results should remain distinct versions.

## Answer from the stored record

Current-work questions start with memory search and the work ledger. History questions need the
revision chain and its supporting evidence. A search preview is navigation: `source.read` opens
the cited original when the stored record does not settle the question.

The owner receives readable sentences. Internal record and observation references remain in
stored links and tool traces rather than appearing in the answer. A new session starts with a
short block: the local time and the latest owner exchanges, at most 2,500 characters. It reads
current work and sources with tools rather than receiving them. Restart consistency still needs to
be checked with the same owner question after a restart.

## Report the same state

A live delta gets two turns in the same session. The first decides only whether to tell the owner
and ends in `[notify]` with owner-facing text or `[ack]`. Before that reply is routed, the daemon
queues a record order for the same messages: the agent revises or creates the work items with
links to the messages, updates the board sections that changed (`briefing`, `action_required`,
`decisions`, `pipeline`) and the case's wiki page, or declares that nothing needs recording. The
daemon then checks the ledger for a revision citing those messages or the declaration, and orders
the record again, at most three times in all, before it logs the batch as lost. Messages more than
six hours old when they arrive are not delivered as live deltas.

Scheduled full reports default to 08:00, 13:00 and 18:00 Asia/Seoul. Hourly reminders run from
09:00 through 21:00, with a full report taking precedence in a matching hour. The scheduler
records an hour as sent only after delivery succeeds. See
[reports and board](../guides/reports-and-board.md) for operation and verification.

Wiki pages hold organized human-readable context. The current owner guidance uses `Home.md` as
the table of contents, pages for continuing topics, a dated daily journal, and `lessons/`.
Work history stays in the ledger. See [wiki](../guides/wiki.md).

## Learn from the next result

Rules that always apply belong in the owner policy file, which the agent holds in every session.
Other corrections are saved as scoped lessons. For an owner message or a delta's notify turn, the
runtime searches memory with the incoming text and shows up to three matching lessons,
preferences or constraints, marked as advice rather than facts, and not repeated in the same
session on the same day. The agent decides whether they apply.

A saved lesson is evidence of storage. Learning requires a changed result on the next related
request, no spillover into an unrelated request, and persistence in a fresh session or after
restart. The [intent workflow](../development/intent-workflow.md) preserves this acceptance test.

## Trace the result

Inspect the accepted mailbox input, model run, catalog and native tool traces, stored revisions,
and Telegram delivery ledger together. A completed model turn, a database row or a send receipt
alone cannot prove that the owner's question was answered correctly. For uncertain delivery,
inspect the existing receipt before repeating the send.

The wiring is in [daemon assembly](../../packages/standalone/src/cli/commands/daemon.ts),
[owner guidance](../../packages/standalone/src/runtime/owner-system-prompt.ts) and
[the report scheduler](../../packages/standalone/src/runtime/report-scheduler.ts).

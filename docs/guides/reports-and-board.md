---
title: Read reports and reconcile the board
parent: Guides
nav_order: 7
---

# Read reports and reconcile the board

Ask MAMA for the current situation in your owner chat, then open the viewer's
Board page to compare it with the work ledger. The board is written by the agent.
Each section shows when it was last written, and the header counts open, overdue
and unassigned work.

The four sections are `briefing`, `action_required`, `decisions`, and `pipeline`.
MAMA reads them with `report.read` and publishes HTML with `report.publish`.
When a turn changes work, the agent reads the sections that item is in or leaves
and publishes them again. A full report rewrites all four, whether it is scheduled
or you ask for it in chat in any words.

## What happens after a source change

A source change gets two turns. The first shows the agent the new messages and
asks only whether you need to know now. It ends with `[notify] <text>` for a
message to you or `[ack]` for a quiet acknowledgement. These are runtime routing
markers, not commands you need to send. An untagged response is logged but not
delivered as a notification. The agent judges urgency using the source, your
owner policy and the lessons shown with the messages.

The second turn records the change. The agent finds the work the messages belong
to, revises or creates it with links to the messages, updates the board sections
that change and, when the messages settle lasting knowledge, the project's wiki
page. When nothing needs
recording it says so with `work.no_update`. MAMA then checks the work ledger. If
neither happened, the messages wait and are recorded together with the channel's
next change, or on their own five minutes later. After three attempts the daemon
log shows `record order lost`.

Messages more than six hours old when they arrive, such as a first collection's
history, are stored but not delivered as live changes.

## Set report hours

Report hours are in your timezone (the `timezone` setting; see
[Configuration](../reference/configuration.md)):

```yaml
reports:
  full_report_hours: [8, 13, 18]
  reminder_start_hour: 9
  reminder_end_hour: 21
```

A full report starts from the work ledger: the items whose events happened since the previous
full report (`work.list` with `eventSince`; 24 hours for the first), the open pipeline, and
`schedule.upcoming` (14 days by default). It opens original messages only for a change the ledger
does not explain, and a source whose last collection failed is reported as such. The report
lists every item waiting for an owner decision and compares deadlines with
calendar events and holidays. When you have given rules in chat about how reports
are ordered or worded, the report follows them. Otherwise it has five parts: key
situation today, needs a response, needs a decision, pipeline, and next actions,
with the owner schedule under key situation today. The board's pipeline has one row
for every open item, so the report names open items by their importance to you rather
than all of them. An item past its deadline is settled in the report: recorded as done
or cancelled when it ended, or given its new deadline when it continues. An empty activity
window is reported plainly, and a collection failure is never described as no change.

Full reports also rewrite all four board sections. Reminders read the open
pipeline (and the calendar when the session has not read it today), update only
`action_required`, and deliver a three-to-six-line priority reminder. When nothing
needs you, the reminder is not sent. A full-report hour takes precedence over a
reminder. The language and style of reports come from your owner policy file and
from the rules you give in chat about reports, which also set a report's order and
wording.

The scheduler checks every minute. It records an hour as sent only after delivery
through `delivery.reports` succeeds; pending reports prevent another scheduled report
from starting. See the [messengers guide](messengers.md) for route setup.

## Check a discrepancy

Name the affected work and what is wrong in your owner chat. Ask MAMA to compare its
history and original evidence with the board, revise the work if warranted, and
republish the affected view. A publication receipt confirms a board write; it does
not by itself confirm that the content is right or that a Telegram message arrived.
See [Corrections and learning](corrections-and-learning.md) and
[Troubleshooting](troubleshooting.md).

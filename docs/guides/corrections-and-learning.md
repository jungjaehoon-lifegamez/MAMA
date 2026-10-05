---
title: Correct MAMA and check what it learns
parent: Guides
nav_order: 4
---

# Correct MAMA and check what it learns

Tell the owner agent what was wrong, what should change, and when the correction
applies. For example: “For the daily report, put the actions I need to take first.
Keep ordinary answers in their usual order.” A task-specific correction should
identify the affected work and its evidence.

## How a correction is applied and kept

When you correct MAMA, the agent applies the correction to the current work in the
same turn: it revises the affected work items and board sections, reading the
originals it needs, and only then replies. It does not answer with a promise for
something it can do now.

It then keeps the correction as a lesson, preference, constraint, or workflow,
saved with `memory.save` and an `appliesWhen` line. Use kind `workflow` for a
procedure and include its ordered steps; add `evidenceChecks` when the procedure
must check particular evidence. The agent compares a new correction with the ones
it already has. When it belongs with an earlier one, the agent revises that
record with `replaces`, keeping every earlier point you have not withdrawn or
replaced; otherwise it saves a new one. It links your message with a
`derived_from` link when its observation reference is available. A request you
mark as for this time only is applied to that answer and not saved.

The old record stays in history. Use `memory.retire` with a reason when you
withdraw a correction or it no longer applies; retirement changes its status and
keeps the record. `memory.read:provenance` reads the record's source links.

## When corrections reach the agent

Rules that always apply to how MAMA works for you, such as the language, the
style of reports and notices, and what a report contains, belong in your owner
policy file. The agent reads that file with its instructions in every session.
A rule about reports that you give in chat also reaches every full report, as
described below.

Other corrections are lessons for particular situations. When a message from you
or a change in a connected source arrives, the agent is shown the few lessons that
match it best, marked as lessons rather than facts. It is not shown the same lesson
again in that session on the same day.

When the agent records what a change did, it also sees a list of every rule you
gave it in chat, one line each, saying when the rule applies. Before it writes, it
reads the rules that fit what it is recording. A rule about finished work, for
example, applies when the agent decides that an item is finished, which the
change's own words may never say.

The same list comes with the steps for a full report, both the scheduled ones and
the ones you ask for. A rule about how reports are ordered or worded then applies
to every report, whatever words you used to ask for it.

When you ask for the full report, in any words, the agent recognises the request
and follows the same procedure as the scheduled report.

Corrections never change the rules on untrusted source content, credentials,
success claims, or administration. A correction is not evidence of current work
state: the agent still reads the work record and preserved originals when needed.

## Check the next related situation

After a correction:

1. Read the saved instruction and its scope.
2. Request a related task and check that the result changes as intended.
3. Request an unrelated task and check that the correction has not spread to it.
4. Start a new session and repeat the related request.

Saving succeeds when the record is durable. Learning succeeds when a later
related result is correct without changing unrelated work. Inspect the answer,
report, or file itself rather than relying on a claim that MAMA remembered.

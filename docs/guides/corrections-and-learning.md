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

It decides whether the correction always applies or fits a particular situation.
A standing rule goes into the owner policy: the agent reads it with
`manage.policy.read`, then changes it with `manage.policy.update` in your chat
turn. Each change keeps the reason, the full policy text and your message in
memory history. A hand edit is reported when the file and its latest revision
differ; the next update keeps the hand-edited text as its base revision.

A situational correction is kept as a lesson, preference, constraint, or workflow,
saved with `memory.save` and an `appliesWhen` line. Use kind `workflow` for a
procedure and include its ordered steps; add `evidenceChecks` when the procedure
must check particular evidence. The agent compares a new correction with the ones
it already has. When it belongs with an earlier one, the agent revises that
record with `replaces`, keeping every earlier point you have not withdrawn or
replaced; otherwise it saves a new one. Its provenance carries your stored
message. The agent can also state a `derived_from` link. A request you
mark as for this time only is applied to that answer and not saved.

The old record stays in history. Use `memory.retire` with a reason when you
withdraw a situational correction or it no longer applies; retirement changes its status and
keeps the record. `memory.read:provenance` reads the record's source links.
Policy revisions change only through `manage.policy.update`.

## When corrections reach the agent

Only a rule you give in your own conversation with the agent has owner-rule authority. Messages
collected from connected sources remain observations, even when they quote you. The agent can still
save lessons learned from those observations; they are marked as learned advice, not your rules.
An observed message cannot replace or retire one of your owner rules.

Rules that always apply to how MAMA works for you, such as the language, the
style of reports and notices, and what a report contains, belong in your owner
policy file. The agent reads that file with its instructions in every session.

Situational owner rules and learned lessons stay in memory. When a message from
you or a notice of a change in a connected source arrives, the agent is shown the
few that match it best, marked as your rules or learned advice rather than facts.
It is not shown the same one again in that session on the same day.

When recording work or writing a report, the agent reads the situational rules
and lessons that fit with `memory.search` before writing. The steps for recording
and full reports point to this search and to the standing rules in the owner
policy.

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

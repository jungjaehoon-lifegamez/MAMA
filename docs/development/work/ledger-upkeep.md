# Ledger upkeep: three orders the host starts and checks

Owner decision 2026-10-17: build this before 1.0 W2.3. Evidence is in
[checks.md](../checks.md#ledger-upkeep-measured-2026-10-17).

## Why

The agent records a live delta well because the host starts the work and checks the result: a
record order is checked by citation or `work.no_update`, and 98% of batches are recorded. The other
upkeep has neither a trigger nor a check, and is mostly not done:

- **Closing summaries.** 6 of 34 items closed in October have one. A summary covers the item's
  rounds, the points raised and how it ended. The September figure (64%) is the development
  session's manual pass, not the agent's.
- **Write-back.** 29 of 85 owner-question turns that answered from source search (34%) recorded
  what they found.
- **Board drift.** The owner asked three times in two weeks to compare the ledger with the task
  board. Each time the agent fixed a few items.

The agent can do all three, since some closed items carry a full summary. So this is a host gap,
not a model gap (AGENTS.md: fix what the program delivers, not what a better model would).

## Shape (shared)

Each upkeep kind is a scheduled order on the record-order lane (`operator:record`, `scheduled` kind,
the common session's chain):

1. The host chooses the subjects from stored facts.
2. The agent judges and writes.
3. When the order's run ends, the host checks that every subject has a work revision written in
   that run, or a `work.no_update` from that run citing it.
4. Subjects left unchecked go into the next order of the same kind, up to three attempts.
5. After that they are reported lost, as record orders already are.

Domain words stay out of host code. The host knows "status became done", "a turn read these
observations" and "a board connector's card moved". Stage names, list names and what counts as
drift come from the owner's data and corrections.

## U1 Closing summary order

- **Subjects:** items whose current status became `done` or `cancelled` since the last close order
  and that no close-order run has revised. The host scans hourly. One order carries at most ten
  items, oldest first.
- **Order asks for:** the item's closing summary in `description`, written as one revision with
  `derived_from` links to the revisions' evidence:
  - rounds (submissions, external feedback and the points raised, internal reviews);
  - who did what;
  - how it ended;
  - what is worth reusing.

  An item that already has one is answered with `work.no_update`.

- **Check:** the run revised each item, or no-updated it citing the item.
- **Done when:** a week after deploy, at least 90% of items closed in that week have a closing
  summary written by a close order. Count with SQL over `commitment_assignments` joined to the
  order runs.

## U2 Write-back order

- **Subjects:** owner and member question turns that read observations through `source.search` or
  `source.read` (`observationRef` in the tool output) and whose run cites none of them in a work
  revision, `memory.save` or `work.no_update`. The host checks five minutes after the turn ends.
  One order per question turn, carrying at most 30 observations.
- **Order asks for:** "a question was answered from these sources". Record what belongs in the
  ledger:
  - a work revision;
  - a fact or lesson, including prices, specs and client rules, which have no other home;
  - or `work.no_update` with the reason.

  Cite with `derived_from`.

- **Check:** the record-order check over the order's observations.
- **Done when:** a week after deploy, at least 90% of question turns that read sources are followed
  by a recorded or no-updated write-back order. A repeated question about the same matter reads
  the ledger first and searches sources fewer times than the first one did; compare the two
  turns' `source.search` counts.

## U3 Board reconcile order

- **Subjects:** once a day, before the morning report:
  1. open ledger items whose linked card (the card ids among their cited board observations) moved
     after the item's latest revision;
  2. open items with no source event for seven days;
  3. cards that moved in the last day and that no revision cites.

  Each subject carries the facts: the card's current list and time, and the item's status, stage
  and latest event. At most 30 subjects, oldest first.

- **Order asks for:** bring each subject's ledger state in line with what the board and the latest
  originals show (`work.revise` with the reason), or `work.no_update` saying why it stays.
- **Check:** each subject was revised, or no-updated citing its card or item.
- **Relocation:** the daily page's "Stale work" step (help topic `daily`) moves here and is deleted
  from the daily procedure in the same PR.
- **Done when:** for seven days after deploy, every daily order's subjects are checked, and the
  owner gives no manual "compare with the board" instruction.

## Order of work

- **PR 1 (U2):** the smallest. It reuses the record-order batch and check as they are.
- **PR 2 (U1):** an hourly scan plus the close-order prompt.
- **PR 3 (U3):** the daily scan, the subject facts, and the relocation of the daily's stale step.
- **After each PR:** a live check measured with the SQL in its "Done when", recorded in
  checks.md.

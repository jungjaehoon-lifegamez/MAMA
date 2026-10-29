# Ledger upkeep: three orders the host starts and checks

Owner decision 2026-10-17: build this before 1.0 W2.3. Evidence is in
[checks.md](../checks.md#ledger-upkeep-measured-2026-10-17).

## Why

A record order handles 98% of live delta batches. Read that figure with care: a batch passes when
one of its observations is cited by any revision, or when its own order calls `work.no_update`
(`record-orders.ts:57-79`). So it measures batches handled, not every observation recorded. Even
so, it is the only upkeep with a host trigger and a host check. The rest has neither, and is
mostly not done:

- **Closing summaries:** 6 of 34 items closed in October have one.
- **Write-back:** 29 of 85 owner-question turns that read sources recorded what they read.
- **Board drift:** the owner asked three times in two weeks to compare with the board.

Some closed items do carry full summaries, so the agent can do this. The gap is in the host
(AGENTS.md: fix what the program delivers).

## Shared order kind

- **Channels:** each kind has its own `scheduled` channel (`operator:close`, `operator:writeback`,
  `operator:reconcile`) with its own payload parser and renderer.
- **Delivery:** the common session's chain, never in replay. The result, lost and uncertain
  branches of `stimulus-delivery.ts`, which today name only `operator:record` (`:762`, `:857`,
  `:871`), take every upkeep channel through one port.
- **Subject:** a stable key per kind:
  - U1: item plus closing revision;
  - U2: the question turn's model run;
  - U3: item, or card plus its triggering event.
- **Attempts:** counted per subject from the stored orders of the last seven days, as
  `storedBatches` counts batches. A scan never selects a subject that is checked, still open in an
  order, or lost after three attempts. A new closing revision, turn or card move is a new subject.
- **Check:** per subject, in the order's run and its child runs. The kind decides what counts:
  - U1 and U3: a work revision on the item (`commitment_assignments.model_run_id`).
  - U2: a work revision or a `memory.save` whose `derived_from` cites one of the order's
    observations.
  - All three: a `work.no_update` naming the subject.
- **Contract change:** `work.no_update` takes `commitmentIds` beside `observationRefs`, so an item
  can be named (`record-actions.ts`).
- **Domain words** stay out of host code. Stage and list names, and what counts as drift, come
  from the owner's data and corrections.

## U1 Closing summary order

- **Subjects:** each closing revision written after the deploy, meaning a revision that moves the
  item's current status (core's fold, `applies_until` honoured) to `done` or `cancelled`. A
  reopened item that closes again is a new subject. The host scans hourly. One order carries at
  most ten subjects, oldest first.
- **Before the deploy:** items closed earlier get their summaries from a one-time
  development-session script. It computes rounds from the existing revisions and is pushed on a
  copy first (owner, 2026-10-17).
- **Order asks for:** a closing summary in `description`, written as one revision with
  `derived_from` links to the evidence. It covers the rounds (submissions, external feedback and
  its points, internal reviews), who did what, how the item ended, and what is reusable. An item
  whose summary is already current gets `work.no_update` naming it.
- **Check:** the revision sets a non-empty `description`. A status-only revision does not pass.
- **Done when:** a week after deploy, at least 90% of that week's closing revisions have a
  description-setting revision from a close-order run, or a no-update naming the item. Count with
  SQL over `commitment_assignments` and `tool_traces`.

## U2 Write-back order

- **Subjects:** question turns of principals with the owner role and of the common session.
  Members' DMs stay personal (owner, 2026-10-17; P6). A turn qualifies when it read observations
  and its run cites none of them.
- **Common sources only:** only observations in common scope are carried. The owner's own DM chat
  and anything personal-scoped are dropped, so no personal observation reaches the common session.
  The question text is never carried.
  - "Common" is decided the way the common session's reads decide it, from the observation's own
    scope columns: a non-chat source the owner reads connector-wide (`connectorWideRead`),
    unscoped or scoped to the common principal; or a chat message scoped to the common principal
    outside every private Telegram channel. Anything else is dropped.
  - Owner decision 2026-10-29: the owner's DMs that a connector relays (Kagemusha, Slack,
    Chatwork, iMessage, Discord) are common. The common session already reads them
    connector-wide, so a write-back may record them in the ledger. "The owner's own DM chat"
    above means the owner's private chat with MAMA itself.
- **Two scan choices:** a search hit counts as consulting a source, as an opened read does (a
  question answered from a search preview is the same gap; the order still marks which were
  opened). "Cites none" is checked against every ref the turn consulted, personal ones included,
  so a turn that cited anything it read is not a subject.
- **Read receipt (prerequisite):**
  - `source.search` and `source.read` record the observation refs they returned in
    `tool_traces.evidence_json`, in full.
  - `output_summary` is cut at 4,000 characters and 40 array items (`trace-summary.ts:40-72`), so
    it cannot be the source.
  - Search hits are candidates. The order lists the refs that `source.read` opened first, then
    search hits, up to 30, and says which were opened.
- **Order asks for:** "a question was answered from these sources". Record what belongs in the
  ledger, citing with `derived_from`:
  - a work revision;
  - a fact or lesson (prices, specs and client rules go here);
  - or `work.no_update` with the reason.
- **Check:** turn-level. At least one qualifying write cites the order's observations, or a
  no-update names them.
- **Done when:** a week after deploy, at least 90% of qualifying turns have a checked write-back
  order. A repeated question about a written-back matter makes fewer `source.search` calls than the
  first one did.

## U3 Board reconcile order

- **Subjects:** once a day, before the morning report.
  1. The daily page's "Stale work" step, moved as it is: items in progress or in review whose
     latest source event is over 30 days old, at most ten a day, oldest first. It is deleted from
     help topic `daily` in the same PR.
  2. Open items whose linked card moved after the item's latest revision. A linked card is a card
     id among the item's cited board observations, read from stored events.
- **Order asks for:** read each subject's card live with the board tool, plus its latest originals.
  Then either write `work.revise` with the reason, or `work.no_update` naming the item and saying
  why it stays. A stored move is a hint, and the live card decides. A collection gap shows up as a
  live card that differs from the stored events, and the agent says so.
- **Check:** a revision on the item, or a no-update naming it.
- **Done when:** for seven days after deploy, every daily order's subjects are checked, and the
  owner gives no manual "compare with the board" instruction.
- **As built (PR 3, `upkeep-reconcile.ts`):**
  - Cadence: the hourly tick finds the order due from local midnight until the first hour in
    `reports.full_report_hours` (in `timezone`), once a local day, read from the stored orders.
    A restart that morning places no second order, and an unchecked subject waits for the next
    day, so its attempts count one a day. No full-report hour after midnight fails the scan
    loudly in `daemon.log`.
  - Stale items come from `work.list`'s own read (`workListLedger`): the same fold, visibility,
    status and `lastEventBefore` definition. The text moved from help topic `daily` into the
    order.
  - A move is a stored board event whose action data names the list the card went to
    (`data.listAfter`), within the seven-day attempt window. "After the item's latest revision"
    compares with the latest revision time on the source timeline (event time, else write time),
    because a backfill writes earlier periods last.
  - Keys: `stale:<item>`; `move:<item>:<connector>:<card>:<event>`. The item is in the move key
    because the check is per item and two items citing one card are two subjects.
  - One order carries at most ten subjects: moves first, because they leave the window, then
    stale items oldest first.
  - A stale item kept with `work.no_update` or a revision without a new source event stays
    stale. It is ordered again once its checked order leaves the seven-day window: a weekly
    re-check.

## What already exists and is reused

- **`record-orders.ts`:** stays as it is. Its batches follow live deltas and ride with the next
  delta, so a separate runner (`upkeep-orders.ts`) serves the upkeep kinds. The two share the
  child-run wait (`runningChildren`).
- **`stimulus-delivery.ts`:** the `scheduled` branch.
- **`turn-orders.ts`:** the wording of `deltaRecordOrder`'s steps.
- **The daily page's "Stale work" step:** becomes U3's first subject list.
- **Kagemusha:** has per-delta taskboard and feedback-forwarding reconciles, ported as record
  orders. It has no closing summary, no write-back and no daily board sweep.

## Not in scope

- **Agent-written summaries for items closed before the deploy:** the development-session script
  writes them.
- **Members' DM questions:** they stay personal (P6).
- **A price or estimate record type:** prices are saved as facts until the facts prove not enough.
- **Board connectors other than Trello:** card ids are read generically, but only Trello carries
  them today.
- **Changing the stale threshold:** U3 keeps 30 days and ten a day.

## Tests (each PR)

**Scan:**

- done after the deploy vs before it;
- a revision bounded by `applies_until`;
- reopened and closed again;
- a subject checked, still open, or lost after three attempts;
- an owner-role turn vs a member turn;
- personal-scope observations dropped;
- a turn whose run already cites what it read.

**Check:**

- a revision on the item, in the run or a child run;
- a status-only revision fails U1;
- `memory.save` citing the observations passes U2;
- a `work.no_update` naming an item passes;
- anything else retries, and the subject is lost after three attempts and never selected again.

**Delivery:**

- each channel renders its order;
- the result, lost and uncertain paths are taken for each channel;
- replay enqueues nothing;
- a restart recovers open orders.

**Read receipt:** a search returning more than 40 hits keeps every ref in `evidence_json`.

**Live:** the "Done when" SQL on the owner install a week after deploy, recorded in checks.md.

## Failure modes

| Failure                                                         | Handling                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| An order run fails or is stopped                                | The subject retries. A third failure is reported lost and the subject is not selected again. |
| A close order changes the status again                          | It adds no new closing revision, so there is no new subject.                                 |
| A personal observation would reach the common session           | Only common-scope refs are carried.                                                          |
| Stored card moves lag the board                                 | The order reads the card live. Stored moves only choose the subjects.                        |
| One card is cited by two items                                  | Both items become subjects, and the agent judges.                                            |
| A revision sets the status to done again                        | The subject is the transition into a closed status, so it stays the same subject.            |
| A finished order's child runs still write                       | The kind places no new order until that check ends.                                          |
| A replay daemon finds an upkeep order a live run left           | It serves the order but scans for none.                                                      |
| A subject waits past the seven-day window (the daemon was down) | It leaves the scan without a lost report, and its stored orders show the attempts.           |

## Order of work

- **PR 1 (U1):** the upkeep runner (`upkeep-orders.ts`: scan, order, per-subject check, attempts
  counted from stored orders, lost after three), its delivery branches, `work.no_update` taking
  `commitmentIds`, and the closing summary kind (`upkeep-close.ts`). `closeSince` is written once
  to `runtime/upkeep-state.json` at the first live start. Beside it, in the development session,
  the one-time summary script for items closed before that instant.
- **PR 2 (U2):** the read receipt and the write-back kind.
- **PR 3 (U3):** the daily kind, and the move of the stale step out of help topic `daily`.
- **After each PR:** a live check with its "Done when" SQL, recorded in checks.md.

## Review

- **plan-eng-review (2026-10-17):** owner decisions on U2's scope (owner role and common session
  only) and U1's history (a script).
- **Codex outside voice:** nine findings, all taken. U2 crossed the personal boundary, and its read
  evidence was truncated. Checks were not per subject and did not count `memory.save`. The
  three-attempt limit did not reach the scanners. The lost and uncertain branches were bound to the
  record channel. U3 changed the stale policy. U1's measure passed status-only revisions. The 98%
  figure was read too broadly.

## GSTACK REVIEW REPORT

| Review       | Trigger            | Why                             | Runs | Status                | Findings                                                                 |
| ------------ | ------------------ | ------------------------------- | ---- | --------------------- | ------------------------------------------------------------------------ |
| Eng Review   | `/plan-eng-review` | Architecture & tests (required) | 1    | CLEAR (PLAN)          | 3 own findings + 9 outside-voice findings, all folded; 2 owner decisions |
| Codex Review | outside voice      | Independent 2nd opinion         | 1    | issues_found → folded | 9 findings, 9 taken                                                      |

- **CROSS-MODEL:** no disagreement. The outside voice found what the first pass missed (privacy
  boundary, truncated receipts, per-subject checks), and all of it was taken.
- **VERDICT:** ENG CLEARED (PLAN): ready to implement PR 1.

NO UNRESOLVED DECISIONS

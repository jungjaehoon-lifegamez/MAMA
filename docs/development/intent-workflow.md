---
title: Check the product intent
parent: Development
nav_order: 5
---

# Check the product intent

Use these checks to evaluate changes against [INTENT](../../INTENT.md). They are development
acceptance evidence, not an extra host approval gate or a prescribed owner-agent tool sequence.

## Name the result before implementation

| Check | Required result                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| C1    | The owner asks who is working on what and receives an accurate answer supported by work and source evidence.                         |
| C2    | The owner asks how work progressed and what feedback it received; the answer comes from stored revision history.                     |
| C3    | The owner asks for a similar past case and receives its relevant feedback and outcome with supporting evidence.                      |
| C4    | Scheduled reports and the board agree with the work ledger.                                                                          |
| C5    | An owner correction changes the next relevant action, leaves unrelated actions unchanged and survives restart.                       |
| C6    | A packed core installed in a temporary directory uses public exports and its own database to write, revise, link and search records. |

The product requirements cover understanding source material, keeping related work together,
answering from saved records, reporting changes, and applying corrections. The shared engine has
separate requirements. Internal
references belong in records and traces; owner-facing answers are readable text without
internal identifiers, in the style the owner policy sets. Traceable reads and correct explanation together support the answer.

## Record the evidence you observed

| Level            | What it establishes                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Unit             | A function or module behaves as exercised.                                                              |
| Integration      | The exercised package or runtime boundaries work together.                                              |
| Installed daemon | The installed build runs, with a clean daemon log and database read-back.                               |
| Real owner turn  | A real owner request on real data produced the observed answer or artifact, delivery and stored result. |

Do not promote a lower level by inference. A model response is not an effect receipt. A receipt is
not proof of answer quality. A saved correction is not proof of changed behaviour.

## Check the complete loop

1. Name the relevant C checks and the visible change they should prove.
2. Inspect the existing producers, consumers, source data and assembly. Reuse the mechanisms that
   already serve the purpose.
3. Run the smallest useful test, then the installed and real-owner checks needed for the claim.
4. Read back work revisions, source evidence, board or wiki changes and delivery results. For files,
   compare the actual artifact with the request and base version; preserve originals and new versions.
5. Add 3–5 lines to [checks](checks.md): result, command or evidence, evidence level and
   what still fails. Use **met**, **partial**, **not met** or **unverified** for each check.
6. Keep completed sub-tasks separate from completion of the overall purpose.

## Preserve the learning test

The useful cycle is: a related situation brings a small hint; the agent investigates the underlying
experience, decides and acts; the actual result supports a scoped correction; the next related
situation produces a better result. Hints need applicability and evidence access. They should not
replace judgment with a prewritten answer or mandatory recipe.

Test a new related request, an unrelated request, a fresh session and a restart. Treat a backend
change as a separate transfer test. Keep original feedback and outcomes available when replacing,
merging or retiring a rule. A failure count or the model's success claim is not enough to change
that rule automatically.

Before removing a procedure or policy, identify where its knowledge will reach the agent and
confirm it in an owner turn. Compare guidance changes with the same model, effort, tools and frozen
sources. Record quality, completion, correction scope and request-to-delivery time together.

Team sharing follows the single-owner product requirements. Future requester, executor, approver and recipient roles
must remain distinguishable, but a future team contract is not evidence that today's owner flow works.

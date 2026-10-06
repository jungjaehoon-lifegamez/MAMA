# TODOs

Current work is in the [development plan](docs/development/plan.md); evidence and unresolved checks are in
[checks.md](docs/development/checks.md). These follow-ups serve [INTENT.md](INTENT.md).
A task and its revisions are the container for a case.

## Backfill for every connector and optional Jev — Recognise and Attach

Deferred from the rebuild PR (owner decision 2026-09-27). Replace the operator script
`scripts/replay/import-september.mjs` and its `september-*` runtime files with a `mama import`
command that takes a connector and a date range, for every selectable connector (today only the
Kagemusha bridge and Trello history can be imported). Replay must run without `jev.keyFile`: the
owner agent classifies each day window itself; with a key, the window queue keeps Jev's scores.
An agent-facing Jev action for sameness pairs (off by default: owner text leaves for the Jev
service) waits for a measurement that live duplicates or attribution improve; the 9/17 backfill
measurement put Jev's value in backfill volume (about 1,278 judgments against about 11 a day live).

## Human-member canary — after the owner checks

Resume a real member canary only after recognise, attach, answer, report and learn pass on real
owner data. Prove explicit grants, private-data isolation, revocation, session-policy replacement
and delivery receipts. Use actual participant input and current interfaces; historical member
rows do not establish that the rebuilt product supports team use.

## Artifact flow — Attach and Answer

Complete one real request → original → distinct new version → recorded delivery → follow-up
flow. Bind the request, base version, changes, actor and recipient to task history. Native
attachment processing and Telegram file delivery have live evidence; large-file Drive delivery
and durable version/receipt linkage remain work. Resolve uncertain delivery from its existing
receipt before sending again. Generalise only after a second artifact domain needs it.

## Provider continuity — Answer and Learn

Compare the same longitudinal task under fresh retrieval, MAMA-carried history and corrections,
and provider-native session state. Measure answer/evidence quality, correction persistence,
recovery, latency and token use with the same inputs. Run after a real task and artifact flow is
stable or a material provider change; a connected backend or resumed thread is not continuity.

## Trello and Kagemusha lifecycle — Recognise and Attach

Prove that real source changes attach to the right task and preserve revisions, roles, evidence
and delivery receipts across replay and live collection. The agent decides identity and status.
Only introduce a shared lifecycle abstraction when a third real source needs the same contract.
Consider Trello webhooks only after measured polling latency fails the owner's needs, with the
callback authentication and replay boundary specified first.

## Provenance at recall time — Answer and Learn

Check that recalled memory exposes enough origin and evidence for the agent to distinguish
owner decisions from externally derived claims. `memory.read:provenance` and untrusted evidence
wrapping exist; they do not by themselves prove that a normal answer follows and weighs the
source. Trace recall → provenance → original → answer on a real task, including a corrected
memory after restart, before adding more result fields.

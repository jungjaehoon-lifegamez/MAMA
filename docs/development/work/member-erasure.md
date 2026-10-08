# Member export and erasure (B1) — work list

Owner decision 6 (2026-10-08, [team-flow.md](team-flow.md)): a member exports all their personal
records and deletes them from the server. Records bound only to the member's own scope are the
exception to INTENT.md's "records and links are never edited": nothing shared cites them → delete;
shared work cites them → tombstone (id and scope kept, content and vectors wiped); shared revisions
the member wrote stay.

Scope comes from evidence: a member can only write through the member role (P1: memory saves,
retirements, checkpoints, links in records, its own chat, its turns). Tables of modules with no
writer and no live rows (entity, case, wiki index, situation, vnext operator, owner-event inbox,
error patterns, sessions) are out. Commitments are out: the role cannot create work, and shared
revisions stay by decision.

## Core (one release)

| #   | Store                                                                                                    | Selector                                                                             | Rule                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | `decisions`, `memory_scope_bindings`, `memory_events`, `embeddings`, FTS, trigram, vector cache          | bound only to `user:<member>`                                                        | export; delete if nothing outside the member's records cites it, else tombstone            |
| 2   | `judgment_commands`, `command_bindings`                                                                  | receipts of the records in 1                                                         | export; keep the command id with its payload wiped, so a replay cannot recreate the record |
| 3   | `twin_edges`                                                                                             | edges whose endpoints or evidence are records in 1                                   | export; delete edges between erased records; an edge from a kept record keeps its endpoint |
| 4   | `checkpoints`                                                                                            | `user:<member>` binding                                                              | export; delete                                                                             |
| 5   | `observation_versions`                                                                                   | scope `user:<member>` (the member's chat)                                            | export; delete uncited versions, tombstone cited ones (bodyless)                           |
| 6   | `mailbox_inputs`, `mailbox_input_refs`, `mailbox_seen`, `native_input_deliveries`, `native_turn_results` | `principal_id` = member                                                              | export; delete settled inputs; keep unacked inputs and their receipt group as `in_flight`  |
| 7   | `model_runs`, `tool_traces`                                                                              | native invocation → mailbox principal, explicit principal, descendants, actor traces | export; keep the run and trace ids with content wiped (cost and counts stay)               |
| 8   | erasure receipt (migration 103)                                                                          | one row per erasure: principal, time, counts per store, no content                   | written last; counts include `in_flight`; next export reads the receipt                    |

Reads after erasure: a deleted record is absent; a tombstone reads as `{id, scopes, state:
"erased"}` in memory reads, work reads, graph and provenance, and recall/search never returns it.

API (core, no product names): `exportPrincipalRecords(adapter, principalId)` and
`erasePrincipalRecords(adapter, { principalId, commandId })`, both refusing the owner principal
and any principal that is not a registered member.

Execution erasure snapshots run ownership before deleting mailbox rows. An unacked input keeps
its delivery, refs, seen refs, result, run descendants and traces; a shared native receipt also
keeps its acknowledged root until the turn settles. A later erase needs a new command id.
A kept correction's edge target stays, with reason and attributes wiped; its personal endpoints
become tombstones so the surviving edge does not dangle.

## Product (P9, after P3 places the member's files)

Chat raw store and `connector_event_index` rows of the member's DM; the owner-message ledger's
entries for the member's DM; the member's downloads, workspace and session transcripts. P9 runs the
core call and these in one owner-free member turn, refusing any other principal.

## Proof

Before and after on a temporary database with an owner, a member and shared work: the export holds
exactly the member-scoped rows of every store above; afterwards each reads back as absent or
tombstoned; a shared revision the member wrote, an owner record citing a member record, and a record
bound to both the member's and a shared scope are unchanged except the tombstoned citation target;
a replayed erased command does not recreate anything; the vector cache returns no erased record;
the owner's counts are unchanged.

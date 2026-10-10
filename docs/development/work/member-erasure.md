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

| #   | Store                                                                                                    | Selector                                                                             | Rule                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | `decisions`, `memory_scope_bindings`, `memory_events`, `embeddings`, FTS, trigram, vector cache          | bound only to `user:<member>`                                                        | export; delete if nothing outside the member's records cites it, else tombstone                              |
| 2   | `judgment_commands`, `command_bindings`                                                                  | receipts of the records in 1                                                         | export; keep the command id with its payload wiped, so a replay cannot recreate the record                   |
| 3   | `twin_edges`                                                                                             | edges whose endpoints or evidence are records in 1                                   | export; delete edges between erased records; an edge from a kept record keeps its endpoint                   |
| 4   | `checkpoints`                                                                                            | `user:<member>` binding                                                              | export; delete                                                                                               |
| 5   | `observation_versions`                                                                                   | scope `user:<member>` (the member's chat)                                            | export; delete uncited versions, tombstone cited ones (bodyless)                                             |
| 6   | `mailbox_inputs`, `mailbox_input_refs`, `mailbox_seen`, `native_input_deliveries`, `native_turn_results` | `principal_id` = member                                                              | export; delete terminal inputs; keep pending/claimed inputs and their executing receipt group as `in_flight` |
| 7   | `model_runs`, `tool_traces`                                                                              | native invocation → mailbox principal, explicit principal, descendants, actor traces | export; keep the run and trace ids with content wiped (cost and counts stay)                                 |
| 8   | erasure receipt (migration 103)                                                                          | one row per erasure: principal, time, counts per store, no content                   | written last; counts include `in_flight`; next export reads the receipt                                      |

Reads after erasure: a deleted record is absent; a tombstone reads as `{id, scopes, state:
"erased"}` in memory reads, work reads, graph and provenance, and recall/search never returns it.

API (core, no product names): `exportPrincipalRecords(adapter, principalId)` and
`erasePrincipalRecords(adapter, { principalId, commandId })`, both refusing the owner principal
and any principal that is not a registered member.

Execution erasure snapshots run ownership before deleting mailbox rows. A pending or claimed input keeps
its delivery, refs, seen refs, result, run descendants and traces; a shared native receipt also
keeps its acknowledged root until the turn settles. A later erase needs a new command id.
A kept correction's edge target stays, with reason and attributes wiped; its personal endpoints
become tombstones so the surviving edge does not dangle.

Review corrections: each new native run stores the turn's `principalId` alongside its existing
input refs, including a child's freshly issued access. Pruned mailbox inputs cannot orphan those
runs; legacy runs still use their surviving mailbox linkage. A consumer-created pre-103
`mailbox_seen` gains its nullable principal column in the constructor, before inserts are prepared.

Cited decisions keep their id, rowid and scope bindings for edge and assignment joins. Their kind
and status become NULL (the CHECKs admit NULL, but no `erased` enum value); non-null record kind
becomes `legacy`, and both creation/update times become the erasure time. Observation capture time
remains the immutable visibility boundary. Erased raw refs obey the live time, source ceiling and
connector/channel constraints; a wiped source/channel cannot prove a restricted grant. Empty-query
search excludes tombstones in SQL before LIMIT, while direct listings may still show their state.

Migration 103 only skips a rebuilt table when every canonical column, nullability and CHECK is
present and the observation body XOR is absent. An incomplete table already holding `erased_at`
fails naming that table; complete tables and consumer extensions remain intact.

## Product (P9, owner decision 13, 2026-10-11)

The member asks in its own message turn; the host erases after that turn has settled, because the
running turn holds the workspace, the transcripts and its own mailbox input (core keeps a claimed
input `in_flight`). Store map and evidence: [checks](../checks.md#p9-plan-pass-2026-10-11).

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Done when                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core: `StimulusDelivery.onSettled?(row)` after both settle sites (`runtime.ts` delivered and reconciled), the terminal hook beside `onDead` and `onUncertain`. A throwing hook is logged and changes no drain result                                                                                                                                                                                                                                                                         | A core test sees one call per acked input on both paths; a throwing hook leaves `delivered` unchanged                                                                                     |
| 2   | `records.export` and `records.erase` in the member role only. No principal input: they act on the caller. Allowed only in the member's own message turn: the mailbox row of the turn's source ref belongs to the caller with kind `owner_message`; replay, delta, scheduled and subagent turns and every other principal are `denied`                                                                                                                                                        | The same calls from the owner, a delta, a replay and a subagent turn are `denied`; `help` lists both for the member only                                                                  |
| 3   | `records.export({})` builds one zip now and sends it to the member's own DM through the member file-delivery path (`deliver.telegram.file`, 50 MiB). It holds the core export, the product rows below and the member's files, never a credential copy (`.codex/auth.json`, `runtime/session-credential` and their like)                                                                                                                                                                      | The zip's record counts equal the core export plus the product rows; no credential file; over 50 MiB nothing is sent and the error names the size                                         |
| 4   | `records.erase({})` returns a preview (counts per store, file count and bytes) and a single-use confirmation token bound to the member, the issuing input and the time; a new preview replaces it. `records.erase({ confirmationToken })` is accepted only in a later member message: another mailbox input with a larger id, received after the token was issued. It returns `scheduled`                                                                                                    | Confirming in the issuing turn, with an input queued before the preview, with another member's token or a used token is refused                                                           |
| 5   | When the confirming input settles, the host runs the erasure on the shared serial chain: unserve the member and cancel its queued inputs (they run no model turn and are erased); reset, stop and remove its native session as P8's retire does; build the export and deliver it; only after Telegram confirms delivery, erase                                                                                                                                                               | A member input queued after the confirm runs no turn and reads back absent; a failed or oversized delivery erases nothing and the member is served again as before                        |
| 6   | Erase, each step selecting what remains so a retry finishes a partial run: product `connector_event_index` rows of `user:<member>` chat (before core, which deletes the observations they reference); core `erasePrincipalRecords`; chat `raw_items` and `pending_core_projections` of `user:<member>`; message-ledger entries whose target or key is the member's DM; the whole `<member_root>/<id>` tree, the member temp dir and every `.retired-` runtime and temp archive of the member | Each store reads back absent or tombstoned; the owner's work total, chat rows, ledger entries and files are unchanged; a shared revision the member wrote is unchanged                    |
| 7   | Serve the member again in a fresh environment with its enrollment and grants. Send a host receipt with the counts to the member's DM through a new member-DM text port, and record it in the member's chat as a host exchange (#468), so the member's agent can answer about it                                                                                                                                                                                                              | The next member turn opens a new session in an empty workspace; the receipt is delivered, recorded with `deliveryVerified`, and its counts equal the core receipt plus the product counts |
| 8   | A failure after deletion began sends a receipt naming the failed step, serves the member again and leaves the rest for a new confirmation                                                                                                                                                                                                                                                                                                                                                    | A fixture failure in step 6 yields that receipt and a second confirmation finishes the erase                                                                                              |

Done in #471, with these choices from eight review rounds: the erasure retires the member before
taking the export, so no writer or intake exists while it is built; files go into the zip
uncompressed so the 50 MiB limit is checked before anything is read; host-managed directories give
only transcripts, history and the action journal; links that leave the member's trees are named and
left out; the file inventory is taken again right before the trees are deleted. An export runs
after its turn, holds the shared chain only while its zip is built, and a member has one at a time.

Not in P9: a restart between the confirm and the erasure drops the confirmation silently, a member-DM
receipt is not re-sent after a restart, and an erasure pauses claims for every principal until its
export is delivered. Member messages are first admitted in P10, so these join P10. Core follow-up:
the preview and the export call B1's snapshot, which reads whole tables and filters in JS; a
bounded count for the preview and a streaming export are core work.
Security alerts about a member keep the principal, host and time (decision 7) and stay.

## Proof

Before and after on a temporary database with an owner, a member and shared work: the export holds
exactly the member-scoped rows of every store above; afterwards each reads back as absent or
tombstoned; a shared revision the member wrote, an owner record citing a member record, and a record
bound to both the member's and a shared scope are unchanged except the tombstoned citation target;
a replayed erased command does not recreate anything; the vector cache returns no erased record;
the owner's counts are unchanged.

# W38 — Conversations with MAMA are kept as raw sources

Owner decisions, 2026-10-06:

- The owner's conversation with MAMA is kept as raw source data, as Kagemusha keeps it. The
  messages still in the mailbox are pushed in.
- Agent sessions are split into a common session, the owner session and one session per team
  member. Each keeps common memory apart from each member's memory. This item only stores the
  owner's conversation; the same path later stores each session's conversation.

Program evidence ([checks](../checks.md)):

- MAMA keeps the owner's messages only in the mailbox, which deletes handled rows seven days after
  they were acknowledged (`mama-core/src/runtime/mailbox.ts:316`). Replies survive in
  `native_turn_results`. 6 of the 26 active owner rules already cite a message that is gone.
- A provenance read follows `derived_from` observation links, and an owner message is no
  observation, so a correction cannot link the message it came from. The corrections guide
  already describes that link.
- Kagemusha records the owner's message before the turn and the reply after it, in the same table
  as every monitored channel. It indexes both for search and leaves the owner chat out of deltas
  when it reads them (`getNewSince(sinceId, ['telegram'])`).
- The parts exist. A collect-only raw save followed by projection indexes an item without a delta
  (`replay/import-manifest.ts` `drainRawProjections`), and no source reader treats collect-only
  items differently. All three messengers hand owner messages to
  `createStimulusIntake.acceptOwnerMessage` (`runtime/stimulus-delivery.ts`). The `telegram`
  polling connector is not usable: it is disabled, because the gateway owns the bot's updates.
- Replay windows read every connector in `connector_event_index`
  (`replay/replay-source-catalog.ts` `readReplaySourceEvents`), so a stored chat would be replayed
  as source events unless it is excluded.
- Snapshot taken before more rows expire (testbed only, not in the repository):
  `~/.mama/backfill/owner-chat/` holds 125 owner messages from 09-29 to 10-06 (123 with their
  reply) and 98 replies whose message was already pruned.

## Work

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Done when                                                                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W38.1 | `acceptOwnerMessage` saves the message as a collect-only raw item and projects it, before the mailbox row is accepted. It uses a connector of its own (`chat`), not `telegram`, so the polling connector's items never mix in. The channel is the messenger chat key, the source id is the message ref (the same ref the mailbox and an owner rule's provenance carry), and the author is the principal. A failed save fails the intake, as any accept failure does. `chat` joins the owner's connectors, so source reads reach it | Tests under a temporary `$HOME`: an owner message becomes one observation readable by `source.read` and found by `source.search`; no `source_delta` row is produced; a save failure leaves no mailbox row                                     |
| W38.2 | After the messenger confirms delivery (`deliverResponse` → ledger `delivered`), the reply is saved the same way, with source id `<message ref>:reply`, the agent as author, and a link to its message                                                                                                                                                                                                                                                                                                                              | Tests: a delivered reply is stored once; a failed send stores nothing; a retried send does not duplicate; a stop between delivery and the save is recovered at the next start from `native_turn_results` through the W38.6 item builder, once |
| W38.3 | The owner message order carries the message's observation ref, so a correction saved in that turn can state `derived_from` to it. The agent states the link; the host writes none                                                                                                                                                                                                                                                                                                                                                  | Test: the order shows the ref; a `memory.save` with that `derived_from` link resolves through `memory.read:provenance`                                                                                                                        |
| W38.4 | `owner.messages` and the session start's last exchanges read the stored chat instead of the mailbox. Delete `ownerExchangesBetween`/`answerFor` (`runtime/session-start-context.ts`) and the seven-day retention note in `owner.messages`                                                                                                                                                                                                                                                                                          | Tests: exchanges older than seven days are returned; lines deleted and added are counted in the PR                                                                                                                                            |
| W38.5 | Replay windows leave out the `chat` connector at the read, as Kagemusha's delta read leaves out its chat                                                                                                                                                                                                                                                                                                                                                                                                                           | Test: a replay window over a period with stored chat has no chat events                                                                                                                                                                       |
| W38.6 | Backfill in the testbed with the daemon stopped: the snapshot goes through the W38.1/W38.2 item builder (questions, their replies, and replies without a question)                                                                                                                                                                                                                                                                                                                                                                 | Counts match the snapshot (125, 123, 98); `source.read` returns a 09-29 message; `daemon.log` is clean after restart                                                                                                                          |

Open (owner's call): whether the owner's agent may read a team member's chat by default. Letta lets
an admin read every conversation. This is a policy line in the team design, not part of W38.

Messages before 09-29 survive only in the Claude CLI transcripts, which MAMA does not own. They are
not backfilled unless the owner asks.

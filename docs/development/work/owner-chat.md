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
- The parts exist, with one limit. A collect-only raw save plus a projection indexes an item
  without a delta, and no source reader treats collect-only items differently. The import's
  `drainRawProjections` cannot be reused live: it drains and acknowledges every connector's pending
  projections (`replay/import-manifest.ts:154`), including rows the poller still needs for its
  deltas (`connectors/framework/polling-scheduler.ts:245`, `:282`), and it is asynchronous while
  `acceptOwnerMessage` is synchronous (`runtime/stimulus-delivery.ts:58`). The synchronous core sink
  `createCoreRawIndexSink` (`replay/import-manifest.ts:127`) projects one item. All three messengers
  hand owner messages to `acceptOwnerMessage`. The `telegram` polling connector is not usable: it
  is disabled, because the gateway owns the bot's updates.
- `LOADABLE_CONNECTORS` is the owner's connector list (`runtime/action-surface.ts:51`). It drives
  loaders and config checks, and `ownerMemoryScopes` adds a `channel` and a `project` scope per
  entry to every write that names no scope. `chat` must not enter that list.
- A reply is delivered when the messenger's ledger marks it `delivered`, not when
  `deliverResponse` returns: offline, it only marks the entry ready (`gateways/telegram.ts:271`),
  and recovery later sends either the reply or the host's interruption notice. Delivered ledger
  entries drop the text after seven days. `native_turn_results` holds the model's output and no
  delivery state.
- An earlier version of this item is dead code: `gateways/conversation-record.ts` (325 lines) and
  `gateways/session-store.ts` (675 lines) store owner messages and results as observations, and
  only their own tests import them.
- The memory write path already records where a save came from: `session.sourceRefs` lands in a
  record's provenance (`mama-core/src/memory/api.ts:916`, `:1027`), and the provenance read
  resolves it. Nothing sets it for owner turns today.
- Replay windows read every connector in `connector_event_index`
  (`replay/replay-source-catalog.ts` `readReplaySourceEvents`), so a stored chat would be replayed
  as source events unless it is excluded.
- Snapshot taken before more rows expire (testbed only, not in the repository):
  `~/.mama/backfill/owner-chat/` holds 125 owner messages from 09-29 to 10-06 (123 with their
  reply) and 98 replies whose message was already pruned.

## Work

Order: W38 lands before W37's live merge. Policy revisions need the owner message as a stored
original, and messages after the 10-06 snapshot leave the mailbox from 10-13.

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Done when                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W38.1 | `acceptOwnerMessage` saves the message as a collect-only raw item of the `chat` connector and projects that one item through the synchronous core sink, before the mailbox row is accepted. The channel is `<messenger>:<chat id>`, the source id is the message ref (the ref the mailbox and an owner rule's provenance carry), the author is the principal, and the item is bound to `user:<principal>` explicitly. `chat` stays out of `LOADABLE_CONNECTORS`; the owner's readable sources name it separately. A failed save fails the intake; the gateway's processing entry then goes through the existing interruption path, so the owner is told | Tests under a temporary `$HOME`: an owner message becomes one observation readable by `source.read` and found by `source.search`; no `source_delta` row is produced and another connector's pending projection is left pending; a save failure leaves no mailbox row and the owner receives the interruption notice |
| W38.2 | Each messenger saves the text it actually sent when its ledger marks the entry `delivered` (Telegram `deliverReadyEntry`, and the Discord and Slack equivalents). The source id is `<message ref>:reply`; the author is the agent for a reply and the host for an interruption notice. The message ref is a metadata field, not a link: the host writes no link                                                                                                                                                                                                                                                                                         | Tests: a delivered reply is stored once with the sent text; a reply that was never sent stores nothing; recovery that sends the interruption notice stores it as the host's; a retried send does not duplicate                                                                                                      |
| W38.3 | Owner turns set `session.sourceRefs` to the message's observation, so every memory record written in that turn carries it in its provenance. The agent may still state `derived_from` links                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Test: `memory.read:provenance` of a correction saved in an owner turn returns the owner's message text                                                                                                                                                                                                              |
| W38.4 | `owner.messages` and the session start's last exchanges read the stored chat instead of the mailbox. Delete `ownerExchangesBetween`, `ownerExchanges`, `answerFor`, the `deliveredRefs` port and `recentDeliveredMessageRefs` (`runtime/session-start-context.ts`, `runtime/owner-runtime.ts`), the seven-day retention note in `owner.messages`, and the dead `conversation-record.ts` and `session-store.ts` with their tests                                                                                                                                                                                                                         | Tests: exchanges older than seven days are returned; lines deleted and added are counted in the PR                                                                                                                                                                                                                  |
| W38.5 | Replay windows leave out `chat` at the read, as Kagemusha's delta read leaves out its chat. `source.recent` leaves `chat` out of its channel list unless the call names it; `source.search` and `source.read` reach it                                                                                                                                                                                                                                                                                                                                                                                                                                  | Tests: a replay window over a period with stored chat has no chat events; `source.recent` without a channel lists none, and with the chat channel lists its lines                                                                                                                                                   |
| W38.6 | Backfill in the testbed with the daemon stopped: the snapshot goes through the W38.1/W38.2 item builders. Snapshot replies came from `native_turn_results`, so they are stored with delivery unverified                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Counts match the snapshot (125 messages, 123 replies, 98 replies without a message); `source.read` returns a 09-29 message; `daemon.log` is clean after restart                                                                                                                                                     |

Decided (owner, 2026-10-06): the owner's agent cannot read a team member's chat by default. W38.1
adds `chat` to the owner's connectors while only the owner's own chat exists; once member chats
are stored, the owner's reads of `chat` are limited to the owner's own channel (team design).

Messages before 09-29 survive only in the Claude CLI transcripts, which MAMA does not own. They are
not backfilled unless the owner asks.

# W32 — Found in any spelling; judged right in its conversation (v2)

Owner decisions, 2026-10-01:

- **Search finds other spellings:** when the agent meets a task or an event that is not in its
  memory, it searches. A word or a task must be found in another language and in approximate
  spellings ("다국어로 또는 근사치로").
- **Conversations, not single messages:** "대화의 경우 하나만이 아니라 연결이고 묶음이고 전후
  맥락". The agent judges a conversation as a whole, with what came before it.
- **Memory philosophy (MAMA decision `memory_philosophy_agent_judgment_paths`):** the unit is a
  connected judgment; the host provides structure and receipts, the agent judges. A classifier may
  narrow what the agent reads; it never writes a link, a status or an authority.

v1 of this plan assumed live messages were going unjudged. An independent review showed it had
counted messages from before record orders existed. v2 is built on the corrected counts below.

Evidence (live database, 2026-10-01):

- **Live coverage is already near complete.** Record orders started at 09-29 10:08 (#334).
  Since then the uncited counts of live Chatwork, Slack and Kakao messages are 3 of 112 (09-29,
  all before #347), 0 of 253 (09-30) and 0 of 48 (10-01). The 09-17 to 09-25 replay windows and
  the live days before 09-29 ran without a record stage. Replay rows never enqueue one
  (`stimulus-delivery.ts:572`), so their messages are linked only where a turn chose to link them.
- **What coverage does not show.** Whether a citation names the right item has never been
  checked. The check also has gaps of its own:
  - It passes a batch on any one cited observation (`record-orders.ts:55-71`, `LIMIT 1`), or on
    any no-update in the order's runs whatever it names (`:76`).
  - It reads a no-update's refs from the trace summary, which keeps 40 array items and 4,000
    characters (`trace-summary.ts:57`).
  - It does not count a lesson's `derived_from` citation, though the order asks for one
    (`turn-orders.ts:490`).
  - A single no-update naming every ref passes, and `work.no_update` accepts any strings
    (`record-actions.ts:41-51`).
- **What the order shows.** The last five lines and a list of ids (`turn-orders.ts:410, 474`).
  It does not show which item an earlier message of the same conversation was cited by.
  Kagemusha's reconcile is the same (`agent-awareness.ts`, `reconcileTaskboardForDelta`).
- **Search.** `source.search` requires every term as a substring of title, content, author or
  channel (`raw-query.ts:299-319`). Raw observations have no embeddings; `embeddings` is keyed to
  memory records (`node-sqlite-adapter.ts:612-660`). 496 messages are about 7 current cards. A
  Japanese name query finds 42% of them and a Korean one 40%. The same card appears under its
  Japanese name, its Korean name, or only as a numeric code inside a file name.
- **What finds a conversation's work (PoC, MAMA decision `case_similarity_filter_measured`).** On
  60 real messages with the card name hidden, MAMA's embedding over earlier messages already linked
  to each card put the right card first 62% of the time and in the top five 92%. Without those
  earlier links, Jev and a local model reached 35–37%.

## Work

| #     | What changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W32.1 | **Search finds other spellings.** A background embedder in the daemon gives each current observation a passage vector from MAMA's model (multilingual-e5-large), newest first, and keeps up with new ones. The vectors go in a new core table keyed by observation id (migration 100); superseded versions are not embedded. `source.search` (product) returns its text hits, then, on the first page, up to 10 nearest-meaning hits. A meaning hit must stand 2.5 standard deviations above the query's mean similarity in that connector: e5 scores sit in a narrow band, so no single absolute floor separates related messages (about-card p50 0.777, other messages p99 0.776). Meaning hits keep the substring path's filters: the replay read ceiling and the one-connector rule. Each hit says how it matched (`text` or `meaning`); a meaning hit gives its similarity. | On the 7 cards (496 messages, Slack, KakaoTalk and Chatwork), each name query in Japanese and in Korean (14 queries) returns among its meaning hits at least one message about the card that the text query cannot find (other language or code only). Meaning-hit precision and short-reply share are recorded. Tests: a Korean query finds a Japanese-only message; a hit must stand out from the query's other scores; replay never sees a message after its ceiling; one connector; each hit carries its match kind. The second-consumer check passes. The embedding cost per message is logged by the daemon. |
| W32.2 | **Are the judgments right?** The owner checks 30 citations sampled from live record orders since 09-29: single-item revisions, multi-link revisions and no-updates, each shown with its messages and conversation. Revision-cited and no-update-cited messages are counted separately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The wrong-citation count is recorded in `checks.md`, by kind. W32.4 starts only if wrong citations are found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| W32.3 | **The record receipt is exact.** The record check counts only what was written for those messages. A no-update stores the refs it names durably, not in the trace summary. A batch is recorded when each of its observations is cited by a work revision, a lesson, or a no-update naming it. The "any no-update in the run" pass is removed. Each order's end logs `record coverage delta=<id> revision=<a> no_update=<b> uncited=<c>`. Stored record orders of the old shape still parse at boot.                                                                                                                                                                                                                                                                                                                                                                              | Tests that fail on the old check: one cited message of three does not record the batch; a no-update naming none does not; a lesson citation counts; 60 refs in one no-update all count. Boot recovery parses an old-shape order.                                                                                                                                                                                                                                                                                                                                                                                   |
| W32.4 | **The record order shows the conversation (only after W32.2 finds wrong citations).** The order lists its messages with their reply marks (Slack thread parent, Chatwork `[rp]` target). Before them it shows up to 12 earlier messages of the same conversation, each with the item it was cited by. These come from a render-time port reading `connector_event_index`, `twin_edges` and `commitment_assignments`, because stored context goes stale between attempts.                                                                                                                                                                                                                                                                                                                                                                                                         | A repeat of the W32.2 check on orders written after it shows fewer wrong citations. Tokens per order are compared with 09-30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| W32.5 | **History before 09-29 stays findable, not rewritten.** Messages from before record orders existed are left as observations. Re-recording them would append revisions that fold over newer state (`commitments.ts:322-350`). W32.1 makes them findable in any spelling, and `work.show` already reads an item's linked history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A Korean search for a 09-18 event in Japanese finds it. No revision is written for past events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Out of scope

- The host linking or grouping messages by meaning.
- A classifier writing links or statuses. A suggestion tool that ranks candidate items by earlier
  linked cases (the PoC) may follow as something the agent pulls; it is not part of W32.
- Splitting record orders by size: live orders since 09-29 hold at most 6 refs.
- Local decision models (`local_decision_models_measured`).

## Release

PRs, in order:

1. **Engine and MAMA OS:** W32.1 with this plan, including core migration 100 (a minor release)
   and the `source.search` fusion.
2. **MAMA OS:** W32.3.
3. **Owner check:** W32.2, then W32.4 only if W32.2 finds wrong citations.

Proof:

- **Tests:** each item's tests fail on the old code.
- **Live:** the W32.1 search numbers on the daemon database after backfill, and the W32.2 counts.

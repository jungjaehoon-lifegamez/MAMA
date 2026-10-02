# W33 — Trello: read the state live, keep the history as actions

Owner decisions, 2026-10-02:

- **Current state is read live** from Trello, as Kagemusha reads it. No copy of the board state is
  kept in the database.
- **History is polled and stored**, in the same shape as the imported history, so every change
  (moves, comments, attachments, due dates, labels, archive) can be searched and cited.
- **Done** means two owner questions answered right in Telegram: where a card is now, and when it
  reached a given list (for example its FIX).

Evidence:

- The agent has no Trello read of its own in the current build. On 2026-10-01 a full report checked
  Trello by searching stored rows, at most three per item since 09-25; on 2026-10-02 the open-item
  review needed the Trello API called by hand. On 2026-07-24 answering state from the change log
  produced three Trello defects in a day (missing labels, wrong times, merged cards).
- The poller (`connectors/trello/index.ts:221-373`) diffs open-card snapshots kept in a JSON state
  file. It records moves, label and member changes, but not comments, attachments, due dates,
  archived cards or copies. The imported months hold 1,121 attachments and 177 comments; the live
  rows hold none. The stored history has two kinds of rows: imported actions and live snapshot
  changes.
- Work revisions cite 5,934 Trello observations; citing needs stored records.
- Over 207 days of imported actions, 2,228 board batches of five minutes had actions and 34 held
  only reorders, so every action can reach the agent without a filter.
- Polls fail (a board fetch timed out on 2026-10-02); a stored copy of the state would go stale
  silently, while a live read fails where it is asked.

## Kagemusha and MAMA

| Kagemusha (`tools/trello-tools.ts`) | MAMA (`trello.read`) | Difference |
| --- | --- | --- |
| `trello_kanban`: every board's cards in five work columns | `boards`, then `cards` per list | The column patterns are business vocabulary: MAMA returns list names and the agent judges them. |
| `trello_boards`, `trello_board_lists` | `boards`: the configured boards, their lists and open-card counts | Only the boards in `connectors.json` the principal is granted, not every board of the account. |
| `trello_cards` | `cards`: open cards of a board or a list | Same. |
| `trello_card_detail` | `card`: description, labels, members, checklists and the card's latest actions | Each action that is stored carries its observation ref, so the answer can cite it. |
| `trello_search` | `search`: cards matching a query on the granted boards | Same. |
| A kanban cache that serves stale columns when a refresh fails | No cache; a failed request is the action's error | No fallback path (AGENTS.md). |

## Work

| # | What changes | Done when |
| --- | --- | --- |
| W33.1 | **One action mapping.** `actionItem` moves from `replay/trello-import.ts:70` to `connectors/trello/` beside `trelloActionLine`; the importer and the poller both use it. The line names label changes by name ("labels A, B -> A, C") from the board's labels when the caller passes them; the importer fetches each board's labels once. | Tests: an import and a poll of the same action store the same item; a label change shows the names. |
| W33.2 | **The poller reads actions.** `TrelloConnector.poll(since)` reads `GET /boards/{id}/actions` (filter all, `since`, pages of 1,000 by `before`) and `GET /boards/{id}/labels` for each configured board, and returns the W33.1 items. The snapshot code is removed: `CardState`, its encoding, the state file and its option (`trelloStatePath` in `connectors/index.ts`, `runtime/connectors.ts:43,206`, `cli/commands/daemon.ts`), and the handoff methods that committed it. A board that fails fails the poll, as now, so the scheduler retries from the same `since` (`polling-scheduler.ts:214-307`). Deltas stay one per board batch. | Tests: paging, `since`, an action seen twice stored once, a failing board stores nothing and keeps the cursor. The old snapshot tests are removed with the code. |
| W33.3 | **`trello.read`.** One action with four views — `boards`, `cards` (`board`, optional `list`), `card` (`id`), `search` (`query`, `limit` up to 20) — added to `OWNER_ACTIONS` (`runtime/action-surface.ts:45`) and so to code_act scripts. It declares `readsConnector: { fixed: 'trello' }` and reads only configured boards; a non-owner principal reads only its granted boards (as `stored-source-reader.ts:63`). The requests go through read methods on the registered `TrelloConnector`, reached by the connector-registry port the attachment actions use (`cli/commands/daemon.ts:444`), so the credentials stay in the connector. `cards` refuses more than 100 cards and names the list to narrow to. Times are ISO with the owner's offset. | Tests with a mocked Trello: each view's shape; an ungranted board is denied; an unconfigured board is refused; over 100 cards fails with the narrowing message; a Trello error is the action's error. |
| W33.4 | **The agent is told where Trello lives.** The source-access line of the owner policy (`runtime/owner-system-prompt.ts:168`) adds: the current Trello state is read with `trello.read`; past changes are stored rows read with `source.search` and `source.read`. | `owner-system-prompt` test updated. |
| W33.5 | **Cutover in the testbed** (outside the repo). After deploy, the actions since the last import are imported once with the import tool; the old snapshot state file is deleted. | `daemon.log` clean; new Trello rows are action lines with the action in metadata; the two owner questions answered right in Telegram. |

## Known limits

- History rows arrive up to one poll (5 minutes) after the change; `trello.read` is current.
- A label is named as it was called when its change was stored; a later rename does not rewrite
  history.
- The 95 rows the snapshot poller stored before the cutover keep their shape.

## Out of scope

- A stored copy of the current board state.
- Grouping lists into work columns (the agent's judgment).
- Writing to Trello.

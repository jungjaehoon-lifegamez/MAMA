/**
 * The one stored shape of a Trello board action. The history import and the poller both store
 * this item, so an action imported and later polled (the poll windows overlap on purpose) is the
 * same row. The item depends only on the action and the board's configured name. Each action is
 * its own entity, as an imported chat message is: Trello edits a comment in place on the same
 * action, and the raw store records a re-listed action that changed as its next revision (an
 * entity keyed by the card would make it an immutable version and refuse the change, stopping
 * every later poll). The card stays in metadata.cardId.
 */
import type { NormalizedItem } from '../framework/types.js';
import { trelloActionLine } from './action-line.js';

export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data: Record<string, unknown>;
  idMemberCreator?: string;
  memberCreator?: Record<string, unknown>;
}

export interface TrelloBoardChannel {
  /** The connectors.json channel key, which channel grants and the index use. */
  key: string;
  boardId: string;
  /** The configured board name; the scheduler adds the same value as channelName. */
  name?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function trelloActionItem(board: TrelloBoardChannel, action: TrelloAction): NormalizedItem {
  const card = record(action.data.card);
  const list = record(action.data.list);
  const cardId = typeof card?.id === 'string' ? card.id : board.boardId;
  return {
    source: 'trello',
    sourceId: action.id,
    sourceEntityId: action.id,
    channel: board.key,
    author: 'trello',
    content: trelloActionLine(action),
    timestamp: new Date(Date.parse(action.date)),
    type: 'kanban_card',
    metadata: {
      actionType: action.type,
      boardId: board.boardId,
      cardId,
      ...(board.name === undefined ? {} : { channelName: board.name }),
      ...(list === undefined ? {} : { list }),
      ...(action.idMemberCreator === undefined ? {} : { idMemberCreator: action.idMemberCreator }),
      ...(action.memberCreator === undefined ? {} : { memberCreator: action.memberCreator }),
      data: action.data,
    },
  };
}

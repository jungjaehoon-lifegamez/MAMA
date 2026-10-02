/**
 * TrelloConnector — stores every action of the configured boards. Each poll reads
 * /boards/{id}/actions since the scheduler's cursor and returns the same item the history import
 * stores (connectors/trello/actions.ts); the windows overlap and the raw store keeps an action
 * once. The connector also serves trello.read, so the credentials stay here.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { messageWithCauses } from '../../utils/error-message.js';
import { TrelloApi } from './api.js';
import { trelloActionItem, type TrelloAction, type TrelloBoardChannel } from './actions.js';
import { trelloActionLine } from './action-line.js';

export interface TrelloBoardView {
  board: string;
  name: string | null;
  lists: Array<{ id: string; name: string; openCards: number }>;
}

export interface TrelloCardView {
  id: string;
  name: string;
  board: string;
  list: string | null;
  labels: string[];
  members: string[];
  due: string | null;
  dueComplete: boolean;
  lastActivity: string;
  url: string | null;
}

export interface TrelloCardDetail extends TrelloCardView {
  description: string;
  closed: boolean;
  checklists: Array<{ name: string; items: Array<{ name: string; state: string }> }>;
  actions: Array<{ id: string; time: string; line: string }>;
}

interface RawCard {
  id: string;
  name: string;
  idBoard?: string;
  idList: string;
  idMembers?: string[];
  labels?: Array<{ name?: string }>;
  due: string | null;
  dueComplete?: boolean;
  dateLastActivity: string;
  shortUrl?: string;
  list?: { name?: string };
}

const CARD_FIELDS =
  'name,idBoard,idList,idMembers,labels,due,dueComplete,dateLastActivity,shortUrl';

export class TrelloConnector implements IConnector {
  readonly name = 'trello';
  readonly type = 'api' as const;

  private client: TrelloApi | null = null;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  /** The configured boards; an ignored channel or one without a board is left out. */
  boards(): TrelloBoardChannel[] {
    return Object.entries(this.config.channels).flatMap(([key, channel]) =>
      channel.role === 'ignore' || !channel.boardId
        ? []
        : [
            {
              key,
              boardId: channel.boardId,
              ...(channel.name === undefined ? {} : { name: channel.name }),
            },
          ]
    );
  }

  api(): TrelloApi {
    if (!this.client) throw new Error('TrelloConnector not initialized');
    return this.client;
  }

  async init(): Promise<void> {
    const apiKey = process.env.MAMA_TRELLO_KEY;
    const token = process.env[this.config.auth.tokenName ?? 'MAMA_TRELLO_TOKEN'];
    if (!apiKey?.trim() || !token?.trim()) {
      throw new Error(
        'Trello credentials missing. Run mama secret set MAMA_TRELLO_KEY and mama secret set MAMA_TRELLO_TOKEN, then restart through ~/.mama/start.sh.'
      );
    }
    this.client = new TrelloApi({ apiKey, token }, this.fetchImpl);
  }

  async dispose(): Promise<void> {
    this.client = null;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.client !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'MAMA_TRELLO_KEY',
        description: 'Trello API key. Enter it with mama secret set MAMA_TRELLO_KEY.',
      },
      {
        type: 'token',
        tokenName: this.config.auth.tokenName ?? 'MAMA_TRELLO_TOKEN',
        description: 'Trello token. Enter it with mama secret set MAMA_TRELLO_TOKEN.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      const apiKey = process.env.MAMA_TRELLO_KEY;
      const token = process.env[this.config.auth.tokenName ?? 'MAMA_TRELLO_TOKEN'];
      if (!apiKey || !token) return false;
      const res = await fetch(`https://api.trello.com/1/members/me?key=${apiKey}&token=${token}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** One failing board fails the poll, so the scheduler keeps its cursor and retries the window. */
  async poll(since: Date): Promise<NormalizedItem[]> {
    const api = this.api();
    const boards = this.boards();
    const items: NormalizedItem[] = [];
    let failed = 0;
    for (const board of boards) {
      try {
        const actions = await api.boardActions(board.boardId, { fromMs: since.getTime() });
        items.push(...actions.map((action) => trelloActionItem(board, action)));
      } catch (err) {
        failed += 1;
        this.lastError = `Board ${board.boardId}: ${messageWithCauses(err)}`;
      }
    }
    if (failed > 0) {
      throw new Error(
        `Trello poll failed for ${failed} of ${boards.length} configured boards; last error: ${this.lastError}`
      );
    }
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    return items;
  }

  private boardKey(boardId: string): string | undefined {
    return this.boards().find((board) => board.boardId === boardId)?.key;
  }

  private cardView(
    card: RawCard,
    lists: ReadonlyMap<string, string>,
    members: ReadonlyMap<string, string>
  ): TrelloCardView {
    return {
      id: card.id,
      name: card.name,
      board: this.boardKey(card.idBoard ?? '') ?? card.idBoard ?? '',
      list: card.list?.name ?? lists.get(card.idList) ?? null,
      labels: (card.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
      members: (card.idMembers ?? []).map((id) => members.get(id) ?? id),
      due: card.due,
      dueComplete: card.dueComplete === true,
      lastActivity: card.dateLastActivity,
      url: card.shortUrl ?? null,
    };
  }

  /** Each board's open lists with their open card counts. */
  async readBoards(boards: TrelloBoardChannel[]): Promise<TrelloBoardView[]> {
    const api = this.api();
    const views: TrelloBoardView[] = [];
    for (const board of boards) {
      const lists = await api.get<Array<{ id: string; name: string; cards?: unknown[] }>>(
        `/boards/${encodeURIComponent(board.boardId)}/lists`,
        { filter: 'open', fields: 'name', cards: 'open', card_fields: 'id' }
      );
      views.push({
        board: board.key,
        name: board.name ?? null,
        lists: lists.map((list) => ({
          id: list.id,
          name: list.name,
          openCards: list.cards?.length ?? 0,
        })),
      });
    }
    return views;
  }

  /** The open cards of a board, or of one of its lists, with list, label and member names. */
  async readCards(board: TrelloBoardChannel, listId?: string): Promise<TrelloCardView[]> {
    const api = this.api();
    const boardPath = `/boards/${encodeURIComponent(board.boardId)}`;
    const lists = await api.get<Array<{ id: string; name: string }>>(`${boardPath}/lists`, {
      filter: 'open',
      fields: 'name',
    });
    const members = await api.get<Array<{ id: string; fullName?: string; username?: string }>>(
      `${boardPath}/members`,
      { fields: 'fullName,username' }
    );
    const cards = await api.get<RawCard[]>(
      listId === undefined
        ? `${boardPath}/cards/open`
        : `/lists/${encodeURIComponent(listId)}/cards`,
      { fields: CARD_FIELDS }
    );
    const listNames = new Map(lists.map((list) => [list.id, list.name]));
    if (cards.length > 100) {
      const counts = new Map<string, number>();
      for (const card of cards) counts.set(card.idList, (counts.get(card.idList) ?? 0) + 1);
      const error = new Error(
        `${cards.length} open cards; read one list: ${[...counts]
          .map(([id, count]) => `${id} ${listNames.get(id) ?? '?'} (${count})`)
          .join(', ')}`
      );
      error.name = 'invalid_input';
      throw error;
    }
    const memberNames = new Map(
      members.map((member) => [member.id, member.fullName || member.username || member.id])
    );
    return cards.map((card) =>
      this.cardView({ ...card, idBoard: card.idBoard ?? board.boardId }, listNames, memberNames)
    );
  }

  /** One card with its description, checklists and latest actions; label changes are named. */
  async readCard(cardId: string): Promise<TrelloCardDetail & { boardId: string }> {
    const api = this.api();
    const card = await api.get<
      RawCard & {
        desc?: string;
        closed?: boolean;
        members?: Array<{ id: string; fullName?: string; username?: string }>;
        checklists?: Array<{
          name?: string;
          checkItems?: Array<{ name?: string; state?: string }>;
        }>;
        actions?: TrelloAction[];
      }
    >(`/cards/${encodeURIComponent(cardId)}`, {
      fields: `${CARD_FIELDS},desc,closed`,
      list: 'true',
      list_fields: 'name',
      members: 'true',
      member_fields: 'fullName,username',
      checklists: 'all',
      checklist_fields: 'name',
      actions: 'all',
      actions_limit: '20',
      action_memberCreator_fields: 'fullName,username',
    });
    const boardId = card.idBoard ?? '';
    const labels = await api.boardLabels(boardId);
    const members = new Map(
      (card.members ?? []).map((member) => [
        member.id,
        member.fullName || member.username || member.id,
      ])
    );
    return {
      ...this.cardView(card, new Map(), members),
      boardId,
      description: card.desc ?? '',
      closed: card.closed === true,
      checklists: (card.checklists ?? []).map((checklist) => ({
        name: checklist.name ?? '',
        items: (checklist.checkItems ?? []).map((item) => ({
          name: item.name ?? '',
          state: item.state ?? '',
        })),
      })),
      actions: (card.actions ?? []).map((action) => ({
        id: action.id,
        time: action.date,
        line: trelloActionLine(action, labels),
      })),
    };
  }

  /** Cards matching a query on the given boards (Trello search, at most 20 terms). */
  async searchCards(
    query: string,
    boards: TrelloBoardChannel[],
    limit: number
  ): Promise<TrelloCardView[]> {
    const result = await this.api().get<{ cards?: RawCard[] }>('/search', {
      query,
      modelTypes: 'cards',
      idBoards: boards.map((board) => board.boardId).join(','),
      cards_limit: String(limit),
      card_fields: CARD_FIELDS,
      card_list: 'true',
      partial: 'true',
    });
    return (result.cards ?? []).map((card) => this.cardView(card, new Map(), new Map()));
  }
}

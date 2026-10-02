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
import { trelloActionItem, type TrelloBoardChannel } from './actions.js';

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
}

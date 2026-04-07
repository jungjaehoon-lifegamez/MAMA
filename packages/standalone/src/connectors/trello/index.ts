/**
 * TrelloConnector — polls Trello boards via native fetch.
 * Auth token format: "apiKey:token" stored in config.auth.token or TRELLO_TOKEN env var.
 * Emits kanban_card NormalizedItems for moved/new cards.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface TrelloCard {
  id: string;
  name: string;
  idMembers: string[];
  dateLastActivity: string;
}

interface TrelloList {
  id: string;
  name: string;
  cards: TrelloCard[];
}

export class TrelloConnector implements IConnector {
  readonly name = 'trello';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private apiKey: string | null = null;
  private token: string | null = null;
  private readonly baseUrl = 'https://api.trello.com/1';
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  /** boardId → (cardId → listName) */
  private lastCardStates: Map<string, Map<string, string>> = new Map();

  private readonly stateFilePath = join(homedir(), '.mama', 'connectors', 'trello', 'trello-state.json');

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  private loadState(): void {
    if (existsSync(this.stateFilePath)) {
      try {
        const data = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
        for (const [board, cards] of Object.entries(data.lastCardStates ?? {})) {
          this.lastCardStates.set(board, new Map(Object.entries(cards as Record<string, string>)));
        }
      } catch { /* ignore corrupt state */ }
    }
  }

  private saveState(): void {
    const dir = join(homedir(), '.mama', 'connectors', 'trello');
    mkdirSync(dir, { recursive: true });
    const obj: Record<string, Record<string, string>> = {};
    for (const [board, cards] of this.lastCardStates) {
      obj[board] = Object.fromEntries(cards);
    }
    writeFileSync(this.stateFilePath, JSON.stringify({ lastCardStates: obj }));
  }

  async init(): Promise<void> {
    const rawToken =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'TRELLO_TOKEN'];
    if (!rawToken) {
      throw new Error(
        'Trello token not found. Set TRELLO_TOKEN environment variable (format: apiKey:token).'
      );
    }
    const parts = rawToken.split(':');
    if (parts.length < 2) {
      throw new Error('Trello token format invalid. Expected "apiKey:token".');
    }
    this.apiKey = parts[0] ?? null;
    this.token = parts.slice(1).join(':');
    this.loadState();
  }

  async dispose(): Promise<void> {
    this.apiKey = null;
    this.token = null;
    this.lastCardStates.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.token !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'TRELLO_TOKEN',
        description:
          'Trello API credentials in format "apiKey:token". Get from https://trello.com/app-key',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.apiKey || !this.token) return false;
      const url = `${this.baseUrl}/members/me?key=${this.apiKey}&token=${this.token}`;
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }

  async poll(_since: Date): Promise<NormalizedItem[]> {
    if (!this.apiKey || !this.token) throw new Error('TrelloConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;

    for (const [channelKey, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;
      if (!channelCfg.boardId) continue;

      const channelName = channelCfg.name ?? channelKey;
      const boardId = channelCfg.boardId;

      try {
        const url =
          `${this.baseUrl}/boards/${boardId}/lists` +
          `?cards=open&card_fields=name,idMembers,dateLastActivity` +
          `&key=${this.apiKey}&token=${this.token}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let res: Response;
        try {
          res = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }

        if (!res.ok) {
          hadError = true;
          this.lastError = `Board ${boardId}: HTTP ${res.status}`;
          continue;
        }

        const lists = (await res.json()) as TrelloList[];

        // Get or init previous card states for this board
        if (!this.lastCardStates.has(boardId)) {
          this.lastCardStates.set(boardId, new Map());
        }
        const prevCardState = this.lastCardStates.get(boardId)!;
        const newCardState = new Map<string, string>();

        for (const list of lists) {
          for (const card of list.cards) {
            newCardState.set(card.id, list.name);

            const prevList = prevCardState.get(card.id);
            const isNew = prevList === undefined;
            const isMoved = prevList !== undefined && prevList !== list.name;

            if (isNew || isMoved) {
              let content = `${card.name} | ${list.name}`;
              if (isMoved) {
                content += ` (from: ${prevList})`;
              }

              items.push({
                source: 'trello',
                sourceId: `${boardId}:${card.id}:${Date.now()}`,
                channel: channelName,
                author: 'trello',
                content,
                timestamp: new Date(card.dateLastActivity),
                type: 'kanban_card',
                metadata: {
                  boardId,
                  cardId: card.id,
                  listName: list.name,
                  prevListName: prevList,
                  cardName: card.name,
                  members: card.idMembers,
                },
              });
            }
          }
        }

        // Update card state snapshot for this board
        this.lastCardStates.set(boardId, newCardState);
      } catch (err) {
        hadError = true;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    this.saveState();
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}

/**
 * TrelloConnector — polls Trello boards via native fetch.
 * Auth token format: "apiKey:token" stored in config.auth.token or TRELLO_TOKEN env var.
 * Emits kanban_card NormalizedItems for new/moved/updated cards.
 *
 * A card's operational state is more than its list: production boards track the
 * assignee and the revision round (e.g. a "初稿" / "1回修正" label) on the card
 * itself. The poller therefore ingests labels and resolved member names, and a
 * label/member change on an unmoved card is a change worth emitting - owner
 * question "who owns this and which revision round is it in" must be answerable
 * from the raw store.
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

interface TrelloLabel {
  name: string;
  color: string | null;
}

interface TrelloCard {
  id: string;
  name: string;
  idMembers: string[];
  labels?: TrelloLabel[];
  dateLastActivity: string;
}

interface TrelloList {
  id: string;
  name: string;
  cards: TrelloCard[];
}

interface TrelloBoardMember {
  id: string;
  fullName?: string;
  username?: string;
}

/** Stored per-card state. Legacy entries are the plain list name; v2 entries
 *  carry the full fingerprint so label/assignee changes are detectable. */
interface CardState {
  list: string;
  labels: string[];
  members: string[];
}

const STATE_V2_PREFIX = 'v2:';

function encodeCardState(state: CardState): string {
  return `${STATE_V2_PREFIX}${JSON.stringify([state.list, state.labels, state.members])}`;
}

function decodeCardState(raw: string): { state: CardState; legacy: boolean } {
  if (raw.startsWith(STATE_V2_PREFIX)) {
    try {
      const [list, labels, members] = JSON.parse(raw.slice(STATE_V2_PREFIX.length)) as [
        string,
        string[],
        string[],
      ];
      return { state: { list, labels: labels ?? [], members: members ?? [] }, legacy: false };
    } catch {
      /* fall through to legacy interpretation */
    }
  }
  // Legacy value: the bare list name (pre-label/member polling). Treated as
  // list-only so the format upgrade never floods the raw store with a
  // "changed" item for every open card.
  return { state: { list: raw, labels: [], members: [] }, legacy: true };
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

  /** boardId → (cardId → encoded card state) */
  private lastCardStates: Map<string, Map<string, string>> = new Map();

  private readonly stateFilePath = join(
    homedir(),
    '.mama',
    'connectors',
    'trello',
    'trello-state.json'
  );

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
      } catch {
        /* ignore corrupt state */
      }
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

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** id → display name for a board's members. Failure degrades to raw ids
   *  (name resolution is enrichment, never a reason to drop a poll). */
  private async fetchMemberNames(boardId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/boards/${boardId}/members?fields=fullName,username&key=${this.apiKey}&token=${this.token}`
      );
      if (!res.ok) return names;
      const members = (await res.json()) as TrelloBoardMember[];
      for (const m of members) {
        const name = m.fullName || m.username;
        if (name) names.set(m.id, name);
      }
    } catch {
      /* degrade to ids */
    }
    return names;
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
          `?cards=open&card_fields=name,idMembers,labels,dateLastActivity` +
          `&key=${this.apiKey}&token=${this.token}`;

        const res = await this.fetchWithTimeout(url);

        if (!res.ok) {
          hadError = true;
          this.lastError = `Board ${boardId}: HTTP ${res.status}`;
          continue;
        }

        const lists = (await res.json()) as TrelloList[];
        // Lazy: boards whose open cards carry no members need no roster call.
        const anyMembers = lists.some((l) => l.cards.some((c) => c.idMembers.length > 0));
        const memberNames = anyMembers ? await this.fetchMemberNames(boardId) : new Map();

        // Get or init previous card states for this board
        if (!this.lastCardStates.has(boardId)) {
          this.lastCardStates.set(boardId, new Map());
        }
        const prevCardState = this.lastCardStates.get(boardId)!;
        const newCardState = new Map<string, string>();

        for (const list of lists) {
          for (const card of list.cards) {
            const labels = (card.labels ?? []).map((l) => l.name).filter(Boolean);
            const assignees = card.idMembers.map((id) => memberNames.get(id) ?? id);
            const current: CardState = { list: list.name, labels, members: assignees };
            newCardState.set(card.id, encodeCardState(current));

            const prevRaw = prevCardState.get(card.id);
            const isNew = prevRaw === undefined;
            const prev = prevRaw !== undefined ? decodeCardState(prevRaw) : undefined;
            const isMoved = prev !== undefined && prev.state.list !== list.name;
            // Label/assignee deltas only fire against v2 state: a legacy entry
            // carries no labels/members, so comparing against it would emit a
            // one-time "changed" flood across every open card on upgrade.
            const isUpdated =
              prev !== undefined &&
              !prev.legacy &&
              !isMoved &&
              (prev.state.labels.join(' ') !== labels.join(' ') ||
                prev.state.members.join(' ') !== assignees.join(' '));

            if (isNew || isMoved || isUpdated) {
              let content = `${card.name} | ${list.name}`;
              if (isMoved) {
                content += ` (from: ${prev!.state.list})`;
              }
              if (isUpdated && prev!.state.labels.join(' ') !== labels.join(' ')) {
                content += ` (labels: ${prev!.state.labels.join(', ') || 'none'} -> ${labels.join(', ') || 'none'})`;
              }
              if (isUpdated && prev!.state.members.join(' ') !== assignees.join(' ')) {
                content += ` (assignees changed)`;
              }
              if (labels.length > 0) {
                content += ` | labels: ${labels.join(', ')}`;
              }
              if (assignees.length > 0) {
                content += ` | assignees: ${assignees.join(', ')}`;
              }

              items.push({
                source: 'trello',
                sourceId: `${boardId}:${card.id}:${Date.now()}`,
                channel: channelName,
                author: 'trello',
                content,
                // First sight is an OBSERVATION, stamped now: on install (or a
                // state reset) dateLastActivity can be years old, which parks
                // the card's only enriched item below every since-window and
                // makes it invisible to retrieval (live incident 2026-07-24).
                // Moves/updates keep the card's own activity time - the change
                // just happened, so it is both fresh and semantically exact.
                timestamp: isNew ? new Date() : new Date(card.dateLastActivity),
                type: 'kanban_card',
                metadata: {
                  lastActivityAt: card.dateLastActivity,
                  boardId,
                  cardId: card.id,
                  listName: list.name,
                  // Omit when absent: the canonical raw-ref serializer rejects
                  // undefined values ("undefined is not serializable at $.prevListName").
                  ...(prev !== undefined ? { prevListName: prev.state.list } : {}),
                  cardName: card.name,
                  members: card.idMembers,
                  memberNames: assignees,
                  labels,
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

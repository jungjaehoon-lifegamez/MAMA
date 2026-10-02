/**
 * Trello REST reads shared by the poller, the history import and trello.read. A failed request
 * is the caller's error: no retry and no cached answer.
 */
import type { TrelloAction } from './actions.js';

export interface TrelloCredentials {
  apiKey: string;
  token: string;
}

const BASE_URL = 'https://api.trello.com/1';
const ACTION_PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

function actionTime(action: TrelloAction): number {
  const value = Date.parse(action.date);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Trello action date is invalid');
  return value;
}

function assertAction(value: unknown): asserts value is TrelloAction {
  const action = value as Partial<TrelloAction> | null;
  if (
    !action ||
    typeof action.id !== 'string' ||
    action.id.trim() === '' ||
    typeof action.type !== 'string' ||
    !action.data ||
    typeof action.data !== 'object'
  ) {
    throw new Error('Trello action identity is invalid');
  }
  actionTime(action as TrelloAction);
}

export class TrelloApi {
  constructor(
    private readonly credentials: TrelloCredentials,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('key', this.credentials.apiKey);
    url.searchParams.set('token', this.credentials.token);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Trello ${path} failed with HTTP ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** A board's actions with fromMs <= date < untilMs (open-ended without untilMs), oldest first. */
  async boardActions(
    boardId: string,
    window: { fromMs: number; untilMs?: number }
  ): Promise<TrelloAction[]> {
    const path = `/boards/${encodeURIComponent(boardId)}/actions`;
    const kept = new Map<string, TrelloAction>();
    let before = window.untilMs === undefined ? undefined : new Date(window.untilMs).toISOString();
    for (;;) {
      const page = await this.get<unknown>(path, {
        filter: 'all',
        since: new Date(window.fromMs).toISOString(),
        ...(before === undefined ? {} : { before }),
        limit: String(ACTION_PAGE_SIZE),
        fields: 'id,type,date,data,idMemberCreator',
        memberCreator: 'true',
        memberCreator_fields: 'id,fullName,username',
      });
      if (!Array.isArray(page)) throw new Error('Trello actions response must be an array');
      let oldest: TrelloAction | undefined;
      for (const value of page) {
        assertAction(value);
        const at = actionTime(value);
        if (
          oldest === undefined ||
          at < actionTime(oldest) ||
          (at === actionTime(oldest) && value.id < oldest.id)
        ) {
          oldest = value;
        }
        if (at < window.fromMs || (window.untilMs !== undefined && at >= window.untilMs)) continue;
        kept.set(value.id, value);
      }
      if (
        page.length < ACTION_PAGE_SIZE ||
        oldest === undefined ||
        // A full page whose oldest action sits exactly at the start can have same-millisecond
        // actions on the next page; only an older one proves the window is read.
        actionTime(oldest) < window.fromMs
      ) {
        break;
      }
      if (oldest.id === before) throw new Error('Trello action pagination made no progress');
      before = oldest.id;
    }
    return [...kept.values()].sort(
      (a, b) => actionTime(a) - actionTime(b) || a.id.localeCompare(b.id)
    );
  }

  /** The board's labels by id, for naming label changes in live reads. */
  async boardLabels(boardId: string): Promise<Map<string, string>> {
    const labels = await this.get<Array<{ id?: unknown; name?: unknown }>>(
      `/boards/${encodeURIComponent(boardId)}/labels`,
      { fields: 'name', limit: '1000' }
    );
    return new Map(
      labels.flatMap((label) =>
        typeof label.id === 'string' && typeof label.name === 'string' && label.name.trim() !== ''
          ? [[label.id, label.name] as const]
          : []
      )
    );
  }
}

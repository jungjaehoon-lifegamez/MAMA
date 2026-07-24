/**
 * Trello live query tools — the READ answer path for current-state questions.
 *
 * Ported from Kagemusha's mechanism (trello_search / trello_card_detail):
 * state questions are answered by reading the LIVE board at question time,
 * never by projecting the connector change log. The 2026-07-24 incident chain
 * (missing labels/assignees, first-sight timestamps burying enriched items,
 * per-character card collapse) was one architecture mistake surfacing three
 * ways: a log projection serving state queries. The connector log remains the
 * delta/trigger source; these tools are the truth reads, the same pattern as
 * kagemusha_* for the kagemusha DB.
 *
 * Read-only: no mutation endpoint is ever called. Card text is untrusted
 * external data — tool descriptions instruct the model to treat it as data.
 */

import { loadConnectorConfig } from '../config-loader.js';

const BASE_URL = 'https://api.trello.com/1';
const FETCH_TIMEOUT_MS = 15_000;

export interface TrelloQueryDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to ~/.mama/connectors.json. */
  configPath?: string;
}

interface TrelloAuth {
  apiKey: string;
  token: string;
  /** boardId → display name for enabled trello channels ('' = unscoped). */
  boardNames: Map<string, string>;
}

/** Loud, no-fallback auth resolution via the connector contract:
 *  config.auth.token ?? env[tokenName ?? 'TRELLO_TOKEN'], "apiKey:token". */
export function resolveTrelloQueryAuth(deps: TrelloQueryDeps = {}): TrelloAuth {
  const env = deps.env ?? process.env;
  const loaded = loadConnectorConfig(deps.configPath);
  if (!loaded.ok) {
    throw new Error(
      `trello query tools: connector configuration unreadable (${loaded.error.code})`
    );
  }
  const trello = (
    loaded.config as Record<
      string,
      | {
          enabled?: boolean;
          auth?: { token?: string; tokenName?: string };
          channels?: Record<string, { role?: string; name?: string; boardId?: string }>;
        }
      | undefined
    >
  )['trello'];
  if (!trello?.enabled) {
    throw new Error('trello query tools: the trello connector is not enabled in connectors.json');
  }
  const rawToken = trello.auth?.token ?? env[trello.auth?.tokenName ?? 'TRELLO_TOKEN'];
  if (!rawToken) {
    throw new Error(
      'trello query tools: no credentials (set the connector token, format "apiKey:token")'
    );
  }
  const sep = rawToken.indexOf(':');
  if (sep <= 0) {
    throw new Error('trello query tools: credential format invalid, expected "apiKey:token"');
  }
  const boardNames = new Map<string, string>();
  for (const [key, ch] of Object.entries(trello.channels ?? {})) {
    if (ch?.role !== 'ignore' && ch?.boardId) boardNames.set(ch.boardId, ch.name ?? key);
  }
  return { apiKey: rawToken.slice(0, sep), token: rawToken.slice(sep + 1), boardNames };
}

async function trelloGet<T>(
  path: string,
  params: Record<string, string>,
  auth: TrelloAuth,
  fetchFn: typeof fetch
): Promise<T> {
  const search = new URLSearchParams({ ...params, key: auth.apiKey, token: auth.token });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(`${BASE_URL}${path}?${search.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`trello API ${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface RawSearchCard {
  id: string;
  name: string;
  due: string | null;
  dateLastActivity: string;
  labels?: Array<{ name: string }>;
  members?: Array<{ fullName?: string; username?: string }>;
  list?: { name?: string };
  board?: { id?: string; name?: string };
}

export interface TrelloCardSummary {
  cardId: string;
  name: string;
  board: string;
  list: string;
  labels: string[];
  assignees: string[];
  due: string | null;
  lastActivity: string;
}

function summarize(card: RawSearchCard, boardNames: Map<string, string>): TrelloCardSummary {
  return {
    cardId: card.id,
    name: card.name,
    board:
      card.board?.name ?? (card.board?.id ? (boardNames.get(card.board.id) ?? card.board.id) : ''),
    list: card.list?.name ?? '',
    labels: (card.labels ?? []).map((l) => l.name).filter(Boolean),
    assignees: (card.members ?? []).map((m) => m.fullName || m.username || '').filter(Boolean),
    due: card.due,
    lastActivity: card.dateLastActivity,
  };
}

/**
 * Search cards across the configured boards, LIVE. Returns current list,
 * labels (revision round / artist), and assignee names per card.
 */
export async function searchTrelloCards(
  input: { query: string; limit?: number },
  deps: TrelloQueryDeps = {}
): Promise<TrelloCardSummary[]> {
  const query = (input.query ?? '').trim();
  if (!query) {
    throw new Error('trello_search requires a non-empty query');
  }
  const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 10)));
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const result = await trelloGet<{ cards?: RawSearchCard[] }>(
    '/search',
    {
      query,
      modelTypes: 'cards',
      cards_limit: String(limit),
      card_fields: 'name,due,dateLastActivity,labels',
      card_list: 'true',
      card_members: 'true',
      card_board: 'true',
      ...(auth.boardNames.size > 0 ? { idBoards: [...auth.boardNames.keys()].join(',') } : {}),
    },
    auth,
    fetchFn
  );
  return (result.cards ?? []).map((card) => summarize(card, auth.boardNames));
}

export interface TrelloCardDetail extends TrelloCardSummary {
  description: string;
  checklists: Array<{ name: string; items: Array<{ name: string; complete: boolean }> }>;
}

/** Full card detail, LIVE: description head, members, labels, checklists. */
export async function getTrelloCard(
  input: { cardId: string },
  deps: TrelloQueryDeps = {}
): Promise<TrelloCardDetail> {
  const cardId = (input.cardId ?? '').trim();
  if (!cardId || !/^[A-Za-z0-9]+$/.test(cardId)) {
    throw new Error('trello_card requires a cardId (from trello_search results)');
  }
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const card = await trelloGet<
    RawSearchCard & {
      desc?: string;
      checklists?: Array<{
        name: string;
        checkItems?: Array<{ name: string; state: string }>;
      }>;
    }
  >(
    `/cards/${cardId}`,
    {
      fields: 'name,desc,due,dateLastActivity,labels',
      members: 'true',
      member_fields: 'fullName,username',
      list: 'true',
      board: 'true',
      checklists: 'all',
      checkItem_fields: 'name,state',
    },
    auth,
    fetchFn
  );
  return {
    ...summarize(card, auth.boardNames),
    description: (card.desc ?? '').slice(0, 1000),
    checklists: (card.checklists ?? []).slice(0, 10).map((cl) => ({
      name: cl.name,
      items: (cl.checkItems ?? [])
        .slice(0, 30)
        .map((it) => ({ name: it.name, complete: it.state === 'complete' })),
    })),
  };
}

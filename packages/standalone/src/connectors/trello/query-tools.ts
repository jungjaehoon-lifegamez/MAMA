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

import { createHash } from 'node:crypto';
import { loadConnectorConfig } from '../config-loader.js';

const BASE_URL = 'https://api.trello.com/1';
const FETCH_TIMEOUT_MS = 15_000;

/** Progressive page bounds shared by the Trello cards/search facades (Task C). */
const RECORD_DEFAULT_LIMIT = 25;
const RECORD_MAX_LIMIT = 50;
const DESC_DEFAULT_LIMIT = 1000;
const DESC_MAX_LIMIT = 4000;
const CHECKLIST_DEFAULT_LIMIT = 10;
const CHECKLIST_MAX_LIMIT = 25;
const ITEM_DEFAULT_LIMIT = 20;
const ITEM_MAX_LIMIT = 50;

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

interface BoardScanList {
  /** Real Trello list id - stable and unique even when two lists share a display name. */
  id: string;
  name: string;
  cards: Array<{
    id: string;
    name: string;
    due: string | null;
    dateLastActivity: string;
    idMembers?: string[];
    labels?: Array<{ name: string }>;
  }>;
}

interface BoardSnapshot {
  boardId: string;
  boardName: string;
  lists: BoardScanList[];
  roster: Map<string, string>;
  /** 'failed' means the card read itself failed - the board contributed NO data. */
  status: 'ok' | 'failed';
  /** Card data is intact but member names could not be resolved (optional enrichment). */
  rosterDegraded: boolean;
}

interface CachedSnapshot {
  at: number;
  /** The authorization this snapshot was fetched under; a page read under a
   *  DIFFERENT authorization must never see it (P1: PR #262). */
  authFp: string;
  boards: BoardSnapshot[];
}

/** Per-process snapshot cache. A full report asks about many cards in one
 *  turn; without this every trello_search re-fetched every board serially
 *  (~10s x 15 calls in the 2026-07-24 14:03 report turn). 45s keeps a turn
 *  on one snapshot while staying far fresher than the 5-min poll cadence. */
const SNAPSHOT_TTL_MS = 45_000;
let snapshotCache: CachedSnapshot | null = null;

/** Test seam: drop the snapshot cache. */
export function clearTrelloSnapshotCache(): void {
  snapshotCache = null;
}

/**
 * A stable identity of the CURRENT authorization: the credentials and the sorted
 * configured board allowlist (id + display name). It is a one-way hash, so tokens
 * are never exposed, yet a changed token, a removed/added board, or a renamed
 * board all mint a different value. Cache reuse and cursor continuation require
 * the SAME fingerprint, so cached cards are never re-served under new auth.
 */
function authFingerprint(auth: TrelloAuth): string {
  const boards = [...auth.boardNames.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
  );
  return createHash('sha256')
    .update(JSON.stringify([auth.apiKey, auth.token, boards]))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * The current cached snapshot WITHOUT triggering a fresh fetch. Progressive
 * continuations (cards/search cursors) read the exact snapshot their first page
 * observed - even after the 45s fresh-read TTL - as long as it is still present.
 * Once the cache is replaced or cleared the continuation is rejected and the
 * caller restarts, because a page 2 drawn from a different snapshot could skip
 * or repeat cards.
 */
function peekTrelloSnapshot(): CachedSnapshot | null {
  return snapshotCache;
}

/** Stable identity of one cached snapshot: its observation instant plus board
 *  and per-list card structure. A refresh replaces the cache wholesale and mints
 *  a new id, which is exactly what invalidates an in-flight cursor. */
function snapshotId(snapshot: { at: number; boards: BoardSnapshot[] }): string {
  const shape = snapshot.boards.map((board) => [
    board.boardId,
    board.status,
    board.lists.map((list) => [list.id, list.name, list.cards.length]),
  ]);
  return createHash('sha256')
    .update(`${snapshot.at}:${JSON.stringify(shape)}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Fetch all boards' open cards + member rosters IN PARALLEL, cached briefly.
 *  A single unreadable board degrades to an empty snapshot for that board only,
 *  never sinking the whole read - but it is now MARKED 'failed' instead of being
 *  indistinguishable from a board that genuinely has no open cards. A caller that
 *  reports "nothing there" from a failed read states a fact it never observed.
 *
 *  Roster resolution is optional enrichment (the poller treats it the same way):
 *  losing member names degrades naming, never card coverage. */
async function fetchBoardSnapshots(
  auth: TrelloAuth,
  fetchFn: typeof fetch
): Promise<CachedSnapshot> {
  const authFp = authFingerprint(auth);
  if (
    snapshotCache &&
    snapshotCache.authFp === authFp &&
    Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS
  ) {
    // Cached snapshots keep their ORIGINAL observation time and per-board status:
    // a degraded read must not re-serve as a fresh successful one for 45s. Reuse
    // ALSO requires the same authorization - a token or allowlist change refetches.
    return snapshotCache;
  }
  const boards = await Promise.all(
    [...auth.boardNames].map(async ([boardId, boardName]): Promise<BoardSnapshot> => {
      let lists: BoardScanList[] = [];
      let roster = new Map<string, string>();
      const status: 'ok' | 'failed' = 'ok';
      let rosterDegraded = false;
      try {
        lists = await trelloGet<BoardScanList[]>(
          `/boards/${boardId}/lists`,
          { cards: 'open', card_fields: 'name,due,dateLastActivity,idMembers,labels' },
          auth,
          fetchFn
        );
      } catch {
        return { boardId, boardName, lists: [], roster, status: 'failed', rosterDegraded: false };
      }
      if (lists.some((l) => l.cards.some((c) => (c.idMembers ?? []).length > 0))) {
        try {
          const members = await trelloGet<
            Array<{ id: string; fullName?: string; username?: string }>
          >(`/boards/${boardId}/members`, { fields: 'fullName,username' }, auth, fetchFn);
          roster = new Map(
            members.flatMap((m) =>
              m.fullName || m.username ? [[m.id, m.fullName || m.username!]] : []
            )
          );
        } catch {
          rosterDegraded = true;
        }
      }
      return { boardId, boardName, lists, roster, status, rosterDegraded };
    })
  );
  snapshotCache = { at: Date.now(), authFp, boards };
  return snapshotCache;
}

function snapshotCard(
  snap: BoardSnapshot,
  listName: string,
  card: BoardScanList['cards'][number]
): TrelloCardSummary {
  return {
    cardId: card.id,
    name: card.name,
    board: snap.boardName,
    list: listName,
    labels: (card.labels ?? []).map((l) => l.name).filter(Boolean),
    assignees: (card.idMembers ?? []).map((id) => snap.roster.get(id) ?? id),
    due: card.due,
    lastActivity: card.dateLastActivity,
  };
}

export interface TrelloKanbanColumn {
  board: string;
  list: string;
  /** Open cards in the list. */
  count: number;
  /** Cards actually returned; `returned < count` means this column is truncated. */
  returned: number;
  cards: TrelloCardSummary[];
}

export interface TrelloBoardCoverage {
  boardId: string;
  board: string;
  /** 'failed' contributed NO cards - absence of cards is not evidence of an empty board. */
  status: 'ok' | 'failed';
  /** Card data intact, member names unresolved. */
  rosterDegraded: boolean;
}

export interface TrelloKanbanSnapshot {
  /** When the underlying read happened - NOT when this call was made. */
  observedAt: string;
  /** 0 for a fresh read; >0 means this is a reused snapshot of that age. */
  cacheAgeMs: number;
  /** Every configured board read successfully AND no column truncated. */
  complete: boolean;
  truncated: boolean;
  boards: TrelloBoardCoverage[];
  columns: TrelloKanbanColumn[];
}

/**
 * Full LIVE kanban snapshot across the configured boards - the primary answer tool
 * for whole-project status. ONE call replaces a search per card: every open card
 * with its list, labels (revision round / artist), and assignee names, grouped by
 * board+list.
 *
 * The result carries its own coverage because both ways this read can be partial are
 * invisible in the data itself: a board whose fetch failed yields no cards, and a
 * column longer than maxCardsPerList is silently sliced. A caller that asserts a
 * whole-situation claim must check `complete` first.
 */
export async function getTrelloKanban(
  input: { maxCardsPerList?: number } = {},
  deps: TrelloQueryDeps = {}
): Promise<TrelloKanbanSnapshot> {
  const maxCards = Math.max(1, Math.min(100, Math.floor(input.maxCardsPerList ?? 30)));
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const snapshot = await fetchBoardSnapshots(auth, fetchFn);
  const columns: TrelloKanbanColumn[] = [];
  const boards: TrelloBoardCoverage[] = [];
  for (const snap of snapshot.boards) {
    boards.push({
      boardId: snap.boardId,
      board: snap.boardName,
      status: snap.status,
      rosterDegraded: snap.rosterDegraded,
    });
    for (const list of snap.lists) {
      if (list.cards.length === 0) continue;
      const cards = list.cards
        .slice(0, maxCards)
        .map((card) => snapshotCard(snap, list.name, card));
      columns.push({
        board: snap.boardName,
        list: list.name,
        count: list.cards.length,
        returned: cards.length,
        cards,
      });
    }
  }
  const truncated = columns.some((column) => column.returned < column.count);
  return {
    observedAt: new Date(snapshot.at).toISOString(),
    cacheAgeMs: Math.max(0, Date.now() - snapshot.at),
    complete: boards.length > 0 && boards.every((board) => board.status === 'ok') && !truncated,
    truncated,
    boards,
    columns,
  };
}

// ─── Progressive facades (Task C) ──────────────────────────────────────────────

export interface TrelloBoardOverview {
  boardId: string;
  board: string;
  status: 'ok' | 'failed';
  rosterDegraded: boolean;
  /** listId is the STABLE key to pass to getTrelloListCards; `list` is the display name
   *  (two lists on one board can share it, so never key a read by the name). */
  lists: Array<{ listId: string; list: string; count: number }>;
}

export interface TrelloBoardsOverview {
  boards: TrelloBoardOverview[];
  observedAt: string;
  cacheAgeMs: number;
  /** Snapshot identity a cards/search cursor is pinned to. */
  readVersion: string;
  /** Every configured board read successfully. */
  complete: boolean;
}

/**
 * Progressive overview: every configured board and its lists with stable ids and
 * open-card COUNTS - no card arrays. This is the entry point; a caller then reads
 * one list's cards with `getTrelloListCards`. `readVersion` names the snapshot to
 * pass back through a cards/search cursor.
 */
export async function getTrelloBoardsOverview(
  deps: TrelloQueryDeps = {}
): Promise<TrelloBoardsOverview> {
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const snapshot = await fetchBoardSnapshots(auth, fetchFn);
  const boards: TrelloBoardOverview[] = snapshot.boards.map((snap) => ({
    boardId: snap.boardId,
    board: snap.boardName,
    status: snap.status,
    rosterDegraded: snap.rosterDegraded,
    lists: snap.lists.map((list) => ({
      listId: list.id,
      list: list.name,
      count: list.cards.length,
    })),
  }));
  return {
    boards,
    observedAt: new Date(snapshot.at).toISOString(),
    cacheAgeMs: Math.max(0, Date.now() - snapshot.at),
    readVersion: snapshotId(snapshot),
    complete: boards.length > 0 && boards.every((board) => board.status === 'ok'),
  };
}

interface RecordCursor {
  v: 1;
  snapshotId: string;
  scope: string;
  offset: number;
}

function encodeRecordCursor(payload: RecordCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Resolve the snapshot a page reads AND the CURRENT authorization. Authorization
 *  is re-resolved on EVERY page (P1: PR #262): a disabled connector or unreadable
 *  config throws here before any cached field is returned. A cursor pins the EXACT
 *  cached snapshot and rejects if it is gone, replaced, or fetched under a
 *  different authorization; a first page fetches (refreshing on TTL or auth). */
async function resolvePageSnapshot(
  cursor: RecordCursor | null,
  scope: string,
  deps: TrelloQueryDeps
): Promise<{ snapshot: CachedSnapshot; id: string; auth: TrelloAuth }> {
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  if (cursor) {
    const snapshot = peekTrelloSnapshot();
    if (!snapshot) {
      throw new Error(
        'trello cursor snapshot is no longer cached; restart the read from the overview.'
      );
    }
    // Authorization is re-checked against the cache: a changed token or a changed
    // board allowlist rejects the continuation rather than filtering old cards.
    if (snapshot.authFp !== authFingerprint(auth)) {
      throw new Error(
        'trello authorization changed since this cursor was issued; restart the read from the overview.'
      );
    }
    const id = snapshotId(snapshot);
    if (id !== cursor.snapshotId || cursor.scope !== scope) {
      throw new Error(
        'trello cursor belongs to a replaced snapshot or a different scope; restart the read.'
      );
    }
    return { snapshot, id, auth };
  }
  const snapshot = await fetchBoardSnapshots(auth, fetchFn);
  return { snapshot, id: snapshotId(snapshot), auth };
}

function decodeRecordCursor(raw: unknown): RecordCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new Error('trello cursor is malformed; restart the read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('trello cursor is malformed; restart the read.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as RecordCursor).v !== 1 ||
    typeof (parsed as RecordCursor).snapshotId !== 'string' ||
    typeof (parsed as RecordCursor).scope !== 'string' ||
    !Number.isSafeInteger((parsed as RecordCursor).offset) ||
    (parsed as RecordCursor).offset < 0
  ) {
    throw new Error('trello cursor is malformed; restart the read.');
  }
  return parsed as RecordCursor;
}

function boundedRecordLimit(value: unknown): number {
  if (value === undefined) return RECORD_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > RECORD_MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${RECORD_MAX_LIMIT}.`);
  }
  return value as number;
}

export interface TrelloCardsPage {
  boardId: string;
  listId: string;
  board: string;
  list: string;
  cards: TrelloCardSummary[];
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  cacheAgeMs: number;
  readVersion: string;
  /** Source coverage for THIS board; a failed board is not an empty complete list. */
  coverage: { status: 'ok' | 'failed'; rosterDegraded: boolean };
}

/**
 * One bounded page of a single list's open cards, drawn from the cached snapshot.
 * Every card in the list is reachable by walking `nextCursor` - past the old
 * 100-card kanban ceiling. The cursor is pinned to the snapshot and (boardId,
 * listId); a replaced/expired snapshot is rejected with restart guidance.
 */
export async function getTrelloListCards(
  input: { boardId: string; listId: string; limit?: number; cursor?: string },
  deps: TrelloQueryDeps = {}
): Promise<TrelloCardsPage> {
  const boardId = (input.boardId ?? '').trim();
  const listId = (input.listId ?? '').trim();
  if (!boardId || !listId) {
    throw new Error('trello cards view requires boardId and listId from the overview.');
  }
  const scope = `cards:${boardId}:${listId}`;
  const cursor = decodeRecordCursor(input.cursor);
  const limit = boundedRecordLimit(input.limit);
  const { snapshot, id, auth } = await resolvePageSnapshot(cursor, scope, deps);
  // Authorize against the CURRENT allowlist before touching the snapshot: never
  // disclose a board's cards from an old snapshot just because it was cached.
  if (!auth.boardNames.has(boardId)) {
    throw new Error(`trello board '${boardId}' is not configured/authorized.`);
  }
  const board = snapshot.boards.find((b) => b.boardId === boardId);
  if (!board) {
    throw new Error(`trello board '${boardId}' is not configured/authorized.`);
  }
  const observedAt = new Date(snapshot.at).toISOString();
  const cacheAgeMs = Math.max(0, Date.now() - snapshot.at);
  const coverage = { status: board.status, rosterDegraded: board.rosterDegraded };
  if (board.status === 'failed') {
    // A failed board read contributed NO cards; absence here is not an empty list.
    // The display name is unknown (the read failed), so only the id echoes back.
    return {
      boardId,
      listId,
      board: board.boardName,
      list: '',
      cards: [],
      total: 0,
      returned: 0,
      nextCursor: null,
      observedAt,
      cacheAgeMs,
      readVersion: id,
      coverage,
    };
  }
  // Bind by the REAL Trello list id, never by display name: two lists on one board
  // can share a name, and a name lookup would collapse them onto the first match.
  const list = board.lists.find((entry) => entry.id === listId);
  if (!list) {
    throw new Error(`trello list '${listId}' is not present on board '${boardId}'.`);
  }
  const offset = cursor?.offset ?? 0;
  if (offset > list.cards.length) {
    throw new Error('trello cursor is past the end of the list; restart the read.');
  }
  const slice = list.cards
    .slice(offset, offset + limit)
    .map((card) => snapshotCard(board, list.name, card));
  const nextOffset = offset + slice.length;
  return {
    boardId,
    listId,
    board: board.boardName,
    list: list.name,
    cards: slice,
    total: list.cards.length,
    returned: slice.length,
    nextCursor:
      nextOffset < list.cards.length
        ? encodeRecordCursor({ v: 1, snapshotId: id, scope, offset: nextOffset })
        : null,
    observedAt,
    cacheAgeMs,
    readVersion: id,
    coverage,
  };
}

export interface TrelloSearchPage {
  query: string;
  cards: TrelloCardSummary[];
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  cacheAgeMs: number;
  readVersion: string;
  coverage: { boards: TrelloBoardCoverage[]; complete: boolean };
}

/**
 * Progressive search over the cached board snapshot with local substring match -
 * an HONEST full match total and stable paging, not the old 20-result cap. A
 * failed board keeps `complete:false` so a missing match is never read as absent.
 * Local substring scan is deliberate: Trello's /search tokenizes on word
 * boundaries and misses CJK substrings and underscore compounds (e.g.
 * 'エルデリーゼ', 'ex_1055003'), which is most of this board vocabulary.
 */
export async function searchTrelloBoardCards(
  input: { query: string; limit?: number; cursor?: string },
  deps: TrelloQueryDeps = {}
): Promise<TrelloSearchPage> {
  const query = (input.query ?? '').trim();
  if (!query) {
    throw new Error('trello_search requires a non-empty query');
  }
  const scope = `search:${query.toLowerCase()}`;
  const cursor = decodeRecordCursor(input.cursor);
  const limit = boundedRecordLimit(input.limit);
  const { snapshot, id } = await resolvePageSnapshot(cursor, scope, deps);
  const needle = query.toLowerCase();
  const matches: TrelloCardSummary[] = [];
  for (const board of snapshot.boards) {
    for (const list of board.lists) {
      for (const card of list.cards) {
        if (card.name.toLowerCase().includes(needle)) {
          matches.push(snapshotCard(board, list.name, card));
        }
      }
    }
  }
  const offset = cursor?.offset ?? 0;
  if (offset > matches.length) {
    throw new Error('trello cursor is past the end of the matches; restart the read.');
  }
  const slice = matches.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const boards: TrelloBoardCoverage[] = snapshot.boards.map((snap) => ({
    boardId: snap.boardId,
    board: snap.boardName,
    status: snap.status,
    rosterDegraded: snap.rosterDegraded,
  }));
  return {
    query,
    cards: slice,
    total: matches.length,
    returned: slice.length,
    nextCursor:
      nextOffset < matches.length
        ? encodeRecordCursor({ v: 1, snapshotId: id, scope, offset: nextOffset })
        : null,
    observedAt: new Date(snapshot.at).toISOString(),
    cacheAgeMs: Math.max(0, Date.now() - snapshot.at),
    readVersion: id,
    coverage: {
      boards,
      complete: boards.length > 0 && boards.every((board) => board.status === 'ok'),
    },
  };
}

interface RawCardDetail extends RawSearchCard {
  desc?: string;
  checklists?: Array<{
    id?: string;
    name: string;
    checkItems?: Array<{ name: string; state: string }>;
  }>;
}

/** One raw card fetch, gated by the SAME board allowlist list/search obey. Returns
 *  null-free fields only after the returned board.id is a configured board. */
async function fetchAuthorizedCard(
  cardId: string,
  auth: TrelloAuth,
  fetchFn: typeof fetch
): Promise<RawCardDetail> {
  const card = await trelloGet<RawCardDetail>(
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
  // Authorization BEFORE any field is returned: an empty configured set grants no
  // board, and a token-accessible card outside the configured boards is refused
  // generically - no title, board, or contents leak through an unconfigured card.
  const boardId = card.board?.id;
  if (auth.boardNames.size === 0 || !boardId || !auth.boardNames.has(boardId)) {
    throw new Error('trello card is not available in an authorized board');
  }
  return card;
}

export type TrelloCardDetailSection =
  | {
      cardId: string;
      section: 'summary';
      name: string;
      board: string;
      list: string;
      labels: string[];
      assignees: string[];
      due: string | null;
      lastActivity: string;
      descriptionLength: number;
      checklistCount: number;
      itemCount: number;
      /** Binds the authorized fetched card; a continuation must echo it or restart. */
      readVersion: string;
    }
  | {
      cardId: string;
      section: 'description';
      content: string;
      offset: number;
      limit: number;
      total: number;
      nextOffset: number | null;
      complete: boolean;
      readVersion: string;
    }
  | {
      cardId: string;
      section: 'checklists';
      checklists: Array<{ id: string; name: string; itemCount: number; completeCount: number }>;
      offset: number;
      limit: number;
      total: number;
      nextOffset: number | null;
      readVersion: string;
    }
  | {
      cardId: string;
      section: 'checklist_items';
      checklistId: string;
      items: Array<{ name: string; complete: boolean }>;
      offset: number;
      limit: number;
      total: number;
      nextOffset: number | null;
      readVersion: string;
    };

/** Stable version of the authorized fetched card content; survives sectioned
 *  reads and changes if the live card's text/checklists/items change. */
function cardContentVersion(card: RawCardDetail): string {
  const shape = {
    name: card.name,
    desc: card.desc ?? '',
    due: card.due ?? null,
    labels: (card.labels ?? []).map((l) => l.name),
    checklists: (card.checklists ?? []).map((cl) => ({
      id: cl.id ?? null,
      name: cl.name,
      items: (cl.checkItems ?? []).map((it) => ({ name: it.name, state: it.state })),
    })),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('base64url').slice(0, 22);
}

/** A section continuation (offset > 0) must echo the readVersion; a changed card is rejected. */
function assertCardVersion(supplied: unknown, current: string, offset: number): void {
  if (offset > 0 && supplied === undefined) {
    throw new Error(
      'trello_card continuation (offset > 0) requires the readVersion from the previous section read; restart from offset 0.'
    );
  }
  if (supplied !== undefined && supplied !== current) {
    throw new Error(
      'trello_card content changed since this readVersion was issued; restart the read from offset 0.'
    );
  }
}

function nonNegInt(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`trello_card ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function boundedInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`trello_card ${field} must be an integer from 1 to ${max}.`);
  }
  return value as number;
}

/**
 * The ONE deterministic key a checklist is addressed by, used identically when
 * `checklists` emits headers and when `checklist_items` resolves them. A real
 * Trello id (present) is used as-is; an ABSENT id falls back to an `idx:<n>`
 * namespace keyed by the checklist's absolute position, which can never be
 * confused with a Trello hex id - so every returned header id resolves back to
 * its own items instead of an undefined-id lookup that could never match.
 */
function checklistKey(checklist: { id?: string }, index: number): string {
  return checklist.id ?? `idx:${index}`;
}

/**
 * Sectioned card detail. `summary` (default) is metadata plus description length
 * and checklist/item counts; `description` pages the text by Unicode CODE POINTS
 * (offset/limit); `checklists` pages whole checklist headers by RECORD; and
 * `checklist_items` pages whole item records of one checklist. Every long tail is
 * reachable through the returned continuation - nothing is silently sliced. The
 * board allowlist is enforced before ANY field is returned; list/search/detail
 * all agree on the same configured boards.
 */
export async function getTrelloCardDetail(
  input: {
    cardId: string;
    section?: string;
    offset?: number;
    limit?: number;
    checklistId?: string;
    readVersion?: string;
  },
  deps: TrelloQueryDeps = {}
): Promise<TrelloCardDetailSection> {
  const cardId = (input.cardId ?? '').trim();
  if (!cardId || !/^[A-Za-z0-9]+$/.test(cardId)) {
    throw new Error('trello_card requires a cardId (from trello_search results)');
  }
  const section = input.section ?? 'summary';
  if (!['summary', 'description', 'checklists', 'checklist_items'].includes(section)) {
    throw new Error(
      'trello_card section must be one of summary|description|checklists|checklist_items.'
    );
  }
  const auth = resolveTrelloQueryAuth(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  // Authorize (board allowlist) BEFORE any field is disclosed, THEN version.
  const card = await fetchAuthorizedCard(cardId, auth, fetchFn);
  const readVersion = cardContentVersion(card);
  const checklists = card.checklists ?? [];
  if (section === 'summary') {
    const base = summarize(card, auth.boardNames);
    return {
      cardId,
      section: 'summary',
      name: base.name,
      board: base.board,
      list: base.list,
      labels: base.labels,
      assignees: base.assignees,
      due: base.due,
      lastActivity: base.lastActivity,
      descriptionLength: Array.from(card.desc ?? '').length,
      checklistCount: checklists.length,
      itemCount: checklists.reduce((sum, cl) => sum + (cl.checkItems?.length ?? 0), 0),
      readVersion,
    };
  }
  if (section === 'description') {
    const points = Array.from(card.desc ?? '');
    const offset = nonNegInt(input.offset, 'offset');
    assertCardVersion(input.readVersion, readVersion, offset);
    const limit = boundedInt(input.limit, 'limit', DESC_DEFAULT_LIMIT, DESC_MAX_LIMIT);
    const start = Math.min(offset, points.length);
    const slice = points.slice(start, start + limit);
    const end = start + slice.length;
    const nextOffset = end < points.length ? end : null;
    return {
      cardId,
      section: 'description',
      content: slice.join(''),
      offset,
      limit,
      total: points.length,
      nextOffset,
      complete: nextOffset === null,
      readVersion,
    };
  }
  if (section === 'checklists') {
    const offset = nonNegInt(input.offset, 'offset');
    assertCardVersion(input.readVersion, readVersion, offset);
    const limit = boundedInt(input.limit, 'limit', CHECKLIST_DEFAULT_LIMIT, CHECKLIST_MAX_LIMIT);
    const slice = checklists.slice(offset, offset + limit).map((cl, index) => ({
      id: checklistKey(cl, offset + index),
      name: cl.name,
      itemCount: cl.checkItems?.length ?? 0,
      completeCount: (cl.checkItems ?? []).filter((it) => it.state === 'complete').length,
    }));
    const nextOffset = offset + slice.length < checklists.length ? offset + slice.length : null;
    return {
      cardId,
      section: 'checklists',
      checklists: slice,
      offset,
      limit,
      total: checklists.length,
      nextOffset,
      readVersion,
    };
  }
  // checklist_items
  const checklistId = (input.checklistId ?? '').trim();
  if (!checklistId) {
    throw new Error('trello_card section checklist_items requires checklistId.');
  }
  // Resolve by the SAME deterministic key the headers emit, so an absent-id
  // checklist (addressed as idx:<n>) reaches its items too.
  const checklist = checklists.find((cl, index) => checklistKey(cl, index) === checklistId);
  if (!checklist) {
    throw new Error(`trello_card unknown checklistId '${checklistId}' on this card.`);
  }
  const items = checklist.checkItems ?? [];
  const offset = nonNegInt(input.offset, 'offset');
  assertCardVersion(input.readVersion, readVersion, offset);
  const limit = boundedInt(input.limit, 'limit', ITEM_DEFAULT_LIMIT, ITEM_MAX_LIMIT);
  const slice = items
    .slice(offset, offset + limit)
    .map((it) => ({ name: it.name, complete: it.state === 'complete' }));
  const nextOffset = offset + slice.length < items.length ? offset + slice.length : null;
  return {
    cardId,
    section: 'checklist_items',
    checklistId,
    items: slice,
    offset,
    limit,
    total: items.length,
    nextOffset,
    readVersion,
  };
}

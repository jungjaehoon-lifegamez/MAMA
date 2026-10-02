import type { RawIndexSink, RawStore } from '../storage/source-archive.js';
import { loadConnectorConfig } from '../connectors/config-loader.js';
import {
  assertRawProjectionQueuesEmpty,
  drainRawProjections,
  readImportManifest,
  writeImportManifest,
} from './import-manifest.js';
import { existsSync } from 'node:fs';
import { localDateKey } from '../runtime/timezone.js';
import { trelloActionLine } from '../connectors/trello/action-line.js';

const IMPORT_FROM_MS = Date.parse('2026-09-01T00:00:00.000+09:00');
const ACTION_PAGE_SIZE = 1_000;

export interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data: Record<string, unknown>;
  idMemberCreator?: string;
  memberCreator?: Record<string, unknown>;
}

export interface TrelloImportOptions {
  connectorsConfigPath: string;
  rawStore: RawStore;
  rawIndexSink: RawIndexSink;
  fetchImpl?: typeof fetch;
  credentials: { apiKey: string; token: string };
  fromMs?: number;
  untilMs: number;
  observedAtMs?: number;
  manifestPath?: string;
  timeZone: string;
}

export interface TrelloImportResult {
  importedCount: number;
  importedByBoard: Record<string, number>;
  countsByBoardDay: Record<string, Record<string, number>>;
  projectedCount: number;
  pendingProjectionCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionTime(action: TrelloAction): number {
  const value = Date.parse(action.date);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Trello action date is invalid');
  return value;
}

function boardDay(timestampMs: number, timeZone: string): string {
  return localDateKey(timestampMs, timeZone);
}

function boardChannels(path: string): Array<{ key: string; boardId: string }> {
  const result = loadConnectorConfig(path);
  if (!result.ok) throw new Error(result.error.message);
  const trello = result.config.trello;
  if (!trello || !trello.enabled) return [];
  return Object.entries(trello.channels)
    .filter(([, channel]) => channel.role !== 'ignore' && channel.boardId)
    .map(([key, channel]) => ({ key, boardId: channel.boardId! }));
}

function actionItem(
  board: { key: string; boardId: string },
  action: TrelloAction,
  observedAtMs: number
) {
  const card = action.data.card;
  const list = action.data.list;
  const cardRecord =
    card && typeof card === 'object' && !Array.isArray(card)
      ? (card as Record<string, unknown>)
      : undefined;
  const cardId = typeof cardRecord?.id === 'string' ? cardRecord.id : board.boardId;
  return {
    source: 'trello' as const,
    sourceId: action.id,
    sourceEntityId: `${board.boardId}:${cardId}`,
    channel: board.key,
    author: 'trello',
    content: trelloActionLine(action),
    timestamp: new Date(actionTime(action)),
    type: 'kanban_card' as const,
    observedAt: observedAtMs,
    metadata: {
      actionType: action.type,
      boardId: board.boardId,
      cardId,
      ...(list && typeof list === 'object' && !Array.isArray(list) ? { list } : {}),
      ...(action.idMemberCreator === undefined ? {} : { idMemberCreator: action.idMemberCreator }),
      ...(action.memberCreator === undefined ? {} : { memberCreator: action.memberCreator }),
      data: action.data,
    },
  };
}

export async function importTrelloActions(
  options: TrelloImportOptions
): Promise<TrelloImportResult> {
  const fromMs = options.fromMs ?? IMPORT_FROM_MS;
  if (!Number.isSafeInteger(fromMs) || fromMs < 0) {
    throw new Error('Trello import fromMs must be a nonnegative epoch timestamp');
  }
  if (!Number.isSafeInteger(options.untilMs) || options.untilMs < fromMs) {
    throw new Error('Trello import untilMs must be a nonnegative time after fromMs');
  }
  const observedAtMs = options.observedAtMs ?? Date.now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error('Trello import observedAtMs must be a nonnegative epoch timestamp');
  }
  if (
    typeof options.credentials.apiKey !== 'string' ||
    options.credentials.apiKey.trim() === '' ||
    typeof options.credentials.token !== 'string' ||
    options.credentials.token.trim() === ''
  ) {
    throw new Error('Trello import credentials are required');
  }
  assertRawProjectionQueuesEmpty(options.rawStore);
  const fetchImpl = options.fetchImpl ?? fetch;
  const boards = boardChannels(options.connectorsConfigPath);
  const beforeCounts = new Map(
    options.rawStore
      .listConnectorNames()
      .map((connector) => [connector, options.rawStore.count(connector)] as const)
  );
  const importedByBoard: Record<string, number> = {};
  const seenActionIds = new Set<string>();
  for (const board of boards) {
    let before: string | undefined = new Date(options.untilMs).toISOString();
    let keepPaging = true;
    while (keepPaging) {
      const url = new URL(
        `https://api.trello.com/1/boards/${encodeURIComponent(board.boardId)}/actions`
      );
      url.searchParams.set('filter', 'all');
      url.searchParams.set('since', new Date(fromMs).toISOString());
      url.searchParams.set('before', before);
      url.searchParams.set('limit', String(ACTION_PAGE_SIZE));
      url.searchParams.set('fields', 'id,type,date,data,idMemberCreator');
      url.searchParams.set('memberCreator', 'true');
      url.searchParams.set('memberCreator_fields', 'id,fullName,username');
      url.searchParams.set('key', options.credentials.apiKey);
      url.searchParams.set('token', options.credentials.token);
      const response = await fetchImpl(url, { method: 'GET' });
      if (!response.ok)
        throw new Error(`Trello actions request failed with HTTP ${response.status}`);
      let parsed: unknown;
      try {
        parsed = (await response.json()) as unknown;
      } catch (error) {
        throw new Error(`Trello actions response is not JSON: ${errorMessage(error)}`);
      }
      if (!Array.isArray(parsed)) throw new Error('Trello actions response must be an array');
      const actions = parsed as TrelloAction[];
      if (actions.length === 0) {
        keepPaging = false;
        continue;
      }
      const items = [];
      let oldest: TrelloAction | undefined;
      for (const action of actions) {
        if (
          typeof action.id !== 'string' ||
          action.id.trim() === '' ||
          typeof action.type !== 'string'
        ) {
          throw new Error('Trello action identity is invalid');
        }
        const timestamp = actionTime(action);
        if (
          oldest === undefined ||
          timestamp < actionTime(oldest) ||
          (timestamp === actionTime(oldest) && action.id < oldest.id)
        ) {
          oldest = action;
        }
        if (timestamp < fromMs || timestamp >= options.untilMs || seenActionIds.has(action.id))
          continue;
        seenActionIds.add(action.id);
        items.push(actionItem(board, action, observedAtMs));
        importedByBoard[board.key] = (importedByBoard[board.key] ?? 0) + 1;
      }
      if (items.length > 0) options.rawStore.save('trello', items, { collectOnly: true });
      if (
        actions.length < ACTION_PAGE_SIZE ||
        oldest === undefined ||
        actionTime(oldest) <= fromMs
      ) {
        break;
      }
      const nextBefore = oldest.id;
      if (nextBefore === before) throw new Error('Trello action pagination made no progress');
      before = nextBefore;
    }
  }
  const projectedCount = await drainRawProjections(options.rawStore, options.rawIndexSink);
  const afterTotal = options.rawStore
    .listConnectorNames()
    .reduce((total, connector) => total + options.rawStore.count(connector), 0);
  const beforeTotal = [...beforeCounts.values()].reduce((total, count) => total + count, 0);
  const pendingProjectionCount = options.rawStore
    .listConnectorNames()
    .reduce((total, connector) => total + options.rawStore.pendingProjectionCount(connector), 0);
  if (pendingProjectionCount !== 0) {
    throw new Error(`Trello import left ${pendingProjectionCount} raw projections pending`);
  }
  const result = {
    importedCount: afterTotal - beforeTotal,
    importedByBoard,
    countsByBoardDay: options.rawStore
      .query('trello', new Date(fromMs))
      .filter((item) => item.timestamp.getTime() < options.untilMs)
      .reduce<Record<string, Record<string, number>>>((counts, item) => {
        const boardId = item.metadata?.boardId;
        if (typeof boardId !== 'string' || boardId.trim() === '') return counts;
        const days = (counts[boardId] ??= {});
        const date = boardDay(item.timestamp.getTime(), options.timeZone);
        days[date] = (days[date] ?? 0) + 1;
        return counts;
      }, {}),
    projectedCount,
    pendingProjectionCount,
  };
  if (options.manifestPath !== undefined) {
    const existing = existsSync(options.manifestPath)
      ? readImportManifest(options.manifestPath)
      : {
          fromMs,
          untilMs: options.untilMs,
          maxSourceAtMs: null,
          countsByOriginDay: {},
          rawObservationCount: 0,
          indexCount: 0,
          pendingProjectionCount: 0,
          trelloCountsByBoardDay: {},
        };
    writeImportManifest(options.manifestPath, {
      ...existing,
      rawObservationCount: existing.rawObservationCount + result.importedCount,
      indexCount: existing.indexCount + result.projectedCount,
      pendingProjectionCount: result.pendingProjectionCount,
      trelloCountsByBoardDay: result.countsByBoardDay,
    });
  }
  return result;
}

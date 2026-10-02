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
import { TrelloApi } from '../connectors/trello/api.js';
import { trelloActionItem, type TrelloBoardChannel } from '../connectors/trello/actions.js';

export type { TrelloAction } from '../connectors/trello/actions.js';

const IMPORT_FROM_MS = Date.parse('2026-09-01T00:00:00.000+09:00');

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

function boardDay(timestampMs: number, timeZone: string): string {
  return localDateKey(timestampMs, timeZone);
}

function boardChannels(path: string): TrelloBoardChannel[] {
  const result = loadConnectorConfig(path);
  if (!result.ok) throw new Error(result.error.message);
  const trello = result.config.trello;
  if (!trello || !trello.enabled) return [];
  return Object.entries(trello.channels)
    .filter(([, channel]) => channel.role !== 'ignore' && channel.boardId)
    .map(([key, channel]) => ({
      key,
      boardId: channel.boardId!,
      ...(channel.name === undefined ? {} : { name: channel.name }),
    }));
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
  const api = new TrelloApi(options.credentials, fetchImpl);
  for (const board of boards) {
    const actions = await api.boardActions(board.boardId, { fromMs, untilMs: options.untilMs });
    const items = actions.map((action) => ({
      ...trelloActionItem(board, action),
      observedAt: observedAtMs,
    }));
    if (items.length > 0) options.rawStore.save('trello', items, { collectOnly: true });
    importedByBoard[board.key] = (importedByBoard[board.key] ?? 0) + items.length;
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

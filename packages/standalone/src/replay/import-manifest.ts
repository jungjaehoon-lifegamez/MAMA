import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { mapNormalizedItemsToConnectorEventIndexInputs } from '../storage/source-archive.js';
import type {
  NormalizedItem,
  PendingProjection,
  RawIndexProjection,
  RawIndexSink,
  RawStore,
} from '../storage/source-archive.js';
import { upsertConnectorEventIndex } from '../connectors/framework/event-index.js';

export interface ImportManifest {
  /** Inclusive start and exclusive import fence T, both epoch milliseconds. */
  fromMs: number;
  untilMs: number;
  maxSourceAtMs: number | null;
  countsByOriginDay: Record<string, Record<string, number>>;
  rawObservationCount: number;
  indexCount: number;
  pendingProjectionCount: number;
  unmappedByOrigin?: Record<string, number>;
  trelloCountsByBoardDay?: Record<string, Record<string, number>>;
}

function finiteInteger(value: unknown, field: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative epoch-millisecond integer`);
  }
  return value;
}

function countRecord(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object of bounded counts`);
  }
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (key.trim() === '') throw new Error(`${field} contains a blank key`);
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${field}.${key} must be a nonnegative integer`);
    }
    result[key] = count;
  }
  return result;
}

function normalizeManifest(value: unknown): ImportManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Import manifest must contain an object');
  }
  const row = value as Record<string, unknown>;
  const fromMs = finiteInteger(row.fromMs, 'fromMs')!;
  const untilMs = finiteInteger(row.untilMs, 'untilMs')!;
  if (untilMs < fromMs) throw new Error('Import manifest untilMs must not precede fromMs');
  const rawCounts = row.countsByOriginDay;
  if (!rawCounts || typeof rawCounts !== 'object' || Array.isArray(rawCounts)) {
    throw new Error('countsByOriginDay must be an object of origin/day counts');
  }
  const countsByOriginDay: Record<string, Record<string, number>> = {};
  for (const [origin, days] of Object.entries(rawCounts)) {
    countsByOriginDay[origin] = countRecord(days, `countsByOriginDay.${origin}`);
  }
  const manifest: ImportManifest = {
    fromMs,
    untilMs,
    maxSourceAtMs: finiteInteger(row.maxSourceAtMs, 'maxSourceAtMs', true),
    countsByOriginDay,
    rawObservationCount: finiteInteger(row.rawObservationCount, 'rawObservationCount')!,
    indexCount: finiteInteger(row.indexCount, 'indexCount')!,
    pendingProjectionCount: finiteInteger(row.pendingProjectionCount, 'pendingProjectionCount')!,
  };
  if (row.unmappedByOrigin !== undefined) {
    manifest.unmappedByOrigin = countRecord(row.unmappedByOrigin, 'unmappedByOrigin');
  }
  if (row.trelloCountsByBoardDay !== undefined) {
    if (
      !row.trelloCountsByBoardDay ||
      typeof row.trelloCountsByBoardDay !== 'object' ||
      Array.isArray(row.trelloCountsByBoardDay)
    ) {
      throw new Error('trelloCountsByBoardDay must be an object of board/day counts');
    }
    const counts: Record<string, Record<string, number>> = {};
    for (const [board, days] of Object.entries(row.trelloCountsByBoardDay)) {
      counts[board] = countRecord(days, `trelloCountsByBoardDay.${board}`);
    }
    manifest.trelloCountsByBoardDay = counts;
  }
  return manifest;
}

/** Persist only bounded import metadata. The caller chooses the destination explicitly. */
export function writeImportManifest(path: string, manifest: ImportManifest): void {
  const normalized = normalizeManifest(manifest);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function readImportManifest(path: string): ImportManifest {
  if (!existsSync(path)) throw new Error(`Import manifest does not exist: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Import manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return normalizeManifest(parsed);
}

export function createCoreRawIndexSink(
  adapter: DatabaseInstance
): (connectorName: string, items: NormalizedItem[]) => RawIndexProjection[] {
  return (connectorName: string, items: NormalizedItem[]) => {
    return mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items).map((input) => {
      const record = upsertConnectorEventIndex(adapter, input);
      const observationRef = record.current_observation_id;
      if (!observationRef) {
        throw new Error(`Raw index projection omitted an observation ref for ${connectorName}`);
      }
      return { sourceId: input.source_id, observationRef } satisfies RawIndexProjection;
    });
  };
}

export function assertRawProjectionQueuesEmpty(rawStore: RawStore): void {
  const pending = rawStore
    .listConnectorNames()
    .reduce((total, connector) => total + rawStore.pendingProjectionCount(connector), 0);
  if (pending !== 0) {
    throw new Error(`Collect-only import requires empty raw projection queues; found ${pending}`);
  }
}

export async function drainRawProjections(
  rawStore: RawStore,
  rawIndexSink: RawIndexSink
): Promise<number> {
  let projected = 0;
  for (const connector of rawStore.listConnectorNames()) {
    let afterSequence = 0;
    let keepPaging = true;
    while (keepPaging) {
      const page: PendingProjection[] = rawStore.listPendingProjections(
        connector,
        1_000,
        afterSequence
      );
      if (page.length === 0) {
        keepPaging = false;
        continue;
      }
      const acknowledgements: Array<{
        revisionSourceId: string;
        pendingProjectionId: number;
      }> = [];
      for (const projection of page) {
        const saved = await rawIndexSink(connector, [projection]);
        if (saved.length !== 1 || saved[0]?.sourceId !== projection.sourceId) {
          throw new Error(
            `Raw index projection returned the wrong source identity for ${connector}`
          );
        }
        acknowledgements.push({
          revisionSourceId: projection.sourceId,
          pendingProjectionId: projection.pendingProjectionId,
        });
        projected += 1;
      }
      rawStore.acknowledgeProjections(connector, acknowledgements);
      afterSequence = page[page.length - 1]!.pendingProjectionId;
    }
  }
  return projected;
}

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type {
  SourceDelta,
  SourceObservationRef,
} from '../connectors/framework/polling-scheduler.js';
import Database from '../sqlite.js';
import type { WindowQueue } from './window-queue.js';
import type { TimeZoneSetting } from '../runtime/timezone.js';
import { epochAtLocalDateTime, localDateKey } from '../runtime/timezone.js';

export const REPLAY_WINDOW_SIZE_MS = 24 * 60 * 60 * 1_000;
export const REPLAY_REFERENCE_CAP = 500;

export interface ReplaySourceEvent {
  readonly connector: string;
  readonly sourceId: string;
  readonly observationRef: string;
  readonly channelKey: string;
  readonly sourceAtMs: number;
  readonly rawRowId: number;
  readonly author?: string;
  /** Display name of the channel from the connector configuration, when it has one. */
  readonly channelName?: string;
  readonly contentPreview?: string;
  readonly observedAtMs?: number;
  readonly sourceEntityId?: string;
  readonly contentHash?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface ReplayWindow {
  readonly startMs: number;
  readonly endMs: number;
}

interface ReplayIndexRow {
  connector: string;
  source_id: string;
  observation_ref: string | null;
  channel_key: string | null;
  source_at_ms: number;
  raw_row_id: number;
  author: string | null;
  content: string;
  observed_at_ms: number | null;
  source_entity_id: string | null;
  metadata_json: string | null;
  content_hash: Buffer | Uint8Array | string | null;
}

type ReplayCatalogAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ReplaySourceReadOptions {
  rawRoot?: string;
  /** `${connector}\0${channelId}` → configured channel name (connectors.json). */
  channelNames?: ReadonlyMap<string, string>;
  timeZone: TimeZoneSetting;
}

export interface ReplayLedgerDigestItem {
  readonly commitmentId: string;
  /** Current revision: the expectedRevision a work.revise names, so no re-read is needed. */
  readonly revision: number;
  readonly title: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  readonly assignee: string | null;
  readonly lastEventTime: string | null;
}

export interface ReplayWindowDeltaOptions {
  ledgerDigest?: readonly ReplayLedgerDigestItem[];
  queue?: WindowQueue;
}

function assertEpochMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative epoch-millisecond integer`);
  }
}

function assertRange(fromMs: number, untilMs: number): void {
  assertEpochMs(fromMs, 'fromMs');
  assertEpochMs(untilMs, 'untilMs');
  if (untilMs < fromMs) throw new Error('untilMs must not precede fromMs');
}

function compareEvents(left: ReplaySourceEvent, right: ReplaySourceEvent): number {
  return (
    left.sourceAtMs - right.sourceAtMs ||
    left.connector.localeCompare(right.connector) ||
    left.channelKey.localeCompare(right.channelKey) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.rawRowId - right.rawRowId
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function nextLocalMidnight(ms: number, timeZone: string): number {
  const day = localDateKey(ms, timeZone);
  const [year, month, date] = day.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year!, month! - 1, date! + 1)).toISOString().slice(0, 10);
  const midnight = epochAtLocalDateTime(`${tomorrow}T00:00:00`, timeZone);
  return midnight > ms ? midnight : midnight + REPLAY_WINDOW_SIZE_MS;
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Replay source metadata is malformed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Replay source metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function hashText(value: Buffer | Uint8Array | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('hex');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function channelNameFor(
  connector: string,
  channelKey: string,
  names: ReadonlyMap<string, string> | undefined
): string | undefined {
  if (names === undefined) return undefined;
  const local = channelKey.startsWith(`${connector}:`)
    ? channelKey.slice(connector.length + 1)
    : channelKey;
  return names.get(`${connector}\0${channelKey}`) ?? names.get(`${connector}\0${local}`);
}

function rowToEvent(
  row: ReplayIndexRow,
  channelNames: ReadonlyMap<string, string> | undefined
): ReplaySourceEvent {
  if (typeof row.connector !== 'string' || row.connector.trim() === '') {
    throw new Error('Replay source connector is missing');
  }
  if (typeof row.source_id !== 'string' || row.source_id.trim() === '') {
    throw new Error('Replay source id is missing');
  }
  if (typeof row.observation_ref !== 'string' || row.observation_ref.trim() === '') {
    throw new Error(`Replay source projection is missing for ${row.connector}:${row.source_id}`);
  }
  if (typeof row.channel_key !== 'string' || row.channel_key.trim() === '') {
    throw new Error(`Replay source channel is missing for ${row.connector}:${row.source_id}`);
  }
  if (typeof row.content !== 'string') {
    throw new Error(`Replay source content is missing for ${row.connector}:${row.source_id}`);
  }
  assertEpochMs(row.source_at_ms, 'sourceAtMs');
  if (!Number.isSafeInteger(row.raw_row_id) || row.raw_row_id < 1) {
    throw new Error(`Replay source row id is invalid for ${row.connector}:${row.source_id}`);
  }
  if (row.observed_at_ms !== null) assertEpochMs(row.observed_at_ms, 'observedAtMs');
  const metadata = parseMetadata(row.metadata_json);
  // An imported Trello action is stored as a readable line under the connector's name; the
  // person who acted is in the action the metadata keeps.
  const actor = row.connector === 'trello' ? text(record(metadata?.memberCreator).fullName) : '';
  const author = actor || row.author;
  const channelName = channelNameFor(row.connector, row.channel_key, channelNames);
  const event: ReplaySourceEvent = {
    connector: row.connector,
    sourceId: row.source_id,
    observationRef: row.observation_ref,
    channelKey: row.channel_key,
    sourceAtMs: row.source_at_ms,
    rawRowId: row.raw_row_id,
    ...(author ? { author } : {}),
    ...(channelName === undefined ? {} : { channelName }),
    contentPreview: row.content,
    ...(row.observed_at_ms === null ? {} : { observedAtMs: row.observed_at_ms }),
    ...(row.source_entity_id === null ? {} : { sourceEntityId: row.source_entity_id }),
    contentHash: hashText(row.content_hash),
    ...(metadata === undefined ? {} : { metadata }),
  };
  return Object.freeze(event);
}

/** Read the immutable observation projections produced for every imported raw store. */
export function readReplaySourceEvents(
  adapter: ReplayCatalogAdapter,
  fromMs: number,
  untilMs: number,
  options: ReplaySourceReadOptions
): readonly ReplaySourceEvent[] {
  assertRange(fromMs, untilMs);
  const rows = adapter
    .prepare(
      `SELECT e.source_connector AS connector,
              e.source_id,
              e.current_observation_id AS observation_ref,
              e.channel AS channel_key,
              COALESCE(e.event_datetime, e.source_timestamp_ms) AS source_at_ms,
              COALESCE(e.operator_ingest_seq, e.rowid) AS raw_row_id,
              e.author,
              e.content,
              o.observed_at AS observed_at_ms,
              e.source_entity_id,
              e.metadata_json,
              e.content_hash
         FROM connector_event_index e
         LEFT JOIN observation_versions o ON o.observation_id = e.current_observation_id
        WHERE COALESCE(e.event_datetime, e.source_timestamp_ms) >= ?
          AND COALESCE(e.event_datetime, e.source_timestamp_ms) < ?
        ORDER BY source_at_ms ASC, connector ASC, channel_key ASC, e.source_id ASC, raw_row_id ASC`
    )
    .all(fromMs, untilMs) as ReplayIndexRow[];
  const rawRowIds =
    options.rawRoot === undefined ? null : readRawRowIds(options.rawRoot, fromMs, untilMs);
  return Object.freeze(
    rows.map((row) => {
      if (rawRowIds !== null) {
        const rawRowId = rawRowIds.get(`${row.connector}\0${row.source_id}`);
        if (rawRowId === undefined) {
          throw new Error(`Replay raw store row is missing for ${row.connector}:${row.source_id}`);
        }
        return rowToEvent({ ...row, raw_row_id: rawRowId }, options.channelNames);
      }
      return rowToEvent(row, options.channelNames);
    })
  );
}

function readRawRowIds(rawRoot: string, fromMs: number, untilMs: number): Map<string, number> {
  if (!existsSync(rawRoot)) throw new Error('Replay raw root does not exist');
  const ids = new Map<string, number>();
  const connectors = readdirSync(rawRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const connector of connectors) {
    const path = join(rawRoot, connector, 'raw.db');
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare('SELECT id, source_id FROM raw_items WHERE timestamp >= ? AND timestamp < ?')
        .all(fromMs, untilMs) as Array<{ id: number; source_id: string }>;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || row.id < 1 || typeof row.source_id !== 'string') {
          throw new Error(`Replay raw row identity is invalid for ${connector}`);
        }
        const key = `${connector}\0${row.source_id}`;
        if (ids.has(key))
          throw new Error(
            `Replay raw row identity is duplicated for ${connector}:${row.source_id}`
          );
        ids.set(key, row.id);
      }
    } finally {
      db.close();
    }
  }
  return ids;
}

/**
 * The catalog carries each message's text (a Trello action as one readable line) with its
 * channel name. Raw records and attachments stay in the connector raw stores and reach the
 * owner through the normal source.read action.
 */
export class ReplaySourceCatalog {
  private readonly events: readonly ReplaySourceEvent[];
  private readonly timeZone: TimeZoneSetting;

  constructor(events: readonly ReplaySourceEvent[], timeZone: TimeZoneSetting) {
    this.timeZone = timeZone;
    const copy = events.map((event) => {
      if (
        event.connector.trim() === '' ||
        event.sourceId.trim() === '' ||
        event.observationRef.trim() === '' ||
        event.channelKey.trim() === ''
      ) {
        throw new Error('Replay source event identity must be nonblank');
      }
      assertEpochMs(event.sourceAtMs, 'sourceAtMs');
      if (!Number.isSafeInteger(event.rawRowId) || event.rawRowId < 1) {
        throw new Error('rawRowId must be a positive safe integer');
      }
      if (event.observedAtMs !== undefined) assertEpochMs(event.observedAtMs, 'observedAtMs');
      return Object.freeze({ ...event });
    });
    this.events = Object.freeze(copy.sort(compareEvents));
  }

  allEvents(): readonly ReplaySourceEvent[] {
    return this.events;
  }

  eventsForWindow(startMs: number, endMs: number): readonly ReplaySourceEvent[] {
    assertRange(startMs, endMs);
    return this.events.filter((event) => event.sourceAtMs >= startMs && event.sourceAtMs < endMs);
  }

  windows(fromMs: number, untilMs: number): readonly ReplayWindow[] {
    assertRange(fromMs, untilMs);
    const result: ReplayWindow[] = [];
    for (let startMs = fromMs; startMs < untilMs; ) {
      const endMs = Math.min(nextLocalMidnight(startMs, this.timeZone.get()), untilMs);
      result.push({ startMs, endMs });
      startMs = endMs;
    }
    return Object.freeze(result);
  }

  deltasForWindow(
    runId: string,
    startMs: number,
    endMs: number,
    options: ReplayWindowDeltaOptions = {}
  ): readonly SourceDelta[] {
    if (runId.trim() === '') throw new Error('Replay runId is required');
    const events = this.eventsForWindow(startMs, endMs);
    const ordered = [...events].sort(compareEvents);
    const windowId = `window:${startMs}:${endMs}`;
    const refs: readonly SourceObservationRef[] = Object.freeze(
      ordered.map((event) => ({
        connector: event.connector,
        observationRef: event.observationRef,
        sourceId: event.sourceId,
        sourceEntityId: event.sourceEntityId ?? event.sourceId,
        channel: event.channelKey,
        sourceAt: iso(event.sourceAtMs),
        observedAt: iso(event.observedAtMs ?? event.sourceAtMs),
        contentHash: event.contentHash ?? null,
        ...(event.author === undefined ? {} : { author: event.author }),
        ...(event.channelName === undefined ? {} : { channelName: event.channelName }),
        ...(event.contentPreview === undefined ? {} : { contentPreview: event.contentPreview }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      }))
    );
    const first = ordered[0];
    const occurredAt = first === undefined ? startMs : ordered[ordered.length - 1]!.sourceAtMs;
    const ledgerDigest = options.ledgerDigest === undefined ? undefined : [...options.ledgerDigest];
    const endInstructions =
      "Orchestrate this window: note your turn start. current_work and the queue candidates already carry each item's current revision, so do not list the whole ledger again; read only the items you need to check. Decide new work from section C and give it an owner. Before dispatching, create the day's journal daily/YYYY-MM/YYYY-MM-DD.md with one heading per subagent lane. Give each native subagent a disjoint set of work items (source lines, history, current revisions), the wiki pages it owns and its journal heading; it writes its items and pages itself, adds one journal entry per item it moved under its heading with the wiki section update action from your standing instructions (who, source time, what it contained, what is awaited next; on a content-version conflict it re-reads and retries), and returns a receipt (items with revision before/after, created items, pages updated, journal entries added, what it could not do). Dispatch and await subagents using the native tools named in your standing instructions. Then read back the work ledger using its list action with view=items changedSince=<turn start>, reconcile it with the receipts, settle gaps and duplicates, and add a journal entry for any moved item that has none; then write the journal's judgment section (what is blocked or at risk, what the owner must decide or confirm, what to follow up next), the board slots, Home.md and lessons.";
    const delta = {
      kind: 'source_delta' as const,
      collector: 'replay',
      channel: `replay:${windowId}`,
      coalesceKey: `source:replay:${windowId}`,
      refs,
      preview: Object.freeze([
        `replay window=${windowId}`,
        `messages=${String(refs.length)}`,
        ...(first === undefined ? [] : [`source first=${iso(first.sourceAtMs)}`]),
        ...(first === undefined ? [] : [`source last=${iso(occurredAt)}`]),
        `channels=${String(new Set(ordered.map((event) => event.channelKey)).size)}`,
      ]),
      occurredAt,
      replay: {
        runId,
        windowId,
        windowStartMs: startMs,
        windowEndMs: endMs,
        ...(ledgerDigest === undefined ? {} : { ledgerDigest }),
        ...(options.queue === undefined ? {} : { queue: options.queue }),
        endInstructions,
      },
    } satisfies SourceDelta;
    return Object.freeze([delta]);
  }
}

export function createReplaySourceCatalog(
  adapter: ReplayCatalogAdapter,
  fromMs: number,
  untilMs: number,
  options: ReplaySourceReadOptions
): ReplaySourceCatalog {
  return new ReplaySourceCatalog(
    readReplaySourceEvents(adapter, fromMs, untilMs, options),
    options.timeZone
  );
}

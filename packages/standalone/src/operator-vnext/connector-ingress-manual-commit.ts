import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  buildConnectorOperatorCursorName,
  connectorEventIngressOperatorSeqSql,
  type ConnectorEventIngressAdapter,
} from './connector-event-ingress.js';
import {
  PrimaryOperatorRuntime,
  type PrimaryOperatorBatchResult,
  type PrimaryOperatorEvent,
} from './primary-operator-runtime.js';
import { nonNegativeInteger, requiredString } from './validation.js';

interface ConnectorIngressReviewedEventRow {
  operator_seq: number;
  event_index_id: string;
  source_connector: string;
  source_id: string;
  channel: string | null;
}

interface NoUpdateCommitDetailRow {
  scope_key: string;
  reason: string;
}

export interface ConnectorIngressManualCommitInput {
  rawAdapter: ConnectorEventIngressAdapter;
  operatorDb: SQLiteDatabase;
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventIndexIds: readonly string[];
  nowMs?: () => number;
}

export interface ConnectorIngressManualCommitResult {
  ok: boolean;
  mode: 'manual_no_update_commit';
  status: PrimaryOperatorBatchResult['status'];
  cursorName: string;
  connector: string;
  channel: string;
  requestedCount: number;
  processed: number;
  advancedThroughSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  commits: Array<{
    seq: number;
    status: 'no_update';
    outcome: 'committed' | 'already_committed' | 'recovered';
    cursorAdvanced: boolean;
  }>;
  failedSeq?: number;
  error?: string;
}

export type ConnectorIngressManualNoUpdateCommitProvider = (
  input: Omit<ConnectorIngressManualCommitInput, 'rawAdapter' | 'operatorDb' | 'nowMs'>
) => Promise<ConnectorIngressManualCommitResult>;

export class ConnectorIngressManualCommitRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorIngressManualCommitRequestError';
  }
}

export const MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS = 100;

const NO_UPDATE_REASON = 'manual_ingress_reviewed_no_update';

export function isConnectorIngressManualCommitRequestError(
  error: unknown
): error is ConnectorIngressManualCommitRequestError {
  return error instanceof ConnectorIngressManualCommitRequestError;
}

function requestError(message: string): ConnectorIngressManualCommitRequestError {
  return new ConnectorIngressManualCommitRequestError(message);
}

function readCursorSeq(db: SQLiteDatabase, cursorName: string): number {
  const row = db
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as { last_change_seq: number } | undefined;
  return row?.last_change_seq ?? 0;
}

function normalizeEventIndexIds(eventIndexIds: readonly string[]): string[] {
  if (!Array.isArray(eventIndexIds) || eventIndexIds.length === 0) {
    throw requestError('eventIndexIds must not be empty');
  }
  if (eventIndexIds.length > MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS) {
    throw requestError(
      `eventIndexIds must contain at most ${MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS} items`
    );
  }
  return eventIndexIds.map((eventIndexId) => {
    try {
      return requiredString(eventIndexId, 'eventIndexIds[]');
    } catch {
      throw requestError('eventIndexIds must be a non-empty string array');
    }
  });
}

function rowToEvent(row: ConnectorIngressReviewedEventRow): PrimaryOperatorEvent {
  const sourceRef: SourceRef = {
    kind: 'raw',
    connector: requiredString(row.source_connector, 'source_connector'),
    id: requiredString(row.event_index_id, 'event_index_id'),
    source_id: requiredString(row.source_id, 'source_id'),
    channel_id: row.channel,
  };
  return {
    seq: nonNegativeInteger(row.operator_seq, 'operator_seq'),
    sourceRef,
  };
}

function readReviewedEvents(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  eventIndexIds: readonly string[];
}): PrimaryOperatorEvent[] {
  const ids = normalizeEventIndexIds(input.eventIndexIds);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = input.rawAdapter
    .prepare(
      `
        WITH ordered_events AS (
          SELECT
            ${connectorEventIngressOperatorSeqSql()} AS operator_seq,
            event_index_id,
            source_connector,
            source_id,
            channel
          FROM connector_event_index
          WHERE source_connector = ?
            AND channel = ?
        )
        SELECT
          operator_seq,
          event_index_id,
          source_connector,
          source_id,
          channel
        FROM ordered_events
        WHERE event_index_id IN (${placeholders})
        ORDER BY operator_seq ASC
      `
    )
    .all(input.connector, input.channel, ...ids) as ConnectorIngressReviewedEventRow[];
  const orderedIds = rows.map((row) => requiredString(row.event_index_id, 'event_index_id'));
  if (orderedIds.length !== ids.length || orderedIds.some((id, index) => id !== ids[index])) {
    throw requestError('Reviewed event ids do not match the current deterministic connector order');
  }
  return rows.map(rowToEvent);
}

function countEventsInSeqRange(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  afterSeq: number;
  throughSeq: number;
}): number {
  const row = input.rawAdapter
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM connector_event_index
        WHERE source_connector = ?
          AND channel = ?
          AND ${connectorEventIngressOperatorSeqSql()} > ?
          AND ${connectorEventIngressOperatorSeqSql()} <= ?
      `
    )
    .get(input.connector, input.channel, input.afterSeq, input.throughSeq) as
    | { count: number }
    | undefined;
  return nonNegativeInteger(row?.count ?? 0, 'reviewed_range_count');
}

function assertReviewedSeqs(
  input: {
    rawAdapter: ConnectorEventIngressAdapter;
    connector: string;
    channel: string;
  },
  events: readonly PrimaryOperatorEvent[],
  expectedAdvancedThroughSeq: number,
  currentAdvancedThroughSeq: number
): void {
  const expected = nonNegativeInteger(expectedAdvancedThroughSeq, 'expectedAdvancedThroughSeq');
  const firstSeq = events[0]?.seq ?? null;
  const lastSeq = events[events.length - 1]?.seq ?? null;
  if (firstSeq === null || lastSeq === null || firstSeq <= expected) {
    throw requestError('Reviewed event ids do not advance the expected connector cursor');
  }
  const rangeCount = countEventsInSeqRange({
    rawAdapter: input.rawAdapter,
    connector: input.connector,
    channel: input.channel,
    afterSeq: expected,
    throughSeq: lastSeq,
  });
  if (rangeCount !== events.length) {
    throw requestError('Reviewed event ids do not cover the current connector cursor range');
  }
  if (currentAdvancedThroughSeq > expected && currentAdvancedThroughSeq < lastSeq) {
    throw requestError('Reviewed event ids are stale for the current connector cursor');
  }
  if (currentAdvancedThroughSeq < expected) {
    throw requestError('Reviewed cursor is ahead of the current connector cursor');
  }
}

function assertManualNoUpdateCommitDetails(
  db: SQLiteDatabase,
  cursorName: string,
  batch: PrimaryOperatorBatchResult
): void {
  for (const commit of batch.commits) {
    if (commit.status !== 'no_update') {
      throw new Error('Manual no-update commit recovered a non-no-update operator commit');
    }
    const row = db
      .prepare('SELECT scope_key, reason FROM operator_no_updates WHERE idempotency_key = ?')
      .get(commit.idempotencyKey) as NoUpdateCommitDetailRow | undefined;
    if (!row || row.scope_key !== cursorName || row.reason !== NO_UPDATE_REASON) {
      throw new Error('Manual no-update commit recovered mismatched no-update details');
    }
  }
}

export async function commitConnectorIngressNoUpdateBatch(
  input: ConnectorIngressManualCommitInput
): Promise<ConnectorIngressManualCommitResult> {
  const connector = requiredString(input.connector, 'connector');
  const channel = requiredString(input.channel, 'channel');
  const cursorName = buildConnectorOperatorCursorName({ connector, channel });

  const runtime = new PrimaryOperatorRuntime({
    db: input.operatorDb,
    cursorName,
    connector,
    nowMs: input.nowMs,
    allowSeqGaps: true,
  });
  let events: PrimaryOperatorEvent[] = [];
  const batch = await runtime.processBatchAfterValidation(
    () => {
      events = readReviewedEvents({
        rawAdapter: input.rawAdapter,
        connector,
        channel,
        eventIndexIds: input.eventIndexIds,
      });
      assertReviewedSeqs(
        {
          rawAdapter: input.rawAdapter,
          connector,
          channel,
        },
        events,
        input.expectedAdvancedThroughSeq,
        readCursorSeq(input.operatorDb, cursorName)
      );
      return events;
    },
    () => ({
      status: 'no_update',
      reason: NO_UPDATE_REASON,
      scopeKey: cursorName,
    })
  );
  assertManualNoUpdateCommitDetails(input.operatorDb, cursorName, batch);
  const firstSeq = events[0]?.seq ?? null;
  const lastSeq = events[events.length - 1]?.seq ?? null;
  const commits = batch.commits.map((commit) => ({
    seq: commit.lastChangeSeq,
    status: 'no_update' as const,
    outcome: commit.outcome,
    cursorAdvanced: commit.cursorAdvanced,
  }));
  if (batch.status === 'partial_failure') {
    return {
      ok: false,
      mode: 'manual_no_update_commit',
      status: batch.status,
      cursorName,
      connector,
      channel,
      requestedCount: input.eventIndexIds.length,
      processed: batch.processed,
      advancedThroughSeq: batch.advancedThroughSeq,
      firstSeq,
      lastSeq,
      commits,
      failedSeq: batch.failedSeq,
      error: 'Manual no-update commit partially failed.',
    };
  }
  return {
    ok: true,
    mode: 'manual_no_update_commit',
    status: batch.status,
    cursorName,
    connector,
    channel,
    requestedCount: input.eventIndexIds.length,
    processed: batch.processed,
    advancedThroughSeq: batch.advancedThroughSeq,
    firstSeq,
    lastSeq,
    commits,
  };
}

export function createConnectorIngressManualNoUpdateCommitProvider(
  options: Omit<ConnectorIngressManualCommitInput, 'expectedAdvancedThroughSeq' | 'eventIndexIds'>
): ConnectorIngressManualNoUpdateCommitProvider {
  const connector = requiredString(options.connector, 'connector');
  const channel = requiredString(options.channel, 'channel');
  return async (input) => {
    const requestedConnector = requiredString(input.connector, 'connector');
    const requestedChannel = requiredString(input.channel, 'channel');
    if (requestedConnector !== connector || requestedChannel !== channel) {
      throw requestError(
        `Connector ingress manual commit is locked to the configured connector/channel: ${connector}/${channel}`
      );
    }
    return commitConnectorIngressNoUpdateBatch({
      rawAdapter: options.rawAdapter,
      operatorDb: options.operatorDb,
      connector,
      channel,
      expectedAdvancedThroughSeq: input.expectedAdvancedThroughSeq,
      eventIndexIds: input.eventIndexIds,
      nowMs: options.nowMs,
    });
  };
}

import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  connectorEventIngressOperatorSeqSql,
  type ConnectorEventIngressAdapter,
} from './connector-event-ingress.js';
import type { PrimaryOperatorEvent } from './primary-operator-runtime.js';
import { nonNegativeInteger, requiredString } from './validation.js';

interface ConnectorIngressReviewedEventRow {
  operator_seq: number;
  event_index_id: string;
  source_connector: string;
  source_id: string;
  channel: string | null;
}

export const MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS = 100;

export type ConnectorIngressRequestErrorFactory = (message: string) => Error;

function defaultRequestError(message: string): Error {
  return new Error(message);
}

function throwRequestError(factory: ConnectorIngressRequestErrorFactory, message: string): never {
  throw factory(message);
}

export function readConnectorOperatorCursorSeq(db: SQLiteDatabase, cursorName: string): number {
  const row = db
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as { last_change_seq: number } | undefined;
  return row?.last_change_seq ?? 0;
}

export function normalizeReviewedEventIndexIds(
  eventIndexIds: readonly string[],
  options: {
    fieldName: string;
    maxItems?: number;
    requestError?: ConnectorIngressRequestErrorFactory;
  }
): string[] {
  const requestError = options.requestError ?? defaultRequestError;
  const maxItems = options.maxItems ?? MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS;
  if (!Array.isArray(eventIndexIds) || eventIndexIds.length === 0) {
    throwRequestError(requestError, `${options.fieldName} must not be empty`);
  }
  if (eventIndexIds.length > maxItems) {
    throwRequestError(requestError, `${options.fieldName} must contain at most ${maxItems} items`);
  }
  return eventIndexIds.map((eventIndexId) => {
    try {
      return requiredString(eventIndexId, `${options.fieldName}[]`);
    } catch {
      throwRequestError(requestError, `${options.fieldName} must be a non-empty string array`);
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

export function readReviewedConnectorIngressEvents(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  eventIndexIds: readonly string[];
  requestError?: ConnectorIngressRequestErrorFactory;
}): PrimaryOperatorEvent[] {
  const requestError = input.requestError ?? defaultRequestError;
  const placeholders = input.eventIndexIds.map(() => '?').join(', ');
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
    .all(
      input.connector,
      input.channel,
      ...input.eventIndexIds
    ) as ConnectorIngressReviewedEventRow[];
  const orderedIds = rows.map((row) => requiredString(row.event_index_id, 'event_index_id'));
  if (
    orderedIds.length !== input.eventIndexIds.length ||
    orderedIds.some((id, index) => id !== input.eventIndexIds[index])
  ) {
    throwRequestError(
      requestError,
      'Reviewed event ids do not match the current deterministic connector order'
    );
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

export function assertReviewedConnectorIngressSeqs(
  input: {
    rawAdapter: ConnectorEventIngressAdapter;
    connector: string;
    channel: string;
  },
  events: readonly PrimaryOperatorEvent[],
  expectedAdvancedThroughSeq: number,
  currentAdvancedThroughSeq: number,
  requestError: ConnectorIngressRequestErrorFactory = defaultRequestError
): void {
  const expected = nonNegativeInteger(expectedAdvancedThroughSeq, 'expectedAdvancedThroughSeq');
  const firstSeq = events[0]?.seq ?? null;
  const lastSeq = events[events.length - 1]?.seq ?? null;
  if (firstSeq === null || lastSeq === null || firstSeq <= expected) {
    throwRequestError(
      requestError,
      'Reviewed event ids do not advance the expected connector cursor'
    );
  }
  const rangeCount = countEventsInSeqRange({
    rawAdapter: input.rawAdapter,
    connector: input.connector,
    channel: input.channel,
    afterSeq: expected,
    throughSeq: lastSeq,
  });
  if (rangeCount !== events.length) {
    throwRequestError(
      requestError,
      'Reviewed event ids do not cover the current connector cursor range'
    );
  }
  if (currentAdvancedThroughSeq > expected && currentAdvancedThroughSeq < lastSeq) {
    throwRequestError(
      requestError,
      'Reviewed event ids are stale for the current connector cursor'
    );
  }
  if (currentAdvancedThroughSeq < expected) {
    throwRequestError(requestError, 'Reviewed cursor is ahead of the current connector cursor');
  }
}

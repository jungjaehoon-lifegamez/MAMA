import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { PrimaryOperatorEvent } from './primary-operator-runtime.js';
import { nonNegativeInteger, requiredString } from './validation.js';

interface QueryStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
}

export interface ConnectorEventIngressAdapter {
  prepare: (sql: string) => QueryStatement;
}

export interface ConnectorEventIngressScope {
  connector: string;
  channel?: string;
}

export interface ConnectorEventIngressPreviewInput extends ConnectorEventIngressScope {
  rawAdapter: ConnectorEventIngressAdapter;
  operatorDb: ConnectorEventIngressAdapter;
  limit?: number;
}

export type ConnectorEventIngressConfig =
  | { enabled: false }
  | { enabled: true; connector: string; channel: string };

export type ConnectorEventIngressPreviewProvider = (
  input: ConnectorEventIngressScope & { limit?: number }
) => ConnectorEventIngressPreview;

export interface ConnectorOperatorEventPreview extends PrimaryOperatorEvent {
  eventIndexId: string;
  sourceTimestampMs: number;
  sourceId: string;
  channel: string | null;
}

export interface ConnectorEventIngressPreview {
  cursorName: string;
  connector: string;
  channel: string;
  advancedThroughSeq: number;
  events: ConnectorOperatorEventPreview[];
}

interface CursorSeqRow {
  last_change_seq: number;
}

interface ConnectorEventIngressRow {
  operator_seq: number;
  event_index_id: string;
  source_connector: string;
  source_id: string;
  channel: string | null;
  source_timestamp_ms: number;
}

const DEFAULT_INGRESS_LIMIT = 25;
const MAX_INGRESS_LIMIT = 100;
const CONNECTOR_ENV = 'MAMA_VNEXT_INGRESS_CONNECTOR';
const CHANNEL_ENV = 'MAMA_VNEXT_INGRESS_CHANNEL';

export function connectorEventIngressOperatorSeqSql(): string {
  return 'operator_ingest_seq';
}

function positiveLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_INGRESS_LIMIT;
  }
  if (!Number.isFinite(value)) {
    throw new Error('limit must be a finite number');
  }
  return Math.min(MAX_INGRESS_LIMIT, Math.max(0, Math.floor(value)));
}

function readCursorSeq(operatorDb: ConnectorEventIngressAdapter, cursorName: string): number {
  const row = operatorDb
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as CursorSeqRow | undefined;
  return row?.last_change_seq ?? 0;
}

function mapRowToOperatorEvent(row: ConnectorEventIngressRow): ConnectorOperatorEventPreview {
  const sourceId = requiredString(row.source_id, 'source_id');
  const sourceRef: SourceRef = {
    kind: 'raw',
    connector: requiredString(row.source_connector, 'source_connector'),
    id: requiredString(row.event_index_id, 'event_index_id'),
    source_id: sourceId,
    channel_id: row.channel,
  };
  return {
    seq: nonNegativeInteger(row.operator_seq, 'operator_seq'),
    sourceRef,
    eventIndexId: sourceRef.id,
    sourceTimestampMs: nonNegativeInteger(row.source_timestamp_ms, 'source_timestamp_ms'),
    sourceId,
    channel: row.channel,
  };
}

export function buildConnectorOperatorCursorName(scope: ConnectorEventIngressScope): string {
  const connector = requiredString(scope.connector, 'connector');
  const channel = scope.channel === undefined ? null : requiredString(scope.channel, 'channel');
  return channel ? `connector:${connector}:channel:${channel}` : `connector:${connector}`;
}

export function resolveConnectorEventIngressConfig(
  env: Record<string, string | undefined> = process.env
): ConnectorEventIngressConfig {
  const connector = env[CONNECTOR_ENV]?.trim();
  const channel = env[CHANNEL_ENV]?.trim();
  if (!connector && !channel) {
    return { enabled: false };
  }
  if (!connector || !channel) {
    throw new Error(`${CONNECTOR_ENV} and ${CHANNEL_ENV} must be set together`);
  }
  return {
    enabled: true,
    connector,
    channel,
  };
}

export function buildConnectorEventIngressPreview(
  input: ConnectorEventIngressPreviewInput
): ConnectorEventIngressPreview {
  const connector = requiredString(input.connector, 'connector');
  const channel = requiredString(input.channel, 'channel');
  const limit = positiveLimit(input.limit);
  const cursorName = buildConnectorOperatorCursorName({ connector, channel });
  const advancedThroughSeq = readCursorSeq(input.operatorDb, cursorName);
  if (limit === 0) {
    return {
      cursorName,
      connector,
      channel,
      advancedThroughSeq,
      events: [],
    };
  }

  const rows = input.rawAdapter
    .prepare(
      `
        WITH ordered_events AS (
          SELECT
            ${connectorEventIngressOperatorSeqSql()} AS operator_seq,
            event_index_id,
            source_connector,
            source_id,
            channel,
            source_timestamp_ms
          FROM connector_event_index
          WHERE source_connector = ?
            AND channel = ?
        )
        SELECT
          operator_seq,
          event_index_id,
          source_connector,
          source_id,
          channel,
          source_timestamp_ms
        FROM ordered_events
        WHERE operator_seq > ?
        ORDER BY operator_seq ASC
        LIMIT ?
      `
    )
    .all(connector, channel, advancedThroughSeq, limit) as ConnectorEventIngressRow[];

  return {
    cursorName,
    connector,
    channel,
    advancedThroughSeq,
    events: rows.map(mapRowToOperatorEvent),
  };
}

export function createConnectorEventIngressPreviewProvider(
  options: ConnectorEventIngressPreviewInput
): ConnectorEventIngressPreviewProvider {
  const connector = requiredString(options.connector, 'connector');
  const channel = requiredString(options.channel, 'channel');
  return (input) => {
    const requestedConnector = requiredString(input.connector, 'connector');
    const requestedChannel = requiredString(input.channel, 'channel');
    if (requestedConnector !== connector || requestedChannel !== channel) {
      throw new Error(
        `Connector ingress preview is locked to the configured connector/channel: ${connector}/${channel}`
      );
    }
    return buildConnectorEventIngressPreview({
      rawAdapter: options.rawAdapter,
      operatorDb: options.operatorDb,
      connector,
      channel,
      limit: input.limit,
    });
  };
}

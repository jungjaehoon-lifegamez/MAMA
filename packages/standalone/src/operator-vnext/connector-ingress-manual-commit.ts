import type { SQLiteDatabase } from '../sqlite.js';
import {
  buildConnectorOperatorCursorName,
  type ConnectorEventIngressAdapter,
} from './connector-event-ingress.js';
import {
  assertReviewedConnectorIngressSeqs,
  MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS,
  normalizeReviewedEventIndexIds,
  readConnectorOperatorCursorSeq,
  readReviewedConnectorIngressEvents,
} from './connector-ingress-reviewed-events.js';
import {
  PrimaryOperatorRuntime,
  type PrimaryOperatorBatchResult,
  type PrimaryOperatorEvent,
} from './primary-operator-runtime.js';
import { requiredString } from './validation.js';

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

export const MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS = MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS;

const NO_UPDATE_REASON = 'manual_ingress_reviewed_no_update';

export function isConnectorIngressManualCommitRequestError(
  error: unknown
): error is ConnectorIngressManualCommitRequestError {
  return error instanceof ConnectorIngressManualCommitRequestError;
}

function requestError(message: string): ConnectorIngressManualCommitRequestError {
  return new ConnectorIngressManualCommitRequestError(message);
}

function normalizeEventIndexIds(eventIndexIds: readonly string[]): string[] {
  return normalizeReviewedEventIndexIds(eventIndexIds, {
    fieldName: 'eventIndexIds',
    maxItems: MAX_MANUAL_NO_UPDATE_EVENT_INDEX_IDS,
    requestError,
  });
}

function readReviewedEvents(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  eventIndexIds: readonly string[];
}): PrimaryOperatorEvent[] {
  const ids = normalizeEventIndexIds(input.eventIndexIds);
  return readReviewedConnectorIngressEvents({
    rawAdapter: input.rawAdapter,
    connector: input.connector,
    channel: input.channel,
    eventIndexIds: ids,
    requestError,
  });
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
      assertReviewedConnectorIngressSeqs(
        {
          rawAdapter: input.rawAdapter,
          connector,
          channel,
        },
        events,
        input.expectedAdvancedThroughSeq,
        readConnectorOperatorCursorSeq(input.operatorDb, cursorName),
        requestError
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

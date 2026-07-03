import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  isVNextWikiPublishAdapter,
  MAX_WIKI_PAGE_CONTENT_CHARS,
  MAX_WIKI_PUBLISH_PAGES,
  type WikiPublishAdapter,
} from '../wiki-artifacts/wiki-publish-adapter.js';
import type { WikiPublishPageInput } from '../wiki-artifacts/types.js';
import {
  normalizeWikiConfidence,
  normalizeWikiPagePath,
  normalizeWikiPageType,
  requiredWikiString,
} from '../wiki-artifacts/normalization.js';
import {
  buildConnectorOperatorCursorName,
  type ConnectorEventIngressAdapter,
} from './connector-event-ingress.js';
import {
  assertReviewedConnectorIngressSeqs,
  MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS,
  readConnectorOperatorCursorSeq,
  readReviewedConnectorIngressEvents,
} from './connector-ingress-reviewed-events.js';
import { ConnectorIngressManualCommitRequestError } from './connector-ingress-manual-commit.js';
import {
  PrimaryOperatorRuntime,
  type PrimaryOperatorBatchResult,
  type PrimaryOperatorEvent,
} from './primary-operator-runtime.js';
import {
  buildConnectorIdempotencyKey,
  buildCursorScopedIdempotencyKey,
} from './operator-cursor-commit.js';
import { requiredString } from './validation.js';

interface ExistingOperatorCommitStatusRow {
  status: string;
}

export interface ConnectorIngressManualWikiEventPages {
  eventIndexId: string;
  pages: readonly WikiPublishPageInput[];
}

export interface ConnectorIngressManualWikiCommitInput {
  rawAdapter: ConnectorEventIngressAdapter;
  operatorDb: SQLiteDatabase;
  wikiPublishAdapter: WikiPublishAdapter;
  connector: string;
  channel: string;
  expectedAdvancedThroughSeq: number;
  eventPages: readonly ConnectorIngressManualWikiEventPages[];
  nowMs?: () => number;
}

export interface ConnectorIngressManualWikiCommitResult {
  ok: boolean;
  mode: 'manual_wiki_commit';
  status: PrimaryOperatorBatchResult['status'];
  cursorName: string;
  connector: string;
  channel: string;
  requestedCount: number;
  processed: number;
  advancedThroughSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  pagesStored: number;
  commits: Array<{
    seq: number;
    status: 'changed';
    outcome: 'committed' | 'already_committed' | 'recovered';
    cursorAdvanced: boolean;
  }>;
  failedSeq?: number;
  error?: string;
}

export type ConnectorIngressManualWikiCommitProvider = (
  input: Omit<
    ConnectorIngressManualWikiCommitInput,
    'rawAdapter' | 'operatorDb' | 'wikiPublishAdapter' | 'nowMs'
  >
) => Promise<ConnectorIngressManualWikiCommitResult>;

const PARTIAL_FAILURE_MESSAGE = 'Manual wiki commit partially failed.';
export const MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES = MAX_WIKI_PUBLISH_PAGES;

function requestError(message: string): ConnectorIngressManualCommitRequestError {
  return new ConnectorIngressManualCommitRequestError(message);
}

function rejectWikiPageError(error: unknown): never {
  throw requestError(error instanceof Error ? error.message : 'Invalid manual wiki page');
}

function normalizeManualWikiPage(page: WikiPublishPageInput): WikiPublishPageInput {
  const rawPage = page as unknown as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(rawPage, 'sourceRefs') ||
    Object.prototype.hasOwnProperty.call(rawPage, 'source_refs') ||
    Object.prototype.hasOwnProperty.call(rawPage, 'sourceIds') ||
    Object.prototype.hasOwnProperty.call(rawPage, 'source_ids')
  ) {
    throw requestError('Wiki source refs are derived from reviewed events');
  }
  try {
    const content = requiredWikiString(page.content, 'content', 'manual wiki commit page');
    if (content.length > MAX_WIKI_PAGE_CONTENT_CHARS) {
      throw new Error(
        `manual wiki commit page content must not exceed ${MAX_WIKI_PAGE_CONTENT_CHARS} characters`
      );
    }
    return {
      path: normalizeWikiPagePath(page.path, 'manual wiki commit page path'),
      title: requiredWikiString(page.title, 'title', 'manual wiki commit page'),
      type: normalizeWikiPageType(page.type, 'manual wiki commit page'),
      content,
      confidence: normalizeWikiConfidence(page.confidence, 'manual wiki commit page'),
    };
  } catch (error) {
    rejectWikiPageError(error);
  }
}

function normalizeEventPages(eventPages: readonly ConnectorIngressManualWikiEventPages[]): {
  eventIndexIds: string[];
  pagesByEventIndexId: Map<string, readonly WikiPublishPageInput[]>;
} {
  if (!Array.isArray(eventPages) || eventPages.length === 0) {
    throw requestError('event_pages must not be empty');
  }
  if (eventPages.length > MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS) {
    throw requestError(
      `event_pages must contain at most ${MAX_REVIEWED_CONNECTOR_INGRESS_EVENTS} items`
    );
  }
  const eventIndexIds: string[] = [];
  const pagesByEventIndexId = new Map<string, readonly WikiPublishPageInput[]>();
  const eventIndexIdByPagePath = new Map<string, string>();
  let totalPages = 0;
  for (const eventPage of eventPages) {
    const eventIndexId = requiredString(eventPage.eventIndexId, 'event_pages[].event_index_id');
    if (pagesByEventIndexId.has(eventIndexId)) {
      throw requestError('event_pages must not contain duplicate event_index_id values');
    }
    if (!Array.isArray(eventPage.pages) || eventPage.pages.length === 0) {
      throw requestError('event_pages[].pages must not be empty');
    }
    if (eventPage.pages.length > MAX_WIKI_PUBLISH_PAGES) {
      throw requestError(
        `event_pages[].pages must contain at most ${MAX_WIKI_PUBLISH_PAGES} pages`
      );
    }
    totalPages += eventPage.pages.length;
    if (totalPages > MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES) {
      throw requestError(
        `event_pages must contain at most ${MAX_MANUAL_WIKI_COMMIT_TOTAL_PAGES} total pages`
      );
    }
    const pages = eventPage.pages.map((page: WikiPublishPageInput) =>
      normalizeManualWikiPage(page)
    );
    for (const page of pages) {
      const existingEventIndexId = eventIndexIdByPagePath.get(page.path);
      if (existingEventIndexId && existingEventIndexId !== eventIndexId) {
        throw requestError(`duplicate wiki page path across events: ${page.path}`);
      }
      eventIndexIdByPagePath.set(page.path, eventIndexId);
    }
    eventIndexIds.push(eventIndexId);
    pagesByEventIndexId.set(eventIndexId, pages);
  }
  return { eventIndexIds, pagesByEventIndexId };
}

function readReviewedEvents(input: {
  rawAdapter: ConnectorEventIngressAdapter;
  connector: string;
  channel: string;
  eventIndexIds: readonly string[];
}): PrimaryOperatorEvent[] {
  return readReviewedConnectorIngressEvents({
    rawAdapter: input.rawAdapter,
    connector: input.connector,
    channel: input.channel,
    eventIndexIds: input.eventIndexIds,
    requestError,
  });
}

function buildChangedRefs(pages: readonly WikiPublishPageInput[]): SourceRef[] {
  const paths = new Set<string>();
  for (const page of pages) {
    paths.add(normalizeWikiPagePath(page.path, 'wiki manual commit page path'));
  }
  return [...paths].map((path) => ({ kind: 'wiki_page', id: path }) satisfies SourceRef);
}

function pagesForEvent(
  pagesByEventIndexId: Map<string, readonly WikiPublishPageInput[]>,
  event: PrimaryOperatorEvent
): readonly WikiPublishPageInput[] {
  const pages = pagesByEventIndexId.get(event.sourceRef.id);
  if (!pages || pages.length === 0) {
    throw requestError('Reviewed event is missing wiki pages');
  }
  return pages;
}

function assertNoExistingNonChangedCommits(input: {
  operatorDb: SQLiteDatabase;
  cursorName: string;
  connector: string;
  events: readonly PrimaryOperatorEvent[];
}): void {
  const lookupExistingCommit = input.operatorDb.prepare(
    `SELECT status
     FROM vnext_operator_commits
     WHERE cursor_name = ?
       AND idempotency_key IN (?, ?)`
  );
  for (const event of input.events) {
    const cursorScopedKey = buildCursorScopedIdempotencyKey(input.cursorName, event.seq, event.seq);
    const legacyKey = buildConnectorIdempotencyKey(input.connector, event.seq, event.seq);
    const rows = lookupExistingCommit.all(
      input.cursorName,
      cursorScopedKey,
      legacyKey
    ) as ExistingOperatorCommitStatusRow[];
    if (rows.some((row) => row.status !== 'changed')) {
      throw requestError('Manual wiki commit cannot replace a non-changed operator commit');
    }
  }
}

export async function commitConnectorIngressWikiBatch(
  input: ConnectorIngressManualWikiCommitInput
): Promise<ConnectorIngressManualWikiCommitResult> {
  const connector = requiredString(input.connector, 'connector');
  const channel = requiredString(input.channel, 'channel');
  const cursorName = buildConnectorOperatorCursorName({ connector, channel });
  if (!isVNextWikiPublishAdapter(input.wikiPublishAdapter)) {
    throw requestError('Manual wiki commit requires a vNext wiki publish adapter');
  }
  const { eventIndexIds, pagesByEventIndexId } = normalizeEventPages(input.eventPages);

  const runtime = new PrimaryOperatorRuntime({
    db: input.operatorDb,
    cursorName,
    connector,
    nowMs: input.nowMs,
    allowSeqGaps: true,
  });
  let events: PrimaryOperatorEvent[] = [];
  const batch = await runtime.processBatchWithChangedCommitAfterValidation(
    () => {
      events = readReviewedEvents({
        rawAdapter: input.rawAdapter,
        connector,
        channel,
        eventIndexIds,
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
      assertNoExistingNonChangedCommits({
        operatorDb: input.operatorDb,
        cursorName,
        connector,
        events,
      });
      return events;
    },
    () => ({ status: 'changed' }),
    ({ event, sourceRefs }) => {
      const pages = pagesForEvent(pagesByEventIndexId, event);
      const changedRefs = buildChangedRefs(pages);
      const publishResult = input.wikiPublishAdapter.publish({
        pages: pages.map((page) => ({
          ...page,
          sourceRefs: [...sourceRefs],
        })),
      });
      if (publishResult.artifactsStored !== changedRefs.length) {
        throw new Error('Manual wiki commit did not store every changed wiki artifact');
      }
      return changedRefs;
    }
  );
  const firstSeq = events[0]?.seq ?? null;
  const lastSeq = events[events.length - 1]?.seq ?? null;
  const commits = batch.commits.map((commit) => ({
    seq: commit.lastChangeSeq,
    status: 'changed' as const,
    outcome: commit.outcome,
    cursorAdvanced: commit.cursorAdvanced,
  }));
  const pagesStored = batch.commits.reduce((total, commit) => {
    if (commit.status !== 'changed' || commit.outcome === 'already_committed') {
      return total;
    }
    const event = events.find((candidate) => candidate.seq === commit.lastChangeSeq);
    return total + (event ? buildChangedRefs(pagesForEvent(pagesByEventIndexId, event)).length : 0);
  }, 0);
  if (batch.status === 'partial_failure') {
    return {
      ok: false,
      mode: 'manual_wiki_commit',
      status: batch.status,
      cursorName,
      connector,
      channel,
      requestedCount: input.eventPages.length,
      processed: batch.processed,
      advancedThroughSeq: batch.advancedThroughSeq,
      firstSeq,
      lastSeq,
      pagesStored,
      commits,
      failedSeq: batch.failedSeq,
      error: PARTIAL_FAILURE_MESSAGE,
    };
  }
  return {
    ok: true,
    mode: 'manual_wiki_commit',
    status: batch.status,
    cursorName,
    connector,
    channel,
    requestedCount: input.eventPages.length,
    processed: batch.processed,
    advancedThroughSeq: batch.advancedThroughSeq,
    firstSeq,
    lastSeq,
    pagesStored,
    commits,
  };
}

export function createConnectorIngressManualWikiCommitProvider(
  options: Omit<ConnectorIngressManualWikiCommitInput, 'expectedAdvancedThroughSeq' | 'eventPages'>
): ConnectorIngressManualWikiCommitProvider {
  const connector = requiredString(options.connector, 'connector');
  const channel = requiredString(options.channel, 'channel');
  return async (input) => {
    const requestedConnector = requiredString(input.connector, 'connector');
    const requestedChannel = requiredString(input.channel, 'channel');
    if (requestedConnector !== connector || requestedChannel !== channel) {
      throw requestError(
        `Connector ingress manual wiki commit is locked to the configured connector/channel: ${connector}/${channel}`
      );
    }
    return commitConnectorIngressWikiBatch({
      rawAdapter: options.rawAdapter,
      operatorDb: options.operatorDb,
      wikiPublishAdapter: options.wikiPublishAdapter,
      connector,
      channel,
      expectedAdvancedThroughSeq: input.expectedAdvancedThroughSeq,
      eventPages: input.eventPages,
      nowMs: options.nowMs,
    });
  };
}

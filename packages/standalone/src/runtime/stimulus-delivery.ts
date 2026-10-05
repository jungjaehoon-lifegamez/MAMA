import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '@jungjaehoon/mama-core/canonicalize';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { ContentBlock } from '@jungjaehoon/mama-core/runtime/drivers/types';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type {
  RuntimeHandle,
  StimulusDelivery,
  StimulusReceipt,
} from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { NativeTurnResultRecord } from '@jungjaehoon/mama-core/runtime/native-input-journal';
import type { SourceDelta } from '../connectors/framework/polling-scheduler.js';
import type { QueueCandidateScore, QueueLine, WindowQueue } from '../replay/window-queue.js';
import { SUBAGENT_RUNTIME_RULES, type OwnerRuntimeBackend } from './owner-system-prompt.js';
import {
  RECORD_ORDER_CHANNEL,
  REPORT_CHANNEL,
  deltaLines,
  deltaNotifyOrder,
  deltaRecordOrder,
  liveDeltaLines,
  ownerMessageOrder,
  parseRecordOrder,
  recordOrderLines,
  scheduledReportOrder,
  sessionStartBlock,
  type Lesson,
  type OwnerRuleLine,
  type SessionStartInput,
} from './turn-orders.js';
import { localDateKey, localStamp, type TimeZoneSetting } from './timezone.js';
import { messageWithCauses } from '../utils/error-message.js';

export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

export interface OwnerMessageInput {
  id: string;
  channelKey: string;
  occurredAt: number;
  text: string;
  replyTo?: string | null;
  payload?: JsonValue;
}

export interface ScheduledInput {
  id: string;
  channelKey: string;
  occurredAt: number;
  payload?: JsonValue;
}

export interface StimulusIntake {
  accept(stimulus: Stimulus): StimulusReceipt;
  isPending?(sourceMessageRef: string): boolean;
  acceptOwnerMessage(input: OwnerMessageInput): StimulusReceipt;
  acceptSourceDelta(delta: SourceDelta): StimulusReceipt;
  acceptScheduled(input: ScheduledInput): StimulusReceipt;
}

/** A lesson the host may attach to a turn; the id keeps it from repeating within a session day. */
export interface TurnLesson extends Lesson {
  id: string;
}

/** The record order a live delta's notify turn leaves behind (W23). */
export interface RecordOrderPort {
  /**
   * Enqueue the first record order for a live delta, carrying the channel's unrecorded batches;
   * called before its reply is routed.
   */
  enqueueFirst(row: MailboxRow): void;
  /** Check a finished record order; a batch still unrecorded waits for its channel's next order. */
  onResult(row: MailboxRow, modelRunId: string | null): void | Promise<void>;
  /** A record row that went uncertain or dead: the same check, run at once. */
  onLost(row: MailboxRow, reason: string): void | Promise<void>;
  /**
   * A live delta whose notify turn was interrupted: its batch counts as recorded, gets its first
   * record order, or is reported lost when it is too old to record without bringing back stale
   * facts.
   */
  onDeltaLost(row: MailboxRow): 'recorded' | 'ordered' | 'lost';
}

export interface StimulusDeliveryOptions {
  backend: OwnerRuntimeBackend;
  wikiEnabled?: boolean;
  formattingRoutes?: { reports: string; notifications: string };
  timeZone: TimeZoneSetting;
  /** Top lessons for a turn's text, most relevant first. */
  lessons?: (text: string) => Promise<readonly TurnLesson[]>;
  /** The owner's active rules, indexed on every record order. */
  ownerRules?: () => Promise<readonly OwnerRuleLine[]>;
  recordOrders?: RecordOrderPort;
  readResult?: (row: MailboxRow) => NativeTurnResultRecord | null;
  onUncertain?: StimulusDelivery['onUncertain'];
  onDead?: StimulusDelivery['onDead'];
  /** What a new session is told before its first order (`[session_start]`). */
  sessionStart?: (row: MailboxRow) => SessionStartInput | Promise<SessionStartInput>;
  onOwnerResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onSourceResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  /** Scheduled report results only; record orders never reach the owner. */
  onScheduledResult?: (row: MailboxRow, result: NativeTurnResult) => void | Promise<void>;
  onDelivered?: (row: MailboxRow, modelRunId: string | null) => void | Promise<void>;
  onFailed?: (row: MailboxRow, reason: string, modelRunId: string | null) => void | Promise<void>;
  /** A live delta acked without a turn because every line was history when it was accepted. */
  onSkipped?: (row: MailboxRow, reason: string) => void | Promise<void>;
  /**
   * Live only. A row parked uncertain is never rerun; it closes once what it still owes has a
   * place: the owner was told, the record check took the batch, or the next report tick will.
   */
  closeUncertain?: {
    /** The owner's messenger delivered an answer to this message, the interruption notice included. */
    ownerAnswered(row: MailboxRow): boolean;
    onClosed(row: MailboxRow, followUp: string): void | Promise<void>;
  };
}

export interface ReplayClockDelivery extends StimulusDelivery {
  getReplaySourceEndMs(): number | undefined;
}

function sourceObservationHandle(ref: SourceDelta['refs'][number]): string {
  if (typeof ref.observationRef !== 'string' || ref.observationRef.trim() === '') {
    throw new Error(`Source delta ref ${ref.connector}:${ref.sourceId} has no observationRef`);
  }
  return ref.observationRef;
}

function sourceRefId(ref: SourceDelta['refs'][number]): string {
  return `${ref.connector}:${sourceObservationHandle(ref)}`;
}

function sourceOccurrenceTime(delta: SourceDelta): number {
  const sourceTimes = delta.refs.map((ref) => Date.parse(ref.sourceAt));
  if (sourceTimes.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('A source delta requires timezone-qualified source times');
  }
  if (sourceTimes.length === 0) {
    if (delta.replay === undefined)
      throw new Error('A source delta requires at least one source time');
    const emptyWindowTime = delta.occurredAt ?? delta.replay.windowStartMs;
    if (!Number.isSafeInteger(emptyWindowTime) || emptyWindowTime < 0) {
      throw new Error('An empty replay window requires a valid occurrence time');
    }
    return emptyWindowTime;
  }
  const occurredAt = delta.occurredAt ?? Math.max(...sourceTimes);
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new Error('A source delta occurrence time must be a nonnegative epoch millisecond');
  }
  return occurredAt;
}

export function sourceDeltaStimulusId(delta: SourceDelta): string {
  if (delta.refs.length === 0 && delta.replay === undefined) {
    throw new Error('A source delta requires at least one observation ref');
  }
  const refs = delta.refs.map((ref) => sourceRefId(ref)).sort();
  const digest = createHash('sha256')
    .update(canonicalizeJSON({ coalesceKey: delta.coalesceKey, refs }))
    .digest('hex');
  return `source_delta:${digest}`;
}

function sourcePayload(delta: SourceDelta): JsonValue {
  return {
    kind: delta.kind,
    collector: delta.collector,
    channel: delta.channel,
    coalesceKey: delta.coalesceKey,
    refs: delta.refs.map((ref) => ({
      connector: ref.connector,
      ...(ref.channel === undefined ? {} : { channel: ref.channel }),
      observationRef: sourceObservationHandle(ref),
      sourceId: ref.sourceId,
      sourceEntityId: ref.sourceEntityId,
      sourceAt: ref.sourceAt,
      observedAt: ref.observedAt,
      contentHash: ref.contentHash,
      ...(ref.author === undefined ? {} : { author: ref.author }),
      ...(ref.channelName === undefined ? {} : { channelName: ref.channelName }),
      ...(ref.contentPreview === undefined ? {} : { contentPreview: ref.contentPreview }),
      ...(ref.metadata === undefined ? {} : { metadata: ref.metadata }),
    })),
    preview: [...delta.preview],
    ...(delta.replay === undefined ? {} : { replay: delta.replay }),
  } as unknown as JsonValue;
}

export function createStimulusIntake(
  runtime: Pick<RuntimeHandle, 'accept' | 'mailbox'>,
  principalId: string
): StimulusIntake {
  const ownerPayload = (input: OwnerMessageInput): JsonValue =>
    input.payload === undefined ? { text: input.text } : { text: input.text, input: input.payload };
  return {
    accept: (stimulus) => runtime.accept({ ...stimulus, principalId }),
    isPending: (sourceMessageRef) => {
      const row = runtime.mailbox?.readInput(sourceMessageRef, principalId);
      // A failed accepted turn will never run again. Keep a recorded answer pending only
      // until reconciliation delivers it, so recovery cannot replace it with an interruption.
      if (row?.nativeDelivery?.state === 'uncertain') {
        const receipt = row.nativeDelivery.receipt;
        return Boolean(
          receipt && runtime.mailbox!.nativeInputs.resultForReceipt(receipt, principalId)
        );
      }
      return row?.status === 'pending';
    },
    acceptOwnerMessage: (input) =>
      runtime.accept({
        id: input.id,
        kind: 'owner_message',
        principalId,
        channelKey: input.channelKey,
        occurredAt: input.occurredAt,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        payload: ownerPayload(input),
      }),
    acceptSourceDelta: (delta) =>
      runtime.accept({
        id: sourceDeltaStimulusId(delta),
        kind: 'source_delta',
        principalId,
        channelKey: delta.channel,
        refs: delta.refs.map((ref) => ({
          refId: sourceRefId(ref),
          observationRef: sourceObservationHandle(ref),
        })),
        preview: [...delta.preview],
        coalesceKey: delta.coalesceKey,
        occurredAt: sourceOccurrenceTime(delta),
        payload: sourcePayload(delta),
      }),
    acceptScheduled: (input) =>
      runtime.accept({
        id: input.id,
        kind: 'scheduled',
        principalId,
        channelKey: input.channelKey,
        occurredAt: input.occurredAt,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      }),
  };
}

function payloadCarriesMessageText(payload: MailboxRow['payload']): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const refs = payload.refs;
  return (
    Array.isArray(refs) &&
    refs.some(
      (ref) =>
        ref !== null && typeof ref === 'object' && !Array.isArray(ref) && 'contentPreview' in ref
    )
  );
}

function textField(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A source delta whose refs carry message text is rendered as one line per message.
 * The session keeps every turn, so ids, hashes and connector metadata would be re-read on
 * each later model call; the stored observation stays one source.read away.
 */
function messageLines(payload: JsonValue | undefined, timeZone: TimeZoneSetting): string[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const refs = payload.refs;
  if (!Array.isArray(refs) || !payloadCarriesMessageText(payload)) return null;
  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const author = textField(ref.author) || 'unknown';
    const text = textField(ref.contentPreview).replace(/\s+/g, ' ').trim();
    const channelName = textField(ref.channelName);
    const channel = channelName
      ? `${textField(ref.connector)}:${channelName}`
      : textField(ref.channel) || textField(ref.connector);
    lines.push(
      `[${localStamp(textField(ref.sourceAt), timeZone.get())}] ${channel} · ${author} · ${textField(ref.observationRef)}: ${text}`
    );
  }
  return lines;
}

function ledgerLines(replay: JsonValue | undefined): string[] {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return [];
  const digest = replay.ledgerDigest;
  if (!Array.isArray(digest)) return [];
  return digest.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? [
          [
            textField(item.commitmentId),
            typeof item.revision === 'number' ? `r${String(item.revision)}` : '-',
            textField(item.title),
            textField(item.stage) || '-',
            textField(item.status) || '-',
            textField(item.assignee) || '-',
            textField(item.lastEventTime) || '-',
          ].join(' | '),
        ]
      : []
  );
}

function queueCandidate(score: QueueCandidateScore): string {
  return `${score.candidate.title} ${score.confidence.toFixed(2)}`;
}

function queueLine(line: QueueLine): string {
  return `[${line.localTime}] ${line.channelName} · ${line.author ?? '-'} · ${line.observationRef}: ${line.text}`;
}

function queueLines(lines: readonly QueueLine[]): string[] {
  return lines.map(queueLine);
}

/** Render the Jev material without shortening or hiding any source line. */
export function renderWindowQueue(queue: WindowQueue): string {
  const lines: string[] = [];
  lines.push('## A. Matched work');
  for (const [index, group] of queue.sections.a.entries()) {
    lines.push(
      `### A${index + 1}. ${group.candidate.candidate.title} · ${group.candidate.confidence.toFixed(2)} · relevance ${group.relevance.toFixed(2)}`,
      ...queueLines(group.lines)
    );
  }
  lines.push('## B. Ambiguous candidates');
  for (const [index, entry] of queue.sections.b.entries()) {
    lines.push(
      `### B${index + 1}. relevance ${entry.relevance.toFixed(2)} · top-2 ${entry.candidates.map(queueCandidate).join(' | ')}`,
      ...queueLines(entry.lines)
    );
  }
  lines.push('## C. Possible new work');
  for (const [index, entry] of queue.sections.c.entries()) {
    lines.push(
      `### C${index + 1}. relevance ${entry.relevance.toFixed(2)}${entry.candidates.length === 0 ? '' : ` · nearest ${entry.candidates.map(queueCandidate).join(' | ')}`}`,
      ...queueLines(entry.lines)
    );
  }
  lines.push('## Suspected duplicates');
  for (const [index, pair] of queue.sections.suspectedDuplicates.entries()) {
    lines.push(
      `${index + 1}. ${pair.left.commitmentId} "${pair.left.title ?? ''}" ⇔ ${pair.right.commitmentId} "${pair.right.title ?? ''}" · ${pair.confidence.toFixed(2)}`
    );
  }
  lines.push('## Unresolved');
  for (const [index, entry] of queue.sections.unresolved.entries()) {
    lines.push(
      `### U${index + 1}. relevance ${entry.relevance.toFixed(2)} · ${entry.reason}`,
      ...queueLines(entry.lines)
    );
  }
  return wrapUntrustedContent('source_delta', lines.join('\n'));
}

/**
 * Instructions a replay window needs and live turns do not: the window's orchestration and its
 * recording rules, moved here from the standing prompt.
 */
function replayInstructions(backend: OwnerRuntimeBackend, wikiEnabled: boolean): string[] {
  return [
    'replay_instructions:',
    `- You are the orchestrator of this window and must know what happened. Note the time your turn starts. Plan from sections A, B, C, suspected duplicates and unresolved; decide new work (C) yourself and give it an owner; give each native subagent a disjoint set of work items (with their full source lines, history and current revisions) and the topic pages it owns, and wait for every receipt (each commitmentId with revision before and after, created commitmentIds, topic pages updated, anything it could not do). Then read back with work.list view=items changedSince=<your turn start>, compare it with the receipts, and settle gaps, conflicts and duplicates yourself. Only then write the journal's judgment section, the board, Home.md and lessons. The window's current_work already lists every item with its current revision; do not list the whole ledger again. Each subagent adds one entry per moved item to daily/YYYY-MM/YYYY-MM-DD.md, grouped by project, which you create before dispatching.`,
    `- ${SUBAGENT_RUNTIME_RULES[backend].replace('only when an order asks for one', 'for this window')} When a subagent finishes you verify and integrate its result and do not spawn another for the same objective.`,
    `- For a moved item, revise or create the work item (work.revise, work.create) with a summary of what changed and why, derived_from links to its observations, and the assignee and roles the evidence points to. Record "unconfirmed" only when no observation points to anyone. Set eventDatetime to the source event time, not replay time. When current_work supplies a revision, pass it as expectedRevision; for another write in the same window use the revision the previous write returned.`,
    wikiEnabled
      ? `- With end_of_window_instructions, finish the day's work changes before updating each affected board section with report.publish and topic wiki page with manage.wiki.update.`
      : `- With end_of_window_instructions, finish the day's work changes before updating each affected board section with report.publish.`,
    '- A replay window is history and is not delivered to the owner: it ends without a marker.',
  ];
}

/** The replay window text: the window material and its instructions. */
function replayWindowText(
  row: MailboxRow,
  options: Pick<StimulusDeliveryOptions, 'backend' | 'wikiEnabled' | 'timeZone'>
): string {
  const lines = [
    '## Replay window',
    `owner timezone: ${options.timeZone.get()}`,
    `stimulus_id: ${row.stimulusId}`,
    `channel: ${row.channelKey}`,
    `occurred_at: ${new Date(row.occurredAt).toISOString()}`,
    'delivery: replay window, not delivered to the owner',
    ...replayInstructions(options.backend, options.wikiEnabled ?? false),
  ];
  const messages = messageLines(row.payload, options.timeZone);
  if (messages === null) lines.push(`refs: ${JSON.stringify(row.refs)}`);
  lines.push(
    row.refs.length === 0
      ? 'source_read: this replay window has no source messages.'
      : messages !== null
        ? 'source_read: each message line below carries its full text; use the source read action with observationRefs only for a raw record or attachment you need, batched per connector (the first segment of the channel) with source set to that connector.'
        : 'source_read: read these refs with the source read action, in one batched call with observationRefs; content remains bounded per ref.'
  );
  const payload = row.payload;
  const replay =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.replay : undefined;
  if (replay && typeof replay === 'object' && !Array.isArray(replay)) {
    const instructions = replay.endInstructions;
    if (typeof instructions === 'string' && instructions.trim() !== '') {
      lines.push(`window_end_instructions: ${instructions}`);
    }
    if (replay.queue !== undefined) {
      lines.push('window_queue:', renderWindowQueue(replay.queue as unknown as WindowQueue));
      if (messages !== null) {
        const work = ledgerLines(replay);
        lines.push(
          `current_work (commitmentId | revision | title | stage | status | assignee | lastEventTime), ${String(work.length)} items:`,
          ...work
        );
      }
      return lines.join('\n');
    }
  }
  if (messages !== null) {
    const work = ledgerLines(replay);
    lines.push(
      `current_work (commitmentId | revision | title | stage | status | assignee | lastEventTime), ${String(work.length)} items:`,
      ...work,
      `messages (${options.timeZone.get()}, channel · sender · observationRef: text), ${String(messages.length)} lines:`,
      ...messages.map((message) => wrapUntrustedContent('source_delta', message))
    );
    return lines.join('\n');
  }
  if (row.payload !== undefined)
    lines.push(`payload: ${wrapUntrustedContent('source_delta', JSON.stringify(row.payload))}`);
  return lines.join('\n');
}

/** One bounded log line; preserve the original thrown error for runtime settlement. */
/**
 * The failure and what caused it: an uncertain native input wraps the backend error (a request
 * timeout, for one), and the wrapper's message alone hid it from the log on 2026-09-29.
 */
export function stimulusFailureReason(error: unknown): string {
  return messageWithCauses(error).slice(0, 500);
}

function replaySourceCeiling(row: MailboxRow): number | undefined {
  const payload = row.payload;
  if (
    row.kind !== 'source_delta' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.replay === undefined
  )
    return undefined;
  const replay = payload.replay;
  // Replay windows are half-open; malformed bounds must never permit unbounded source reads.
  if (
    !replay ||
    typeof replay !== 'object' ||
    Array.isArray(replay) ||
    !Number.isSafeInteger(replay.windowEndMs) ||
    Number(replay.windowEndMs) <= 0
  ) {
    throw new Error('Replay windowEndMs must provide a nonnegative inclusive source ceiling');
  }
  return Number(replay.windowEndMs) - 1;
}

export function isRecordOrderRow(row: Pick<MailboxRow, 'kind' | 'channelKey'>): boolean {
  return row.kind === 'scheduled' && row.channelKey === RECORD_ORDER_CHANNEL;
}

function ownerText(row: MailboxRow): string {
  const payload = row.payload;
  return payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof payload.text === 'string'
    ? payload.text
    : '';
}

type TurnPlan =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'turn';
      lessonQuery: string | null;
      /** Record orders carry the owner's rules as an index. */
      ownerRuleIndex?: true;
      render: (
        lessons: readonly Lesson[],
        now: Date,
        ownerRules: readonly OwnerRuleLine[]
      ) => string;
    };

/** What a row's turn says, by kind; a live delta with only history lines has no turn. */
function planTurn(row: MailboxRow, options: StimulusDeliveryOptions): TurnPlan {
  const zone = options.timeZone.get();
  if (row.kind === 'owner_message') {
    return {
      kind: 'turn',
      lessonQuery: ownerText(row),
      render: (lessons) =>
        ownerMessageOrder(
          {
            messenger: row.stimulusId.split(':', 1)[0]!,
            occurredAt: row.occurredAt,
            payload: row.payload,
          },
          lessons,
          { timeZone: zone }
        ),
    };
  }
  if (row.kind === 'source_delta') {
    if (replaySourceCeiling(row) !== undefined)
      return { kind: 'turn', lessonQuery: null, render: () => replayWindowText(row, options) };
    // Kagemusha filters at collection: the reference is when the row was accepted, so a delta
    // that waited behind a backlog is still delivered.
    const all = deltaLines(row.payload);
    const lines = liveDeltaLines(all, row.createdAt);
    if (lines.length === 0)
      return {
        kind: 'skip',
        reason: `all ${all.length} lines were older than the six-hour backfill guard when accepted`,
      };
    return {
      kind: 'turn',
      lessonQuery: lines.map((line) => line.text).join(' '),
      render: (lessons, now) =>
        deltaNotifyOrder(lines, row.channelKey, now, lessons, { timeZone: zone }),
    };
  }
  if (row.kind === 'scheduled') {
    if (row.channelKey === RECORD_ORDER_CHANNEL) {
      const record = parseRecordOrder(row.payload);
      return {
        kind: 'turn',
        // The notify turn's recall on the lines the record turn writes from: when W23 split
        // Kagemusha's one delta turn in two, the lessons stayed with the notify turn only.
        lessonQuery: recordOrderLines(record)
          .map((line) => line.text)
          .join(' '),
        ownerRuleIndex: true,
        render: (lessons, now, ownerRules) =>
          deltaRecordOrder(
            record,
            now,
            {
              backend: options.backend,
              timeZone: zone,
              wikiEnabled: options.wikiEnabled ?? false,
            },
            { lessons, ownerRules }
          ),
      };
    }
    if (row.channelKey === REPORT_CHANNEL)
      return {
        kind: 'turn',
        lessonQuery: null,
        render: () =>
          scheduledReportOrder(row.payload, new Date(row.occurredAt), {
            backend: options.backend,
            timeZone: zone,
            messenger: options.formattingRoutes?.reports ?? 'telegram',
          }),
      };
    throw new Error(`Scheduled input on unknown channel ${row.channelKey}`);
  }
  throw new Error(`No owner turn is assembled for stimulus kind ${row.kind ?? 'unknown'}`);
}

/** Deliver every model-bearing kind through one serialized owner session. */
export function createStimulusDelivery(options: StimulusDeliveryOptions): ReplayClockDelivery {
  let serialTail = Promise.resolve();
  let activeReplaySourceEndMs: number | undefined;
  // Lessons shown in this session, cleared on a new session or a new local day: compactions are
  // not observable, so a day bounds how long a lesson stays out of view.
  let shownLessons = new Set<string>();
  let shownDay = '';

  const pickLessons = async (query: string | null, newSession: boolean): Promise<Lesson[]> => {
    const day = localDateKey(Date.now(), options.timeZone.get());
    if (newSession || day !== shownDay) {
      shownLessons = new Set();
      shownDay = day;
    }
    if (query === null || query.trim() === '' || !options.lessons) return [];
    const fresh = (await options.lessons(query))
      .filter((lesson) => !shownLessons.has(lesson.id))
      .slice(0, 3);
    for (const lesson of fresh) shownLessons.add(lesson.id);
    return fresh;
  };

  const deliverResult = async (
    row: MailboxRow,
    result: NativeTurnResult,
    modelRunId = result.modelRunId
  ): Promise<void> => {
    if (row.kind === 'owner_message') await options.onOwnerResult?.(row, result);
    if (row.kind === 'source_delta' && replaySourceCeiling(row) === undefined) {
      // The record order is durable before the notify reply goes anywhere.
      options.recordOrders?.enqueueFirst(row);
      await options.onSourceResult?.(row, result);
    }
    if (row.kind === 'scheduled') {
      if (isRecordOrderRow(row)) await options.recordOrders?.onResult(row, modelRunId ?? null);
      else await options.onScheduledResult?.(row, result);
    }
    await options.onDelivered?.(row, modelRunId ?? null);
  };

  const deliver: StimulusDelivery['deliver'] = async (row, context) => {
    let release!: () => void;
    const previous = serialTail;
    serialTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let modelRunId: string | null = null;
    try {
      const replaySourceEndMs = replaySourceCeiling(row);
      activeReplaySourceEndMs = replaySourceEndMs;
      const plan = planTurn(row, options);
      if (plan.kind === 'skip') {
        // Kagemusha's backfill guard: only history lines, so no live turn and no record order.
        await options.onSkipped?.(row, plan.reason);
        await options.onDelivered?.(row, null);
        return;
      }
      const text = (blocks: readonly string[]): ContentBlock[] => [
        { type: 'text', text: blocks.filter((block) => block !== '').join('\n\n') },
      ];
      const result = await context.run(text([plan.render([], new Date(), [])]), {
        onModelRunStarted: (id: string) => {
          modelRunId = id;
        },
        prepareSessionContent: async ({ isNewSession }) => {
          const lessons = await pickLessons(plan.lessonQuery, isNewSession);
          const ownerRules =
            plan.ownerRuleIndex && options.ownerRules ? await options.ownerRules() : [];
          const start = isNewSession
            ? sessionStartBlock(
                (await options.sessionStart?.(row)) ?? { exchanges: [], decisions: [] },
                new Date(),
                { timeZone: options.timeZone.get() }
              )
            : '';
          return text([start, plan.render(lessons, new Date(), ownerRules)]);
        },
        sessionKey: OWNER_RUNTIME_SESSION_KEY,
        source: row.kind,
        channelId: row.channelKey,
        sourceMessageRef: row.stimulusId,
        ...(replaySourceEndMs === undefined ? {} : { replaySourceEndMs }),
      });
      // A commit failure withholds result provenance, but the opened run still identifies this turn.
      modelRunId = result.modelRunId ?? modelRunId;
      await deliverResult(row, result, modelRunId);
    } catch (error) {
      await options.onFailed?.(row, stimulusFailureReason(error), modelRunId);
      throw error;
    } finally {
      activeReplaySourceEndMs = undefined;
      release();
    }
  };

  const lost = async (row: MailboxRow, reason: string): Promise<void> => {
    if (isRecordOrderRow(row)) await options.recordOrders?.onLost(row, reason);
  };

  /** Where an uncertain row's remaining duty went, or null while it has nowhere to go yet. */
  const followUp = async (
    row: MailboxRow,
    close: NonNullable<StimulusDeliveryOptions['closeUncertain']>
  ): Promise<string | null> => {
    if (row.kind === 'owner_message')
      return close.ownerAnswered(row) ? 'the owner was told it was interrupted' : null;
    if (row.kind === 'source_delta') {
      if (!options.recordOrders) return null;
      return `record check: ${options.recordOrders.onDeltaLost(row)}`;
    }
    if (isRecordOrderRow(row)) {
      if (!options.recordOrders) return null;
      await options.recordOrders.onLost(row, 'record order parked uncertain');
      return 'record check';
    }
    if (row.kind === 'scheduled') return 'the next report tick';
    // Other kinds (native_event) have no producer left and owe nothing further.
    return 'nothing further';
  };

  return {
    deliver,
    prefer: ['owner_message'],
    onUncertain: async (row, reason) => {
      await lost(row, reason);
      await options.onUncertain?.(row, reason);
    },
    onDead: async (row, reason) => {
      await lost(row, reason);
      await options.onDead?.(row, reason);
    },
    reconcile: async (row) => {
      const result = options.readResult?.(row);
      if (result) {
        await deliverResult(row, { ...result, history: [] });
        return 'settled';
      }
      // Core invokes reconciliation only when no delivery in this process owns
      // the input. Never rerun an orphan dispatched to a model without its final result.
      if (row.nativeDelivery?.state === 'dispatching' || row.nativeDelivery?.state === 'accepted') {
        const reason = isRecordOrderRow(row)
          ? 'Record order interrupted before completion; the ledger check decides the next attempt'
          : row.kind === 'scheduled'
            ? 'Scheduled report interrupted before completion; retry on the next report tick'
            : `${row.kind} interrupted before completion; no stored result`;
        await options.onFailed?.(row, reason, null);
        // Core parks the orphan uncertain, preserving its receipt and any result.
        throw new Error(reason);
      }
      // A row already parked uncertain was reported when it was parked. Throwing again would
      // report it again at every start, since core remembers reports only per process. A replay
      // row stays parked: an uncertain row stops replay until its receipts are reconciled.
      if (!options.closeUncertain || replaySourceCeiling(row) !== undefined) return 'unresolved';
      const destination = await followUp(row, options.closeUncertain);
      if (destination === null) return 'unresolved';
      await options.closeUncertain.onClosed(row, destination);
      return 'settled';
    },
    getReplaySourceEndMs: () => activeReplaySourceEndMs,
  };
}

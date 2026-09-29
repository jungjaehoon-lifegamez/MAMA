import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { OwnerRuntimeBackend } from './owner-system-prompt.js';
import { epochAtLocalDateTime, localStamp } from './timezone.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import type { OwnerExchange } from './recent-owner-exchanges.js';

/**
 * The work order each turn kind receives, in one place, as Kagemusha's host issues one per step
 * (`formatDelta`, `buildTaskboardReconcilePrompt`, `buildFullReportPrompt`, the reminder and the
 * session start). Procedures that hold for every turn live in the standing prompt; an order carries
 * the turn's data, its local time and the steps only that turn needs.
 */

export const SESSION_START_LIMIT = 2_500;
export const LESSONS_LIMIT = 1_200;
export const DELTA_LINE_LIMIT = 500;
/** Kagemusha's backfill guard: a source line this old is history, not a live change. */
export const DELTA_HISTORY_CUTOFF_MS = 6 * 60 * 60 * 1000;
export const RECORD_ORDER_CHANNEL = 'operator:record';
export const REPORT_CHANNEL = 'schedule';

export interface TurnOrderOptions {
  backend: OwnerRuntimeBackend;
  timeZone: string;
}

export interface Lesson {
  topic: string;
  summary: string;
  appliesWhen?: string;
}

function currentTime(now: Date, timeZone: string): string {
  return `Current time: ${now.toLocaleString('ko-KR', { timeZone })} (${timeZone})`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, limit: number): string {
  const flat = oneLine(value);
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Stored text never closes a host block, as Kagemusha escapes its lesson blocks. */
function escapeMarkup(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Kagemusha's lesson block: advisory, bounded, never a fact or a tool-call instruction. */
export function lessonsBlock(lessons: readonly Lesson[]): string {
  if (lessons.length === 0) return '';
  const open =
    '<lessons>\nLessons from earlier corrections, not facts; verify current state with tools.';
  const close = '</lessons>';
  const lines: string[] = [];
  let size = open.length + close.length + 2;
  for (const lesson of lessons) {
    const line = escapeMarkup(
      `- ${clip(lesson.topic, 80)}: ${clip(lesson.summary, 360)}${
        lesson.appliesWhen ? ` (applies when: ${clip(lesson.appliesWhen, 160)})` : ''
      }`
    );
    if (size + line.length + 1 > LESSONS_LIMIT) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length === 0 ? '' : [open, ...lines, close].join('\n');
}

/** Kagemusha's `[session_start]`: bounded recent exchanges and the time, nothing pushed wholesale. */
export function sessionStartBlock(
  exchanges: readonly OwnerExchange[],
  now: Date,
  options: Pick<TurnOrderOptions, 'backend' | 'timeZone'>
): string {
  const head = ['[session_start]', currentTime(now, options.timeZone)];
  const tail = `When a turn needs work or source state newer than these exchanges, read only that part with work.list or source.recent.`;
  const pairs = exchanges.map(
    (exchange) =>
      `Owner: ${JSON.stringify(clip(exchange.owner, 200))}\nAnswer: ${JSON.stringify(clip(exchange.answer, 300))}`
  );
  // Drop the oldest exchanges until the block fits.
  while (pairs.length > 0) {
    const text = [
      ...head,
      'Recent owner exchanges, oldest first:',
      ...pairs.map((pair) => pair.replace(/</g, '\\u003c')),
      tail,
    ].join('\n');
    if (text.length <= SESSION_START_LIMIT) return text;
    pairs.shift();
  }
  return [...head, tail].join('\n');
}

function payloadObject(payload: JsonValue | undefined): Record<string, JsonValue> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, JsonValue>)
    : null;
}

function textField(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The files an owner message carries, as paths the agent can read or the download error. */
export function attachmentLines(payload: JsonValue | undefined): string[] {
  const input = payloadObject(payload)?.input;
  const attachments = payloadObject(input)?.attachments;
  if (!Array.isArray(attachments)) return [];
  const lines: string[] = [];
  for (const attachment of attachments) {
    const entry = payloadObject(attachment);
    if (!entry) continue;
    const name = JSON.stringify(entry.name);
    lines.push(
      typeof entry.error === 'string'
        ? `attachment: name=${name} error=${JSON.stringify(entry.error)}`
        : `attachment: name=${name} path=${JSON.stringify(entry.path)}${
            typeof entry.size === 'number' ? ` size=${entry.size} bytes` : ''
          }`
    );
  }
  return lines;
}

export function ownerMessageOrder(
  input: { messenger: string; occurredAt: number; payload: JsonValue | undefined },
  lessons: readonly Lesson[],
  options: Pick<TurnOrderOptions, 'timeZone'>
): string {
  const text = textField(payloadObject(input.payload)?.text);
  return [
    `[owner_message] ${input.messenger} · ${localStamp(new Date(input.occurredAt).toISOString(), options.timeZone)} (${options.timeZone})`,
    lessonsBlock(lessons),
    text,
    ...attachmentLines(input.payload),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface DeltaLine {
  sourceAt: string;
  channel: string;
  author: string;
  text: string;
  observationRef: string;
}

/** The message lines a live delta carries, one per ref that has text. */
export function deltaLines(payload: JsonValue | undefined): DeltaLine[] {
  const refs = payloadObject(payload)?.refs;
  if (!Array.isArray(refs)) return [];
  const channelFallback = textField(payloadObject(payload)?.channel);
  return refs.flatMap((value) => {
    const ref = payloadObject(value);
    if (!ref) return [];
    const channelName = textField(ref.channelName);
    const connector = textField(ref.connector);
    return [
      {
        sourceAt: textField(ref.sourceAt),
        channel: channelName
          ? `${connector}:${channelName}`
          : textField(ref.channel) || channelFallback || connector,
        author: textField(ref.author) || 'unknown',
        text: oneLine(textField(ref.contentPreview)),
        observationRef: textField(ref.observationRef),
      },
    ];
  });
}

/** Kagemusha's backfill guard: lines older than the cutoff are not delivered as live changes. */
export function liveDeltaLines(lines: readonly DeltaLine[], nowMs: number): DeltaLine[] {
  return lines.filter((line) => {
    const at = Date.parse(line.sourceAt);
    return Number.isFinite(at) && nowMs - at <= DELTA_HISTORY_CUTOFF_MS;
  });
}

function deltaChannelLabel(lines: readonly DeltaLine[], fallback: string): string {
  const channels = [...new Set(lines.map((line) => line.channel).filter(Boolean))];
  return channels.length === 1 ? channels[0]! : fallback;
}

/** Kagemusha's notify turn: the messages inline, and only the decision whether to tell the owner. */
export function deltaNotifyOrder(
  lines: readonly DeltaLine[],
  channelKey: string,
  now: Date,
  lessons: readonly Lesson[],
  options: Pick<TurnOrderOptions, 'timeZone'>
): string {
  const rendered = lines.map(
    (line) =>
      `[${localStamp(line.sourceAt, options.timeZone)}] ${line.author}: ${clip(line.text, DELTA_LINE_LIMIT)}`
  );
  return [
    `[delta ${deltaChannelLabel(lines, channelKey)} ~${localStamp(now.toISOString(), options.timeZone)}] (${options.timeZone})`,
    lessonsBlock(lessons),
    wrapUntrustedContent('source_delta', rendered.join('\n')),
    'Decide whether the owner needs to hear this now under the owner policy. Reply with [notify] and the message the owner receives, or with [ack]. A record order follows; do not record work in this turn.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface RecordOrderLine {
  sourceAt: string;
  author: string;
  text: string;
}

export interface RecordOrderPayload {
  order: 'record';
  deltaStimulusId: string;
  channel: string;
  observationRefs: string[];
  /** The delta's last lines, as Kagemusha's record turn carries them (five, 300 chars each). */
  lines: RecordOrderLine[];
  attempt: number;
}

/** The record order's payload, built only from the delta so a replayed result enqueues the same row. */
export function recordOrderPayload(
  delta: { stimulusId: string; channelKey: string; payload?: JsonValue },
  attempt: number
): RecordOrderPayload {
  const lines = deltaLines(delta.payload);
  const observationRefs = [
    ...new Set(lines.map((line) => line.observationRef).filter(Boolean)),
  ].sort();
  return {
    order: 'record',
    deltaStimulusId: delta.stimulusId,
    channel: delta.channelKey,
    observationRefs,
    lines: lines.slice(-5).map((line) => ({
      sourceAt: line.sourceAt,
      author: line.author,
      text: clip(line.text, 300),
    })),
    attempt,
  };
}

export function recordOrderId(deltaStimulusId: string, attempt: number): string {
  return `record:${deltaStimulusId}:${attempt}`;
}

export function parseRecordOrder(payload: JsonValue | undefined): RecordOrderPayload {
  const value = payloadObject(payload);
  if (
    !value ||
    value.order !== 'record' ||
    typeof value.deltaStimulusId !== 'string' ||
    typeof value.channel !== 'string' ||
    !Array.isArray(value.observationRefs) ||
    !value.observationRefs.every((ref) => typeof ref === 'string') ||
    !Array.isArray(value.lines) ||
    typeof value.attempt !== 'number'
  )
    throw new Error(
      'A record order needs deltaStimulusId, channel, observationRefs, lines and attempt'
    );
  return value as unknown as RecordOrderPayload;
}

/** Kagemusha's `[delta_taskboard_reconcile]`: fixed steps, one durable outcome, reply [ack]. */
export function deltaRecordOrder(
  record: RecordOrderPayload,
  now: Date,
  options: TurnOrderOptions & { wikiEnabled: boolean }
): string {
  const lines = record.lines.map((line) => {
    const known = Number.isFinite(Date.parse(line.sourceAt));
    return `[${known ? localStamp(line.sourceAt, options.timeZone) : '-'}] ${line.author}: ${line.text}`;
  });
  return [
    `[delta_record] ${record.channel} · ${record.observationRefs.length} messages`,
    currentTime(now, options.timeZone),
    ...(lines.length === 0 ? [] : [wrapUntrustedContent('source_delta', lines.join('\n'))]),
    'Record what this delta changed:',
    `1. Use its lines above; read originals with source.read and observationRefs from the list below only for what the lines do not show.`,
    `2. Find the work they belong to with work.list (view=items with text) before creating anything.`,
    `3. For each moved item, work.revise (or work.create for newly entrusted work) with derived_from links to the observations below and eventDatetime set to the source event time; update only the board sections that change with report.publish, reading its contract with help first in a session${
      options.wikiEnabled
        ? `; add the dated line to the case's topic page with manage.wiki.update`
        : ''
    }. A lesson saved here links these observations with derived_from.`,
    `4. If nothing needs recording, call work.no_update with the reason and the observations below.`,
    '5. Reply exactly [ack].',
    `observations: ${record.observationRefs.join(', ')}`,
  ].join('\n');
}

export interface ScheduledReport {
  report: 'full' | 'reminder';
  hourKey: string;
  previousFullReportAt: string | null;
}

export function scheduledReport(payload: JsonValue | undefined): ScheduledReport {
  const value = payloadObject(payload);
  if (
    !value ||
    (value.report !== 'full' && value.report !== 'reminder') ||
    typeof value.hourKey !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}:\d{2}$/.test(value.hourKey)
  ) {
    throw new Error(
      'Scheduled report requires { report: full | reminder, hourKey: YYYY-MM-DD:HH }'
    );
  }
  const previousFullReportAt = value.previousFullReportAt;
  if (
    previousFullReportAt !== undefined &&
    previousFullReportAt !== null &&
    typeof previousFullReportAt !== 'string'
  ) {
    throw new Error('Scheduled report previousFullReportAt must be a time or null');
  }
  return {
    report: value.report,
    hourKey: value.hourKey,
    previousFullReportAt: typeof previousFullReportAt === 'string' ? previousFullReportAt : null,
  };
}

/** The scheduled report orders: the data only; the full-report procedure is in the standing prompt. */
export function scheduledReportOrder(
  payload: JsonValue | undefined,
  now: Date,
  options: TurnOrderOptions & { messenger: string }
): string {
  const { report, previousFullReportAt } = scheduledReport(payload);
  if (report === 'full') {
    const since =
      previousFullReportAt === null
        ? '24 hours ago'
        : `${new Date(
            epochAtLocalDateTime(
              `${previousFullReportAt.slice(0, 10)}T${previousFullReportAt.slice(11)}:00:00`,
              options.timeZone
            )
          ).toISOString()} (the previous full report)`;
    return [
      '[scheduled_full_report]',
      currentTime(now, options.timeZone),
      `Changes since: ${since}`,
      'Write the full report by the full-report procedure.',
      `Messenger: ${options.messenger}`,
    ].join('\n');
  }
  return [
    '[scheduled_task_reminder]',
    currentTime(now, options.timeZone),
    `1. Read open work with work.list view=pipeline, keeping only the fields you need in the script.`,
    `2. Pick the top five to eight by priority and deadline, including every item waiting on an owner decision; check schedule.upcoming if this session has not read it today.`,
    `3. Update only the action_required board section with report.publish.`,
    '4. Reply with a three-to-six-line reminder of those items, most urgent first, under a title that names them. If nothing needs the owner now, reply [ack] only.',
    `Messenger: ${options.messenger}`,
  ].join('\n');
}

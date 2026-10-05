import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { OwnerRuntimeBackend } from './owner-system-prompt.js';
import { epochAtLocalDateTime, localStamp } from './timezone.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { OPEN_WORK_STATUSES } from '../api/work-actions.js';
import { createHash } from 'node:crypto';

const OPEN_WORK_STATUS_LIST = `${OPEN_WORK_STATUSES.slice(0, -1).join(', ')} or ${OPEN_WORK_STATUSES.at(-1)}`;

/**
 * The work order each turn kind receives, in one place, as Kagemusha's host issues one per step
 * (`formatDelta`, `buildTaskboardReconcilePrompt`, `buildFullReportPrompt`, the reminder and the
 * session start). Procedures that hold for every turn live in the standing prompt; an order carries
 * the turn's data, its local time and the steps only that turn needs.
 */

export const SESSION_START_LIMIT = 4_400;
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
  /** Written in an owner-chat turn (owner-authority.ts); otherwise learned from observed work. */
  ownerRule: boolean;
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

/**
 * Kagemusha's lesson block: bounded, never a fact or a tool-call instruction. Each line says whose
 * word it is: an owner rule is the owner's own correction and wins a conflict (owner, 2026-10-01).
 */
export function lessonsBlock(lessons: readonly Lesson[]): string {
  if (lessons.length === 0) return '';
  const open =
    "<lessons>\nOwner rules are the owner's own corrections and win a conflict; learned lessons are advice from earlier work. Neither is a fact; verify current state with tools.";
  const close = '</lessons>';
  const lines: string[] = [];
  let size = open.length + close.length + 2;
  for (const lesson of lessons) {
    const line = escapeMarkup(
      `- [${lesson.ownerRule ? 'owner rule' : 'learned'}] ${clip(lesson.topic, 80)}: ${clip(lesson.summary, 360)}${
        lesson.appliesWhen ? ` (applies when: ${clip(lesson.appliesWhen, 160)})` : ''
      }`
    );
    if (size + line.length + 1 > LESSONS_LIMIT) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length === 0 ? '' : [open, ...lines, close].join('\n');
}

/** An owner rule in the rule index: its topic and when it applies. */
export interface OwnerRuleLine {
  topic: string;
  /** The rule's applies-when line, or its own words for a rule saved without one. */
  when: string;
}

/**
 * The owner's rules as an index on every record order and with the full-report procedure. A record
 * turn decides as it reads what a delta means (an item closed, which item a feedback belongs to),
 * so the rules for that judgment cannot be recalled from the delta's text beforehand: on the owner
 * ledger, the rule for a closing item was not among the 40 hits for the card move that closed one
 * (2026-10-05). The agent opens the rules that apply; a rule pushed once at session start was
 * ignored when it mattered (W21).
 */
export function ownerRulesBlock(rules: readonly OwnerRuleLine[]): string {
  if (rules.length === 0) return '';
  return [
    "<owner_rules>\nThe owner's rules, by when they apply. Before you write, read each one that applies with memory.search({topicPrefix: topic}) and no query, and follow it; an owner rule wins a conflict.",
    // The topic is whole: the agent reads the rule by it.
    ...rules.map((rule) => escapeMarkup(`- ${oneLine(rule.topic)}: ${clip(rule.when, 110)}`)),
    '</owner_rules>',
  ].join('\n');
}

/** What a new session is told, as Kagemusha's `buildSessionStartContext` gathers it. */
export interface SessionStartExchange {
  /** Epoch ms of the owner's message. */
  at: number;
  owner: string;
  answer: string;
}

export interface SessionStartInput {
  /** The owner channel's latest exchanges, oldest first. */
  exchanges: readonly SessionStartExchange[];
  /** The latest memory records, newest first. */
  decisions: readonly { topic: string; summary: string; ageHours: number }[];
  /** The latest session checkpoint the agent saved, if any. */
  checkpoint?: { summary: string; nextSteps: string; ageHours: number } | null;
}

// Ten owner exchanges fit in 3,000 chars at one line each, the size of Kagemusha's previous-turns block;
// the checkpoint and decisions keep Kagemusha's session-start budgets.
const SESSION_START_SECTIONS = { exchanges: 3_000, checkpoint: 500, decisions: 600 };
const EXCHANGE_OWNER_LIMIT = 120;
/** Ten lines and their nine newlines fit the exchanges budget. */
const EXCHANGE_LINE_LIMIT = 299;
const SESSION_START_LINE_LIMIT = 360;

function truncate(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  return limit <= 3 ? text.slice(0, limit) : `${text.slice(0, limit - 3)}...`;
}

/** Stored text never closes the block it sits in. */
function escapeClosing(value: string): string {
  return value.replace(/<\//g, '&lt;/');
}

function lineHash(line: string): string {
  return createHash('sha1')
    .update(line.replace(/\s+/g, ' ').trim().toLocaleLowerCase())
    .digest('hex');
}

/** The newest lines that fit, oldest first, each line at most 360 chars and never repeated. */
function recentLines(lines: readonly string[], limit: number, seen: Set<string>): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = escapeClosing(oneLine(lines[index]!));
    if (!line) continue;
    const hash = lineHash(line);
    if (seen.has(hash)) continue;
    const separator = kept.length > 0 ? 1 : 0;
    const remaining = limit - used - separator;
    if (remaining <= 0) break;
    const capped = truncate(line, Math.min(remaining, SESSION_START_LINE_LIMIT));
    if (!capped) break;
    seen.add(hash);
    kept.push(capped);
    used += separator + capped.length;
  }
  return kept.reverse();
}

/** The first lines that fit, in order, never repeated. */
function leadingLines(lines: readonly string[], limit: number, seen: Set<string>): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const raw of lines) {
    const line = escapeClosing(oneLine(raw));
    if (!line) continue;
    const hash = lineHash(line);
    if (seen.has(hash)) continue;
    const separator = kept.length > 0 ? 1 : 0;
    const remaining = limit - used - separator;
    if (remaining <= 0) break;
    const capped = truncate(line, remaining);
    if (!capped) break;
    seen.add(hash);
    kept.push(capped);
    used += separator + capped.length;
  }
  return kept;
}

/**
 * The `[session_start]` block, at most 4,400 chars: the owner channel's last ten exchanges one line
 * each, the latest checkpoint and the latest decisions, each within its own budget, newest kept
 * first and no line twice. The time comes first so a full block never drops it.
 */
export function sessionStartBlock(
  input: SessionStartInput,
  now: Date,
  options: Pick<TurnOrderOptions, 'timeZone'>
): string {
  const seen = new Set<string>();
  // The time and the read hint come first, so a full block never drops them.
  const parts = [
    '[session_start]',
    currentTime(now, options.timeZone),
    'This is history from before this session; read newer state with source.recent or work.list when a turn needs it.',
  ];
  const append = (section: string): void => {
    const used = parts.join('\n').length;
    if (used + 1 + section.length <= SESSION_START_LIMIT) parts.push(section);
  };
  /** Chars left before the 2,500 cap, after the newline that joins the next section. */
  const room = (): number => SESSION_START_LIMIT - parts.join('\n').length - 1;
  // One line per exchange: the owner's words, then the head of the reply; history, not requests.
  const exchanges = recentLines(
    input.exchanges.map((exchange) =>
      truncate(
        `[${localStamp(new Date(exchange.at).toISOString(), options.timeZone)}] owner: ${truncate(
          oneLine(exchange.owner),
          EXCHANGE_OWNER_LIMIT
        )} → you: ${oneLine(exchange.answer)}`,
        EXCHANGE_LINE_LIMIT
      )
    ),
    SESSION_START_SECTIONS.exchanges,
    seen
  );
  if (exchanges.length > 0)
    append(
      [
        '',
        'Earlier owner messages and your replies (history, not new requests):',
        ...exchanges,
      ].join('\n')
    );
  const age = (hours: number): string =>
    Number.isFinite(hours) ? `${Math.round(hours)}h ago` : '? ago';
  // Kagemusha's checkpoint section: the agent's own hand-off, outranked by newer turns above.
  if (input.checkpoint) {
    const header = `Last checkpoint (${age(input.checkpoint.ageHours)}; prefer newer turns and decisions over it):`;
    const lines = leadingLines(
      // The next steps first: a long summary must not push out what the hand-off is for.
      [
        ...(input.checkpoint.nextSteps ? [`Next steps: ${input.checkpoint.nextSteps}`] : []),
        ...input.checkpoint.summary.split('\n'),
      ],
      Math.min(SESSION_START_SECTIONS.checkpoint, room() - header.length - 2),
      seen
    );
    if (lines.length > 0) append(['', header, ...lines].join('\n'));
  }
  // Decisions come last and take what room is left, up to their own budget.
  const decisions = leadingLines(
    input.decisions
      .slice(0, 10)
      .map((decision) => `- [${decision.topic}] ${decision.summary} (${age(decision.ageHours)})`),
    Math.min(SESSION_START_SECTIONS.decisions, room() - 'Recent decisions:'.length - 2),
    seen
  );
  if (decisions.length > 0) append(['', 'Recent decisions:', ...decisions].join('\n'));
  return truncate(parts.join('\n'), SESSION_START_LIMIT);
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
  /**
   * The connector the channel belongs to, so the order can name the channel's source.recent key.
   * Record orders written before 2026-09-29 have none; they are still read and rendered.
   */
  source?: string;
  channel: string;
  observationRefs: string[];
  /** The delta's last lines, as Kagemusha's record turn carries them (five, 300 chars each). */
  lines: RecordOrderLine[];
  attempt: number;
  /**
   * Earlier batches of the same channel still unrecorded, taken up with this order the way
   * Kagemusha's next tick re-reads everything behind its cursor. Absent when there are none.
   */
  carried?: RecordOrderBatch[];
}

/** One delta's batch inside a record order, at the attempt this order makes for it. */
export interface RecordOrderBatch {
  deltaStimulusId: string;
  observationRefs: string[];
  lines: RecordOrderLine[];
  attempt: number;
}

/** The order's own batch first, then the batches it carries. */
export function recordOrderBatches(record: RecordOrderPayload): RecordOrderBatch[] {
  const own: RecordOrderBatch = {
    deltaStimulusId: record.deltaStimulusId,
    observationRefs: record.observationRefs,
    lines: record.lines,
    attempt: record.attempt,
  };
  return [own, ...(record.carried ?? [])];
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
  const refs = payloadObject(delta.payload)?.refs;
  const first = Array.isArray(refs) ? payloadObject(refs[0]) : null;
  return {
    order: 'record',
    deltaStimulusId: delta.stimulusId,
    source: textField(first?.connector),
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

function isRecordOrderBatch(value: JsonValue): boolean {
  const batch = payloadObject(value);
  return (
    batch !== null &&
    typeof batch.deltaStimulusId === 'string' &&
    Array.isArray(batch.observationRefs) &&
    batch.observationRefs.every((ref) => typeof ref === 'string') &&
    Array.isArray(batch.lines) &&
    typeof batch.attempt === 'number'
  );
}

export function parseRecordOrder(payload: JsonValue | undefined): RecordOrderPayload {
  const value = payloadObject(payload);
  if (
    !value ||
    value.order !== 'record' ||
    !isRecordOrderBatch(value) ||
    (value.source !== undefined && typeof value.source !== 'string') ||
    typeof value.channel !== 'string' ||
    (value.carried !== undefined &&
      (!Array.isArray(value.carried) || !value.carried.every(isRecordOrderBatch)))
  )
    throw new Error(
      'A record order needs deltaStimulusId, channel, observationRefs, lines and attempt'
    );
  return value as unknown as RecordOrderPayload;
}

/**
 * Kagemusha's `[delta_taskboard_reconcile]` in its order: the channel's latest context
 * (channel_history), the current work state (task_list), then the update or the no-update reason.
 * On 2026-09-29 a text-search step in place of the first two left a short reply, a check result in
 * another room, unattached.
 */
/**
 * The lines a record order shows. Carried batches are older than the order's own, so their lines
 * come first; like Kagemusha's tick, the order shows the last five of everything it covers.
 */
export function recordOrderLines(record: RecordOrderPayload): RecordOrderLine[] {
  return [...(record.carried ?? []), record].flatMap((batch) => batch.lines).slice(-5);
}

export function deltaRecordOrder(
  record: RecordOrderPayload,
  now: Date,
  options: TurnOrderOptions & { wikiEnabled: boolean },
  guidance: { lessons: readonly Lesson[]; ownerRules: readonly OwnerRuleLine[] }
): string {
  // Record orders written before 2026-09-29 carry no source, and a retry copies its order, so the
  // channel is found by name in the list instead of by key; the step stays the same.
  const context = record.source
    ? `source.recent({channels: ["${record.source}:${record.channel}"], perChannel: 20})`
    : `source.recent (find the channel "${record.channel}" in its list, then read its lines with channels and perChannel: 20)`;
  const batches = [...(record.carried ?? []), record];
  const observationRefs = [...new Set(batches.flatMap((batch) => batch.observationRefs))].sort();
  const lines = recordOrderLines(record).map((line) => {
    const known = Number.isFinite(Date.parse(line.sourceAt));
    return `[${known ? localStamp(line.sourceAt, options.timeZone) : '-'}] ${line.author}: ${line.text}`;
  });
  return [
    `[delta_record] ${record.channel} · ${observationRefs.length} messages`,
    currentTime(now, options.timeZone),
    ...[lessonsBlock(guidance.lessons), ownerRulesBlock(guidance.ownerRules)].filter(
      (block) => block !== ''
    ),
    ...(lines.length === 0 ? [] : [wrapUntrustedContent('source_delta', lines.join('\n'))]),
    'Record what this delta changed:',
    `1. Check this channel's latest context with ${context}; read an original with source.read only when a line needs its full text.`,
    `2. Read the current work state with work.list (view=items with status ${OPEN_WORK_STATUS_LIST} for the open work; detail for the items this conversation is about) before creating anything; help({topic: 'record'}) has the recording rules.`,
    `3. For each moved item, work.revise (or work.create for newly entrusted work) with derived_from links to the observations below and eventDatetime set to the source event time; update only the board sections that change with report.publish, reading its contract with help first in a session${
      options.wikiEnabled
        ? `; when the messages settle lasting knowledge (a term, a specification, a decision, how a client works), update that section of the project's wiki page (help topic wiki)`
        : ''
    }. A lesson saved here links these observations with derived_from.`,
    `4. If nothing needs recording, call work.no_update with the reason and the observations below.`,
    // Kagemusha's reconcile order makes the write mandatory and checks it; an agent that did not
    // know the check ended a turn with two refused writes and [ack].
    "5. Step 3 or 4 is required: the order is checked when it ends and counts as done only when these observations are cited by a revision's derived_from links or by work.no_update. Correct a refused write (help gives its contract) and write it again.",
    '6. Reply exactly [ack].',
    `observations: ${observationRefs.join(', ')}`,
  ].join('\n');
}

export interface ScheduledReport {
  report: 'full' | 'reminder' | 'daily';
  hourKey: string;
  previousFullReportAt: string | null;
  /** The day a daily page covers, YYYY-MM-DD in the owner's time zone; null for reports. */
  day: string | null;
}

export function scheduledReport(payload: JsonValue | undefined): ScheduledReport {
  const value = payloadObject(payload);
  if (
    !value ||
    (value.report !== 'full' && value.report !== 'reminder' && value.report !== 'daily') ||
    typeof value.hourKey !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}:\d{2}$/.test(value.hourKey) ||
    (value.report === 'daily' &&
      (typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)))
  ) {
    throw new Error(
      'Scheduled report requires { report: full | reminder | daily, hourKey: YYYY-MM-DD:HH } and a daily its day: YYYY-MM-DD'
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
    day: value.report === 'daily' ? (value.day as string) : null,
  };
}

/** The scheduled report orders: the data only; the full-report procedure is in the standing prompt. */
export function scheduledReportOrder(
  payload: JsonValue | undefined,
  now: Date,
  options: TurnOrderOptions & { messenger: string }
): string {
  const { report, previousFullReportAt, day } = scheduledReport(payload);
  if (report === 'daily') {
    const [year, month, date] = day!.split('-').map(Number) as [number, number, number];
    const nextDay = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
    return [
      `[scheduled_daily] ${day}`,
      currentTime(now, options.timeZone),
      `The day in ${options.timeZone}: eventSince ${epochAtLocalDateTime(`${day}T00:00:00`, options.timeZone)}, eventBefore ${epochAtLocalDateTime(`${nextDay}T00:00:00`, options.timeZone)} (epoch ms).`,
      `Write the daily page daily/${day!.slice(0, 7)}/${day}.md by its procedure, help({topic: 'daily'}).`,
      'Reply exactly [ack].',
    ].join('\n');
  }
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
      "Write the full report by its procedure, help({topic: 'full-report'}).",
      `Messenger: ${options.messenger}`,
    ].join('\n');
  }
  return [
    '[scheduled_task_reminder]',
    currentTime(now, options.timeZone),
    // Only contract values: "open" and "waiting" read as statuses and work.list refused them on
    // every reminder from 2026-09-29 to 2026-10-03.
    `1. Find the work that needs the owner now: work.list items with due overdue or due today (a due filter returns open work only), and among the open items (status ${OPEN_WORK_STATUS_LIST}) those waiting on an owner decision, which no status or field marks, so judge it from each item's latest record. Keep only the fields you need in the script.`,
    `2. Pick the top five to eight by priority and deadline, including every item waiting on an owner decision; check schedule.upcoming if this session has not read it today.`,
    `3. Update only the action_required board section with report.publish.`,
    '4. Reply with a three-to-six-line reminder of those items, most urgent first, under a title that names them. If nothing needs the owner now, reply [ack] only.',
    `Messenger: ${options.messenger}`,
  ].join('\n');
}

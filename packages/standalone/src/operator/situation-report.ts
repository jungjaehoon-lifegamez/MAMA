/**
 * SituationReporter - the OUTPUT leg of the trigger loop (M2), superseding TriggerReporter (M1.5).
 *
 * Accumulates a BOUNDED window of drained events (per-channel counts + last-K excerpts), plus
 * fire/author activity and the memory those fires recalled (agent-authored memoryQuery drove the
 * recall - trigger-fire.ts:33-34). On a report cadence the AGENT composes an owner situation
 * report from the AGGREGATE (agent-first: the agent judges content and may reply NOTHING to
 * suppress); the system only windows/schedules/sends.
 *
 * Two framings share one accumulator + send machinery:
 *   - 'digest': the short periodic update (the M1.5 fire digest, now window-aware).
 *   - 'full'  : the fuller scheduled report covering the whole window since the last full report.
 *
 * No activity -> no agent call, no send (no spam). Send failure propagates loudly (no-fallback)
 * and keeps the buffer so the next cadence retries. English default; the agent is told to answer
 * in the owner's language if inferable. NO personal strings in this source.
 */
import type { OperatorChannelEvent, OutputSink } from './operator-interfaces.js';
import { createHash } from 'node:crypto';
import type { AskAgent } from './trigger-author.js';
import type { BackendType } from '../agent/model-runner.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

/**
 * Machine frame tag prepended to the FULL report prompt so the report-run wiring can tell a full
 * report from a digest for tool-use auditing (report-run.ts). Kagemusha frames its scheduled full
 * report with the same bracketed-tag convention (report-prompts.ts buildFullReportPrompt).
 */
export const OPERATOR_FULL_REPORT_TAG = '[operator_full_report]';

export interface FireActivity {
  triggerId: string;
  kind: string;
  channelId: string;
  recalled: { topic: string; content: string }[];
}

export type ReportMode = 'digest' | 'full';

export interface PreparedSituationReport {
  mode: ReportMode;
  text: string;
  citedTriggerIds: string[];
  createdAtIso: string;
  deliveryId?: string;
}

/** Deterministic prompt-size bounds (mind memory + prompt length; see plan design decision 4). */
const MAX_EXCERPTS_PER_CHANNEL = 5;
const MAX_EXCERPT_CHARS = 160;
const MAX_CHANNELS_IN_PROMPT = 12;
const MAX_CHANNELS_IN_SNAPSHOT = MAX_CHANNELS_IN_PROMPT * 4;
const MAX_RECALLED = 20;
const MAX_FIRES_IN_SNAPSHOT = 100;
const MAX_SEEN_EVENT_KEYS = 10_000;

interface ChannelWindow {
  count: number;
  excerpts: string[]; // last-K, each already sliced to MAX_EXCERPT_CHARS
}

interface FireAgg {
  triggerId: string;
  kind: string;
  channelId: string;
  count: number;
  topics: Set<string>;
}

export interface SituationReporterSnapshot {
  version: 1;
  channels: Array<{ channelId: string; count: number; excerpts: string[] }>;
  windowTotal: number;
  fires: Array<{
    triggerId: string;
    kind: string;
    channelId: string;
    count: number;
    topics: string[];
  }>;
  authored: number;
  recalled: Array<{ topic: string; content: string }>;
  eventKeys?: string[];
}

export interface SituationReporterOptions {
  /** Model provider controls only the tool-call syntax; report workflow/content stays shared. */
  backend?: BackendType;
  /**
   * M2.3: tool-call instructions injected into the FULL report framing so the agent
   * ACTIVELY gathers current context (channels, tasks, memory) before writing - the
   * lesson from Kagemusha, whose report prompt instructs its agent to call its tools
   * (and which deleted its deterministic report builder for low quality). The lines
   * are injected from the runtime wiring (which knows the daemon's toolset); this
   * module stays generic. Digest mode never uses them (frequent + must stay light).
   *
   * A zero-arg provider is resolved at fire time (buildPrompt runs per report),
   * so runtime wiring can inject freshly anchored gather lines (e.g. a delta
   * `since=<last successful report>`) without rebuilding the reporter.
   */
  selfGatherLines?: string[] | (() => string[]);
  /**
   * Kagemusha dual-output mechanism: lines instructing the FULL report run to also
   * publish the operator board slots (report_publish) before writing the text
   * report. Injected from runtime wiring (board-slot-instructions.ts); digest mode
   * never publishes the board.
   */
  boardPublishLines?: string[];
  /**
   * G2 success signal: called with the trigger ids the agent says it actually
   * drew on for the sent report (parsed from the stripped USED_TRIGGERS
   * trailer, validated against this window's fires). The wiring records
   * 'succeeded' outcomes so evolution finally gets a positive signal instead
   * of being elimination-only. Uncited fires stay NEUTRAL - not failures.
   */
  recordTriggerUse?: (triggerIds: string[]) => void;
  /**
   * Context carry (plan v6 S1-T4): called with (deliveredAtIso, reportText)
   * after a FULL report is successfully delivered. Runtime wiring persists it
   * so the owner console can reference the latest report per chat turn.
   */
  persistLastFullReport?: (deliveredAtIso: string, text: string) => void;
}

/** Machine trailer the agent appends; stripped before the owner sees the report. */
const USED_TRIGGERS_PATTERN = /\n?^USED_TRIGGERS:\s*(.*)\s*$/im;

export class SituationReporter {
  private windowByChannel = new Map<string, ChannelWindow>();
  private windowTotal = 0;
  private fireAgg = new Map<string, FireAgg>();
  private authored = 0;
  private recalled = new Map<string, string>(); // topic -> content (deduped, bounded)
  private eventKeys = new Set<string>();
  private opts: SituationReporterOptions;

  constructor(opts: SituationReporterOptions = {}) {
    this.opts = opts;
  }

  /** Fold a batch of drained events into the bounded per-channel window. */
  recordWindow(events: OperatorChannelEvent[]): void {
    for (const e of events) {
      const eventKey = this.eventKey(e);
      if (this.eventKeys.has(eventKey)) continue;
      this.eventKeys.add(eventKey);
      if (this.eventKeys.size > MAX_SEEN_EVENT_KEYS) {
        const oldest = this.eventKeys.values().next().value;
        if (oldest) this.eventKeys.delete(oldest);
      }
      const w = this.windowByChannel.get(e.channelId) ?? { count: 0, excerpts: [] };
      w.count += 1;
      const text = e.content.trim();
      if (text) {
        w.excerpts.push(text.slice(0, MAX_EXCERPT_CHARS));
        if (w.excerpts.length > MAX_EXCERPTS_PER_CHANNEL) {
          w.excerpts.shift();
        }
      }
      this.windowByChannel.set(e.channelId, w);
      this.windowTotal += 1;
    }
  }

  hasRecordedEvent(event: OperatorChannelEvent): boolean {
    return (
      this.eventKeys.has(this.eventKey(event)) || this.eventKeys.has(this.legacyEventKey(event))
    );
  }

  private eventKey(event: OperatorChannelEvent): string {
    return createHash('sha256').update(this.legacyEventKey(event)).digest('hex');
  }

  private legacyEventKey(event: OperatorChannelEvent): string {
    return `${event.channel}:${event.channelId}:${event.eventIndexId ?? event.id}`;
  }

  /** Fold one fire into the aggregate; merge the memory it recalled (agent-query-driven). */
  recordFire(activity: FireActivity): void {
    const key = `${activity.triggerId}|${activity.channelId}`;
    const agg = this.fireAgg.get(key) ?? {
      triggerId: activity.triggerId,
      kind: activity.kind,
      channelId: activity.channelId,
      count: 0,
      topics: new Set<string>(),
    };
    agg.count += 1;
    for (const r of activity.recalled) {
      agg.topics.add(r.topic);
      if (!this.recalled.has(r.topic) && this.recalled.size < MAX_RECALLED) {
        this.recalled.set(r.topic, r.content.slice(0, MAX_EXCERPT_CHARS));
      }
    }
    this.fireAgg.set(key, agg);
  }

  recordAuthored(count: number): void {
    this.authored += count;
  }

  /** Any window events, fires, or authored triggers accumulated since the last reset. */
  hasActivity(): boolean {
    return this.windowTotal > 0 || this.fireAgg.size > 0 || this.authored > 0;
  }

  snapshot(): SituationReporterSnapshot {
    return {
      version: 1,
      channels: [...this.windowByChannel.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, MAX_CHANNELS_IN_SNAPSHOT)
        .map(([channelId, window]) => ({
          channelId: channelId.slice(0, 512),
          count: window.count,
          excerpts: window.excerpts.map((excerpt) => excerpt.slice(0, MAX_EXCERPT_CHARS)),
        })),
      windowTotal: this.windowTotal,
      fires: [...this.fireAgg.values()]
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.triggerId.localeCompare(b.triggerId) ||
            a.channelId.localeCompare(b.channelId)
        )
        .slice(0, MAX_FIRES_IN_SNAPSHOT)
        .map((fire) => ({
          triggerId: fire.triggerId.slice(0, 512),
          kind: fire.kind.slice(0, 512),
          channelId: fire.channelId.slice(0, 512),
          count: fire.count,
          topics: [...fire.topics].slice(-MAX_RECALLED).map((topic) => topic.slice(0, 512)),
        })),
      authored: this.authored,
      recalled: [...this.recalled.entries()].map(([topic, content]) => ({
        topic: topic.slice(0, 512),
        content: content.slice(0, MAX_EXCERPT_CHARS),
      })),
      eventKeys: [...this.eventKeys].map((key) => key.slice(0, 1_024)),
    };
  }

  restore(snapshot: SituationReporterSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error('Unsupported situation reporter snapshot version');
    }
    this.reset();
    for (const channel of snapshot.channels.slice(0, MAX_CHANNELS_IN_SNAPSHOT)) {
      this.windowByChannel.set(channel.channelId, {
        count: Math.max(0, channel.count),
        excerpts: channel.excerpts.slice(-MAX_EXCERPTS_PER_CHANNEL),
      });
    }
    this.windowTotal = Math.max(0, snapshot.windowTotal);
    for (const fire of snapshot.fires.slice(0, MAX_FIRES_IN_SNAPSHOT)) {
      this.fireAgg.set(`${fire.triggerId}|${fire.channelId}`, {
        triggerId: fire.triggerId,
        kind: fire.kind,
        channelId: fire.channelId,
        count: Math.max(0, fire.count),
        topics: new Set(fire.topics.slice(0, MAX_RECALLED)),
      });
    }
    this.authored = Math.max(0, snapshot.authored);
    for (const item of snapshot.recalled.slice(0, MAX_RECALLED)) {
      this.recalled.set(item.topic, item.content.slice(0, MAX_EXCERPT_CHARS));
    }
    this.eventKeys = new Set((snapshot.eventKeys ?? []).slice(-MAX_SEEN_EVENT_KEYS));
  }

  /**
   * Agent composes the report from the aggregate; sink delivers it. Returns true if a report was
   * sent, false if there was nothing to say or the agent suppressed it (NOTHING).
   */
  async prepareReport(
    askAgent: AskAgent,
    mode: ReportMode,
    deliveryId?: string
  ): Promise<PreparedSituationReport | null> {
    // M2.1: the scheduled FULL report is a duty report - it composes even on an empty window
    // (the owner relies on it arriving; a quiet window is itself the news). Digests stay gated.
    if (mode !== 'full' && !this.hasActivity()) return null;

    const raw = (await askAgent(this.buildPrompt(mode))).trim();
    if (raw === '' || /^NOTHING\b/i.test(raw)) {
      if (mode === 'full') {
        throw new Error('Full owner report returned no content');
      }
      this.reset(); // agent judged nothing worth reporting - drop the buffer quietly
      return null;
    }

    // Parse + strip the USED_TRIGGERS machine trailer (the owner never sees it)
    // and validate the ids against THIS window's fires (no hallucinated credit).
    const match = raw.match(USED_TRIGGERS_PATTERN);
    const text = raw.replace(USED_TRIGGERS_PATTERN, '').trim();
    let cited: string[] = [];
    if (match) {
      const windowIds = new Set([...this.fireAgg.values()].map((f) => f.triggerId));
      cited = [
        ...new Set(
          match[1]
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0 && id.toLowerCase() !== 'none' && windowIds.has(id))
        ),
      ];
    }
    if (text === '') {
      if (mode === 'full') {
        throw new Error('Full owner report returned no content');
      }
      this.reset(); // trailer-only reply: nothing was delivered, so no credit either
      return null;
    }

    return {
      mode,
      text,
      citedTriggerIds: cited,
      createdAtIso: new Date().toISOString(),
      ...(deliveryId ? { deliveryId } : {}),
    };
  }

  async deliverPrepared(
    prepared: PreparedSituationReport,
    output: Pick<OutputSink, 'send'>
  ): Promise<void> {
    if (prepared.mode !== 'digest' && prepared.mode !== 'full') {
      throw new Error('Unsupported prepared report mode');
    }

    if (prepared.deliveryId) {
      await output.send(prepared.text, prepared.deliveryId);
    } else {
      await output.send(prepared.text);
    }
    // Credit only AFTER a successful send: success means "cited in a DELIVERED
    // report". Crediting before send would double-count on the retry path
    // (send throws -> buffer kept -> next cadence re-cites the same fires).
    if (prepared.citedTriggerIds.length > 0) {
      this.opts.recordTriggerUse?.(prepared.citedTriggerIds);
    }
    // Context carry (plan v6 S1-T4): persist the DELIVERED full report so the
    // chat console can reference "the report you just got" instead of
    // fabricating one. Same success condition as the delta anchor.
    if (prepared.mode === 'full') {
      try {
        this.opts.persistLastFullReport?.(new Date().toISOString(), prepared.text);
      } catch (error) {
        // Carry is derived state - persistence failure must not fail the
        // delivered report, but it must be loud.
        console.warn(
          `[situation-report] failed to persist last full report for context carry: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.reset();
  }

  async report(
    askAgent: AskAgent,
    output: Pick<OutputSink, 'send'>,
    mode: ReportMode
  ): Promise<boolean> {
    const prepared = await this.prepareReport(askAgent, mode);
    if (!prepared) {
      return false;
    }
    await this.deliverPrepared(prepared, output);
    return true;
  }

  private reset(): void {
    this.windowByChannel.clear();
    this.windowTotal = 0;
    this.fireAgg.clear();
    this.authored = 0;
    this.recalled.clear();
    this.eventKeys.clear();
  }

  /** Public for testability. Aggregate window + fire activity + recalled memory -> agent prompt. */
  buildPrompt(mode: ReportMode): string {
    const channels = [...this.windowByChannel.entries()].sort((a, b) => b[1].count - a[1].count);
    const shown = channels.slice(0, MAX_CHANNELS_IN_PROMPT);
    const windowLines = shown.map(
      ([channelId, w]) =>
        `- ${channelId}: ${w.count} msg(s); recent: ${w.excerpts.join(' | ') || '(none)'}`
    );
    if (channels.length > shown.length) {
      const restCount = channels.slice(shown.length).reduce((n, [, w]) => n + w.count, 0);
      windowLines.push(
        `- (+${channels.length - shown.length} more channel(s), ${restCount} msg(s))`
      );
    }

    const fireLines = [...this.fireAgg.values()].map(
      (f) =>
        `- trigger "${f.kind}" [id: ${f.triggerId}] fired ${f.count}x on ${f.channelId}; recalled: ${[...f.topics].join(', ') || '(none)'}`
    );
    const memoryLines = [...this.recalled.entries()].map(
      ([topic, content]) => `- ${topic}: ${content}`
    );

    // Resolve the gather lines only for the FULL report - the digest framing never renders
    // them, so a zero-arg PROVIDER must not be invoked (it may do real gather work) just to
    // build a digest prompt. The guard below stays anchored on the RESOLVED array: a zero-arg
    // provider's `.length` is its arity (0), so guarding on the raw opts value would compile
    // cleanly and silently drop the ENTIRE gather block on every production report.
    const gatherLines =
      mode === 'full'
        ? typeof this.opts.selfGatherLines === 'function'
          ? this.opts.selfGatherLines()
          : (this.opts.selfGatherLines ?? [])
        : [];
    const gatherInstructions =
      this.opts.backend === 'codex'
        ? [
            'Before writing, ACTIVELY gather current context with your injected native host tools directly.',
            'Call each tool through the native model tool interface and wait for its result before',
            'the next call; never emit Markdown or JavaScript substitutes for tool calls.',
            'Gather with these injected native host tools:',
            ...gatherLines.map((line) => `- ${line}`),
            'These tool names are already injected for this run. Do not search for them, and do',
            'not fall back to Bash or curl against any API.',
            'Use ONLY these injected host tools to gather. Do NOT read log files, databases, or',
            'the filesystem with Bash, Read, or other unrelated tools - those are not the task',
            'board and will make the report wrong. Your tool findings are the primary source;',
            'the window summary below is only a hint.',
            '',
            'After gathering, if the window contains a durable decision or lesson worth keeping,',
            'persist exactly ONE by calling the injected native mama_save host tool (type',
            '"decision", with topic, decision, reasoning). Only save when it is genuinely',
            'durable; skip the save otherwise. This is your judgement, not a requirement.',
          ]
        : [
            'Before writing, ACTIVELY gather current context by CALLING your gateway tools.',
            'Emit each call as a fenced tool_call JSON block and wait for the result before',
            'the next call. The block format is exactly:',
            '```tool_call',
            '{"name": "kagemusha_tasks", "input": {"status": "in_progress"}}',
            '```',
            'Gather with these gateway tool calls:',
            ...gatherLines.map((line) => `- ${line}`),
            'These gateway tools are NOT native or deferred CLI tools: ToolSearch cannot',
            'load them and will find nothing. Invoke them ONLY as fenced tool_call JSON',
            'blocks in your reply text - do not search for them, and do not fall back to',
            'Bash or curl against any API.',
            'Use ONLY these gateway tool_call blocks to gather. Do NOT read log files,',
            'databases, or the filesystem with Bash, Read, or other native tools - those are',
            'not the task board and will make the report wrong. Your gateway tool findings',
            'are the primary source; the window summary below is only a hint.',
            '',
            'After gathering, if the window contains a durable decision or lesson worth',
            'keeping, persist exactly ONE with a gateway tool_call to mama_save (type',
            '"decision", with topic, decision, reasoning). Only save when it is genuinely',
            'durable; skip the save otherwise. This is your judgement, not a requirement.',
          ];

    // M2.1 posture: the full report is a DUTY report (always arrives - a quiet window is
    // reported as quiet, the aliveness signal owners rely on); the digest defaults to briefing
    // and keeps NOTHING only for pure noise.
    const framing =
      mode === 'full'
        ? [
            OPERATOR_FULL_REPORT_TAG,
            'You are the operator agent. Write your scheduled FULLER situation report for your owner',
            'covering the whole window below (multiple channels, since the last full report). Group',
            "what recurred, what is new, and what needs the owner's attention. Plain language, no",
            'markdown tables. This scheduled report must ALWAYS arrive: if the window was quiet,',
            'say so in one or two lines instead of skipping.',
            "Structure the report with these sections (render the headings in the owner's language;",
            'omit a section only when it is truly empty):',
            '1) Key situation  2) Action required  3) Decisions needed  4) Pipeline  5) Next actions',
            ...(gatherLines.length > 0 ? ['', ...gatherInstructions] : []),
            ...(this.opts.boardPublishLines && this.opts.boardPublishLines.length > 0
              ? ['', ...this.opts.boardPublishLines]
              : []),
          ]
        : [
            'You are the operator agent. Write a SHORT proactive digest for your owner about the',
            'situation below - what happened, what recurred, and what the owner may want to look at.',
            '2-6 lines, plain language, no markdown tables. Default to sending the brief when there',
            'is meaningful activity; reply exactly NOTHING only if this window is pure noise',
            '(duplicates, bot chatter) with nothing the owner could act on.',
          ];

    return [
      ...framing,
      // Attribution discipline (owner feedback: the only quality complaint on day-1
      // reports was merged sender/room identities).
      'Attribute people and rooms EXACTLY as they appear in the source lines: a channel/room',
      'name is never a person, and a sender is never a room. If you cannot tell who said',
      'something, write "(sender unclear)" instead of guessing or merging names.',
      // G2 success signal: machine trailer, stripped before delivery.
      'After the report body, add ONE final line exactly in this form:',
      'USED_TRIGGERS: <comma-separated ids of the fired triggers (from [id: ...] in the fire',
      'activity below) whose fire or recalled memory you actually drew on>, or',
      'USED_TRIGGERS: none if you drew on none. This line is machine-read and stripped',
      'before the owner sees the report.',
      'Reply in the language the owner uses on these channels if you can tell; otherwise English.',
      // Local wall-clock, not UTC: the first live report stamped itself in UTC because the
      // agent had no local time reference (Kagemusha injects local time the same way).
      `Current local time: ${new Date().toLocaleString()}. Use LOCAL time in the report, never UTC.`,
      '',
      'Window (per channel; excerpts truncated):',
      wrapUntrustedContent(
        'connector-window',
        windowLines.length > 0 ? windowLines.join('\n') : '- (no channel messages this window)'
      ),
      '',
      `Triggers newly authored this window: ${this.authored}`,
      'Fire activity:',
      ...(fireLines.length > 0 ? fireLines : ['- (no triggers fired this window)']),
      '',
      'Memory your triggers surfaced this window:',
      ...(memoryLines.length > 0 ? memoryLines : ['- (none)']),
    ].join('\n');
  }
}

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
import type { AskAgent } from './trigger-author.js';

export interface FireActivity {
  triggerId: string;
  kind: string;
  channelId: string;
  recalled: { topic: string; content: string }[];
}

export type ReportMode = 'digest' | 'full';

/** Deterministic prompt-size bounds (mind memory + prompt length; see plan design decision 4). */
const MAX_EXCERPTS_PER_CHANNEL = 5;
const MAX_EXCERPT_CHARS = 160;
const MAX_CHANNELS_IN_PROMPT = 12;
const MAX_RECALLED = 20;

interface ChannelWindow {
  count: number;
  excerpts: string[]; // last-K, each already sliced to MAX_EXCERPT_CHARS
}

interface FireAgg {
  kind: string;
  channelId: string;
  count: number;
  topics: Set<string>;
}

export interface SituationReporterOptions {
  /**
   * M2.3: tool-call instructions injected into the FULL report framing so the agent
   * ACTIVELY gathers current context (channels, tasks, memory) before writing - the
   * lesson from Kagemusha, whose report prompt instructs its agent to call its tools
   * (and which deleted its deterministic report builder for low quality). The lines
   * are injected from the runtime wiring (which knows the daemon's toolset); this
   * module stays generic. Digest mode never uses them (frequent + must stay light).
   */
  selfGatherLines?: string[];
}

export class SituationReporter {
  private windowByChannel = new Map<string, ChannelWindow>();
  private windowTotal = 0;
  private fireAgg = new Map<string, FireAgg>();
  private authored = 0;
  private recalled = new Map<string, string>(); // topic -> content (deduped, bounded)
  private opts: SituationReporterOptions;

  constructor(opts: SituationReporterOptions = {}) {
    this.opts = opts;
  }

  /** Fold a batch of drained events into the bounded per-channel window. */
  recordWindow(events: OperatorChannelEvent[]): void {
    for (const e of events) {
      const w = this.windowByChannel.get(e.channelId) ?? { count: 0, excerpts: [] };
      w.count += 1;
      const text = e.content.trim();
      if (text) {
        w.excerpts.push(text.slice(0, MAX_EXCERPT_CHARS));
        if (w.excerpts.length > MAX_EXCERPTS_PER_CHANNEL) w.excerpts.shift();
      }
      this.windowByChannel.set(e.channelId, w);
      this.windowTotal += 1;
    }
  }

  /** Fold one fire into the aggregate; merge the memory it recalled (agent-query-driven). */
  recordFire(activity: FireActivity): void {
    const key = `${activity.triggerId}|${activity.channelId}`;
    const agg =
      this.fireAgg.get(key) ?? { kind: activity.kind, channelId: activity.channelId, count: 0, topics: new Set<string>() };
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

  /**
   * Agent composes the report from the aggregate; sink delivers it. Returns true if a report was
   * sent, false if there was nothing to say or the agent suppressed it (NOTHING).
   */
  async report(askAgent: AskAgent, output: Pick<OutputSink, 'send'>, mode: ReportMode): Promise<boolean> {
    // M2.1: the scheduled FULL report is a duty report - it composes even on an empty window
    // (the owner relies on it arriving; a quiet window is itself the news). Digests stay gated.
    if (mode !== 'full' && !this.hasActivity()) return false;

    const text = (await askAgent(this.buildPrompt(mode))).trim();
    if (text === '' || /^NOTHING\b/i.test(text)) {
      this.reset(); // agent judged nothing worth reporting - drop the buffer quietly
      return false;
    }

    await output.send(text); // throws loudly on failure; buffer kept for retry (no-fallback)
    this.reset();
    return true;
  }

  private reset(): void {
    this.windowByChannel.clear();
    this.windowTotal = 0;
    this.fireAgg.clear();
    this.authored = 0;
    this.recalled.clear();
  }

  /** Public for testability. Aggregate window + fire activity + recalled memory -> agent prompt. */
  buildPrompt(mode: ReportMode): string {
    const channels = [...this.windowByChannel.entries()].sort((a, b) => b[1].count - a[1].count);
    const shown = channels.slice(0, MAX_CHANNELS_IN_PROMPT);
    const windowLines = shown.map(
      ([channelId, w]) => `- ${channelId}: ${w.count} msg(s); recent: ${w.excerpts.join(' | ') || '(none)'}`
    );
    if (channels.length > shown.length) {
      const restCount = channels.slice(shown.length).reduce((n, [, w]) => n + w.count, 0);
      windowLines.push(`- (+${channels.length - shown.length} more channel(s), ${restCount} msg(s))`);
    }

    const fireLines = [...this.fireAgg.values()].map(
      (f) => `- trigger "${f.kind}" fired ${f.count}x on ${f.channelId}; recalled: ${[...f.topics].join(', ') || '(none)'}`
    );
    const memoryLines = [...this.recalled.entries()].map(([topic, content]) => `- ${topic}: ${content}`);

    // M2.1 posture: the full report is a DUTY report (always arrives - a quiet window is
    // reported as quiet, the aliveness signal owners rely on); the digest defaults to briefing
    // and keeps NOTHING only for pure noise.
    const framing =
      mode === 'full'
        ? [
            'You are the operator agent. Write your scheduled FULLER situation report for your owner',
            'covering the whole window below (multiple channels, since the last full report). Group',
            "what recurred, what is new, and what needs the owner's attention. Plain language, no",
            'markdown tables. This scheduled report must ALWAYS arrive: if the window was quiet,',
            'say so in one or two lines instead of skipping.',
            'Structure the report with these sections (render the headings in the owner\'s language;',
            'omit a section only when it is truly empty):',
            '1) Key situation  2) Action required  3) Decisions needed  4) Pipeline  5) Next actions',
            ...(this.opts.selfGatherLines && this.opts.selfGatherLines.length > 0
              ? [
                  '',
                  'Before writing, ACTIVELY gather current context with your tools:',
                  ...this.opts.selfGatherLines.map((line) => `- ${line}`),
                  'Your tool findings are the primary source; the window summary below is only a hint.',
                ]
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
      'Reply in the language the owner uses on these channels if you can tell; otherwise English.',
      // Local wall-clock, not UTC: the first live report stamped itself in UTC because the
      // agent had no local time reference (Kagemusha injects local time the same way).
      `Current local time: ${new Date().toLocaleString()}. Use LOCAL time in the report, never UTC.`,
      '',
      'Window (per channel; excerpts truncated):',
      ...(windowLines.length > 0 ? windowLines : ['- (no channel messages this window)']),
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

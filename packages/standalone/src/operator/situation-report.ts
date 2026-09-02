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
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import {
  isArtifactProvenance,
  type ArtifactProvenance,
  type ReportCarryTarget,
} from './report-carry.js';
import {
  serializeOwnerReportContext,
  type OwnerReportContextV1,
  type ReportWindowEvidence,
} from './report-context.js';

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
  provenance?: ArtifactProvenance;
  target?: ReportCarryTarget;
  payloadIdentity?: string;
  occurrence?: {
    kind: 'digest' | 'scheduled_full' | 'on_demand_full';
    hourKey?: string;
    firedAtIso?: string;
  };
}

export interface DeliveredFullReport {
  mode: 'full';
  deliveryId: string;
  citedTriggerIds: string[];
  createdAtIso: string;
  deliveredAtIso: string;
  text: string;
  provenance: ArtifactProvenance;
  target?: ReportCarryTarget;
  payloadIdentity?: string;
  occurrence?: PreparedSituationReport['occurrence'];
}

/** Deterministic prompt-size bounds (mind memory + prompt length; see plan design decision 4). */
const MAX_EXCERPTS_PER_CHANNEL = 5;
const MAX_EXCERPT_CHARS = 160;
const MAX_CHANNELS_IN_PROMPT = 12;
const MAX_CHANNELS_IN_SNAPSHOT = MAX_CHANNELS_IN_PROMPT * 4;
const MAX_RECALLED = 20;
const MAX_FIRES_IN_SNAPSHOT = 100;
const MAX_SEEN_EVENT_KEYS = 10_000;
const SAFE_CHANNEL_LABELS = new Set([
  'calendar',
  'chatwork',
  'claude-code',
  'discord',
  'drive',
  'gmail',
  'imessage',
  'kagemusha',
  'notion',
  'obsidian',
  'sheets',
  'slack',
  'telegram',
  'trello',
]);

interface ChannelWindow {
  label: string;
  count: number;
  excerpts: SituationReportExcerpt[];
}

interface FireAgg {
  triggerId: string;
  kind: string;
  channelId: string;
  count: number;
  topics: Set<string>;
}

export interface SituationReportExcerpt {
  authorLabel: string;
  text: string;
  observedAt: string | null;
}

export interface SituationReporterSnapshotV1 {
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

export interface SituationReporterSnapshotV2 {
  version: 2;
  channels: Array<{
    channelId: string;
    label: string;
    count: number;
    excerpts: SituationReportExcerpt[];
  }>;
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

export type SituationReporterSnapshot = SituationReporterSnapshotV1 | SituationReporterSnapshotV2;

export interface SituationReporterOptions {
  /**
   * G2 success signal: called with the trigger ids the agent says it actually
   * drew on for the sent report (parsed from the stripped USED_TRIGGERS
   * trailer, validated against this window's fires). The wiring records
   * 'succeeded' outcomes so evolution finally gets a positive signal instead
   * of being elimination-only. Uncited fires stay NEUTRAL - not failures.
   */
  recordTriggerUse?: (triggerIds: string[]) => void;
  /** Reads the provenance of the run that just composed a FULL report. */
  fullReportProvenance?: () => ArtifactProvenance;
  /** Called only after a FULL report has definitely been delivered. */
  persistLastFullReport?: (report: DeliveredFullReport) => void;
}

/** Machine trailer the agent appends; stripped before the owner sees the report. */
const USED_TRIGGERS_PATTERN = /\n?^USED_TRIGGERS:\s*(.*)\s*$/im;

function legacyExcerpt(value: string): SituationReportExcerpt {
  return {
    authorLabel: 'unknown',
    text: value.slice(0, MAX_EXCERPT_CHARS),
    observedAt: null,
  };
}

function renderExcerpt(excerpt: SituationReportExcerpt): string {
  return excerpt.authorLabel === 'unknown'
    ? excerpt.text
    : `${excerpt.authorLabel}: ${excerpt.text}`;
}

function trustedChannelLabel(value: string): string {
  return SAFE_CHANNEL_LABELS.has(value) ? value : 'unknown';
}

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
      const w = this.windowByChannel.get(e.channelId) ?? {
        label: trustedChannelLabel(e.channel),
        count: 0,
        excerpts: [],
      };
      w.count += 1;
      const body = e.content.trim();
      if (body) {
        // userId is opaque by contract. Until ingress supplies a separately
        // trusted display label, every new excerpt keeps its author unknown.
        const observedAt = Number.isFinite(e.createdAt)
          ? new Date(e.createdAt).toISOString()
          : null;
        w.excerpts.push({
          authorLabel: 'unknown',
          text: body.slice(0, MAX_EXCERPT_CHARS),
          observedAt,
        });
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

  /** Host-authored bounded evidence for OwnerReportContextV1; raw channel and trigger IDs stay out. */
  windowEvidence(start: string, end: string): ReportWindowEvidence {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error('Invalid situation report evidence window');
    }
    const snapshot = this.snapshot();
    const triggerByKind = new Map<string, { count: number; topics: Set<string> }>();
    for (const fire of snapshot.fires) {
      const aggregate = triggerByKind.get(fire.kind) ?? { count: 0, topics: new Set<string>() };
      aggregate.count += fire.count;
      for (const topic of fire.topics) aggregate.topics.add(topic);
      triggerByKind.set(fire.kind, aggregate);
    }
    return {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      channelCount: snapshot.channels.length,
      messageCount: snapshot.windowTotal,
      channels: snapshot.channels
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
        .map((channel) => ({
          label: channel.label.slice(0, 160),
          count: channel.count,
          excerpts: channel.excerpts.map((excerpt) => ({ ...excerpt })),
        })),
      triggerActivity: [...triggerByKind.entries()]
        .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
        .map(([kind, aggregate]) => ({
          kind: kind.slice(0, 160),
          count: aggregate.count,
          topics: [...aggregate.topics].sort().map((topic) => topic.slice(0, 512)),
        })),
    };
  }

  snapshot(): SituationReporterSnapshotV2 {
    return {
      version: 2,
      channels: [...this.windowByChannel.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, MAX_CHANNELS_IN_SNAPSHOT)
        .map(([channelId, window]) => ({
          channelId: channelId.slice(0, 512),
          label: window.label.slice(0, 160),
          count: window.count,
          excerpts: window.excerpts.map((excerpt) => ({
            authorLabel: excerpt.authorLabel.slice(0, MAX_EXCERPT_CHARS),
            text: excerpt.text.slice(0, MAX_EXCERPT_CHARS),
            observedAt: excerpt.observedAt,
          })),
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
    if (snapshot.version !== 1 && snapshot.version !== 2) {
      throw new Error('Unsupported situation reporter snapshot version');
    }
    this.reset();
    if (snapshot.version === 2) {
      for (const channel of snapshot.channels.slice(0, MAX_CHANNELS_IN_SNAPSHOT)) {
        this.windowByChannel.set(channel.channelId, {
          label: channel.label,
          count: Math.max(0, channel.count),
          excerpts: channel.excerpts.slice(-MAX_EXCERPTS_PER_CHANNEL).map((excerpt) => ({
            authorLabel: excerpt.authorLabel.slice(0, MAX_EXCERPT_CHARS),
            text: excerpt.text.slice(0, MAX_EXCERPT_CHARS),
            observedAt: excerpt.observedAt,
          })),
        });
      }
    } else {
      for (const channel of snapshot.channels.slice(0, MAX_CHANNELS_IN_SNAPSHOT)) {
        const separator = channel.channelId.indexOf(':');
        const candidate = separator > 0 ? channel.channelId.slice(0, separator) : '';
        this.windowByChannel.set(channel.channelId, {
          label: trustedChannelLabel(candidate),
          count: Math.max(0, channel.count),
          excerpts: channel.excerpts.slice(-MAX_EXCERPTS_PER_CHANNEL).map(legacyExcerpt),
        });
      }
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
    deliveryId?: string,
    context?: OwnerReportContextV1
  ): Promise<PreparedSituationReport | null> {
    // M2.1: the scheduled FULL report is a duty report - it composes even on an empty window
    // (the owner relies on it arriving; a quiet window is itself the news). Digests stay gated.
    if (mode !== 'full' && !this.hasActivity()) return null;

    const raw = (
      await askAgent(
        mode === 'full' ? this.buildPrompt('full', context!) : this.buildPrompt('digest')
      )
    ).trim();
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

    const provenance =
      mode === 'full'
        ? (this.opts.fullReportProvenance?.() ?? {
            status: 'unavailable' as const,
            reason: 'no_run_handle' as const,
          })
        : undefined;
    if (provenance !== undefined && !isArtifactProvenance(provenance)) {
      throw new Error('Full owner report provenance is invalid');
    }

    return {
      mode,
      text,
      citedTriggerIds: cited,
      createdAtIso: new Date().toISOString(),
      ...(deliveryId ? { deliveryId } : {}),
      ...(provenance ? { provenance } : {}),
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
    // TG-06: persist carry only after the external send succeeds. The prepared
    // artifact, not mutable process state, owns both the delivery ID and run provenance.
    if (prepared.mode === 'full') {
      if (!prepared.deliveryId) {
        console.warn('[situation-report] skipped full-report carry: missing delivery id');
      } else if (!prepared.provenance) {
        console.warn('[situation-report] skipped full-report carry: missing provenance');
      } else {
        const report: DeliveredFullReport = {
          mode: 'full',
          deliveryId: prepared.deliveryId,
          citedTriggerIds: [...prepared.citedTriggerIds],
          createdAtIso: prepared.createdAtIso,
          deliveredAtIso: new Date().toISOString(),
          text: prepared.text,
          provenance: prepared.provenance,
          ...(prepared.target ? { target: prepared.target } : {}),
          ...(prepared.payloadIdentity ? { payloadIdentity: prepared.payloadIdentity } : {}),
          ...(prepared.occurrence ? { occurrence: prepared.occurrence } : {}),
        };
        try {
          this.opts.persistLastFullReport?.(report);
        } catch (error) {
          // Carry is derived state - persistence failure must not fail the delivered report.
          console.warn(
            `[situation-report] failed to persist last full report for context carry: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
    this.reset();
  }

  /**
   * TG-06: called by the report delivery boundary (ReportDeliveryPort) exactly
   * once per DELIVERED report. Credits the cited triggers and resets the
   * accumulation window. Retry/rejection/cancellation outcomes must NOT call
   * this - an undelivered report keeps its window and earns no credit.
   */
  markDeliveredOutcome(citedTriggerIds: readonly string[]): void {
    if (citedTriggerIds.length > 0) {
      this.opts.recordTriggerUse?.([...citedTriggerIds]);
    }
    this.reset();
  }

  /**
   * Detached, model-safe evidence for one full-report occurrence. Channel and author identities
   * were already reduced to trusted display labels when the window was recorded; raw ids and
   * recalled memory never cross this boundary.
   */
  buildWindowEvidence(start: string, end: string): ReportWindowEvidence {
    return {
      start,
      end,
      channelCount: this.windowByChannel.size,
      messageCount: this.windowTotal,
      channels: [...this.windowByChannel.values()]
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
        .map((channel) => ({
          label: channel.label,
          count: channel.count,
          excerpts: channel.excerpts.map((excerpt) => ({ ...excerpt })),
        })),
      triggerActivity: [...this.fireAgg.values()]
        .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind))
        .map((fire) => ({
          kind: fire.kind,
          count: fire.count,
          topics: [...fire.topics].sort(),
        })),
    };
  }

  async report(
    askAgent: AskAgent,
    output: Pick<OutputSink, 'send'>,
    mode: ReportMode,
    context?: OwnerReportContextV1
  ): Promise<boolean> {
    const prepared = await this.prepareReport(askAgent, mode, undefined, context);
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

  buildPrompt(mode: 'full', context: OwnerReportContextV1): string;
  buildPrompt(mode: 'digest'): string;
  /** Public for testability. Explicit full reports consume one packet; digests retain M2 framing. */
  buildPrompt(mode: ReportMode, context?: OwnerReportContextV1): string {
    if (mode === 'full' && context === undefined) {
      throw new Error('Owner report context is required for a full report');
    }
    if (mode === 'full' && context !== undefined) {
      const serialized = serializeOwnerReportContext(context);
      return [
        'You are the operator agent. Write the scheduled full situation report for the owner.',
        'Use the single canonical evidence packet below as the only factual report input.',
        'Explain what changed, what is open, what needs judgment, and state which source categories are incomplete.',
        'Do not infer task completion from an incomplete source or an absent Trello card.',
        'Never reproduce the packet JSON. Never emit internal IDs, tool syntax, or lifecycle metadata.',
        'Use plain language without markdown tables and answer in the owner language visible in the packet.',
        'Use these sections when non-empty: Key situation, Action required, Decisions needed, Pipeline, Next actions.',
        '',
        wrapUntrustedContent('owner-report-context', serialized),
      ].join('\n');
    }
    const channels = [...this.windowByChannel.entries()].sort((a, b) => b[1].count - a[1].count);
    const shown = channels.slice(0, MAX_CHANNELS_IN_PROMPT);
    const windowLines = shown.map(
      ([channelId, w]) =>
        `- ${channelId}: ${w.count} msg(s); recent: ${w.excerpts.map(renderExcerpt).join(' | ') || '(none)'}`
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

    const framing = [
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
      // agent had no local time reference; inject the runtime's local wall clock explicitly.
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

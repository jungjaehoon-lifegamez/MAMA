import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeConnectorState } from './connector-state.js';

import type { ConnectorRegistry } from './connector-registry.js';
import type { ChannelConfig, IConnector, NormalizedItem } from './types.js';
import type { PendingProjection, RawIndexSink, RawStore } from '../../storage/source-archive.js';
import type { WindowQueue } from '../../replay/window-queue.js';

export interface SourceObservationRef {
  connector: string;
  observationRef: string;
  sourceId: string;
  sourceEntityId: string;
  channel?: string;
  sourceAt: string;
  observedAt: string;
  contentHash: string | null;
  author?: string;
  /** Configured channel name, when the connector configuration has one. */
  channelName?: string;
  /** Source text for replay orientation (a Trello action as one line); source.read remains canonical. */
  contentPreview?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceDelta {
  kind: 'source_delta';
  collector: string;
  channel: string;
  coalesceKey: string;
  refs: readonly SourceObservationRef[];
  preview: readonly string[];
  /** Source occurrence time; replay deltas must never use host capture time. */
  occurredAt?: number;
  replay?: {
    runId: string;
    windowId: string;
    windowStartMs: number;
    windowEndMs: number;
    ledgerDigest?: readonly {
      commitmentId: string;
      revision: number;
      title: string | null;
      stage: string | null;
      status: string | null;
      assignee: string | null;
      lastEventTime: string | null;
    }[];
    queue?: WindowQueue;
    endInstructions?: string;
  };
}

export type RawBatchCommittedCallback = (delta: SourceDelta) => void | Promise<void>;

export interface PollingSchedulerOptions {
  initialLookbackMs?: number;
  rawIndexSink?: RawIndexSink;
  now?: () => number;
  initialNow?: number;
  recordPollOutcome?: (connectorName: string, outcome: { at: number; error?: string }) => void;
}

interface PollState {
  [connectorName: string]: string;
}

/** Convert a provider display name to the identity declared by connectors.json. */
export function canonicalChannelKey(
  item: Pick<NormalizedItem, 'source' | 'channel'>,
  channelConfigs: Record<string, Record<string, ChannelConfig>>
): string | null {
  const sourceConfigs = channelConfigs[item.source];
  if (!sourceConfigs) return null;
  const direct = sourceConfigs[item.channel];
  if (direct) return direct.role === 'ignore' ? null : item.channel;
  if (item.source === 'kagemusha' && item.channel.startsWith('kagemusha:')) {
    const configuredKey = item.channel.slice('kagemusha:'.length);
    const originSeparator = configuredKey.indexOf(':');
    const sourceKey =
      originSeparator < 0 ? configuredKey : configuredKey.slice(originSeparator + 1);
    const configured = sourceConfigs[configuredKey] ?? sourceConfigs[sourceKey];
    if (configured) return configured.role === 'ignore' ? null : item.channel;
  }
  const matched = Object.entries(sourceConfigs).find(([, config]) => config.name === item.channel);
  if (!matched || matched[1].role === 'ignore') return null;
  return matched[0];
}

/** Message text a live delta carries per item; the notify order shows up to 500 characters. */
const DELTA_TEXT_LIMIT = 1_000;

function boundedPreview(items: readonly NormalizedItem[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    for (const line of item.content.split(/\r?\n/).slice(0, 2)) {
      if (line.trim() === '') continue;
      lines.push(line.slice(0, 280));
      if (lines.length >= 8) return lines;
    }
  }
  return lines;
}

function sourceObservationRef(
  connector: string,
  item: NormalizedItem,
  observationRef: string
): SourceObservationRef {
  if (typeof item.observedAt !== 'number' || !Number.isFinite(item.observedAt)) {
    throw new Error('A committed source item must have a finite observation time');
  }
  const channelName =
    typeof item.metadata?.channelName === 'string' ? item.metadata.channelName : undefined;
  return {
    connector,
    observationRef,
    sourceId: item.sourceId,
    sourceEntityId: item.sourceEntityId ?? item.sourceId,
    channel: item.channel,
    sourceAt: item.timestamp.toISOString(),
    observedAt: new Date(item.observedAt).toISOString(),
    contentHash: item.contentHash ?? null,
    // The notify order carries each message inline, as Kagemusha's delta turn does; source.read
    // stays the full original.
    author: item.author,
    ...(channelName === undefined ? {} : { channelName }),
    contentPreview: item.content.slice(0, DELTA_TEXT_LIMIT),
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
  };
}

export class PollingScheduler {
  private readonly rawStore: RawStore;
  private readonly rawIndexSink?: RawIndexSink;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly initialNow: number;
  private readonly recordPollOutcome?: PollingSchedulerOptions['recordPollOutcome'];
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastPollTimes = new Map<string, Date>();
  private readonly inFlight = new Set<string>();
  private readonly initialLookbackMs: number;
  private polling = false;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();

  private track(work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const result = work();
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result)
    );
    return result;
  }

  constructor(rawStore: RawStore, basePath: string, options: PollingSchedulerOptions = {}) {
    this.rawStore = rawStore;
    this.rawIndexSink = options.rawIndexSink;
    this.stateFile = join(basePath, 'poll-state.json');
    this.now = options.now ?? Date.now;
    this.initialNow = options.initialNow ?? this.now();
    this.recordPollOutcome = options.recordPollOutcome;
    this.initialLookbackMs = options.initialLookbackMs ?? 86_400_000;
    this.restoreState();
  }

  private restoreState(): void {
    if (!existsSync(this.stateFile)) return;
    let state: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('poll state is not an object');
      }
      state = value as Record<string, unknown>;
    } catch (error) {
      // Each source then starts from its first-poll window; the file is kept for a look.
      const quarantine = `${this.stateFile}.corrupt-${this.now()}-${process.pid}`;
      renameSync(this.stateFile, quarantine);
      console.error(
        `[PollingScheduler] unreadable poll state quarantined at ${quarantine}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    for (const [name, value] of Object.entries(state)) {
      const candidate =
        typeof value === 'string'
          ? value
          : value &&
              typeof value === 'object' &&
              typeof (value as { lastPollTime?: unknown }).lastPollTime === 'string'
            ? (value as { lastPollTime: string }).lastPollTime
            : null;
      if (candidate === null) continue;
      const date = new Date(candidate);
      if (Number.isFinite(date.getTime()) && date.getTime() <= this.now() + 300_000) {
        this.lastPollTimes.set(name, date);
      }
    }
  }

  private persistState(): void {
    const state: PollState = {};
    for (const [name, date] of this.lastPollTimes) state[name] = date.toISOString();
    writeConnectorState(this.stateFile, state);
  }

  getLastPollTime(name: string): Date | undefined {
    return this.lastPollTimes.get(name);
  }

  resetPollState(name: string, since?: Date): void {
    if (since !== undefined && !Number.isFinite(since.getTime())) {
      throw new Error(`Invalid poll state for connector ${name}`);
    }
    if (since === undefined) this.lastPollTimes.delete(name);
    else this.lastPollTimes.set(name, since);
    this.persistState();
  }

  private async pollOne(
    name: string,
    connector: IConnector,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): Promise<void> {
    const since =
      this.lastPollTimes.get(name) ?? new Date(this.initialNow - this.initialLookbackMs);
    try {
      connector.beginPollHandoff?.();
      const pollStartedAt = this.now();
      const polled = await connector.poll(since, { hasCursor: this.lastPollTimes.has(name) });
      const observedAt = this.now();
      const canonicalItems = polled.flatMap((item) => {
        const channel = canonicalChannelKey(item, channelConfigs);
        if (channel === null) return [];
        const label = channelConfigs[item.source]?.[channel]?.name;
        return [
          {
            ...item,
            channel,
            observedAt,
            ...(label ? { metadata: { ...(item.metadata ?? {}), channelName: label } } : {}),
          },
        ];
      });
      // A connector's first snapshot of a new feed is indexed like any item but is not live work;
      // historical import pages use the raw store's collect-only path and stay for their import.
      const snapshotIds = new Set(
        canonicalItems.filter((item) => item.collectOnly === true).map((item) => item.sourceId)
      );
      if (canonicalItems.length > 0) this.rawStore.save(name, canonicalItems);

      const pending: PendingProjection[] = [];
      let afterSequence = 0;
      let page: PendingProjection[] = [];
      do {
        page = this.rawStore.listPendingProjections(name, 1000, afterSequence);
        pending.push(...page.filter((item) => !item.collectOnly));
        if (page.length === 1000) {
          afterSequence = page[page.length - 1]!.pendingProjectionId;
        }
      } while (page.length === 1000);
      if (pending.length > 0 && this.rawIndexSink === undefined) {
        throw new Error(`Raw index projection is not configured for connector ${name}`);
      }
      const observationRefs = new Map<string, string>();
      for (const item of pending) {
        const projections = await this.rawIndexSink!(name, [item]);
        if (projections.length !== 1) {
          throw new Error(
            `Raw index projection must return one observation ref for ${name}:${item.sourceId}`
          );
        }
        const projection = projections[0]!;
        if (
          projection.sourceId !== item.sourceId ||
          typeof projection.observationRef !== 'string' ||
          projection.observationRef.trim() === ''
        ) {
          throw new Error(
            `Raw index projection returned the wrong observation ref for ${name}:${item.sourceId}`
          );
        }
        observationRefs.set(item.sourceId, projection.observationRef);
      }

      const byChannel = new Map<string, NormalizedItem[]>();
      for (const item of pending.filter((row) => !snapshotIds.has(row.sourceId))) {
        const group = byChannel.get(item.channel) ?? [];
        group.push(item);
        byChannel.set(item.channel, group);
      }
      for (const [channel, items] of byChannel) {
        await onRawBatchCommitted({
          kind: 'source_delta',
          collector: name,
          channel,
          coalesceKey: `source:${name}:${channel}`,
          refs: items.map((item) => {
            const ref = observationRefs.get(item.sourceId);
            if (ref === undefined) {
              throw new Error(`Missing projected observation ref for ${name}:${item.sourceId}`);
            }
            return sourceObservationRef(name, item, ref);
          }),
          preview: boundedPreview(items),
        });
      }
      if (pending.length > 0) {
        this.rawStore.acknowledgeProjections(
          name,
          pending.map((item) => ({
            revisionSourceId: item.sourceId,
            pendingProjectionId: item.pendingProjectionId,
          }))
        );
      }
      await connector.commitPoll?.();
      this.lastPollTimes.set(name, new Date(pollStartedAt));
      this.recordPollOutcome?.(name, { at: this.now() });
    } catch (error) {
      console.error(`[PollingScheduler] poll failed for connector ${name}`, error);
      connector.abortPollHandoff?.();
      this.recordPollOutcome?.(name, {
        at: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  pollConnector(
    name: string,
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): Promise<void> {
    return this.track(() =>
      this.pollConnectorOnce(name, registry, channelConfigs, onRawBatchCommitted)
    );
  }

  private async pollConnectorOnce(
    name: string,
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): Promise<void> {
    if (this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      const connector = registry.get(name);
      if (!connector) throw new Error(`Connector is not registered: ${name}`);
      await this.pollOne(name, connector, channelConfigs, onRawBatchCommitted);
      this.persistState();
    } catch (error) {
      console.error(`[PollingScheduler] poll failed for connector ${name}`, error);
    } finally {
      this.inFlight.delete(name);
    }
  }

  pollAll(
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): Promise<void> {
    return this.track(() => this.pollAllOnce(registry, channelConfigs, onRawBatchCommitted));
  }

  private async pollAllOnce(
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [name, connector] of registry.getActive()) {
        if (this.stopped) break;
        if (this.inFlight.has(name)) continue;
        this.inFlight.add(name);
        try {
          await this.pollOne(name, connector, channelConfigs, onRawBatchCommitted);
        } finally {
          this.inFlight.delete(name);
        }
      }
      this.persistState();
    } catch (error) {
      console.error('[PollingScheduler] batch poll failed', error);
    } finally {
      this.polling = false;
    }
  }

  startBatch(
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    intervalMinutes: number,
    onRawBatchCommitted: RawBatchCommittedCallback
  ): void {
    if (this.stopped) throw new Error('Cannot start a stopped polling scheduler');
    void this.pollAll(registry, channelConfigs, onRawBatchCommitted);
    this.timers.set(
      '__batch__',
      setInterval(
        () => void this.pollAll(registry, channelConfigs, onRawBatchCommitted),
        intervalMinutes * 60_000
      )
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }
}

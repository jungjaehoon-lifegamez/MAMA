/**
 * PollingScheduler — drives periodic collection from all registered connectors.
 * Persists lastPollTime to basePath/poll-state.json for crash recovery.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { ConnectorRegistry } from './connector-registry.js';
import type { ChannelConfig, NormalizedItem } from './types.js';
import type { RawIndexSink, RawStore } from './raw-store.js';
import { classifyItemsByRole } from '../../memory/history-extractor.js';
import type { ClassifiedItems } from '../../memory/history-extractor.js';

type BatchExtractCallback = (classified: ClassifiedItems) => void | Promise<void>;

interface PollState {
  [connectorName: string]: string; // ISO timestamp
}

export class PollingScheduler {
  private readonly rawStore: RawStore;
  private readonly rawIndexSink?: RawIndexSink;
  private lastPollTimes = new Map<string, Date>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly stateFile: string;
  private isBatchRunning = false;
  /** Initial lookback for connectors with no saved state (default: 24h). Set to 0 for all history. */
  initialLookbackMs: number;

  constructor(
    rawStore: RawStore,
    basePath: string,
    options?: { initialLookbackMs?: number; rawIndexSink?: RawIndexSink }
  ) {
    this.rawStore = rawStore;
    this.rawIndexSink = options?.rawIndexSink;
    this.stateFile = join(basePath, 'poll-state.json');
    this.initialLookbackMs = options?.initialLookbackMs ?? 24 * 60 * 60 * 1000;
    this.restoreState();
  }

  private restoreState(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const raw = readFileSync(this.stateFile, 'utf8');
      const state = JSON.parse(raw) as PollState;
      for (const [name, iso] of Object.entries(state)) {
        this.lastPollTimes.set(name, new Date(iso));
      }
    } catch {
      // Corrupt state file — start fresh
    }
  }

  persistState(): void {
    const state: PollState = {};
    for (const [name, date] of this.lastPollTimes.entries()) {
      state[name] = date.toISOString();
    }
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  async pollAll(
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    onBatchExtract: BatchExtractCallback
  ): Promise<void> {
    if (this.isBatchRunning) {
      console.log('[connector] pollAll: skipping — previous batch still running');
      return;
    }
    this.isBatchRunning = true;
    try {
      console.log(`[connector] pollAll: ${registry.getActive().size} connectors`);
      const allItems: NormalizedItem[] = [];

      for (const [name, connector] of registry.getActive()) {
        const since =
          this.lastPollTimes.get(name) ??
          new Date(this.initialLookbackMs > 0 ? Date.now() - this.initialLookbackMs : 0);
        try {
          const items = await connector.poll(since);
          console.log(
            `[connector:${name}] polled ${items.length} items (since: ${since.toISOString()})`
          );
          if (items.length > 0) {
            this.rawStore.save(name, items);
            if (this.rawIndexSink) {
              await this.rawIndexSink(name, items);
            }
            allItems.push(...items);
          }
          // Only advance the cursor after a successful poll+save+index.
          this.lastPollTimes.set(name, new Date());
        } catch (err) {
          console.error(`[connector:${name}] poll error:`, err);
        }
      }

      console.log(`[connector] pollAll total: ${allItems.length} items`);
      if (allItems.length > 0) {
        const classified = classifyItemsByRole(allItems, channelConfigs, 'hub');
        console.log(
          `[connector] classified: truth=${classified.truth.length} activity=${classified.activity.length} spoke=${classified.spoke.length}`
        );
        await onBatchExtract(classified);
      }

      this.persistState();
    } finally {
      this.isBatchRunning = false;
    }
  }

  startBatch(
    registry: ConnectorRegistry,
    channelConfigs: Record<string, Record<string, ChannelConfig>>,
    intervalMinutes: number,
    onBatchExtract: BatchExtractCallback
  ): void {
    // Initial poll (fire-and-forget)
    this.pollAll(registry, channelConfigs, onBatchExtract).catch((err) =>
      console.error('[connector] initial batch poll error:', err)
    );
    // Periodic
    this.timers.set(
      '__batch__',
      setInterval(
        () =>
          this.pollAll(registry, channelConfigs, onBatchExtract).catch((err) =>
            console.error('[connector] batch poll error:', err)
          ),
        intervalMinutes * 60_000
      )
    );
  }

  getLastPollTime(name: string): Date | undefined {
    return this.lastPollTimes.get(name);
  }

  /** Reset poll cursor for a connector to re-ingest from a given date. */
  resetPollState(name: string, since?: Date): void {
    if (since) {
      this.lastPollTimes.set(name, since);
    } else {
      this.lastPollTimes.delete(name);
    }
    this.persistState();
    console.log(
      `[connector] Poll state reset for ${name}: ${since ? since.toISOString() : 'epoch'}`
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.rawStore?.close();
  }
}

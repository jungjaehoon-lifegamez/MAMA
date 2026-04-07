/**
 * PollingScheduler — drives periodic collection from all registered connectors.
 * Persists lastPollTime to basePath/poll-state.json for crash recovery.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { ConnectorRegistry } from './connector-registry.js';
import type { ChannelConfig, NormalizedItem } from './types.js';
import type { RawStore } from './raw-store.js';
import { classifyItemsByRole } from '../../memory/history-extractor.js';
import type { ClassifiedItems } from '../../memory/history-extractor.js';

type BatchExtractCallback = (classified: ClassifiedItems) => void | Promise<void>;

interface PollState {
  [connectorName: string]: string; // ISO timestamp
}

export class PollingScheduler {
  private readonly rawStore: RawStore;
  private lastPollTimes = new Map<string, Date>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly stateFile: string;
  private isBatchRunning = false;

  constructor(rawStore: RawStore, basePath: string) {
    this.rawStore = rawStore;
    this.stateFile = join(basePath, 'poll-state.json');
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
        const since = this.lastPollTimes.get(name) ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
        let success = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const items = await connector.poll(since);
            console.log(
              `[connector:${name}] polled ${items.length} items (since: ${since.toISOString()})`
            );
            if (items.length > 0) {
              this.rawStore.save(name, items);
              allItems.push(...items);
            }
            this.lastPollTimes.set(name, new Date());
            success = true;
            break;
          } catch (err) {
            console.error(
              `[connector:${name}] poll error (attempt ${attempt}/3):`,
              err instanceof Error ? err.message : err
            );
            if (attempt < 3) {
              const delay = attempt * 2000;
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        if (!success) {
          console.error(
            `[connector:${name}] all 3 retry attempts failed, skipping until next cycle`
          );
        }
      }

      console.log(`[connector] pollAll total: ${allItems.length} items`);
      if (allItems.length > 0) {
        // Query unextracted items from each connector's raw DB (extracted_at IS NULL)
        const unextractedItems: NormalizedItem[] = [];
        const connectorForItem = new Map<string, string>();
        for (const [name] of registry.getActive()) {
          // Use a wide window — the extracted_at IS NULL filter does the real dedup
          const fresh = this.rawStore.queryUnextracted(name, new Date(0));
          for (const item of fresh) {
            connectorForItem.set(item.sourceId, name);
          }
          unextractedItems.push(...fresh);
        }

        if (unextractedItems.length === 0) {
          console.log(`[connector] all ${allItems.length} items already extracted, skipping`);
        } else {
          if (unextractedItems.length < allItems.length) {
            console.log(
              `[connector] ${allItems.length - unextractedItems.length} already extracted, processing ${unextractedItems.length} new`
            );
          }
          const classified = classifyItemsByRole(unextractedItems, channelConfigs, 'hub');
          console.log(
            `[connector] classified: truth=${classified.truth.length} activity=${classified.activity.length} spoke=${classified.spoke.length}`
          );
          await onBatchExtract(classified);

          // Mark extracted in each connector's raw DB
          const byConnector = new Map<string, string[]>();
          for (const item of unextractedItems) {
            const cn = connectorForItem.get(item.sourceId) ?? item.source;
            const ids = byConnector.get(cn) ?? [];
            ids.push(item.sourceId);
            byConnector.set(cn, ids);
          }
          for (const [cn, ids] of byConnector) {
            this.rawStore.markExtracted(cn, ids);
          }
        }
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
    this.pollAll(registry, channelConfigs, onBatchExtract).catch((err) =>
      console.error('[connector] initial batch poll error:', err)
    );
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

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.rawStore?.close();
  }
}

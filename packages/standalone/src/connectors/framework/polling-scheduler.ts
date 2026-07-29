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
  [connectorName: string]: string; // ISO timestamp (current flat schema)
}

/**
 * Cursors this far past "now" are considered poisoned and rejected on restore.
 * Live incident (2026-07-09): a legacy runtime persisted cursor = max item timestamp,
 * which for the calendar connector (future-dated events) poisoned the cursor to 2056 -
 * every subsequent poll asked "since 2056" and returned 0 forever.
 */
const MAX_FUTURE_CURSOR_SKEW_MS = 5 * 60 * 1000;

/**
 * Parse one poll-state entry. Accepts the current flat ISO string and the legacy nested
 * `{ lastPollTime, channels }` object (written by an older runtime). Returns null for
 * anything unparseable, invalid, or future-poisoned - callers must warn loudly and start
 * that connector from the default lookback instead of silently storing an Invalid Date
 * (which used to detonate later as `RangeError: Invalid time value` in persistState).
 */
function parsePollStateEntry(value: unknown): Date | null {
  let iso: string | null = null;
  if (typeof value === 'string') {
    iso = value;
  } else if (typeof value === 'object' && value !== null) {
    const legacy = (value as { lastPollTime?: unknown }).lastPollTime;
    if (typeof legacy === 'string') {
      iso = legacy;
    }
  }
  if (iso === null) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  if (date.getTime() > Date.now() + MAX_FUTURE_CURSOR_SKEW_MS) {
    return null;
  }
  return date;
}

/**
 * The canonical key for a channel: the key the connector config declares it under.
 *
 * Connectors emit `item.channel` in whatever shape their upstream hands them, and measured
 * across the live index that is usually a DISPLAY NAME - Trello board names against a
 * config keyed by 24-character board ids, Slack channel names against a config keyed by
 * channel ids, and so on for six of seven connectors. `findChannelConfig` already absorbs
 * that by falling back to a name match, which is why nothing ever appeared broken: the
 * binding succeeded, and then the un-canonicalised name was written to the event index,
 * where every downstream reader compared it against the config KEY and matched nothing.
 * Zero of 30,671 rows were readable in production.
 *
 * So the accommodation moves to one place and produces one answer. Names are for people;
 * identity is the upstream's stable id, and this is where a name becomes one.
 *
 * Returns null when the channel is not configured at all - the honest answer, and the one
 * that keeps an unconfigured channel out of the index rather than inventing a key for it.
 */
export function canonicalChannelKey(
  item: Pick<NormalizedItem, 'source' | 'channel'>,
  channelConfigs: Record<string, Record<string, ChannelConfig>>
): string | null {
  const sourceConfigs = channelConfigs[item.source];
  if (!sourceConfigs) {
    return null;
  }
  if (sourceConfigs[item.channel]) {
    return item.channel;
  }
  const matched = Object.entries(sourceConfigs).find(([, cfg]) => cfg.name === item.channel);
  return matched ? matched[0] : null;
}

/**
 * `bindConfiguredScope` was here, and it never bound anything.
 *
 * It required `project_entity_id` on a channel config and produced a `project` scope. Zero
 * of the 39 configured channels on the live install declare that field, so it returned
 * every item unchanged for its whole life. What made this invisible was a one-off backfill
 * that had written `channel` scopes into the index: April is 100% scoped, the backfill
 * stopped on 2026-05-20, and from 05-21 onward every single event is unscoped. The live
 * write path had never bound a scope at all - the data only looked otherwise.
 *
 * Raw visibility is decided by the (connector, channel) grant now, which reads the key the
 * row already carries instead of a parallel namespace that had to be populated.
 */

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
      const state = JSON.parse(raw) as Record<string, unknown>;
      for (const [name, value] of Object.entries(state)) {
        const date = parsePollStateEntry(value);
        if (date === null) {
          console.error(
            `[connector] poll-state entry for "${name}" is corrupt or future-poisoned ` +
              `(${JSON.stringify(value).slice(0, 120)}) - ignoring it; "${name}" will poll ` +
              `from the default lookback window`
          );
          continue;
        }
        this.lastPollTimes.set(name, date);
      }
    } catch {
      // Corrupt state file — start fresh
    }
  }

  persistState(): void {
    const state: PollState = {};
    for (const [name, date] of this.lastPollTimes.entries()) {
      if (Number.isNaN(date.getTime())) {
        // Fail loud with the connector name instead of a cryptic RangeError mid-write.
        throw new Error(`[connector] refusing to persist invalid poll cursor for "${name}"`);
      }
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
            const scopedItems = items.map((item) => {
              // Canonicalise BEFORE anything durable is written. Storing the display name
              // is what made the index unreadable; a name that reached storage was never
              // going to be reconciled afterwards, because nothing downstream could tell
              // it apart from an id.
              const canonical = canonicalChannelKey(item, channelConfigs);
              return canonical === null ? item : { ...item, channel: canonical };
            });
            this.rawStore.save(name, scopedItems);
            if (this.rawIndexSink) {
              await this.rawIndexSink(name, scopedItems);
            }
            allItems.push(...scopedItems);
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
      if (Number.isNaN(since.getTime())) {
        throw new Error(`[connector] resetPollState("${name}"): invalid Date`);
      }
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

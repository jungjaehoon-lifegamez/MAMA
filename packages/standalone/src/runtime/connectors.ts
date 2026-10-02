import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { loadConnector, LOADABLE_CONNECTORS } from '../connectors/index.js';
import {
  loadConnectorConfig,
  type ConnectorConfigLoadResult,
} from '../connectors/config-loader.js';
import { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import type { TimeZoneSetting } from './timezone.js';
import {
  PollingScheduler,
  type RawBatchCommittedCallback,
} from '../connectors/framework/polling-scheduler.js';
import {
  RawStore,
  mapNormalizedItemsToConnectorEventIndexInputs,
  type RawIndexProjection,
  type RawIndexSink,
} from '../storage/source-archive.js';
import {
  recordConnectorPollOutcome,
  upsertConnectorEventIndex,
} from '../connectors/framework/event-index.js';

const ONE_DAY_MS = 86_400_000;

export interface ConnectorRuntimeOptions {
  configPath: string;
  wikiRoot?: string;
  rawPath: string;
  statePath: string;
  kagemushaDbPath?: string;
  clock?: () => number;
  rawStore?: RawStore;
  coreAdapter?: DatabaseInstance;
  rawIndexSink?: RawIndexSink;
  acceptSourceDelta: RawBatchCommittedCallback;
  loadConnector?: typeof loadConnector;
  setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  configResult?: ConnectorConfigLoadResult;
  timeZone: TimeZoneSetting;
}

export interface ConnectorRuntime {
  readonly registry: ConnectorRegistry;
  readonly scheduler: PollingScheduler;
  readonly enabledConnectorNames: readonly string[];
  readonly channelCounts: Readonly<Record<string, number>>;
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

function assertFence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Connector poll fence must be a nonnegative epoch-millisecond integer');
  }
}

/** Set the next live poll start without loading or polling any connector. */
export function setLiveConnectorPollCursors(options: {
  configPath: string;
  statePath: string;
  fenceMs: number;
}): void {
  assertFence(options.fenceMs);
  const loaded = configurationOrThrow(loadConnectorConfig(options.configPath));
  const stateFile = join(options.statePath, 'poll-state.json');
  let state: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        `Connector poll state is unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Connector poll state must contain an object');
    }
    state = parsed as Record<string, unknown>;
  }
  const fence = new Date(options.fenceMs).toISOString();
  for (const name of loaded.enabledNames) state[name] = fence;
  mkdirSync(options.statePath, { recursive: true });
  const temporaryPath = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, stateFile);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function coreIndexSink(adapter: DatabaseInstance): RawIndexSink {
  return (connectorName, items) => {
    return mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items).map((input) => {
      const record = upsertConnectorEventIndex(adapter, input);
      const observationRef = record.current_observation_id;
      if (observationRef === null || observationRef.trim() === '') {
        throw new Error(
          `Connector index projection omitted current observation ref for ${connectorName}:${input.source_id}`
        );
      }
      const projection: RawIndexProjection = {
        sourceId: input.source_id,
        observationRef,
      };
      return projection;
    });
  };
}

function configurationOrThrow(
  result: ConnectorConfigLoadResult
): Extract<ConnectorConfigLoadResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

export async function startConnectorRuntime(
  options: ConnectorRuntimeOptions
): Promise<ConnectorRuntime> {
  const config = configurationOrThrow(
    options.configResult ?? loadConnectorConfig(options.configPath)
  );
  const supported = new Set<string>(LOADABLE_CONNECTORS);
  const enabledConnectorNames = config.enabledNames.filter((name) => supported.has(name));
  if (options.wikiRoot && enabledConnectorNames.includes('obsidian')) {
    const inside = (parent: string, child: string): boolean => {
      const path = relative(resolve(parent), resolve(child));
      return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    };
    for (const [channel, setting] of Object.entries(config.config.obsidian?.channels ?? {})) {
      if (
        setting.role !== 'ignore' &&
        setting.vaultPath &&
        inside(setting.vaultPath, options.wikiRoot)
      ) {
        throw new Error(
          `Obsidian vault channel ${channel} contains the configured wiki root; MAMA wiki writes would feed back as source deltas`
        );
      }
    }
  }
  const pollIntervals = new Map<string, number>();
  for (const name of enabledConnectorNames) {
    const interval = config.config[name]?.pollIntervalMinutes;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
      throw new Error(
        `Invalid poll interval for connector ${name}: expected a finite positive number`
      );
    }
    pollIntervals.set(name, interval * 60_000);
  }
  const channelConfigs = Object.fromEntries(
    enabledConnectorNames.map((name) => [name, config.config[name]?.channels ?? {}])
  );
  const registry = new ConnectorRegistry();
  const load = options.loadConnector ?? loadConnector;
  const rawStore = options.rawStore ?? new RawStore(options.rawPath);
  const ownsRawStore = options.rawStore === undefined;
  const clock = options.clock ?? Date.now;
  const bootstrapNow = clock();
  const indexSink =
    options.rawIndexSink ??
    (options.coreAdapter === undefined ? undefined : coreIndexSink(options.coreAdapter));
  if (indexSink === undefined) {
    if (ownsRawStore) rawStore.close();
    throw new Error('Connector runtime requires a core index projection port');
  }

  try {
    for (const name of enabledConnectorNames) {
      const connectorStatePath = [
        'calendar',
        'ical',
        'drive',
        'sheets',
        'discord',
        'telegram',
      ].includes(name)
        ? join(options.statePath, `${name}-state.json`)
        : undefined;
      const connector = await load(name, config.config[name], {
        kagemushaDbPath: options.kagemushaDbPath,
        ...(connectorStatePath === undefined ? {} : { connectorStatePath }),
        timeZone: options.timeZone,
      });
      await connector.init();
      registry.register(name, connector);
    }

    const scheduler = new PollingScheduler(rawStore, options.statePath, {
      rawIndexSink: indexSink,
      ...(options.coreAdapter === undefined
        ? {}
        : {
            recordPollOutcome: (connectorName, outcome) =>
              recordConnectorPollOutcome(options.coreAdapter!, connectorName, outcome),
          }),
      initialLookbackMs: ONE_DAY_MS,
      now: clock,
      initialNow: bootstrapNow,
    });
    const accept = options.acceptSourceDelta;
    await scheduler.pollAll(registry, channelConfigs, accept);

    const setIntervalFn = options.setInterval ?? setInterval;
    const clearIntervalFn = options.clearInterval ?? clearInterval;
    const timers: Array<
      [ReturnType<typeof setInterval>, (timer: ReturnType<typeof setInterval>) => void]
    > = [];
    for (const name of enabledConnectorNames) {
      const timer = setIntervalFn(
        () => void scheduler.pollConnector(name, registry, channelConfigs, accept),
        pollIntervals.get(name)!
      );
      timers.push([timer, clearIntervalFn]);
    }

    let stopped = false;
    return {
      registry,
      scheduler,
      enabledConnectorNames,
      channelCounts: Object.fromEntries(
        enabledConnectorNames.map((name) => [name, Object.keys(channelConfigs[name] ?? {}).length])
      ),
      pollNow: () => scheduler.pollAll(registry, channelConfigs, accept),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        for (const [timer, clear] of timers) clear(timer);
        scheduler.stop();
        await registry.disposeAll();
        if (ownsRawStore) rawStore.close();
      },
    };
  } catch (error) {
    await registry.disposeAll();
    if (ownsRawStore) rawStore.close();
    throw error;
  }
}

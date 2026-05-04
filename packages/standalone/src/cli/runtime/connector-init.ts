/**
 * Connector framework initialization for MAMA OS.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Loads ~/.mama/connectors.json
 *   2. Auto-enables claude-code connector (local, no auth needed)
 *   3. Builds per-source channel config map
 *      (kagemusha channels are distributed by source prefix)
 *   4. Instantiates each enabled connector (loadConnector + init + register)
 *   5. Runs M0 LLM extraction kill switch plus deterministic raw-backed memory indexing
 *   6. Starts connectorScheduler.startBatch() with unified 60-min polling
 *   7. Returns rawStore + enabledConnectorNames + connectorSchedulerStop for the caller
 *
 * Direct LLM connector-to-memory extraction is disabled in M0. The surviving
 * write paths here are entityObservationStore.upsertEntityObservations() and
 * deterministic raw-backed memory indexing with source evidence links.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';

import {
  mapNormalizedItemsToConnectorEventIndexInputs,
  type RawIndexSink,
  type RawStore,
} from '../../connectors/framework/raw-store.js';

const logger = new DebugLogger('connector-init');

/**
 * Result returned by initConnectors.
 */
export interface ConnectorInitResult {
  rawStoreForApi: RawStore | undefined;
  enabledConnectorNames: string[];
  /** Stop function for connectorScheduler; undefined if no connectors are active. */
  connectorSchedulerStop: (() => void) | undefined;
}

/**
 * Initialize the connector framework.
 *
 * Reads ~/.mama/connectors.json, registers enabled connectors,
 * wires connector polling with the M0 LLM extraction kill switch, and starts polling.
 *
 * @deprecated The legacy direct LLM connector-to-memory extraction argument is ignored in M0.
 * Callers should pass null and rely on the raw/entity-observation connector pipeline.
 */
export async function initConnectors(
  /** @deprecated Direct LLM connector-to-memory extraction is disabled in M0. */
  _connectorExtractionFn: ((prompt: string) => Promise<string>) | null
): Promise<ConnectorInitResult> {
  const connectorsConfigPath = join(homedir(), '.mama', 'connectors.json');
  let enabledConnectorNames: string[] = [];

  const { ConnectorRegistry, PollingScheduler, RawStore } =
    await import('../../connectors/framework/index.js');
  const { loadConnector } = await import('../../connectors/index.js');
  const { buildProjectTruth, groupByChannel, buildEntityObservations } =
    await import('../../memory/history-extractor.js');
  const { ingestRawBackedMemoryCandidates } =
    await import('../../memory/raw-backed-memory-ingest.js');
  const { MODEL_NAME } = await import('@jungjaehoon/mama-core');
  const mamaCore = (await import('@jungjaehoon/mama-core')) as unknown as {
    getAdapter?: () => Parameters<
      typeof import('@jungjaehoon/mama-core/connectors/event-index').upsertConnectorEventIndex
    >[0];
    upsertConnectorEventIndex?: typeof import('@jungjaehoon/mama-core/connectors/event-index').upsertConnectorEventIndex;
    upsertEntityObservations?: (inputs: EntityObservationDraft[]) => Promise<unknown>;
  };
  const entityObservationStore = mamaCore;
  type ConnectorsJson = import('../../connectors/framework/types.js').ConnectorsConfig;
  type ChannelConfigMap = import('../../connectors/framework/types.js').ChannelConfig;
  type NormalizedItem = import('../../connectors/framework/types.js').NormalizedItem;
  type EntityObservationDraft = import('../../memory/history-extractor.js').EntityObservationDraft;

  const findChannelConfigForGroup = (
    channelKey: string,
    channelItems: NormalizedItem[]
  ): (ChannelConfigMap & Record<string, unknown>) | undefined => {
    const first = channelItems[0];
    if (!first) {
      return undefined;
    }
    const sourceConfigs = allChannelConfigs[first.source];
    const direct = sourceConfigs?.[first.channel] ?? sourceConfigs?.[channelKey];
    if (direct) {
      return direct as ChannelConfigMap & Record<string, unknown>;
    }
    if (!sourceConfigs) {
      return undefined;
    }
    return Object.values(sourceConfigs).find(
      (cfg) => cfg.name === first.channel || cfg.name === channelKey
    ) as (ChannelConfigMap & Record<string, unknown>) | undefined;
  };

  const mapEntityObservationIdsBySourceId = (
    observations: EntityObservationDraft[]
  ): Map<string, string[]> => {
    const idsBySourceId = new Map<string, string[]>();
    for (const observation of observations) {
      const existing = idsBySourceId.get(observation.source_raw_record_id) ?? [];
      existing.push(observation.id);
      idsBySourceId.set(observation.source_raw_record_id, existing);
    }
    return idsBySourceId;
  };

  let connectorsConfig: ConnectorsJson;
  if (existsSync(connectorsConfigPath)) {
    try {
      connectorsConfig = JSON.parse(readFileSync(connectorsConfigPath, 'utf-8')) as ConnectorsJson;
    } catch (err) {
      console.error(`[connector] failed to parse connectors.json:`, err);
      connectorsConfig = {} as ConnectorsJson;
    }
  } else {
    connectorsConfig = {} as ConnectorsJson;
  }

  // Auto-enable claude-code connector (local, no auth needed)
  if (!connectorsConfig['claude-code']) {
    connectorsConfig['claude-code'] = {
      enabled: true,
      pollIntervalMinutes: 30,
      channels: {},
      auth: { type: 'none' },
    };
    console.log(`[connector] claude-code auto-enabled (local transcript polling)`);
  }

  const connectorRegistry = new ConnectorRegistry();
  const rawStore = new RawStore(join(homedir(), '.mama', 'connectors'));
  const rawIndexSink: RawIndexSink | undefined =
    typeof mamaCore.getAdapter === 'function' &&
    typeof mamaCore.upsertConnectorEventIndex === 'function'
      ? async (connectorName, items) => {
          const adapter = mamaCore.getAdapter?.();
          if (!adapter || typeof mamaCore.upsertConnectorEventIndex !== 'function') {
            throw new Error('[connector] unified raw index unavailable from mama-core');
          }
          for (const input of mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items)) {
            mamaCore.upsertConnectorEventIndex(adapter, input);
          }
        }
      : undefined;

  // Build channel configs for role classification
  // For kagemusha connector, channels are keyed as "source:channelId" (e.g., "chatwork:ROOM_ID")
  // but items have source=row.channel (e.g., "chatwork") and channel=row.channel_id (e.g., "chatwork:ROOM_ID")
  // So we need to distribute kagemusha channel configs by their source prefix
  const allChannelConfigs: Record<string, Record<string, ChannelConfigMap>> = {};
  for (const [name, cc] of Object.entries(connectorsConfig)) {
    if (name === 'kagemusha') {
      // Distribute kagemusha channels by source prefix
      for (const [channelKey, channelCfg] of Object.entries(cc.channels ?? {})) {
        const [source] = channelKey.split(':');
        if (!allChannelConfigs[source]) allChannelConfigs[source] = {};
        allChannelConfigs[source][channelKey] = channelCfg;
      }
    } else {
      allChannelConfigs[name] = cc.channels ?? {};
    }
  }

  for (const [name, connConfig] of Object.entries(connectorsConfig)) {
    if (!connConfig.enabled) continue;
    try {
      const connector = await loadConnector(name, connConfig);
      await connector.init();
      connectorRegistry.register(name, connector);
      console.log(`[connector] ${name} initialized`);
    } catch (err) {
      console.error(`[connector] ${name} failed to init:`, err);
    }
  }

  // Expose rawStore + enabled connector names for API server
  const rawStoreForApi: RawStore = rawStore;
  enabledConnectorNames = Array.from(connectorRegistry.getActive().keys());

  if (connectorRegistry.getActive().size > 0) {
    const connectorScheduler = new PollingScheduler(
      rawStore,
      join(homedir(), '.mama', 'connectors'),
      { rawIndexSink }
    );

    const observationExtractorVersion = 'history-extractor@v1';
    const rawDbRefForSource = (source: string): string => {
      return join(homedir(), '.mama', 'connectors', source, 'raw.db');
    };

    const extractAndSave = async (
      label: string,
      groups: Map<string, NormalizedItem[]>
    ): Promise<void> => {
      for (const [channelKey, channelItems] of groups) {
        try {
          const observations = buildEntityObservations(channelItems, {
            extractorVersion: observationExtractorVersion,
            embeddingModelVersion: MODEL_NAME,
            rawDbRefForSource,
          });
          if (typeof entityObservationStore.upsertEntityObservations === 'function') {
            if (observations.length > 0) {
              await entityObservationStore.upsertEntityObservations(
                observations as EntityObservationDraft[]
              );
            }
          }
          const rawMemoryResult = await ingestRawBackedMemoryCandidates(channelItems, {
            channelConfig: findChannelConfigForGroup(channelKey, channelItems),
            entityObservationIdsBySourceId: mapEntityObservationIdsBySourceId(
              observations as EntityObservationDraft[]
            ),
          });
          logger.debug('[m0-kill-switch] direct LLM connector->memory write disabled', {
            label,
            channelKey,
            itemCount: channelItems.length,
            rawBackedMemorySaved: rawMemoryResult.saved,
            rawBackedMemorySkippedExisting: rawMemoryResult.skippedExisting,
            reason: 'direct_llm_connector_to_memory_write_disabled',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[connector] ${label}:${channelKey} extraction failed while running ` +
              'buildEntityObservations/entityObservationStore.upsertEntityObservations/' +
              'ingestRawBackedMemoryCandidates: ' +
              message,
            { cause: err }
          );
        }
      }
    };

    connectorScheduler.startBatch(
      connectorRegistry,
      allChannelConfigs,
      60, // unified polling interval (minutes)
      async ({ truth, activity, spoke }) => {
        // Pass 0: Truth → ProjectTruth (no LLM)
        const projectTruth = buildProjectTruth(truth);
        if (truth.length > 0) {
          console.log(
            `[connector] truth snapshot: ${Object.keys(projectTruth.projects).length} projects`
          );
        }

        // Pass 1: Activity extraction with truth context
        if (activity.length > 0) {
          const activityGroups = groupByChannel(activity);
          console.log(
            `[connector] activity: ${activity.length} items in ${activityGroups.size} channels`
          );
          await extractAndSave('activity', activityGroups);
        }

        // Pass 2: Spoke extraction with project context
        if (spoke.length > 0) {
          const spokeGroups = groupByChannel(spoke);
          console.log(`[connector] spoke: ${spoke.length} items in ${spokeGroups.size} channels`);
          await extractAndSave('spoke', spokeGroups);
        }
      }
    );

    console.log(`[connector] ${connectorRegistry.getActive().size} connectors active`);

    return {
      rawStoreForApi,
      enabledConnectorNames,
      connectorSchedulerStop: () => connectorScheduler.stop(),
    };
  }

  return { rawStoreForApi, enabledConnectorNames, connectorSchedulerStop: undefined };
}

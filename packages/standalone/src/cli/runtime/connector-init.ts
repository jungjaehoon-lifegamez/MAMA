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
 *   5. Defines extractAndSave() pipeline and 3-pass extraction orchestration
 *   6. Starts connectorScheduler.startBatch() with unified 60-min polling
 *   7. Returns rawStore + enabledConnectorNames + connectorSchedulerStop for the caller
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RawStore } from '../../connectors/framework/raw-store.js';

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
 * wires the 3-pass extraction pipeline, and starts polling.
 */
export async function initConnectors(
  connectorExtractionFn: ((prompt: string) => Promise<string>) | null
): Promise<ConnectorInitResult> {
  const connectorsConfigPath = join(homedir(), '.mama', 'connectors.json');
  let enabledConnectorNames: string[] = [];

  const { ConnectorRegistry, PollingScheduler, RawStore } =
    await import('../../connectors/framework/index.js');
  const { loadConnector } = await import('../../connectors/index.js');
  const {
    buildProjectTruth,
    buildActivityExtractionPrompt,
    buildSpokeExtractionPrompt,
    groupByChannel,
    buildEntityObservations,
  } = await import('../../memory/history-extractor.js');
  const { saveMemory, MEMORY_KINDS, MODEL_NAME } = await import('@jungjaehoon/mama-core');
  const entityObservationStore = (await import('@jungjaehoon/mama-core')) as unknown as {
    upsertEntityObservations?: (inputs: EntityObservationDraft[]) => Promise<unknown>;
  };
  type MemoryKind = import('@jungjaehoon/mama-core').MemoryKind;
  type ConnectorsJson = import('../../connectors/framework/types.js').ConnectorsConfig;
  type ChannelConfigMap = import('../../connectors/framework/types.js').ChannelConfig;
  type NormalizedItem = import('../../connectors/framework/types.js').NormalizedItem;
  type EntityObservationDraft = import('../../memory/history-extractor.js').EntityObservationDraft;

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
      join(homedir(), '.mama', 'connectors')
    );

    const validKinds = new Set<string>(MEMORY_KINDS);
    const observationExtractorVersion = 'history-extractor@v1';
    const rawDbRefForSource = (source: string): string => {
      return join(homedir(), '.mama', 'connectors', source, 'raw.db');
    };

    const extractAndSave = async (
      label: string,
      groups: Map<string, NormalizedItem[]>,
      buildPrompt: (items: NormalizedItem[]) => string
    ): Promise<void> => {
      for (const [channelKey, channelItems] of groups) {
        try {
          if (typeof entityObservationStore.upsertEntityObservations === 'function') {
            const observations = buildEntityObservations(channelItems, {
              extractorVersion: observationExtractorVersion,
              embeddingModelVersion: MODEL_NAME,
              rawDbRefForSource,
            });
            if (observations.length > 0) {
              await entityObservationStore.upsertEntityObservations(
                observations as EntityObservationDraft[]
              );
            }
          }
          const prompt = buildPrompt(channelItems);
          if (prompt.length > 20000) {
            console.log(
              `[connector] ${label}:${channelKey} skipped (prompt too large: ${prompt.length})`
            );
            continue;
          }
          if (!connectorExtractionFn) throw new Error('Extraction not available');
          const responseText = await connectorExtractionFn(prompt);
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const extracted = JSON.parse(jsonMatch[0]) as Array<{
              project?: string;
              work_unit?: string;
              kind?: string;
              topic?: string;
              summary?: string;
              reasoning?: string;
              event_date?: string;
              confidence?: number;
            }>;
            for (const item of extracted) {
              if (!item.topic || !item.summary) continue;
              const projectName = item.project ?? 'unknown';
              const topicStr = item.work_unit
                ? `${projectName}/${item.work_unit}`
                    .toLowerCase()
                    .replace(/[^a-z0-9가-힣_/]+/g, '_')
                : `${projectName}/${item.topic}`.toLowerCase().replace(/[^a-z0-9가-힣_/]+/g, '_');
              await saveMemory({
                topic: topicStr,
                kind: (validKinds.has(item.kind ?? '') ? item.kind : 'fact') as MemoryKind,
                summary: item.summary,
                details: item.reasoning ?? item.summary,
                confidence: Math.max(0, Math.min(1, item.confidence ?? 0.7)),
                scopes: [{ kind: 'project', id: projectName }],
                source: { package: 'standalone', source_type: 'connector' },
                eventDate: item.event_date ?? new Date().toISOString().split('T')[0],
              });
            }
            console.log(`[connector] ${label}:${channelKey}: ${extracted.length} memories saved`);
          }
        } catch (err) {
          console.error(`[connector] ${label}:${channelKey} extraction failed:`, err);
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
          await extractAndSave('activity', activityGroups, (items) =>
            buildActivityExtractionPrompt(items, projectTruth)
          );
        }

        // Pass 2: Spoke extraction with project context
        if (spoke.length > 0) {
          const hubContext = Object.entries(projectTruth.projects).flatMap(([proj, p]) =>
            Object.entries(p.workUnits).map(([wu, state]) => ({
              project: proj,
              workUnit: wu,
              assignedTo: state.assigned,
              status: state.status,
            }))
          );
          const spokeGroups = groupByChannel(spoke);
          console.log(`[connector] spoke: ${spoke.length} items in ${spokeGroups.size} channels`);
          await extractAndSave('spoke', spokeGroups, (items) =>
            buildSpokeExtractionPrompt(items, hubContext, projectTruth)
          );
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

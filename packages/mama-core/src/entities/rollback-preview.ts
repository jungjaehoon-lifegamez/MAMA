import { getAdapter, initDB } from '../db-manager.js';
import { projectEntityToRecallSummary } from './projection.js';
import { getEntityNode, listEntityAliases, type EntityStoreAdapter } from './store.js';
import { listActiveEntityLineage, listEntityLineageHistory } from './lineage-store.js';
import type { EntityLineageLink, EntityNode, EntityTimelineEvent } from './types.js';

export interface RollbackPreviewInput {
  entityId: string;
  mergeActionId?: string;
  observationId?: string;
  maxAffectedRows?: number;
}

export interface RollbackPreviewEntityChange {
  entity_id: string;
  label: string;
  status_after: 'active' | 'merged';
  active_lineage_after: number;
  summary: string;
}

export interface RollbackPreviewMemoryChange {
  id: string;
  topic: string;
  summary: string;
  created_at: number;
}

export interface RollbackPreviewMetricMovement {
  metric: 'false_merge_rate' | 'projection_fragmentation_rate';
  direction: 'increase' | 'decrease';
  reason: string;
}

export interface RollbackPreviewResult {
  entity_id: string;
  merge_action_id: string | null;
  preview_unavailable: boolean;
  history_incomplete: boolean;
  truncated: boolean;
  changed_entities: RollbackPreviewEntityChange[];
  changed_memories: RollbackPreviewMemoryChange[];
  metric_movement: RollbackPreviewMetricMovement[];
}

interface MergeActionRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  created_at: number;
}

function unavailableResult(
  entityId: string,
  mergeActionId: string | null,
  historyIncomplete: boolean
): RollbackPreviewResult {
  return {
    entity_id: entityId,
    merge_action_id: mergeActionId,
    preview_unavailable: true,
    history_incomplete: historyIncomplete,
    truncated: false,
    changed_entities: [],
    changed_memories: [],
    metric_movement: [],
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function getLatestTimeline(
  adapter: EntityStoreAdapter,
  entityId: string
): EntityTimelineEvent | null {
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM entity_timeline_events
        WHERE entity_id = ?
        ORDER BY COALESCE(observed_at, created_at) DESC
        LIMIT 1
      `
    )
    .get(entityId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    event_type: row.event_type as EntityTimelineEvent['event_type'],
    role: typeof row.role === 'string' ? row.role : null,
    valid_from: typeof row.valid_from === 'number' ? row.valid_from : null,
    valid_to: typeof row.valid_to === 'number' ? row.valid_to : null,
    observed_at: typeof row.observed_at === 'number' ? row.observed_at : null,
    source_ref: typeof row.source_ref === 'string' ? row.source_ref : null,
    summary: String(row.summary ?? ''),
    details: typeof row.details === 'string' ? row.details : null,
    created_at: Number(row.created_at),
  };
}

const DEFAULT_MAX_AFFECTED_ROWS = 50;

function normalizeMaxAffectedRows(input: RollbackPreviewInput): number {
  return Math.max(1, input.maxAffectedRows ?? DEFAULT_MAX_AFFECTED_ROWS);
}

function projectLabel(adapter: EntityStoreAdapter, node: EntityNode): string {
  const summary = projectEntityToRecallSummary(
    node,
    listEntityAliases(node.id, adapter),
    getLatestTimeline(adapter, node.id),
    { nodeLookup: { [node.id]: node } }
  );
  return summary.summary;
}

function loadMergeAction(
  adapter: EntityStoreAdapter,
  entityId: string,
  mergeActionId?: string
): MergeActionRow | null {
  const sql = mergeActionId
    ? `
        SELECT id, source_entity_id, target_entity_id, created_at
        FROM entity_merge_actions
        WHERE id = ?
          AND (source_entity_id = ? OR target_entity_id = ?)
        LIMIT 1
      `
    : `
        SELECT id, source_entity_id, target_entity_id, created_at
        FROM entity_merge_actions
        WHERE target_entity_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `;
  const row = (
    mergeActionId
      ? adapter.prepare(sql).get(mergeActionId, entityId, entityId)
      : adapter.prepare(sql).get(entityId)
  ) as MergeActionRow | undefined;
  return row ?? null;
}

function resolveMergePreviewRows(input: {
  sourceHistory: EntityLineageLink[];
  targetActive: EntityLineageLink[];
  sourceEntityId: string;
}): { restoredRows: EntityLineageLink[]; removedRows: EntityLineageLink[] } {
  const restoredRows = input.sourceHistory.filter((row) => row.status === 'superseded');
  let removedRows = input.targetActive.filter(
    (row) => row.source_entity_id === input.sourceEntityId
  );

  if (removedRows.length === 0 && restoredRows.length > 0) {
    const restorableObservationIds = new Set(restoredRows.map((row) => row.entity_observation_id));
    removedRows = input.targetActive.filter((row) =>
      restorableObservationIds.has(row.entity_observation_id)
    );
  }

  return { restoredRows, removedRows };
}

function loadChangedMemories(
  adapter: EntityStoreAdapter,
  observationIds: string[]
): RollbackPreviewMemoryChange[] {
  if (observationIds.length === 0) {
    return [];
  }

  const placeholders = observationIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT DISTINCT d.id, d.topic, d.summary, d.created_at
        FROM decision_entity_sources des
        JOIN decisions d ON d.id = des.decision_id
        WHERE des.entity_observation_id IN (${placeholders})
        ORDER BY d.created_at DESC
      `
    )
    .all(...observationIds) as Array<{
    id: string;
    topic: string;
    summary: string | null;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    summary: row.summary ?? row.topic,
    created_at: row.created_at,
  }));
}

function buildMetricMovement(sourceLabel: string): RollbackPreviewMetricMovement[] {
  return [
    {
      metric: 'false_merge_rate',
      direction: 'decrease',
      reason: `Splitting ${sourceLabel} back out would likely reduce false merge pressure.`,
    },
    {
      metric: 'projection_fragmentation_rate',
      direction: 'increase',
      reason: `Reactivating a second canonical entity likely increases projection fragmentation.`,
    },
  ];
}

async function previewMergeRollback(
  adapter: EntityStoreAdapter,
  input: RollbackPreviewInput,
  mergeAction: MergeActionRow
): Promise<RollbackPreviewResult> {
  const sourceNode = getEntityNode(mergeAction.source_entity_id, adapter);
  const targetNode = getEntityNode(mergeAction.target_entity_id, adapter);
  if (!sourceNode || !targetNode) {
    return unavailableResult(input.entityId, mergeAction.id, true);
  }

  const sourceHistory = await listEntityLineageHistory(sourceNode.id, adapter);
  const targetActive = await listActiveEntityLineage(targetNode.id, adapter);
  const { restoredRows, removedRows } = resolveMergePreviewRows({
    sourceHistory,
    targetActive,
    sourceEntityId: sourceNode.id,
  });

  if (restoredRows.length === 0 || removedRows.length === 0) {
    return unavailableResult(input.entityId, mergeAction.id, true);
  }

  const affectedObservationIds = uniqueStrings([
    ...restoredRows.map((row) => row.entity_observation_id),
    ...removedRows.map((row) => row.entity_observation_id),
  ]);
  const allChangedMemories = loadChangedMemories(adapter, affectedObservationIds);
  const maxAffectedRows = normalizeMaxAffectedRows(input);
  const truncated = allChangedMemories.length > maxAffectedRows;

  return {
    entity_id: input.entityId,
    merge_action_id: mergeAction.id,
    preview_unavailable: false,
    history_incomplete: false,
    truncated,
    changed_entities: [
      {
        entity_id: sourceNode.id,
        label: sourceNode.preferred_label,
        status_after: 'active',
        active_lineage_after: restoredRows.length,
        summary: projectLabel(adapter, { ...sourceNode, status: 'active', merged_into: null }),
      },
      {
        entity_id: targetNode.id,
        label: targetNode.preferred_label,
        status_after: 'active',
        active_lineage_after: Math.max(0, targetActive.length - removedRows.length),
        summary: projectLabel(adapter, targetNode),
      },
    ],
    changed_memories: allChangedMemories.slice(0, maxAffectedRows),
    metric_movement: buildMetricMovement(sourceNode.preferred_label),
  };
}

async function previewObservationDetach(
  adapter: EntityStoreAdapter,
  input: RollbackPreviewInput
): Promise<RollbackPreviewResult> {
  const activeTarget = await listActiveEntityLineage(input.entityId, adapter);
  const targetNode = getEntityNode(input.entityId, adapter);
  if (!targetNode) {
    return unavailableResult(input.entityId, null, false);
  }

  const row = activeTarget.find(
    (candidate) => candidate.entity_observation_id === input.observationId
  );
  if (!row) {
    return unavailableResult(input.entityId, null, false);
  }

  const changedMemories = loadChangedMemories(adapter, [row.entity_observation_id]);
  const maxAffectedRows = normalizeMaxAffectedRows(input);

  return {
    entity_id: input.entityId,
    merge_action_id: null,
    preview_unavailable: false,
    history_incomplete: false,
    truncated: changedMemories.length > maxAffectedRows,
    changed_entities: [
      {
        entity_id: targetNode.id,
        label: targetNode.preferred_label,
        status_after: 'active',
        active_lineage_after: Math.max(0, activeTarget.length - 1),
        summary: projectLabel(adapter, targetNode),
      },
    ],
    changed_memories: changedMemories.slice(0, maxAffectedRows),
    metric_movement: [
      {
        metric: 'false_merge_rate',
        direction: 'decrease',
        reason:
          'Removing one supporting observation may reduce merge confidence for the current entity.',
      },
      {
        metric: 'projection_fragmentation_rate',
        direction: 'increase',
        reason:
          'Detaching one observation may increase fragmentation if it needs a separate entity later.',
      },
    ],
  };
}

export async function previewEntityRollback(
  input: RollbackPreviewInput,
  options: { adapter?: EntityStoreAdapter } = {}
): Promise<RollbackPreviewResult> {
  if (!options.adapter) {
    await initDB();
  }
  const adapter = options.adapter ?? getAdapter();

  if (input.observationId) {
    return previewObservationDetach(adapter, input);
  }

  const mergeAction = loadMergeAction(adapter, input.entityId, input.mergeActionId);
  if (!mergeAction) {
    return unavailableResult(input.entityId, input.mergeActionId ?? null, false);
  }

  return previewMergeRollback(adapter, input, mergeAction);
}

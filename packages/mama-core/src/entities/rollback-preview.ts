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

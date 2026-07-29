import type { EntityNode } from './types.js';

export interface CanonicalEntityOrphanRow {
  entity_id: string;
  title: string;
  kind: EntityNode['kind'];
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  scope_label: string;
  created_at: number;
  linked_decision_count: number;
  evidence_summary: {
    lineage_rows: number;
    raw_evidence_rows: number;
    last_seen_at: number | null;
  };
}

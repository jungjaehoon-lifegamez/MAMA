import type { EntityNode } from './types.js';

export interface ListCanonicalEntitiesInput {
  limit: number;
  cursor?: string | null;
  include_noisy?: boolean;
}

export interface CanonicalEntityListRow {
  id: string;
  kind: EntityNode['kind'];
  preferred_label: string;
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  created_at: number;
  linked_decision_count: number;
}

export interface ListCanonicalEntitiesResult {
  entities: CanonicalEntityListRow[];
  next_cursor: string | null;
  total_count: number;
  visible_count: number;
}

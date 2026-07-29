import type { EntityNode } from './types.js';

export interface SearchCanonicalEntitiesInput {
  query: string;
  limit: number;
  cursor?: string | null;
}

export interface EntitySearchRow {
  id: string;
  kind: EntityNode['kind'];
  preferred_label: string;
  scope_kind: EntityNode['scope_kind'];
  scope_id: string | null;
  score: number;
  linked_decision_count: number;
}

export interface SearchCanonicalEntitiesResult {
  entities: EntitySearchRow[];
  next_cursor: string | null;
}

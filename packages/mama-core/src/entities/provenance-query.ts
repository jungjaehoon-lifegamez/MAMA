import { type SourceLocatorKind } from './source-locator.js';
import type { MemoryRecord } from '../memory/types.js';

export interface ProvenanceObservationSummary {
  id: string;
  observation_type: string;
  entity_kind_hint: string | null;
  surface_form: string;
  normalized_form: string;
  lang: string | null;
  script: string | null;
  context_summary: string | null;
  scope_kind: string;
  scope_id: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  source_connector: string;
  source_locator: string | null;
  source_locator_kind: SourceLocatorKind;
  source_raw_record_id: string;
  created_at: number;
}

export interface MemoryProvenanceResult {
  status: 'legacy' | 'manual' | 'dropped' | 'resolved';
  memory: MemoryRecord;
  observations: ProvenanceObservationSummary[];
  audit: {
    event_type: 'provenance.empty_batch' | 'provenance.link_write_failed';
    reason: string | null;
    created_at: number;
  } | null;
}

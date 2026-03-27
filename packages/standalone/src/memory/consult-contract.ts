export type MemoryConsultIntent =
  | 'bootstrap_session'
  | 'validate_claim'
  | 'get_relevant_truth'
  | 'check_conflicts'
  | 'explain_history';

export interface MemoryConsultRequest {
  intent: MemoryConsultIntent;
  query?: string;
  scopeIds?: string[];
}

export type SearchStrictness = 'recall' | 'balanced' | 'strict';

export interface SearchQualityOptions {
  threshold?: number;
  strict?: boolean;
  strictness?: SearchStrictness;
  disableRecency?: boolean;
  includeRelated?: boolean;
  topicPrefix?: string;
  minLexicalSupport?: boolean;
  diagnostics?: boolean;
}

export interface NormalizedSearchQualityOptions {
  threshold: number;
  strictness: SearchStrictness;
  disableRecency: boolean;
  includeRelated: boolean;
  topicPrefix?: string;
  minLexicalSupport: boolean;
  diagnostics: boolean;
}

export interface SearchHitDiagnostics {
  retrieval_source: string;
  vector_similarity: number | null;
  lexical_support: boolean;
  entity_support: boolean;
  scope_support: boolean;
  graph_source: 'primary' | 'expanded' | null;
  is_vector_only: boolean;
  /** Relevance confirmations only: never include scope or graph position here. */
  confirmation_signals: string[];
  /** Non-relevance metadata useful for diagnostics and audit output. */
  metadata_signals: string[];
  candidate_threshold_used: number;
}

export function normalizeSearchQualityOptions(
  options: SearchQualityOptions = {}
): NormalizedSearchQualityOptions {
  const strictness = options.strict === true ? 'strict' : (options.strictness ?? 'recall');
  const threshold =
    typeof options.threshold === 'number'
      ? options.threshold
      : strictness === 'strict'
        ? 0.6
        : strictness === 'balanced'
          ? 0.45
          : 0.3;

  return {
    threshold,
    strictness,
    disableRecency: options.disableRecency === true,
    includeRelated: options.includeRelated ?? strictness !== 'strict',
    topicPrefix: options.topicPrefix,
    minLexicalSupport: options.minLexicalSupport ?? strictness !== 'recall',
    diagnostics: options.diagnostics === true,
  };
}

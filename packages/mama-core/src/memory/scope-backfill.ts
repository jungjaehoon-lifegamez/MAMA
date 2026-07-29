export interface BackfillResult {
  scanned: number;
  updated: number;
}

export interface ConnectorEventScopeBackfillInput {
  source_connector?: string;
  source_id?: string;
  source_cursor?: string;
  tenant_id?: string;
  project_id?: string;
  memory_scope_kind?: string;
  memory_scope_id?: string;
}

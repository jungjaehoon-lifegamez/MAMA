import { getAdapter, initDB, type DatabaseAdapter } from '../db-manager.js';

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

const LEGACY_PROVENANCE_JSON = JSON.stringify({
  actor: 'actor:legacy',
  source_type: 'legacy',
});

export async function backfillLegacyMemoryProvenance(
  adapter: DatabaseAdapter | null = null
): Promise<BackfillResult> {
  await initDB();
  const db = adapter ?? getAdapter();
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM decisions
        WHERE provenance_json IS NULL
      `
    )
    .get() as { count: number };

  const result = db
    .prepare(
      `
        UPDATE decisions
        SET
          source_refs_json = COALESCE(source_refs_json, '[]'),
          provenance_json = ?
        WHERE provenance_json IS NULL
      `
    )
    .run(LEGACY_PROVENANCE_JSON);

  return {
    scanned: row.count,
    updated: result.changes,
  };
}

export async function backfillConnectorEventScopeMetadata(
  input: ConnectorEventScopeBackfillInput,
  adapter: DatabaseAdapter | null = null
): Promise<BackfillResult> {
  await initDB();
  const db = adapter ?? getAdapter();
  const assignments: string[] = [];
  const assignmentParams: unknown[] = [];

  for (const column of [
    'source_cursor',
    'tenant_id',
    'project_id',
    'memory_scope_kind',
    'memory_scope_id',
  ] as const) {
    const value = input[column];
    if (value !== undefined) {
      assignments.push(`${column} = COALESCE(${column}, ?)`);
      assignmentParams.push(value);
    }
  }

  if (assignments.length === 0) {
    return { scanned: 0, updated: 0 };
  }

  const where: string[] = [];
  const whereParams: unknown[] = [];
  if (input.source_connector !== undefined) {
    where.push('source_connector = ?');
    whereParams.push(input.source_connector);
  }
  if (input.source_id !== undefined) {
    where.push('source_id = ?');
    whereParams.push(input.source_id);
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const scanned = db
    .prepare(`SELECT COUNT(*) AS count FROM connector_event_index${whereSql}`)
    .get(...whereParams) as { count: number };
  const result = db
    .prepare(`UPDATE connector_event_index SET ${assignments.join(', ')}${whereSql}`)
    .run(...assignmentParams, ...whereParams);

  return {
    scanned: scanned.count,
    updated: result.changes,
  };
}

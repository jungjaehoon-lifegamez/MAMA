/**
 * Provenance lookup for correlation: resolve a ledger row's recorded
 * `source_event_id` to its connector event-index row.
 *
 * Kept apart from external-correlation.ts so the correlation rules stay a pure,
 * DB-free unit. The lookup is by EXACT primary key - the id is a hash of connector
 * plus source id, so there is nothing to pattern-match or guess, and a value that
 * does not resolve is simply not provenance.
 */
import type { ProvenanceRecord } from './external-correlation.js';

interface EventIndexRow {
  source_connector: unknown;
  source_id: unknown;
  metadata_json: unknown;
}

interface LookupAdapter {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

interface DbManagerModule {
  getAdapter: () => LookupAdapter;
  initDB?: () => Promise<unknown>;
}

async function resolveAdapter(): Promise<LookupAdapter> {
  const dbManager =
    (await import('@jungjaehoon/mama-core/db-manager')) as unknown as DbManagerModule;
  try {
    return dbManager.getAdapter();
  } catch (error) {
    if (typeof dbManager.initDB !== 'function') {
      throw error;
    }
    await dbManager.initDB();
    return dbManager.getAdapter();
  }
}

/**
 * Build a lookup over one prepared statement (a correlation pass resolves one row
 * per open task). Malformed metadata yields null metadata rather than throwing: the
 * correlation layer then falls back to the composite id or reports the ref
 * unresolvable, both of which are honest outcomes.
 */
export async function buildProvenanceLookup(): Promise<
  (eventIndexId: string) => ProvenanceRecord | null
> {
  const adapter = await resolveAdapter();
  const statement = adapter.prepare(
    `SELECT source_connector, source_id, metadata_json
       FROM connector_event_index
      WHERE event_index_id = ?
      LIMIT 1`
  );
  return (eventIndexId: string): ProvenanceRecord | null => {
    const row = statement.get(eventIndexId) as EventIndexRow | undefined;
    if (!row) {
      return null;
    }
    let metadata: Record<string, unknown> | null = null;
    if (typeof row.metadata_json === 'string' && row.metadata_json.length > 0) {
      try {
        const parsed: unknown = JSON.parse(row.metadata_json);
        metadata =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        metadata = null;
      }
    }
    return {
      sourceConnector: String(row.source_connector),
      sourceId: String(row.source_id),
      metadata,
    };
  };
}

/** Read projections owned alongside connector_event_index, independent of polling. */
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess } from '@jungjaehoon/mama-core';

type Reader = Pick<DatabaseAdapter, 'prepare'>;

/** Connector-wide reads or explicitly granted channels, applied before paging or aggregation. */
export function storedSourceAccessFilter(
  access: JudgmentAccess,
  connectors: readonly string[]
): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const channels = access.channels;
  for (const connector of connectors) {
    if (!access.connectors?.includes(connector)) continue;
    if (access.connectorWideRead?.includes(connector)) {
      clauses.push('source_connector = ?');
      params.push(connector);
      continue;
    }
    const granted = [
      ...new Set((channels?.[connector] ?? []).filter((channel) => channel.trim() !== '')),
    ];
    if (granted.length === 0) continue;
    clauses.push(`(source_connector = ? AND channel IN (${granted.map(() => '?').join(',')}))`);
    params.push(connector, ...granted);
  }
  return {
    sql: clauses.length ? clauses.map((clause) => `(${clause})`).join(' OR ') : '0',
    params,
  };
}

export function listStoredConnectorNames(adapter: Reader): string[] {
  const rows = adapter
    .prepare('SELECT DISTINCT source_connector FROM connector_event_index')
    .all() as Array<{ source_connector: string }>;
  return rows.map((row) => row.source_connector);
}

export interface StoredSourceFamily {
  source: string;
  family: string | null;
  count: number;
}

/** Aggregate only readable stored rows, never return room names. */
export function storedSourceFamilies(
  adapter: Reader,
  connectors: readonly string[],
  access: JudgmentAccess
): StoredSourceFamily[] {
  const visibility = storedSourceAccessFilter(access, connectors);
  return adapter
    .prepare(
      `WITH families AS (
         SELECT source_connector AS source,
                CASE WHEN substr(channel, 1, length(source_connector) + 1) = source_connector || ':'
                     THEN substr(channel, length(source_connector) + 2)
                     ELSE NULL END AS family_path
         FROM connector_event_index
         WHERE (${visibility.sql})
       )
       SELECT source,
              CASE WHEN instr(family_path, ':') > 0
                   THEN substr(family_path, 1, instr(family_path, ':') - 1)
                   ELSE family_path END AS family,
              COUNT(*) AS count
       FROM families
       GROUP BY source, family
       ORDER BY source, family`
    )
    .all(...visibility.params) as StoredSourceFamily[];
}

export function hasStoredConnector(adapter: Reader, source: string): boolean {
  return Boolean(
    adapter
      .prepare('SELECT 1 FROM connector_event_index WHERE source_connector = ? LIMIT 1')
      .get(source) ??
    adapter.prepare('SELECT 1 FROM observation_versions WHERE source = ? LIMIT 1').get(source)
  );
}

export function storedConnectorOverview(
  adapter: Reader,
  source: string,
  channels: readonly string[] | null,
  maxSourceMs?: number | null
): Record<string, unknown> {
  const clause = channels ? ` AND e.channel IN (${channels.map(() => '?').join(', ')})` : '';
  const sourceClause =
    maxSourceMs === undefined || maxSourceMs === null
      ? ''
      : ' AND COALESCE(e.event_datetime, e.source_timestamp_ms) <= ?';
  return adapter
    .prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT e.channel) AS channel_count,
              MIN(e.source_timestamp_ms) AS first_source_at,
              MAX(e.source_timestamp_ms) AS last_source_at,
              MAX(o.observed_at) AS last_observed_at
       FROM connector_event_index e
       LEFT JOIN observation_versions o ON o.observation_id = e.current_observation_id
       WHERE e.source_connector = ?${clause}${sourceClause}`
    )
    .get(source, ...(channels ?? []), ...(sourceClause === '' ? [] : [maxSourceMs])) as Record<
    string,
    unknown
  >;
}

export function storedObservationChannel(
  adapter: Reader,
  observationRef: string,
  source: string,
  maxSourceMs?: number | null
): string | null | undefined {
  const sourceClause =
    maxSourceMs === undefined || maxSourceMs === null
      ? ''
      : ' AND source_at IS NOT NULL AND source_at <= ?';
  const row = adapter
    .prepare(
      `SELECT o.channel FROM observation_versions o
       WHERE o.observation_id = ? AND o.source = ?${sourceClause} LIMIT 1`
    )
    .get(observationRef, source, ...(sourceClause === '' ? [] : [maxSourceMs])) as
    | { channel: string | null }
    | undefined;
  return row?.channel;
}

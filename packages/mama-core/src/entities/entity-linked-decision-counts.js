export function loadLinkedDecisionCounts(adapter, entityIds) {
  const uniqueIds = Array.from(
    new Set(entityIds.filter((entityId) => typeof entityId === 'string' && entityId.length > 0))
  );
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT
          l.canonical_entity_id AS entity_id,
          COUNT(DISTINCT des.decision_id) AS linked_decision_count
        FROM entity_lineage_links l
        INNER JOIN decision_entity_sources des
          ON des.entity_observation_id = l.entity_observation_id
        WHERE l.status = 'active'
          AND l.canonical_entity_id IN (${placeholders})
        GROUP BY l.canonical_entity_id
      `
    )
    .all(...uniqueIds);

  const counts = new Map(uniqueIds.map((entityId) => [entityId, 0]));
  for (const row of rows) {
    counts.set(row.entity_id, Number(row.linked_decision_count) || 0);
  }
  return counts;
}

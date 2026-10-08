import type { DatabaseInstance } from '../db-manager.js';
import { createPrincipalRepository } from './principal-repository.js';
import { observationScopes } from './erased-record.js';

type Row = Record<string, unknown>;
export interface PrincipalRecordExport {
  principalId: string;
  stores: Record<string, Row[]>;
  counts: Record<string, number>;
}
export interface ErasureStoreCount {
  deleted: number;
  tombstoned: number;
  wiped: number;
  in_flight: number;
}
export interface PrincipalErasureReceipt {
  principalId: string;
  commandId: string;
  erasedAt: number;
  state: 'erased' | 'nothing_to_erase';
  counts: Record<string, ErasureStoreCount>;
}

const CANONICAL_COLUMNS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    decisions:
      'rowid id topic decision reasoning outcome failure_reason limitation user_involvement session_id supersedes superseded_by refined_from confidence created_at updated_at needs_validation validation_attempts last_validated_at usage_count trust_context usage_success usage_failure time_saved evidence alternatives risks event_date kind status summary is_static event_datetime agent_id model_run_id envelope_hash gateway_call_id source_refs_json provenance_json item_id record_kind payload_json applies_from applies_until duration_days erased_at',
    observation_versions:
      'observation_id source source_id producer_version_id body body_location_json author source_at observed_at content_hash metadata_json scope_json source_type source_locator title artifact_locator artifact_title event_date source_entity_id channel project_id tenant_id memory_scope_kind memory_scope_id erased_at',
    judgment_commands: 'command_id record_id committed_watermark receipt_json created_at erased_at',
    source_commands:
      'command_id observation_id event_id committed_watermark receipt_json created_at erased_at',
    command_bindings:
      'command_id principal_id action payload_hash receipt_kind receipt_key created_at erased_at',
    model_runs:
      'model_run_id model_id model_provider prompt_version tool_manifest_version output_schema_version agent_id instance_id envelope_hash parent_model_run_id input_snapshot_ref input_refs_json completion_summary status error_summary token_count cost_estimate created_at completed_at input_tokens cache_read_input_tokens cache_creation_input_tokens output_tokens compaction_count erased_at erased_principal_id',
    tool_traces:
      'trace_id model_run_id gateway_call_id tool_name input_summary output_summary execution_status duration_ms envelope_hash created_at failure_code diagnostic_json evidence_json catalog_revision owner_scope project_id channel_id operation_id actor_principal_id erased_at',
  }).map(([table, columns]) => [table, new Set(columns.split(' '))])
);

/** Extensions are part of a record too; an unwipeable required field aborts the transaction. */
function clearExtensionContent(
  adapter: DatabaseInstance,
  table: string,
  key: string,
  value: unknown
): void {
  const columns = adapter.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const extras = columns.filter((column) => !CANONICAL_COLUMNS[table]!.has(column.name));
  if (extras.some((column) => column.notnull))
    throw new Error(`Erasure requires nullable extension content in ${table}`);
  if (extras.length === 0) return;
  const assignments = extras.map((column) => `"${column.name.replace(/"/g, '""')}"=NULL`).join(',');
  adapter.prepare(`UPDATE ${table} SET ${assignments} WHERE ${key}=?`).run(value);
}

function requireMember(adapter: DatabaseInstance, principalId: string): void {
  const principal = createPrincipalRepository(adapter).findById(principalId);
  if (principal?.kind !== 'member')
    throw new Error('Export and erasure require a registered member principal');
}

function selectByIds(
  adapter: DatabaseInstance,
  table: string,
  column: string,
  ids: readonly unknown[],
  order: string
): Row[] {
  // The member can have more records than SQLite's bind-parameter limit.
  const results: Row[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    results.push(
      ...(adapter
        .prepare(
          `SELECT * FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(',')}) ORDER BY ${order}`
        )
        .all(...chunk) as Row[])
    );
  }
  const keys = order.split(',').map((s) => s.trim());
  return results.sort((a, b) => {
    for (const key of keys) {
      const av = a[key],
        bv = b[key];
      const delta =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av) === String(bv)
            ? 0
            : String(av) < String(bv)
              ? -1
              : 1;
      if (delta) return delta;
    }
    return 0;
  });
}

function exclusivelyPersonal(
  scopes: Array<{ kind: string; id: string }>,
  principalId: string
): boolean {
  return scopes.length > 0 && scopes.every((s) => s.kind === 'user' && s.id === principalId);
}

// References are structured values or exact reference strings, never a prose match.
function referencedIds(value: unknown, ids: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (ids.has(v)) found.add(v);
      const raw = /^raw:[^:]+:(.+)$/.exec(v);
      if (raw && ids.has(raw[1]!)) found.add(raw[1]!);
      for (const prefix of ['memory:', 'decision:', 'observation:']) {
        if (v.startsWith(prefix) && ids.has(v.slice(prefix.length)))
          found.add(v.slice(prefix.length));
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return found;
}
function jsonRefs(row: Row, columns: string[], ids: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const column of columns) {
    const text = row[column];
    if (typeof text !== 'string') continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
    for (const id of referencedIds(value, ids)) found.add(id);
  }
  return found;
}

/** Native invocation identity belongs to the mailbox; descendants inherit that turn. */
function principalRuns(adapter: DatabaseInstance, principalId: string, inFlight = false): Row[] {
  return adapter
    .prepare(
      `
    WITH RECURSIVE inputs AS (
      SELECT i.*, n.invocation_id, n.receipt_json FROM mailbox_inputs i
      LEFT JOIN native_input_deliveries n ON n.input_id=i.id WHERE i.principal_id=?
    ), protected_inputs AS (
      SELECT * FROM inputs i WHERE i.status<>'acked' OR EXISTS (
        SELECT 1 FROM inputs active WHERE active.status<>'acked' AND active.receipt_json=i.receipt_json
      )
    ), roots AS (
      SELECT mr.model_run_id FROM model_runs mr WHERE
        ${inFlight ? '' : 'mr.erased_principal_id=? OR'}
        EXISTS (SELECT 1 FROM ${inFlight ? 'protected_inputs' : 'inputs'} i
          WHERE i.invocation_id=CASE WHEN json_valid(mr.input_refs_json)
            THEN json_extract(mr.input_refs_json, '$.nativeInputId') END)
        OR (CASE WHEN json_valid(mr.input_refs_json)
              THEN json_extract(mr.input_refs_json, '$.principalId') END = ?
          ${
            inFlight
              ? `AND (EXISTS (SELECT 1 FROM protected_inputs i
            WHERE i.stimulus_id=CASE WHEN json_valid(mr.input_refs_json)
              THEN json_extract(mr.input_refs_json, '$.sourceMessageRef') END)
            OR (CASE WHEN json_valid(mr.input_refs_json)
              THEN json_extract(mr.input_refs_json, '$.nativeInputId') END IS NULL
              AND CASE WHEN json_valid(mr.input_refs_json)
                THEN json_extract(mr.input_refs_json, '$.sourceMessageRef') END IS NULL
              AND EXISTS (SELECT 1 FROM protected_inputs)))`
              : ''
          })
    ), runs(model_run_id) AS (
      SELECT model_run_id FROM roots UNION
      SELECT child.model_run_id FROM model_runs child
      JOIN runs parent ON child.parent_model_run_id=parent.model_run_id
    )
    SELECT mr.* FROM model_runs mr JOIN runs USING (model_run_id) ORDER BY model_run_id
  `
    )
    .all(
      ...(inFlight ? [principalId, principalId] : [principalId, principalId, principalId])
    ) as Row[];
}

function snapshot(adapter: DatabaseInstance, principalId: string): PrincipalRecordExport {
  const stores: Record<string, Row[]> = {};
  stores.decisions = adapter
    .prepare(
      `SELECT d.rowid, d.* FROM decisions d WHERE
    EXISTS (SELECT 1 FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id
      WHERE b.memory_id=d.id AND s.kind='user' AND s.external_id=?)
    AND NOT EXISTS (SELECT 1 FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id
      WHERE b.memory_id=d.id AND (s.kind<>'user' OR s.external_id<>?)) ORDER BY d.id`
    )
    .all(principalId, principalId) as Row[];
  const recordIds = stores.decisions.map((r) => String(r.id));
  const records = new Set(recordIds);
  stores.memory_scope_bindings = selectByIds(
    adapter,
    'memory_scope_bindings',
    'memory_id',
    recordIds,
    'memory_id,scope_id'
  );
  stores.record_actors = selectByIds(
    adapter,
    'record_actors',
    'record_id',
    recordIds,
    'record_id,position,person_id,role'
  );
  stores.embeddings = selectByIds(
    adapter,
    'embeddings',
    'rowid',
    stores.decisions.map((r) => r.rowid),
    'rowid'
  );
  if (!adapter.readCachedEmbeddings) throw new Error('Export requires vector cache access');
  stores.vector_cache = adapter.readCachedEmbeddings(stores.decisions.map((r) => Number(r.rowid)));
  for (const table of ['decisions_fts', 'decisions_trigram']) {
    // External-content FTS rows are exported as logical per-record projections.
    stores[table] = stores.decisions.map((r) => ({
      rowid: r.rowid,
      topic: r.topic,
      decision: r.decision,
      reasoning: r.reasoning,
    }));
  }
  stores.observation_versions = (
    adapter.prepare('SELECT * FROM observation_versions ORDER BY observation_id').all() as Row[]
  ).filter((r) => exclusivelyPersonal(observationScopes(r), principalId));
  const observations = new Set(stores.observation_versions.map((r) => String(r.observation_id)));
  const selected = new Set([...records, ...observations]);
  stores.memory_events = (
    adapter.prepare('SELECT * FROM memory_events ORDER BY event_id').all() as Row[]
  ).filter((r) => {
    if (selected.has(String(r.memory_id))) return true;
    if (r.memory_id !== null) return false;
    return exclusivelyPersonal(JSON.parse(String(r.scope_refs)), principalId);
  });
  stores.judgment_commands = selectByIds(
    adapter,
    'judgment_commands',
    'record_id',
    recordIds,
    'command_id'
  );
  stores.source_commands = selectByIds(
    adapter,
    'source_commands',
    'observation_id',
    [...observations],
    'command_id'
  );
  const commandIds = [...stores.judgment_commands, ...stores.source_commands].map(
    (r) => r.command_id
  );
  stores.command_bindings = selectByIds(
    adapter,
    'command_bindings',
    'command_id',
    commandIds,
    'command_id'
  );
  stores.twin_edges = (
    adapter.prepare('SELECT * FROM twin_edges ORDER BY edge_id').all() as Row[]
  ).filter(
    (r) =>
      endpointSelected(r, 'subject', records, observations) ||
      endpointSelected(r, 'object', records, observations) ||
      jsonRefs(r, ['evidence_refs_json'], selected).size > 0
  );
  for (const table of ['decision_edges', 'link_audit_log']) {
    stores[table] = (
      adapter
        .prepare(
          `SELECT * FROM ${table} ORDER BY ${table === 'decision_edges' ? 'from_id,to_id,relationship' : 'id'}`
        )
        .all() as Row[]
    ).filter(
      (r) =>
        records.has(String(r.from_id)) ||
        records.has(String(r.to_id)) ||
        records.has(String(r.decision_id)) ||
        jsonRefs(r, ['evidence'], selected).size > 0
    );
  }
  stores.checkpoints = adapter
    .prepare(
      `SELECT c.* FROM checkpoints c WHERE
    EXISTS (SELECT 1 FROM checkpoint_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.checkpoint_id=c.id AND s.kind='user' AND s.external_id=?)
    AND NOT EXISTS (SELECT 1 FROM checkpoint_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.checkpoint_id=c.id AND (s.kind<>'user' OR s.external_id<>?)) ORDER BY c.id`
    )
    .all(principalId, principalId) as Row[];
  stores.checkpoint_scope_bindings = selectByIds(
    adapter,
    'checkpoint_scope_bindings',
    'checkpoint_id',
    stores.checkpoints.map((r) => r.id),
    'checkpoint_id,scope_id'
  );
  stores.mailbox_inputs = adapter
    .prepare('SELECT * FROM mailbox_inputs WHERE principal_id=? ORDER BY id')
    .all(principalId) as Row[];
  const inputIds = stores.mailbox_inputs.map((r) => r.id);
  stores.mailbox_input_refs = selectByIds(
    adapter,
    'mailbox_input_refs',
    'input_id',
    inputIds,
    'input_id,ref_id'
  );
  stores.native_input_deliveries = selectByIds(
    adapter,
    'native_input_deliveries',
    'input_id',
    inputIds,
    'input_id'
  );
  stores.mailbox_seen = adapter
    .prepare(
      `SELECT * FROM mailbox_seen s WHERE (s.principal_id=? OR EXISTS (
    SELECT 1 FROM mailbox_input_refs r JOIN mailbox_inputs i ON i.id=r.input_id WHERE r.ref_id=s.ref_id AND i.principal_id=?))
    AND NOT EXISTS (SELECT 1 FROM mailbox_input_refs r JOIN mailbox_inputs i ON i.id=r.input_id WHERE r.ref_id=s.ref_id AND i.principal_id<>?) ORDER BY s.ref_id`
    )
    .all(principalId, principalId, principalId) as Row[];
  stores.native_turn_results = adapter
    .prepare(
      'SELECT * FROM native_turn_results WHERE principal_id=? ORDER BY receipt_json,principal_id'
    )
    .all(principalId) as Row[];
  stores.model_runs = principalRuns(adapter, principalId);
  const runs = new Set(stores.model_runs.map((r) => r.model_run_id));
  stores.tool_traces = (
    adapter.prepare('SELECT * FROM tool_traces ORDER BY trace_id').all() as Row[]
  ).filter((r) => r.actor_principal_id === principalId || runs.has(r.model_run_id));
  stores.principal_erasure_receipts = adapter
    .prepare(
      'SELECT * FROM principal_erasure_receipts WHERE principal_id=? ORDER BY erased_at,command_id'
    )
    .all(principalId) as Row[];
  return {
    principalId,
    stores,
    counts: Object.fromEntries(
      Object.entries(stores).map(([name, entries]) => [name, entries.length])
    ),
  };
}

function endpointSelected(
  row: Row,
  endpoint: 'subject' | 'object',
  records: Set<string>,
  observations: Set<string>
): boolean {
  const kind = row[`${endpoint}_kind`],
    id = String(row[`${endpoint}_id`]);
  return (
    (kind === 'memory' && records.has(id)) ||
    ((kind === 'observation' || kind === 'raw') && observations.has(id))
  );
}

/** A transaction supplies a stable, complete export rather than unrelated per-store reads. */
export function exportPrincipalRecords(
  adapter: DatabaseInstance,
  principalId: string
): PrincipalRecordExport {
  return adapter.transaction(() => {
    requireMember(adapter, principalId);
    return snapshot(adapter, principalId);
  });
}

function readReceipt(row: Row): PrincipalErasureReceipt {
  return {
    principalId: String(row.principal_id),
    commandId: String(row.command_id),
    erasedAt: Number(row.erased_at),
    state: row.state as PrincipalErasureReceipt['state'],
    counts: JSON.parse(String(row.counts_json)),
  };
}

export function erasePrincipalRecords(
  adapter: DatabaseInstance,
  input: { principalId: string; commandId: string }
): PrincipalErasureReceipt {
  if (!input.commandId.trim()) throw new Error('Erasure command id must be nonblank');
  if (!adapter.removeEmbedding)
    throw new Error('Erasure requires transactional vector cache removal');
  const transaction =
    adapter.transactionImmediate?.bind(adapter) ?? adapter.transaction.bind(adapter);
  return transaction(() => {
    requireMember(adapter, input.principalId);
    const previous = adapter
      .prepare('SELECT * FROM principal_erasure_receipts WHERE command_id=?')
      .get(input.commandId) as Row | undefined;
    if (previous) {
      if (previous.principal_id !== input.principalId)
        throw new Error('Erasure command id is already bound to another principal');
      return readReceipt(previous);
    }
    const { stores } = snapshot(adapter, input.principalId);
    // Capture execution ownership before deleting the mailbox or its delivery journal.
    const activeInputs = stores.mailbox_inputs.filter((row) => row.status !== 'acked');
    const activeIds = new Set(activeInputs.map((row) => row.id));
    const activeStimuli = new Set(activeInputs.map((row) => row.stimulus_id));
    const activeReceipts = new Set(
      stores.native_input_deliveries
        .filter((row) => activeIds.has(row.input_id) && row.receipt_json !== null)
        .map((row) => row.receipt_json)
    );
    // A steered turn shares its final receipt. Keep its root delivery too so the
    // preserved run remains attributable on the next erase after settlement.
    for (const delivery of stores.native_input_deliveries)
      if (activeReceipts.has(delivery.receipt_json)) activeIds.add(delivery.input_id);
    const activeRuns = new Set(
      principalRuns(adapter, input.principalId, true).map((row) => row.model_run_id)
    );
    const activeRefs = new Set(
      stores.mailbox_input_refs
        .filter((row) => activeIds.has(row.input_id))
        .map((row) => row.ref_id)
    );
    const inFlight: Record<string, (row: Row) => boolean> = {
      mailbox_inputs: (row) => activeIds.has(row.id),
      mailbox_input_refs: (row) => activeIds.has(row.input_id),
      mailbox_seen: (row) => activeRefs.has(row.ref_id),
      native_input_deliveries: (row) => activeIds.has(row.input_id),
      native_turn_results: (row) =>
        activeReceipts.has(row.receipt_json) || activeStimuli.has(row.primary_stimulus_id),
      model_runs: (row) => activeRuns.has(row.model_run_id),
      tool_traces: (row) => activeRuns.has(row.model_run_id),
    };
    const liveRecords = stores.decisions.filter((r) => r.erased_at === null);
    const liveObservations = stores.observation_versions.filter((r) => r.erased_at === null);
    const records = new Set(liveRecords.map((r) => String(r.id)));
    const observations = new Set(liveObservations.map((r) => String(r.observation_id)));
    const selected = new Set([...records, ...observations]);
    const cited = new Set<string>();
    const mark = (values: Iterable<string>): void => {
      for (const id of values) cited.add(id);
    };
    // Kept judgments may carry evidence without a twin edge, including legacy pointers.
    for (const row of adapter
      .prepare(
        'SELECT id,supersedes,superseded_by,refined_from,payload_json,source_refs_json,provenance_json,evidence FROM decisions WHERE erased_at IS NULL'
      )
      .all() as Row[]) {
      if (records.has(String(row.id))) continue;
      mark(referencedIds([row.supersedes, row.superseded_by], selected));
      mark(
        jsonRefs(
          row,
          ['refined_from', 'payload_json', 'source_refs_json', 'provenance_json', 'evidence'],
          selected
        )
      );
    }
    const allEdges = adapter.prepare('SELECT * FROM twin_edges ORDER BY edge_id').all() as Row[];
    const deletingEdges = new Set(
      stores.twin_edges
        .filter((edge) => endpointSelected(edge, 'subject', records, observations))
        .map((edge) => String(edge.edge_id))
    );
    const citedEdges = new Set<string>();
    // A kept correction may cite another edge, which may itself cite further edges.
    let changedEdges: boolean;
    do {
      changedEdges = false;
      for (const edge of allEdges) {
        if (deletingEdges.has(String(edge.edge_id))) continue;
        for (const endpoint of ['subject', 'object']) {
          const id = String(edge[`${endpoint}_id`]);
          if (edge[`${endpoint}_kind`] === 'edge' && deletingEdges.delete(id)) {
            citedEdges.add(id);
            changedEdges = true;
          }
        }
      }
    } while (changedEdges);
    for (const edge of stores.twin_edges) {
      if (deletingEdges.has(String(edge.edge_id))) continue;
      for (const endpoint of ['subject', 'object'] as const)
        if (endpointSelected(edge, endpoint, records, observations))
          cited.add(String(edge[`${endpoint}_id`]));
      mark(jsonRefs(edge, ['evidence_refs_json'], selected));
    }
    for (const edge of [...stores.decision_edges, ...stores.link_audit_log]) {
      if (records.has(String(edge.from_id))) continue;
      mark(referencedIds([edge.from_id, edge.to_id, edge.decision_id], selected));
      mark(jsonRefs(edge, ['evidence'], selected));
    }
    for (const assignment of adapter
      .prepare('SELECT record_id,set_json FROM commitment_assignments')
      .all() as Row[]) {
      mark(referencedIds(assignment.record_id, selected));
      mark(jsonRefs(assignment, ['set_json'], selected));
    }
    for (const head of adapter.prepare('SELECT head_record_id FROM commitments').all() as Row[])
      mark(referencedIds(head.head_record_id, selected));
    for (const event of adapter
      .prepare('SELECT event_id,memory_id,evidence_refs FROM memory_events')
      .all() as Row[]) {
      if (stores.memory_events.some((e) => e.event_id === event.event_id)) continue;
      mark(jsonRefs(event, ['evidence_refs'], selected));
    }
    const counts: Record<string, ErasureStoreCount> = Object.fromEntries(
      Object.keys(stores).map((name) => [
        name,
        { deleted: 0, tombstoned: 0, wiped: 0, in_flight: 0 },
      ])
    );
    for (const [table, keep] of Object.entries(inFlight)) {
      counts[table].in_flight = stores[table].filter(keep).length;
      stores[table] = stores[table].filter((row) => !keep(row));
    }
    const now = Date.now();
    const del = (table: string, where: string, ...params: unknown[]): void => {
      counts[table].deleted += Number(
        adapter.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes
      );
    };
    // Reserve command identifiers and sever RESTRICT target references before any deletion.
    for (const table of ['judgment_commands', 'source_commands'])
      for (const receipt of stores[table]) {
        if (receipt.erased_at !== null) continue;
        clearExtensionContent(adapter, table, 'command_id', receipt.command_id);
        clearExtensionContent(adapter, 'command_bindings', 'command_id', receipt.command_id);
        const target = table === 'judgment_commands' ? 'record_id' : 'observation_id';
        adapter
          .prepare(
            `UPDATE ${table} SET ${target}=NULL, receipt_json='{}', erased_at=? ${table === 'source_commands' ? ', event_id=NULL' : ''} WHERE command_id=?`
          )
          .run(now, receipt.command_id);
        counts[table].wiped++;
        adapter
          .prepare(
            "UPDATE command_bindings SET payload_hash='erased', receipt_key='erased', erased_at=? WHERE command_id=?"
          )
          .run(now, receipt.command_id);
        counts.command_bindings.wiped++;
      }
    for (const edge of stores.twin_edges) {
      if (deletingEdges.has(String(edge.edge_id))) del('twin_edges', 'edge_id=?', edge.edge_id);
      else if (citedEdges.has(String(edge.edge_id))) {
        adapter
          .prepare(
            `UPDATE twin_edges SET reason_text=NULL, reason_classification=NULL,
          relation_attrs_json=NULL, content_hash=zeroblob(32) WHERE edge_id=?`
          )
          .run(edge.edge_id);
        counts.twin_edges.wiped++;
      }
    }
    for (const table of ['decision_edges', 'link_audit_log'])
      for (const edge of stores[table])
        if (records.has(String(edge.from_id))) {
          if (table === 'link_audit_log') del(table, 'id=?', edge.id);
          else
            del(
              table,
              'from_id=? AND to_id=? AND relationship=?',
              edge.from_id,
              edge.to_id,
              edge.relationship
            );
        }
    for (const event of stores.memory_events) del('memory_events', 'event_id=?', event.event_id);
    for (const row of liveRecords) {
      adapter.removeEmbedding!(Number(row.rowid));
      counts.embeddings.deleted += stores.embeddings.filter((e) => e.rowid === row.rowid).length;
      counts.vector_cache.deleted += stores.vector_cache.filter(
        (e) => e.rowid === row.rowid
      ).length;
      counts.decisions_fts.deleted++;
      counts.decisions_trigram.deleted++;
      del('record_actors', 'record_id=?', row.id);
      if (cited.has(String(row.id))) {
        clearExtensionContent(adapter, 'decisions', 'id', row.id);
        adapter
          .prepare(
            `UPDATE decisions SET erased_at=?, topic='', decision='', reasoning=NULL,
          outcome=NULL, failure_reason=NULL, limitation=NULL, user_involvement=NULL, session_id=NULL,
          supersedes=NULL, superseded_by=NULL, refined_from=NULL, confidence=NULL, needs_validation=0,
          validation_attempts=0, last_validated_at=NULL, usage_count=0, trust_context=NULL,
          usage_success=0, usage_failure=0, time_saved=0, evidence=NULL, alternatives=NULL, risks=NULL,
          event_date=NULL, summary=NULL, is_static=0, event_datetime=NULL, agent_id=NULL,
          model_run_id=NULL, envelope_hash=NULL, gateway_call_id=NULL, source_refs_json=NULL,
          provenance_json=NULL, item_id=NULL, payload_json='{}', applies_from=NULL, applies_until=NULL,
          duration_days=NULL WHERE id=?`
          )
          .run(now, row.id);
        counts.decisions.tombstoned++;
      } else {
        del('memory_scope_bindings', 'memory_id=?', row.id);
        del('decisions', 'id=?', row.id);
      }
    }
    for (const row of liveObservations) {
      if (cited.has(String(row.observation_id))) {
        clearExtensionContent(
          adapter,
          'observation_versions',
          'observation_id',
          row.observation_id
        );
        const scopes = observationScopes(row);
        adapter
          .prepare(
            `UPDATE observation_versions SET erased_at=?, source=NULL, source_id=NULL,
          producer_version_id=NULL, body=NULL, body_location_json=NULL, author=NULL, source_at=NULL,
          content_hash=NULL, metadata_json='{}', scope_json=?, source_type=NULL, source_locator=NULL,
          title=NULL, artifact_locator=NULL, artifact_title=NULL, event_date=NULL, source_entity_id=NULL,
          channel=NULL, project_id=NULL, tenant_id=NULL WHERE observation_id=?`
          )
          .run(now, JSON.stringify({ scopes }), row.observation_id);
        counts.observation_versions.tombstoned++;
      } else del('observation_versions', 'observation_id=?', row.observation_id);
    }
    for (const row of stores.checkpoint_scope_bindings)
      del(
        'checkpoint_scope_bindings',
        'checkpoint_id=? AND scope_id=?',
        row.checkpoint_id,
        row.scope_id
      );
    for (const row of stores.checkpoints) del('checkpoints', 'id=?', row.id);
    for (const row of stores.mailbox_seen) del('mailbox_seen', 'ref_id=?', row.ref_id);
    for (const row of stores.native_input_deliveries)
      del('native_input_deliveries', 'input_id=?', row.input_id);
    for (const row of stores.mailbox_input_refs)
      del('mailbox_input_refs', 'input_id=? AND ref_id=?', row.input_id, row.ref_id);
    for (const row of stores.mailbox_inputs) del('mailbox_inputs', 'id=?', row.id);
    for (const row of stores.native_turn_results)
      del(
        'native_turn_results',
        'receipt_json=? AND principal_id=?',
        row.receipt_json,
        row.principal_id
      );
    for (const row of stores.tool_traces) {
      if (row.erased_at !== null) continue;
      clearExtensionContent(adapter, 'tool_traces', 'trace_id', row.trace_id);
      adapter
        .prepare(
          `UPDATE tool_traces SET erased_at=?, tool_name='erased', gateway_call_id=NULL, input_summary=NULL,
        output_summary=NULL, envelope_hash=NULL, failure_code=NULL, diagnostic_json=NULL, evidence_json=NULL,
        catalog_revision=NULL, owner_scope=NULL, project_id=NULL, channel_id=NULL WHERE trace_id=?`
        )
        .run(now, row.trace_id);
      counts.tool_traces.wiped++;
    }
    for (const row of stores.model_runs) {
      if (row.erased_at !== null) continue;
      clearExtensionContent(adapter, 'model_runs', 'model_run_id', row.model_run_id);
      adapter
        .prepare(
          `UPDATE model_runs SET erased_at=?, erased_principal_id=?, prompt_version=NULL,
        tool_manifest_version=NULL, output_schema_version=NULL, agent_id=NULL, instance_id=NULL,
        envelope_hash=NULL, input_snapshot_ref=NULL, input_refs_json=NULL, completion_summary=NULL,
        error_summary=NULL WHERE model_run_id=?`
        )
        .run(now, input.principalId, row.model_run_id);
      counts.model_runs.wiped++;
    }
    const changed = Object.values(counts).some((c) => c.deleted + c.tombstoned + c.wiped > 0);
    const state = changed ? 'erased' : 'nothing_to_erase';
    // Last SQL write: failure here rolls back payload wipes, indexes and vector removals.
    adapter
      .prepare(
        'INSERT INTO principal_erasure_receipts (command_id,principal_id,erased_at,state,counts_json) VALUES (?,?,?,?,?)'
      )
      .run(input.commandId, input.principalId, now, state, JSON.stringify(counts));
    return readReceipt(
      adapter
        .prepare('SELECT * FROM principal_erasure_receipts WHERE command_id=?')
        .get(input.commandId) as Row
    );
  });
}

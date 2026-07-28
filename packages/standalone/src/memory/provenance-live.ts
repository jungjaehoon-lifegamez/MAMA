/**
 * The live wiring for provenance resolution: real memory records, real events, real scope.
 *
 * The resolver itself is pure. This is where it meets the database, and the one rule that
 * governs the whole file is that CITATION MUST NOT OUT-READ READING. If this path were
 * more permissive than the path that reads raw events normally, then citing a claim would
 * become a way to see events the read path denies - the handle would launder access.
 * So the visibility rule here mirrors the raw reader in context-compile exactly:
 * an event is visible when its scope is active, or when it carries no scope and the
 * active scopes include the legacy global-system sentinel that the reader also honors.
 *
 * That rule is not cosmetic. On this machine 19,394 of 30,671 indexed events carry no
 * scope at all - they predate scoped indexing. Denying them outright would make provenance
 * useless for most of the corpus; admitting them unconditionally would answer from data
 * the reader would refuse. Matching the reader is the only option that is both.
 */
import { getMemoryProvenance } from '@jungjaehoon/mama-core';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core';
import {
  resolveMemoryProvenance,
  type IndexedEvent,
  type MemoryProvenanceRecord,
  type ProvenanceResolution,
} from './provenance-resolver.js';

interface EventRow {
  event_index_id: unknown;
  source_connector: unknown;
  source_id: unknown;
  channel: unknown;
  content: unknown;
  event_datetime: unknown;
  source_timestamp_ms: unknown;
  memory_scope_kind: unknown;
  memory_scope_id: unknown;
}

interface LookupAdapter {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

interface DbManagerModule {
  getAdapter: () => LookupAdapter;
  initDB?: () => Promise<unknown>;
}

export interface LiveProvenanceOptions {
  /** Scopes active NOW. Not the scopes the memory was written under. */
  scopes: MemoryScopeRef[];
  /**
   * Raw connectors this caller may read. `null` means the caller carries no connector
   * grant information - scope alone then decides. An empty array means no authority at
   * all and denies every event, which is the same distinction the envelope layer makes.
   */
  connectors: readonly string[] | null;
  excerptChars?: number;
}

/**
 * Parse a stored source ref. Only `raw:<connector>:<event_index_id>` dereferences to an
 * event; `memory:`, `case:` and `entity:` refs are real provenance but point at things
 * this resolver does not read, so they are reported as unsupported rather than missing.
 */
export function parseSourceRef(ref: string): { connector?: string; eventIndexId?: string } {
  if (!ref.startsWith('raw:')) {
    return {};
  }
  const rest = ref.slice('raw:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) {
    return {};
  }
  return { connector: rest.slice(0, separator), eventIndexId: rest.slice(separator + 1) };
}

/**
 * Whether an event may be shown under the scopes active now. Pure, and deliberately a
 * mirror of the raw candidate reader rather than a second opinion about access.
 */
export function isEventVisibleNow(
  event: IndexedEvent,
  options: { scopes: readonly MemoryScopeRef[]; connectors: readonly string[] | null }
): boolean {
  if (options.connectors !== null && !options.connectors.includes(event.connector)) {
    return false;
  }
  const scopes = options.scopes;
  if (scopes.length === 0) {
    return false;
  }
  const scope = event.memoryScope ?? null;
  if (!scope) {
    // Unscoped: visible only to a caller holding the legacy global-system sentinel,
    // which is the exact condition under which the raw reader includes these rows.
    return scopes.some((active) => active.kind === 'global' && active.id === 'system');
  }
  return scopes.some(
    (active) =>
      active.kind === scope.kind &&
      (active.id === scope.id ||
        // Rows written before the global/system alignment carry id 'global'.
        (active.kind === 'global' && active.id === 'system' && scope.id === 'global'))
  );
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

function toIsoOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function toIndexedEvent(row: EventRow): IndexedEvent {
  const scopeKind = typeof row.memory_scope_kind === 'string' ? row.memory_scope_kind : null;
  const scopeId = typeof row.memory_scope_id === 'string' ? row.memory_scope_id : null;
  return {
    connector: String(row.source_connector ?? ''),
    eventIndexId: String(row.event_index_id ?? ''),
    sourceId: String(row.source_id ?? ''),
    channel: typeof row.channel === 'string' ? row.channel : null,
    observedAt: toIsoOrNull(row.event_datetime) ?? toIsoOrNull(row.source_timestamp_ms),
    content: typeof row.content === 'string' ? row.content : '',
    memoryScope: scopeKind && scopeId ? { kind: scopeKind, id: scopeId } : null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Fetch a memory's provenance under the scopes active now.
 *
 * Two lookups on purpose. The first is scope-strict. Only if that finds nothing do we ask
 * again admitting records with no scope bindings, and a record that appears only on the
 * second pass is reported as legacy rather than as support. A memory that appears on
 * neither is reported as unknown - never as "exists but withheld", which would confirm
 * the existence of something outside the caller's scope.
 */
async function loadRecord(
  memoryId: string,
  scopes: MemoryScopeRef[]
): Promise<MemoryProvenanceRecord | null> {
  const scoped = await getMemoryProvenance(memoryId, { scopes });
  const record =
    scoped ??
    (await getMemoryProvenance(memoryId, {
      scopes,
      includeLegacyUnscoped: true,
    }));
  if (!record) {
    return null;
  }
  const provenance = record.provenance as Record<string, unknown> | undefined;
  return {
    modelRunId: record.model_run_id,
    contextPacketId: stringOrNull(provenance?.context_packet_id),
    sourceRefs: record.source_refs.map(parseSourceRef),
    legacyUnscoped: scoped === null,
  };
}

/** Resolve one memory's support against the live index and the scopes active now. */
export async function resolveMemoryProvenanceLive(
  memoryId: string,
  options: LiveProvenanceOptions
): Promise<ProvenanceResolution> {
  const record = await loadRecord(memoryId, options.scopes);
  const adapter = await resolveAdapter();
  const statement = adapter.prepare(
    `SELECT event_index_id, source_connector, source_id, channel, content,
            event_datetime, source_timestamp_ms, memory_scope_kind, memory_scope_id
       FROM connector_event_index
      WHERE event_index_id = ?
      LIMIT 1`
  );

  return resolveMemoryProvenance(memoryId, {
    lookupMemoryProvenance: () => record,
    lookupEvent: (connector, eventIndexId) => {
      const row = statement.get(eventIndexId) as EventRow | undefined;
      if (!row) {
        return null;
      }
      const event = toIndexedEvent(row);
      // The id is a hash of connector plus source id, so a connector mismatch means the
      // ref was rewritten rather than that the event moved. Treat it as gone, not as data.
      return event.connector === connector ? event : null;
    },
    isVisible: (event) =>
      isEventVisibleNow(event, { scopes: options.scopes, connectors: options.connectors }),
    ...(options.excerptChars === undefined ? {} : { excerptChars: options.excerptChars }),
  });
}

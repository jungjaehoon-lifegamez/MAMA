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
  type ParsedSourceRef,
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
  project_id: unknown;
  tenant_id: unknown;
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
   * Raw connectors this caller may read. No grant means NO raw events, never all of
   * them - the reader fails closed here and so must this. An earlier version accepted
   * `null` to mean "scope alone decides", which turned a missing envelope into a
   * connector-wide grant.
   */
  connectors: readonly string[];
  /** Project and tenant window, mirroring the reader's filters on the same columns. */
  projectIds?: readonly string[];
  tenantId?: string | null;
  /**
   * Visibility clamp on observation time, in epoch ms. The reader bounds raw candidates
   * by `COALESCE(event_datetime, source_timestamp_ms)`; without a counterpart here, an
   * `as_of` boundary would hold for reading and not for citation. Nothing assigns
   * `envelope.scope.as_of` today, so these are null in practice - implemented now
   * because a filter with no counterpart is exactly the shape the tenant leak had.
   */
  minObservedMs?: number | null;
  maxObservedMs?: number | null;
  excerptChars?: number;
}

/**
 * Parse a stored source ref into what it actually is.
 *
 * The shapes here were measured, not guessed. Of the source refs on this machine 13,403
 * are `memory:`, 1,748 are `envelope:`, 9 are `message:` and none are `raw:`. An earlier
 * version of this parser understood only `raw:` and reported every real memory as
 * `unsupported_ref` - a tool that was wired, callable, and answered nothing.
 */
export function parseSourceRef(ref: string): ParsedSourceRef {
  const separator = ref.indexOf(':');
  if (separator <= 0 || separator === ref.length - 1) {
    return { kind: 'unsupported' };
  }
  const prefix = ref.slice(0, separator);
  const rest = ref.slice(separator + 1);

  if (prefix === 'memory' || prefix === 'envelope' || prefix === 'message') {
    return { kind: prefix, id: rest };
  }
  if (prefix !== 'raw') {
    return { kind: 'unsupported' };
  }
  // `raw:<connector>:<event_index_id>`. Split on the FIRST colon of the remainder so a
  // colon inside the id cannot shift the boundary.
  const inner = rest.indexOf(':');
  if (inner <= 0 || inner === rest.length - 1) {
    return { kind: 'unsupported' };
  }
  return { kind: 'raw', connector: rest.slice(0, inner), eventIndexId: rest.slice(inner + 1) };
}

/**
 * Whether an event may be shown under the authority active now.
 *
 * This reproduces the raw candidate reader's predicate clause for clause. The first
 * version of this function did not: it mirrored the MEMORY reader's legacy rule, which is
 * the looser `scopes.some(global/system)`, while the RAW reader requires
 * `hasGlobalSystemScope && !hasScopedVisibility` (source-readers.ts:704-711). Since
 * deriveMemoryScopes always appends global:system next to project/channel/user, the loose
 * rule is true in every production configuration and the strict one is false in every
 * production configuration - so the mistake was not a corner case, it was the default.
 *
 * A shared predicate would be better than a faithful copy, and the copy is only defensible
 * because a differential test pins the two together.
 */
export function isEventVisibleNow(
  event: IndexedEvent,
  options: {
    scopes: readonly MemoryScopeRef[];
    connectors: readonly string[];
    projectIds?: readonly string[];
    tenantId?: string | null;
    minObservedMs?: number | null;
    maxObservedMs?: number | null;
  }
): boolean {
  const { scopes, connectors } = options;
  const projectIds = options.projectIds ?? [];
  const tenantId = options.tenantId ?? null;

  // The reader's own guard: no connectors or no scopes means no raw events at all.
  if (connectors.length === 0 || scopes.length === 0) {
    return false;
  }
  if (!connectors.includes(event.connector)) {
    return false;
  }

  const hasGlobalSystemScope = scopes.some(
    (scope) => scope.kind === 'global' && scope.id === 'system'
  );
  const hasScopedVisibility =
    scopes.some((scope) => !(scope.kind === 'global' && scope.id === 'system')) ||
    projectIds.length > 0 ||
    Boolean(tenantId);
  const includesLegacyGlobalSystem = hasGlobalSystemScope && !hasScopedVisibility;

  if (projectIds.length > 0) {
    const projectMatches =
      (event.projectId !== null &&
        event.projectId !== undefined &&
        projectIds.includes(event.projectId)) ||
      (includesLegacyGlobalSystem && (event.projectId ?? null) === null);
    if (!projectMatches) {
      return false;
    }
  }
  if (tenantId) {
    const tenantMatches =
      event.tenantId === tenantId ||
      (includesLegacyGlobalSystem && (event.tenantId ?? null) === null);
    if (!tenantMatches) {
      return false;
    }
  }

  // The reader's time bound. An event with no timestamp at all cannot satisfy a bound
  // the reader applies to a COALESCE of two columns, so it is excluded when one is set.
  const min = options.minObservedMs ?? null;
  const max = options.maxObservedMs ?? null;
  if (min !== null || max !== null) {
    const observedMs = event.observedAt === null ? null : Date.parse(event.observedAt);
    if (observedMs === null || Number.isNaN(observedMs)) {
      return false;
    }
    if (min !== null && observedMs < min) {
      return false;
    }
    if (max !== null && observedMs > max) {
      return false;
    }
  }

  const scope = event.memoryScope ?? null;
  if (!scope) {
    return includesLegacyGlobalSystem;
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
  // Only a row with BOTH columns null is unscoped, because that is the only row the
  // reader's `IS NULL AND IS NULL` clause matches. Collapsing a half-populated or
  // empty-string row to "unscoped" would hand it the legacy allowance the reader denies.
  const unscoped = scopeKind === null && scopeId === null;
  return {
    connector: String(row.source_connector ?? ''),
    eventIndexId: String(row.event_index_id ?? ''),
    sourceId: String(row.source_id ?? ''),
    channel: typeof row.channel === 'string' ? row.channel : null,
    observedAt: toIsoOrNull(row.event_datetime) ?? toIsoOrNull(row.source_timestamp_ms),
    content: typeof row.content === 'string' ? row.content : '',
    memoryScope: unscoped ? null : { kind: scopeKind ?? '', id: scopeId ?? '' },
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
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
async function lookupWithLegacyFallback(
  memoryId: string,
  scopes: MemoryScopeRef[]
): Promise<{
  record: NonNullable<Awaited<ReturnType<typeof getMemoryProvenance>>>;
  legacy: boolean;
} | null> {
  const scoped = await getMemoryProvenance(memoryId, { scopes });
  if (scoped) {
    return { record: scoped, legacy: false };
  }
  const unbound = await getMemoryProvenance(memoryId, { scopes, includeLegacyUnscoped: true });
  return unbound ? { record: unbound, legacy: true } : null;
}

async function loadRecord(
  memoryId: string,
  scopes: MemoryScopeRef[]
): Promise<MemoryProvenanceRecord | null> {
  const found = await lookupWithLegacyFallback(memoryId, scopes);
  if (!found) {
    return null;
  }
  const record = found.record;
  const provenance = record.provenance as Record<string, unknown> | undefined;
  return {
    modelRunId: record.model_run_id,
    contextPacketId: stringOrNull(provenance?.context_packet_id),
    sourceRefs: record.source_refs.map(parseSourceRef),
    legacyUnscoped: found.legacy,
  };
}

/**
 * Which supporting memories the caller may see, resolved up front.
 *
 * The pure resolver checks visibility synchronously, so this pre-answers it for the
 * memory refs a record carries - typically a handful, up to fifty in the live corpus.
 * Uses the SAME two-pass gate as the record itself, legacy pass included: an ancestor
 * with no scope bindings is admitted exactly where an unbound record is, rather than
 * reported out of scope because the second pass was skipped. An earlier docstring
 * claimed that parity without the code doing it.
 */
async function resolveVisibleMemoryRefs(
  record: MemoryProvenanceRecord | null,
  scopes: MemoryScopeRef[]
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (!record) {
    return visible;
  }
  const ids = new Set(record.sourceRefs.flatMap((ref) => (ref.kind === 'memory' ? [ref.id] : [])));
  for (const id of ids) {
    if (await lookupWithLegacyFallback(id, scopes)) {
      visible.add(id);
    }
  }
  return visible;
}

/**
 * Whether a message ref may be named.
 *
 * `sourceMessageRef` is built as `source:channelId:turnId` (message-router.ts), and a
 * channel scope id as `source:channelId` (scope-context.ts) - so a ref belongs to a
 * caller's channel exactly when an active channel scope is its prefix. Compared as a
 * prefix rather than parsed, because a turn id can itself contain a colon
 * (`generated:<uuid>`) and splitting on the last one would silently mis-attribute it.
 *
 * This matters beyond tidiness: every memory carrying such a ref is also bound to
 * global:system, which every caller holds, so an unchecked ref handed a private channel
 * identifier to any agent that could read the memory at all.
 */
export function isMessageRefVisible(ref: string, scopes: readonly MemoryScopeRef[]): boolean {
  return scopes.some((scope) => scope.kind === 'channel' && ref.startsWith(`${scope.id}:`));
}

/** Resolve one memory's support against the live index and the scopes active now. */
export async function resolveMemoryProvenanceLive(
  memoryId: string,
  options: LiveProvenanceOptions
): Promise<ProvenanceResolution> {
  const record = await loadRecord(memoryId, options.scopes);
  const visibleMemoryRefs = await resolveVisibleMemoryRefs(record, options.scopes);
  const adapter = await resolveAdapter();
  const statement = adapter.prepare(
    `SELECT event_index_id, source_connector, source_id, channel, content,
            event_datetime, source_timestamp_ms, memory_scope_kind, memory_scope_id,
            project_id, tenant_id
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
    isSupportVisible: (support) => {
      if (support.kind === 'memory') {
        return visibleMemoryRefs.has(support.id);
      }
      if (support.kind === 'message') {
        return isMessageRefVisible(support.id, options.scopes);
      }
      // An envelope hash is opaque and names nothing outside the system: it identifies
      // the authorization a write happened under, not a channel, person or record.
      // Correlating memories by it stays within what the caller could already read, so
      // it is emitted - stated here rather than left as an unexamined default.
      return true;
    },
    isVisible: (event) =>
      isEventVisibleNow(event, {
        scopes: options.scopes,
        connectors: options.connectors,
        ...(options.projectIds === undefined ? {} : { projectIds: options.projectIds }),
        tenantId: options.tenantId ?? null,
        minObservedMs: options.minObservedMs ?? null,
        maxObservedMs: options.maxObservedMs ?? null,
      }),
    ...(options.excerptChars === undefined ? {} : { excerptChars: options.excerptChars }),
  });
}

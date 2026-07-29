/**
 * The live wiring for provenance resolution: real memory records, real events, real scope.
 *
 * The resolver itself is pure. This is where it meets the database, and the one rule that
 * governs the whole file is that CITATION MUST NOT OUT-READ READING. If this path were
 * more permissive than the path that reads raw events normally, then citing a claim would
 * become a way to see events the read path denies - the handle would launder access.
 * So this path does not have its own rule any more. When the caller holds a channel grant
 * it calls the SAME function the reader compiles into SQL (mama-core channel-grant.ts).
 * Mirroring by hand is what this file used to do, and the mirror held right up until the
 * reader changed - at which point citation started refusing excerpts for the very events
 * the reader was citing, and the differential test kept passing because its fixtures never
 * set a grant.
 *
 * The pre-grant rule below is retained for callers that hold no grant. It matters that it
 * stays generous about unscoped rows: 19,394 of 30,671 indexed events carry no scope at
 * all, so denying them outright would make provenance useless for most of the corpus.
 */
import { getMemoryProvenance } from '@jungjaehoon/mama-core';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core';
import { isChannelGranted, type ChannelGrant } from '@jungjaehoon/mama-core/context-compile';
import {
  resolveMemoryProvenance,
  type IndexedEvent,
  type MemoryProvenanceRecord,
  type ParsedSourceRef,
  type ProvenanceResolution,
} from './provenance-resolver.js';

/** The columns the predicate needs. Shared so a test reads exactly what production does. */
export const EVENT_INDEX_COLUMNS = `event_index_id, source_connector, source_id, channel, content,
            event_datetime, source_timestamp_ms, memory_scope_kind, memory_scope_id,
            project_id, tenant_id`;

export interface EventRow {
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

/**
 * Statuses every memory read path excludes (source-readers.ts:293, and recall's own
 * history exclusion). Mirrored so a citation cannot present a retired record as current.
 */
const RETIRED_MEMORY_STATUSES = new Set(['superseded', 'quarantined', 'contradicted', 'stale']);

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
  /**
   * The channels of each connector this caller may read, when the caller holds a grant.
   * Present means the grant decides, exactly as it does in the reader. Absent means the
   * pre-grant rule applies, so a caller that has not been given one is unaffected.
   */
  channels?: ChannelGrant;
  /** Project and tenant window, mirroring the reader's filters on the same columns. */
  projectIds?: readonly string[];
  tenantId?: string | null;
  /**
   * Visibility clamp on observation time, in epoch ms. Only the MAX is threaded from the
   * call site, deliberately: the reader's lower bound comes solely from `range.start_ms`,
   * which is caller-chosen narrowing, while the upper bound folds in `as_of`, which is an
   * authority clamp. A future reader should not "fix" the asymmetry. The reader bounds raw candidates
   * by `COALESCE(event_datetime, source_timestamp_ms)`; without a counterpart here, an
   * `as_of` boundary would hold for reading and not for citation. Nothing assigns
   * `envelope.scope.as_of` today, so these are null in practice - implemented now
   * because a filter with no counterpart is exactly the shape the tenant leak had.
   */
  minObservedMs?: number | null;
  maxObservedMs?: number | null;
  excerptChars?: number;
  /** Redaction to apply to excerpts, so this surface scrubs what recall scrubs. */
  redact?: (text: string) => string;
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
 * The time bound, shared by both branches.
 *
 * An event with no timestamp at all cannot satisfy a bound the reader applies to a
 * COALESCE of two columns, so it is excluded whenever one is set.
 */
function isWithinObservedWindow(
  event: IndexedEvent,
  options: { minObservedMs?: number | null; maxObservedMs?: number | null }
): boolean {
  const min = options.minObservedMs ?? null;
  const max = options.maxObservedMs ?? null;
  if (min === null && max === null) return true;
  const observedMs = event.observedAt === null ? null : Date.parse(event.observedAt);
  if (observedMs === null || Number.isNaN(observedMs)) return false;
  return (min === null || observedMs >= min) && (max === null || observedMs <= max);
}

/**
 * Whether an event may be shown under the authority active now.
 *
 * When a channel grant is supplied this DELEGATES to the shared rule rather than copying
 * it. The previous version copied the reader clause for clause and said so in a comment,
 * which held until the reader changed - then the copy silently became a different rule
 * that refused excerpts for the very events the reader was citing. The differential test
 * meant to catch that kept passing, because its fixtures never set a grant.
 *
 * "A shared predicate would be better than a faithful copy" is what the old comment here
 * said. It was right.
 *
 * Without a grant the pre-grant rule still applies, so callers that have not been given
 * one behave exactly as before.
 */
export function isEventVisibleNow(
  event: IndexedEvent,
  options: {
    scopes: readonly MemoryScopeRef[];
    connectors: readonly string[];
    channels?: ChannelGrant;
    projectIds?: readonly string[];
    tenantId?: string | null;
    minObservedMs?: number | null;
    maxObservedMs?: number | null;
  }
): boolean {
  const { scopes, connectors } = options;
  if (options.channels) {
    return (
      isChannelGranted(event.connector, event.channel, options.channels) &&
      isWithinObservedWindow(event, options)
    );
  }
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

  if (!isWithinObservedWindow(event, options)) {
    return false;
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

/**
 * One column to epoch ms, with SQL's notion of "absent" and no other.
 *
 * `COALESCE` falls through on NULL and nothing else, so 0 and negative values are
 * PRESENT to the reader. Treating them as missing - which this did, by requiring
 * `value > 0` - made the mapper judge a different instant than the query: a row with
 * `event_datetime = 0` compared as 0 in SQL and as its source timestamp here. The
 * differential caught it the moment it was routed through the production mapper.
 *
 * The non-numeric string branch is DEFENSIVE, not faithful: SQLite orders a TEXT value
 * above every INTEGER regardless of what it spells, so SQL would exclude such a row from
 * any upper bound while `Date.parse` gives it a real instant. Unreachable - both columns
 * are INTEGER-affinity, the write path passes a number, and all 30,671 live rows store
 * integers - but it is a divergence if it ever runs, and better named than implied.
 */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  // better-sqlite3 returns bigint when safeIntegers is on. Nothing enables it today, but
  // without this arm flipping that flag would null every timestamp and silently disable
  // the time clamp entirely.
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function coalesceObservedAt(eventDatetime: unknown, sourceTimestampMs: unknown): string | null {
  const ms = toEpochMs(eventDatetime) ?? toEpochMs(sourceTimestampMs);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Row to the struct the predicate judges.
 *
 * Exported because it is the layer BELOW the predicate, and a differential that
 * hand-builds its own struct proves the predicate mirrors the reader while leaving this
 * mapping unjudged - which is where a scope-column coercion bug already lived once.
 */
export function toIndexedEvent(row: EventRow): IndexedEvent {
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
    observedAt: coalesceObservedAt(row.event_datetime, row.source_timestamp_ms),
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

/**
 * The stored record's status. `getMemoryProvenance` selects it nowhere, so this is a
 * separate read rather than a field that was there all along - which is precisely why the
 * status filter had no counterpart on this path for four review rounds.
 */
async function loadRetirement(
  memoryId: string
): Promise<{ status: string | null; retired: boolean }> {
  const adapter = await resolveAdapter();
  const row = adapter
    .prepare(`SELECT status, superseded_by FROM decisions WHERE id = ? LIMIT 1`)
    .get(memoryId) as { status?: unknown; superseded_by?: unknown } | undefined;
  const status = typeof row?.status === 'string' ? row.status : null;
  const supersededBy = typeof row?.superseded_by === 'string' ? row.superseded_by : null;
  return {
    status,
    // Either signal retires it: the reader filters on status, and recall additionally
    // requires `superseded_by IS NULL`.
    retired: (status !== null && RETIRED_MEMORY_STATUSES.has(status)) || supersededBy !== null,
  };
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
  const retirement = await loadRetirement(record.memory_id);
  const provenance = record.provenance as Record<string, unknown> | undefined;
  return {
    status: retirement.status,
    retired: retirement.retired,
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
 * memory refs a record carries - typically a handful, up to fifty in the live corpus,
 * and up to two lookups each, so ~100 serial round trips at the tail. Bounded and off
 * the hot path (agent-invoked, not per-turn); the second lookup fires only for an
 * ancestor with no scope bindings, of which the live corpus has two. Worth replacing
 * with one bindings query if a memory ever carries hundreds of ancestors.
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
// Known limit, stated rather than discovered: the channel id space is not prefix-free.
// Real channel ids already contain colons, so a channel `S:X` produces refs that a caller
// scoped to `S` matches. Nothing in the ref format distinguishes "channel S, turn X:99"
// from "channel S:X, turn 99", so this cannot be resolved by parsing harder - it would
// take a delimiter the writer does not use. There are no such colliding pairs in the live
// scope table, so the guarantee holds on today's data rather than structurally.

/** Resolve one memory's support against the live index and the scopes active now. */
export async function resolveMemoryProvenanceLive(
  memoryId: string,
  options: LiveProvenanceOptions
): Promise<ProvenanceResolution> {
  const record = await loadRecord(memoryId, options.scopes);
  const visibleMemoryRefs = await resolveVisibleMemoryRefs(record, options.scopes);
  const adapter = await resolveAdapter();
  const statement = adapter.prepare(
    `SELECT ${EVENT_INDEX_COLUMNS}
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
    ...(options.redact === undefined ? {} : { redact: options.redact }),
    isSupportVisible: (support) => {
      if (support.kind === 'memory') {
        return visibleMemoryRefs.has(support.id);
      }
      if (support.kind === 'message') {
        return isMessageRefVisible(support.id, options.scopes);
      }
      // Envelope hashes are emitted. The reason is NOT that the hash is inert - it is a
      // lookup key into GET /api/memory/provenance, which serves unscoped results by
      // hash and explicitly refuses scope filters (memory-provenance-handler.ts:26-33).
      // What makes it safe is that the route sits behind requireAdminAuth
      // (api/index.ts:215) and no role holding mama_provenance has an admin token or a
      // shell. That is an access control in another file, so if this tool is ever
      // granted to a role with either, revisit this line - the hash stops being safe
      // before anything here changes.
      return true;
    },
    isVisible: (event) =>
      isEventVisibleNow(event, {
        scopes: options.scopes,
        connectors: options.connectors,
        ...(options.channels ? { channels: options.channels } : {}),
        ...(options.projectIds === undefined ? {} : { projectIds: options.projectIds }),
        tenantId: options.tenantId ?? null,
        minObservedMs: options.minObservedMs ?? null,
        maxObservedMs: options.maxObservedMs ?? null,
      }),
    ...(options.excerptChars === undefined ? {} : { excerptChars: options.excerptChars }),
  });
}

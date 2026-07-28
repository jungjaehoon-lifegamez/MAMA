/**
 * Reading evidence.
 *
 * This replaces a path that returned ZERO rows out of 30,671 in production, blocked four
 * separate ways at once: a project window whose column was null on every row, a tenant
 * partition with exactly one value, a scope-id namespace that shared nothing with the one
 * callers hold, and a legacy escape hatch gated shut whenever any specific scope was
 * present - which is always. Each was individually fatal. Patching one would have changed
 * nothing, which is why this is a replacement and not a repair.
 *
 * The rule here is the whole module: an event is visible when the caller was granted its
 * connector and its channel. Both come from `(source_connector, channel)`, which every one
 * of the 30,671 indexed rows carries with no nulls, and which is the SAME key the
 * connector config declares its channels under. The old path invented a third naming layer
 * on top of that key, populated it 37% of the time, and then filtered on it.
 *
 * So the grant is not a new abstraction. It is the config, read as what it already is: a
 * statement of which connectors and channels this system was told to look at.
 */
import { loadConnectorConfig } from '../connectors/config-loader.js';

/** What a caller may read: connector -> the channels of it they may see. */
export interface EvidenceGrant {
  /**
   * A connector absent from the map is denied entirely. A connector present with an
   * EMPTY set is also denied - "granted the connector but no channel of it" is not a
   * useful state, and treating it as "all channels" is how a grant becomes a wildcard.
   */
  readonly channelsByConnector: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface EvidenceEvent {
  eventIndexId: string;
  connector: string;
  channel: string;
  sourceId: string;
  title: string | null;
  content: string;
  observedAtMs: number;
}

export interface EvidenceQuery {
  /** Only events at or after this instant. Omit for no lower bound. */
  sinceMs?: number;
  /** Only events at or before this instant. Omit for no upper bound. */
  untilMs?: number;
  limit?: number;
}

interface ReadAdapter {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * The visibility rule, whole. Two conditions, both against the key the row already has.
 *
 * Deliberately NOT a mirror of anything. The previous design had one predicate for
 * reading and a second for citation, kept in step by a differential test - which meant a
 * test existed to prove one copy faithfully reproduced another copy of a function that
 * returned nothing.
 *
 * HONEST STATE OF THAT GOAL: this is not yet the only predicate. `isEventVisibleNow`
 * (memory/provenance-live.ts) and `isRawVisible` (mama-core edges/ref-validation.ts) still
 * apply the old scope rule, and their differential test passes only because its fixtures
 * never set a channel grant - it now pins two predicates on the branch neither production
 * path takes. Until those are converged, mama_provenance refuses excerpts for events
 * context_compile cites, and vice versa. Converging them is the work; claiming it is done
 * would be the same mistake in a different place.
 */
export function isEventVisible(
  event: { connector: string; channel: string },
  grant: EvidenceGrant
): boolean {
  const channels = grant.channelsByConnector.get(event.connector);
  return channels !== undefined && channels.has(event.channel);
}

/** Build a grant from the connector config, which already names every channel. */
export function grantFromConnectorConfig(config: unknown): EvidenceGrant {
  const channelsByConnector = new Map<string, ReadonlySet<string>>();
  if (config === null || typeof config !== 'object') {
    return { channelsByConnector };
  }
  for (const [connector, raw] of Object.entries(config as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as { enabled?: unknown; channels?: unknown };
    // A disabled connector is not a grant. Reading its history because rows survive
    // disabling would make "off" mean "off for new data only".
    if (entry.enabled === false) {
      continue;
    }
    if (entry.channels === null || typeof entry.channels !== 'object') {
      continue;
    }
    channelsByConnector.set(connector, new Set(Object.keys(entry.channels as object)));
  }
  return { channelsByConnector };
}

/**
 * The same grant in the shape the context boundary carries it.
 *
 * One derivation, two consumers: this module reads evidence directly, and the compile path
 * hands the grant to mama-core's raw reader. Deriving it twice is how the two would come to
 * disagree, and a citation path that disagrees with the reading path is exactly the defect
 * this rebuild started from.
 */
export function grantAsBoundaryChannels(grant: EvidenceGrant): Record<string, string[]> {
  const channels: Record<string, string[]> = {};
  for (const [connector, ids] of grant.channelsByConnector) {
    channels[connector] = [...ids];
  }
  return channels;
}

/**
 * The live grant, read fresh on every call.
 *
 * Not cached at boot: the owner adds and removes channels while the daemon runs, and a
 * grant captured once would keep reading a channel after it was removed - the failure
 * mode where turning something off does not turn it off.
 */
export function liveBoundaryChannels(): Record<string, string[]> {
  const loaded = loadConnectorConfig();
  // A config that cannot be read is not a grant. Falling back to "everything" on a parse
  // error is how a read path ends up wider precisely when the configuration is broken.
  if (!loaded.ok) return {};
  return grantAsBoundaryChannels(grantFromConnectorConfig(loaded.config));
}

/**
 * Read visible evidence, newest first.
 *
 * The grant is applied in SQL rather than by filtering afterwards, so a caller cannot
 * receive rows it may not see even transiently, and so the limit counts rows the caller
 * can actually read - the old path's limit counted rows before visibility, which is how a
 * "top 50" could be 50 hidden rows and look like an empty channel.
 */
export function readEvidence(
  adapter: ReadAdapter,
  grant: EvidenceGrant,
  query: EvidenceQuery = {}
): EvidenceEvent[] {
  const pairs: string[] = [];
  const params: unknown[] = [];
  for (const [connector, channels] of grant.channelsByConnector) {
    for (const channel of channels) {
      pairs.push('(source_connector = ? AND channel = ?)');
      params.push(connector, channel);
    }
  }
  if (pairs.length === 0) {
    return [];
  }

  const clauses = [`(${pairs.join(' OR ')})`];
  if (query.sinceMs !== undefined) {
    clauses.push('COALESCE(event_datetime, source_timestamp_ms) >= ?');
    params.push(query.sinceMs);
  }
  if (query.untilMs !== undefined) {
    clauses.push('COALESCE(event_datetime, source_timestamp_ms) <= ?');
    params.push(query.untilMs);
  }
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  params.push(limit);

  const rows = adapter
    .prepare(
      `SELECT event_index_id, source_connector, channel, source_id, title, content,
              COALESCE(event_datetime, source_timestamp_ms) AS observed_ms
         FROM connector_event_index
        WHERE ${clauses.join(' AND ')}
        ORDER BY observed_ms DESC, event_index_id ASC
        LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    eventIndexId: String(row.event_index_id),
    connector: String(row.source_connector),
    channel: String(row.channel),
    sourceId: String(row.source_id ?? ''),
    title: typeof row.title === 'string' ? row.title : null,
    content: typeof row.content === 'string' ? row.content : '',
    observedAtMs: Number(row.observed_ms),
  }));
}

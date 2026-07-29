/**
 * Resolving an event an agent cited to one it could actually have read.
 *
 * `task_update` had no cause field at all, so 375 of the 381 unattributed changes on the
 * live ledger were updates - the single reason coverage sits at 32%. Adding a field is easy
 * and would have been worthless: the agent sees messages through `kagemusha_messages`, which
 * returns the bridge's own row id, a different id space from `connector_event_index`. A
 * citation in the wrong id space resolves to nothing and the change stays unattributed.
 *
 * Measured before building this: of 300 recent bridge messages, 266 (89%) resolve exactly
 * against `(connector, source_id)` as `<channelId>:<id>`, and no suffix maps to more than
 * one event. So the citation is resolvable - through a join, not by string equality with
 * `event_index_id`.
 *
 * TWO RULES, and the second is the one that matters:
 *
 *   1. A citation resolves or it does not. There is no partial credit and no fuzzy match:
 *      an id that names nothing leaves the change unattributed, which is the truthful
 *      outcome and is never an error - the change itself was legitimate.
 *
 *   2. A CITATION MUST NOT OUT-READ READING. The cited event has to be inside the caller's
 *      own grant. Without that, naming an id becomes a way to attach a channel the caller
 *      cannot read to a record it can, and the attribution surface turns into the leak the
 *      read path refuses to be.
 */
import { isChannelGranted, type ChannelGrant } from '@jungjaehoon/mama-core/context-compile';

export type CitationOutcome =
  | { status: 'resolved'; eventIndexId: string; connector: string; channel: string }
  /** Names nothing this system has indexed. */
  | { status: 'unresolved' }
  /** Names a real event the caller may not read. Deliberately distinct from unresolved. */
  | { status: 'outside_grant' };

interface CiteAdapter {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

interface EventRow {
  event_index_id?: unknown;
  source_connector?: unknown;
  channel?: unknown;
}

/**
 * Resolve a cited reference against the event index.
 *
 * Accepts the two shapes an agent actually holds:
 *   - `evt_...`               the index's own id, as context_compile packets carry it
 *   - `<connector>:<sourceId>` the upstream id, as the bridge and connector tools return it
 *
 * The second is split on the FIRST colon only: source ids contain colons of their own
 * (`kakao:room:508638`), and splitting anywhere else silently addresses a different event.
 */
export function resolveCitation(
  adapter: CiteAdapter,
  citation: string,
  grant: ChannelGrant
): CitationOutcome {
  const trimmed = citation.trim();
  if (trimmed.length === 0) return { status: 'unresolved' };

  const row = lookupById(adapter, trimmed) ?? lookupBySource(adapter, trimmed);
  if (!row) return { status: 'unresolved' };

  const connector = String(row.source_connector ?? '');
  const channel = typeof row.channel === 'string' ? row.channel : null;
  if (!isChannelGranted(connector, channel, grant)) {
    return { status: 'outside_grant' };
  }
  return {
    status: 'resolved',
    eventIndexId: String(row.event_index_id ?? ''),
    connector,
    channel: channel ?? '',
  };
}

function lookupById(adapter: CiteAdapter, citation: string): EventRow | null {
  const row = adapter
    .prepare(
      `SELECT event_index_id, source_connector, channel
         FROM connector_event_index WHERE event_index_id = ? LIMIT 1`
    )
    .get(citation) as EventRow | undefined;
  return row ?? null;
}

function lookupBySource(adapter: CiteAdapter, citation: string): EventRow | null {
  const separator = citation.indexOf(':');
  if (separator <= 0 || separator === citation.length - 1) return null;
  const connector = citation.slice(0, separator);
  const sourceId = citation.slice(separator + 1);
  const row = adapter
    .prepare(
      `SELECT event_index_id, source_connector, channel
         FROM connector_event_index
        WHERE source_connector = ? AND source_id = ? LIMIT 1`
    )
    .get(connector, sourceId) as EventRow | undefined;
  return row ?? null;
}

/**
 * Resolve a claim's support back to the events it came from.
 *
 * This is the capability the whole "traceable judgment" idea rests on, and until now it
 * did not exist in any form the agent could reach. Memory records carried model run,
 * envelope, gateway call and source refs; recall stripped every one of them, so an agent
 * could read a memory and then had no way to say which memory a statement rested on. A
 * handle was added upstream; this turns the handle into an answer.
 *
 * Two rules shape everything here.
 *
 * POSSESSION IS NOT AUTHORIZATION. Holding a memory id proves only that recall returned
 * it once, under some scope, at some time. Every event is re-checked against the scope
 * active NOW, and content is withheld when that check fails. A resolver that trusted the
 * handle would turn recall into a capability leak: read once, cite forever.
 *
 * ABSENCE GETS A REASON. Silence is what made the original problem invisible - a report
 * asserted things with nothing behind them and looked identical to one that was
 * grounded. Every failure here names itself, so "I cannot support this" is a statement
 * the agent can make instead of a gap it cannot see.
 */

/** Why a claim, or one of its supports, could not be resolved. */
export type ResolutionFailure =
  /** The memory carries no source refs at all. */
  | 'missing_ref'
  /** Provenance exists but predates scoped writes - nothing to re-check against. */
  | 'legacy_unscoped'
  /** The referenced event is no longer in the index. */
  | 'event_deleted'
  /** The event exists but is not visible under the scope active now. */
  | 'outside_scope'
  /** The ref shape is not one this resolver knows how to dereference. */
  | 'unsupported_ref'
  /** No memory with that id. */
  | 'unknown_memory';

export interface ResolvedEvent {
  connector: string;
  eventIndexId: string;
  sourceId: string;
  channel: string | null;
  observedAt: string | null;
  /** Bounded excerpt. Never the whole record: this answers "where from", not "give me". */
  excerpt: string;
}

/** One support that could not be dereferenced, and why. */
export interface UnresolvedSupport {
  eventIndexId: string | null;
  reason: ResolutionFailure;
}

export interface ProvenanceResolution {
  memoryId: string;
  /**
   * `resolved` - every support dereferenced and visible.
   * `partial`  - at least one resolved, at least one not.
   * `unresolved` - nothing could be shown, and `reason` says why.
   */
  status: 'resolved' | 'partial' | 'unresolved';
  modelRunId: string | null;
  contextPacketId: string | null;
  events: ResolvedEvent[];
  unresolved: UnresolvedSupport[];
  /** Present only when nothing resolved, so a caller never has to infer the cause. */
  reason?: ResolutionFailure;
}

/** A memory's recorded provenance, reduced to what resolution needs. */
export interface MemoryProvenanceRecord {
  modelRunId: string | null;
  contextPacketId: string | null;
  /** Canonical source refs; empty when the write was not evidence-backed. */
  sourceRefs: ReadonlyArray<{ connector?: string; eventIndexId?: string }>;
  /** True when the record predates scoped provenance and cannot be re-checked. */
  legacyUnscoped?: boolean;
}

export interface IndexedEvent {
  connector: string;
  eventIndexId: string;
  sourceId: string;
  channel: string | null;
  observedAt: string | null;
  content: string;
}

export interface ProvenanceResolverDeps {
  lookupMemoryProvenance(memoryId: string): MemoryProvenanceRecord | null;
  lookupEvent(connector: string, eventIndexId: string): IndexedEvent | null;
  /**
   * Whether this event is visible under the scope active NOW - not the scope that was
   * active when the memory was written. This is the check that keeps a handle from
   * becoming a standing capability.
   */
  isVisible(event: IndexedEvent): boolean;
  /** Excerpt bound in characters. */
  excerptChars?: number;
}

const DEFAULT_EXCERPT_CHARS = 280;

function excerptOf(content: string, limit: number): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/**
 * Resolve one memory's support. Never throws for missing or invisible evidence - those
 * are answers, not errors, and an agent needs to be able to report them.
 */
export function resolveMemoryProvenance(
  memoryId: string,
  deps: ProvenanceResolverDeps
): ProvenanceResolution {
  const limit = deps.excerptChars ?? DEFAULT_EXCERPT_CHARS;
  const record = deps.lookupMemoryProvenance(memoryId);

  if (!record) {
    return {
      memoryId,
      status: 'unresolved',
      modelRunId: null,
      contextPacketId: null,
      events: [],
      unresolved: [],
      reason: 'unknown_memory',
    };
  }

  const base = {
    memoryId,
    modelRunId: record.modelRunId,
    contextPacketId: record.contextPacketId,
  };

  if (record.legacyUnscoped) {
    return {
      ...base,
      status: 'unresolved',
      events: [],
      unresolved: [],
      reason: 'legacy_unscoped',
    };
  }
  if (record.sourceRefs.length === 0) {
    // A durable claim with no evidence behind it. Accepted at write time on purpose -
    // requiring a compiled packet before an agent may record an observation would gate
    // judgment on paperwork - but it must be visible here rather than look like support.
    return {
      ...base,
      status: 'unresolved',
      events: [],
      unresolved: [],
      reason: 'missing_ref',
    };
  }

  const events: ResolvedEvent[] = [];
  const unresolved: UnresolvedSupport[] = [];

  for (const ref of record.sourceRefs) {
    if (!ref.connector || !ref.eventIndexId) {
      unresolved.push({ eventIndexId: ref.eventIndexId ?? null, reason: 'unsupported_ref' });
      continue;
    }
    const event = deps.lookupEvent(ref.connector, ref.eventIndexId);
    if (!event) {
      unresolved.push({ eventIndexId: ref.eventIndexId, reason: 'event_deleted' });
      continue;
    }
    if (!deps.isVisible(event)) {
      // Named, but nothing about it disclosed - not the channel, not a word of content.
      unresolved.push({ eventIndexId: ref.eventIndexId, reason: 'outside_scope' });
      continue;
    }
    events.push({
      connector: event.connector,
      eventIndexId: event.eventIndexId,
      sourceId: event.sourceId,
      channel: event.channel,
      observedAt: event.observedAt,
      excerpt: excerptOf(event.content, limit),
    });
  }

  if (events.length === 0) {
    return {
      ...base,
      status: 'unresolved',
      events,
      unresolved,
      // Every ref failed; report the first cause rather than a bare "nothing".
      reason: unresolved[0]?.reason ?? 'missing_ref',
    };
  }

  return {
    ...base,
    status: unresolved.length === 0 ? 'resolved' : 'partial',
    events,
    unresolved,
  };
}

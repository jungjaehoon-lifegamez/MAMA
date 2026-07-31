/**
 * The live grant: which connectors and channels this system was told to look at.
 *
 * This file used to also carry a boolean visibility predicate and a SQL reader of its own -
 * a third and fourth compiled copy of a rule whose whole point was that there be one. Both
 * had zero callers, which is worse than a live copy rather than better: nothing exercises
 * them, so nothing notices when they drift, and they sit there looking authoritative until
 * someone reads one and believes it. They are deleted. The rule lives in mama-core's
 * channel-grant.ts, where its two used forms sit adjacent with a differential between them.
 *
 * What remains here is the part that is genuinely local: turning the owner's connector
 * config into a grant, and narrowing that grant to what one envelope may read.
 *
 * WHY A GRANT AT ALL. The path it replaced returned ZERO rows out of 30,671 in production,
 * blocked four separate ways at once: a project window whose column was null on every row,
 * a tenant partition with exactly one value, a scope-id namespace that shared nothing with
 * the one callers hold, and a legacy escape hatch gated shut whenever any specific scope
 * was present - which is always. Each was individually fatal, so this is a replacement and
 * not a repair.
 *
 * An event is visible when the caller was granted its connector and its channel. Both come
 * from `(source_connector, channel)`, which every indexed row carries with no nulls, and
 * which is the SAME key the connector config declares its channels under. The old path
 * invented a third naming layer on top of that key, populated it 37% of the time, and then
 * filtered on it.
 */
import type { ChannelGrant } from '@jungjaehoon/mama-core/context-compile';
import { loadConnectorConfig } from '../connectors/config-loader.js';

/**
 * Build a grant from the connector config, which already names every channel.
 *
 * A connector present with an EMPTY channel list is denied rather than granted everything -
 * that rule is stated and enforced in `isChannelGranted`, which is the only place it lives.
 */
export function grantFromConnectorConfig(config: unknown): ChannelGrant {
  const grant: ChannelGrant = {};
  if (config === null || typeof config !== 'object') {
    return grant;
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
    grant[connector] = Object.keys(entry.channels as object);
  }
  return grant;
}

/**
 * The live grant, read fresh on every call.
 *
 * Not cached at boot: the owner adds and removes channels while the daemon runs, and a
 * grant captured once would keep reading a channel after it was removed - the failure
 * mode where turning something off does not turn it off.
 */
export function liveBoundaryChannels(): ChannelGrant {
  const loaded = loadConnectorConfig();
  // A config that cannot be read is not a grant. Falling back to "everything" on a parse
  // error is how a read path ends up wider precisely when the configuration is broken.
  if (!loaded.ok) return {};
  return grantFromConnectorConfig(loaded.config);
}

/**
 * The channel grant, as MEMORY scopes.
 *
 * Memories extracted from a channel are stored under `channel:<connector>:<channelId>` -
 * the SAME key the grant declares.
 */
export function channelMemoryScopesFromGrant(
  grant: ChannelGrant,
  connectors: readonly string[]
): Array<{ kind: 'channel'; id: string }> {
  const scopes: Array<{ kind: 'channel'; id: string }> = [];
  for (const connector of Object.keys(grant).sort()) {
    if (!connectors.includes(connector)) continue;
    for (const channelId of [...grant[connector]].sort()) {
      scopes.push({ kind: 'channel', id: `${connector}:${channelId}` });
    }
  }
  return scopes;
}

/**
 * The READ allowance a run's raw grant implies for memory: a run allowed to read a
 * channel's raw events may recall the memories extracted from it. This was the dominant
 * compile failure S2 named (memory_scope_out_of_scope, 2,700+ violations/morning):
 * envelopes carry identity scopes while retrieval asks for the real channels memories
 * are stored under.
 *
 * This is an ENFORCEMENT-LAYER allowance, never issued into the envelope. Envelope
 * channel scopes double as the raw-narrowing input (`narrowGrantToEnvelope`) and as
 * `mama_save`'s write binding - issuing the mirror widened a chat's raw reads back to
 * every sibling channel and bound every saved memory to all of them (PR #217 review,
 * blocking #2/#3). Read acceptance widens READS only, computed against the LIVE grant
 * at check time.
 *
 * A connector the envelope already narrows with an identity channel scope (a chat's own
 * channel, a temporal run's binding) keeps that narrowing: per-channel isolation is the
 * point of those scopes, and the mirror must not dissolve it.
 */
export function mirrorReadScopes(
  envelope: {
    scope: {
      raw_connectors: readonly string[];
      memory_scopes: ReadonlyArray<{ kind: string; id: string }>;
    };
  },
  grant: ChannelGrant = liveBoundaryChannels()
): Array<{ kind: 'channel'; id: string }> {
  const channelScopedConnectors = new Set<string>();
  for (const scope of envelope.scope.memory_scopes) {
    if (scope.kind !== 'channel') continue;
    const separator = scope.id.indexOf(':');
    if (separator <= 0) continue;
    channelScopedConnectors.add(scope.id.slice(0, separator));
  }
  return channelMemoryScopesFromGrant(
    grant,
    envelope.scope.raw_connectors.filter((connector) => !channelScopedConnectors.has(connector))
  );
}

/**
 * Narrow the configured grant to what THIS envelope may read.
 *
 * Two independent narrowings, and the second is the whole reason this exists rather than a
 * one-line filter:
 *
 * 1. Connector - the envelope's `raw_connectors` is the standing permission.
 *
 * 2. CHANNEL - when the envelope names channel scopes, only those channels are readable.
 *    Raw visibility used to be decided by the scope columns, so a per-message envelope
 *    scoped to one channel could not reach another. Deciding it by connector alone silently
 *    dropped that isolation: reactive envelopes for two channels of the same connector
 *    carry identical `raw_connectors`, so every such run could have compiled 500-character
 *    excerpts out of every other configured channel of that connector. The scope columns
 *    were the wrong mechanism - populated on 37% of rows in three namespaces - but the
 *    isolation they attempted is real, and it belongs here, where the envelope's own
 *    channel scopes state it exactly.
 *
 * An envelope with no channel scope is a run that was never bound to one (a report, a
 * scheduled worker), and it keeps the connector-level ceiling.
 *
 * CALLERS MUST PASS THE ENVELOPE'S OWN SCOPES, never a caller-requested subset. A request
 * may narrow what it asks for; it must not be able to widen its grant by asking for less.
 * Two surfaces got that wrong before it was written down here.
 */
export function narrowGrantToEnvelope(
  configured: ChannelGrant,
  visibility: {
    connectors: readonly string[];
    scopes: readonly { kind: string; id: string }[];
  }
): ChannelGrant {
  // Channel scope ids are `<connector>:<channelId>` (deriveMemoryScopes). Split on the
  // FIRST separator only: channel ids contain colons of their own.
  const scopedChannels = new Map<string, Set<string>>();
  for (const scope of visibility.scopes) {
    if (scope.kind !== 'channel') continue;
    const separator = scope.id.indexOf(':');
    if (separator <= 0) continue;
    const connector = scope.id.slice(0, separator);
    const channelId = scope.id.slice(separator + 1);
    if (channelId.length === 0) continue;
    const existing = scopedChannels.get(connector) ?? new Set<string>();
    existing.add(channelId);
    scopedChannels.set(connector, existing);
  }

  const narrowed: ChannelGrant = {};
  for (const [connector, channels] of Object.entries(configured)) {
    if (!visibility.connectors.includes(connector)) continue;
    const bound = scopedChannels.get(connector);
    // A channel scope naming no configured channel leaves the connector with an empty
    // grant, which reads nothing. That is the correct answer: the run is bound to a channel
    // this system was not told to look at.
    narrowed[connector] = bound ? channels.filter((channel) => bound.has(channel)) : channels;
  }
  return narrowed;
}

/**
 * WRITE authority never widens past the envelope. A context packet's scopes may
 * carry the READ allowance (the compile boundary defaults to it), but a save
 * binds permanently - one memory_scope_bindings row per scope - so only the
 * packet scopes the envelope itself names are write-eligible (PR #217
 * re-review, blocking #4: finding #3 through the packet back door). Pre-mirror
 * packets satisfied packet ⊆ envelope, so this is the identity for them.
 */
export function writeEligiblePacketScopes<T extends { kind: string; id: string }>(
  packetScopes: readonly T[],
  envelopeScopes: ReadonlyArray<{ kind: string; id: string }>
): T[] {
  const envelopeKeys = new Set(envelopeScopes.map((scope) => `${scope.kind}:${scope.id}`));
  return packetScopes.filter((scope) => envelopeKeys.has(`${scope.kind}:${scope.id}`));
}

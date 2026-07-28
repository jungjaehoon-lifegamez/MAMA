/**
 * The raw visibility rule, in one place.
 *
 * There were three copies of this decision. The reader had one, twin-ref validation had a
 * second, and the standalone citation path had a third that carried a comment promising it
 * reproduced the reader "clause for clause" - which it did, until the reader changed. The
 * differential test that was supposed to catch that kept passing, because its fixtures
 * never exercised the branch production takes. Copies pinned by a test are still copies;
 * the test just tells you later.
 *
 * So the rule lives here, and everything that needs it takes it from here. It has to exist
 * in two compiled forms - a boolean for checking one row you already hold, and SQL for
 * selecting rows you do not - and those two forms are adjacent in this file with a
 * differential over a matrix that includes what production sends. Two forms of one rule is
 * the irreducible minimum; three copies of a decision is not.
 */

/** Connector -> the channels of it that may be read. */
export type ChannelGrant = Record<string, readonly string[]>;

/**
 * The rule: an event is visible when its connector is granted and its channel is one of
 * the channels granted for that connector.
 *
 * A connector absent from the grant is denied. A connector present with an empty list is
 * also denied - "granted the connector but no channel of it" is not a useful state, and
 * reading it as "all channels" is how a grant becomes a wildcard.
 */
export function isChannelGranted(
  connector: string,
  channel: string | null | undefined,
  grant: ChannelGrant
): boolean {
  if (typeof channel !== 'string' || channel.length === 0) return false;
  const channels = grant[connector];
  return Array.isArray(channels) && channels.includes(channel);
}

export interface ChannelGrantClause {
  sql: string;
  params: unknown[];
}

/**
 * The same rule as a SQL predicate.
 *
 * Returns null when nothing is readable, which callers must treat as "select nothing"
 * rather than "no filter" - an empty WHERE is how a visibility rule turns into a full scan
 * at the exact moment it should have refused.
 *
 * `requestedConnectors` narrows further: a connector the caller did not ask for is not read
 * even though it is granted. The grant is a ceiling, never an instruction.
 */
export function channelGrantClause(
  grant: ChannelGrant,
  requestedConnectors: readonly string[] | undefined,
  columns: { connector: string; channel: string }
): ChannelGrantClause | null {
  const pairs: string[] = [];
  const params: unknown[] = [];
  for (const [connector, channels] of Object.entries(grant)) {
    if (Array.isArray(requestedConnectors) && !requestedConnectors.includes(connector)) continue;
    // Array.isArray, not `?? []`: the boolean form denies a malformed grant quietly, so
    // this one must not throw on it. Two forms of a rule that disagree on bad input have
    // already started to be two rules.
    if (!Array.isArray(channels)) continue;
    const unique = [
      ...new Set(channels.filter((channel) => typeof channel === 'string' && channel.length > 0)),
    ];
    if (unique.length === 0) continue;
    pairs.push(
      `(${columns.connector} = ? AND ${columns.channel} IN (${unique.map(() => '?').join(', ')}))`
    );
    params.push(connector, ...unique);
  }
  return pairs.length === 0 ? null : { sql: `(${pairs.join(' OR ')})`, params };
}

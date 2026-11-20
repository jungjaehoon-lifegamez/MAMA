/**
 * The sources each person connected from their own DM (personal-connectors.md, C1). A row names the
 * kind and the channels the person bound; the credential stays in runtime/accounts/ (P1). Collected
 * items are stored under their own connector name and a channel key carrying the person, because
 * source reads filter by connector and channel: the install's connectors and the common session's
 * whole-connector reads never reach them.
 */
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

export const PERSONAL_SOURCE_KINDS = [
  'chatwork',
  'slack',
  'discord',
  'notion',
  'trello',
  'telegram',
  'ical',
] as const;
export type PersonalSourceKind = (typeof PERSONAL_SOURCE_KINDS)[number];

export interface PersonalChannel {
  id: string;
  name: string | null;
}

export interface PersonalSource {
  principalId: string;
  kind: PersonalSourceKind;
  channels: PersonalChannel[];
  createdAt: number;
  lastPollAt: number | null;
  lastError: string | null;
}

/** The 16 hex digits that name a person in storage, never the principal id itself. */
export function personHash(principalId: string): string {
  return createHash('sha256').update(principalId).digest('hex').slice(0, 16);
}

/**
 * One connector name, and so one raw store and one pending-projection queue, per person and kind:
 * one person's stuck item never holds another's polls (#final review I6).
 */
export function personalConnectorName(principalId: string, kind: PersonalSourceKind): string {
  return `personal-${kind}-${personHash(principalId)}`;
}

/** Two people binding the same upstream channel each keep their own copy. */
export function personalChannelKey(principalId: string, channelId: string): string {
  return `${personHash(principalId)}:${channelId}`;
}

interface Row {
  principal_id: string;
  kind: PersonalSourceKind;
  channels_json: string;
  created_at: number;
  last_poll_at: number | null;
  last_error: string | null;
}

const toSource = (row: Row): PersonalSource => ({
  principalId: row.principal_id,
  kind: row.kind,
  channels: JSON.parse(row.channels_json) as PersonalChannel[],
  createdAt: row.created_at,
  lastPollAt: row.last_poll_at,
  lastError: row.last_error,
});

export function createPersonalSourceStore(
  adapter: DatabaseAdapter,
  options: { now?: () => number } = {}
) {
  const now = options.now ?? Date.now;
  return {
    get(principalId: string, kind: PersonalSourceKind): PersonalSource | null {
      const row = adapter
        .prepare('SELECT * FROM personal_sources WHERE principal_id = ? AND kind = ?')
        .get(principalId, kind) as Row | undefined;
      return row ? toSource(row) : null;
    },
    list(principalId: string): PersonalSource[] {
      return (
        adapter
          .prepare('SELECT * FROM personal_sources WHERE principal_id = ? ORDER BY kind')
          .all(principalId) as Row[]
      ).map(toSource);
    },
    listAll(): PersonalSource[] {
      return (
        adapter.prepare('SELECT * FROM personal_sources ORDER BY principal_id, kind').all() as Row[]
      ).map(toSource);
    },
    bind(principalId: string, kind: PersonalSourceKind, channels: PersonalChannel[]): void {
      adapter
        .prepare(
          `INSERT INTO personal_sources (principal_id, kind, channels_json, created_at)
             VALUES (?, ?, ?, ?)
           ON CONFLICT (principal_id, kind) DO UPDATE SET channels_json = excluded.channels_json`
        )
        .run(principalId, kind, JSON.stringify(channels), now());
    },
    remove(principalId: string, kind: PersonalSourceKind): boolean {
      return (
        adapter
          .prepare('DELETE FROM personal_sources WHERE principal_id = ? AND kind = ?')
          .run(principalId, kind).changes > 0
      );
    },
    removeAll(principalId: string): PersonalSourceKind[] {
      const kinds = this.list(principalId).map((source) => source.kind);
      adapter.prepare('DELETE FROM personal_sources WHERE principal_id = ?').run(principalId);
      return kinds;
    },
    recordPoll(
      principalId: string,
      kind: PersonalSourceKind,
      outcome: { at: number; error: string | null }
    ): void {
      adapter
        .prepare(
          'UPDATE personal_sources SET last_poll_at = ?, last_error = ? WHERE principal_id = ? AND kind = ?'
        )
        .run(outcome.at, outcome.error, principalId, kind);
    },
  };
}

export type PersonalSourceStore = ReturnType<typeof createPersonalSourceStore>;

/**
 * Re-key indexed connector events from display names to configured channel keys.
 *
 * WHY THIS EXISTS. Six of seven connectors wrote `item.channel` as a human display name
 * while the config declares the same channel under the upstream's stable id. Binding
 * absorbed the difference with a name fallback, so nothing ever looked broken, and every
 * reader downstream compared a display name against a config key and matched nothing.
 * `canonicalChannelKey` fixes this at the write boundary - for newly polled events only.
 * The rows already indexed stay unreadable until they are moved, and on the live index
 * that is 15,279 events belonging to channels the owner did configure.
 *
 * WHY IT IS NOT JUST ONE UPDATE. The channel value is a join key in five places. Moving
 * the index rows alone would leave every consumer cursor pointing at a channel that no
 * longer exists, and a consumer that cannot find its cursor starts from the beginning -
 * so a repair intended to make history readable would instead redeliver it as news.
 *
 * WHAT IT REFUSES TO DO:
 *   - Guess. A display name that maps to two configured channels is reported and skipped;
 *     an identity that has to be inferred is not an identity.
 *   - Invent. A channel that appears in no config entry is left exactly as it is. Those
 *     rows are correctly invisible: the owner never asked this system to look there.
 *   - Run by accident. Dry run is the default and --apply is required, because this
 *     rewrites a join key across six tables in a database nothing else backs up.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConnectorConfig } from '../src/connectors/config-loader.js';

interface Rekey {
  connector: string;
  from: string;
  to: string;
  events: number;
}

interface Plan {
  rekeys: Rekey[];
  ambiguous: Array<{ connector: string; name: string; candidates: number }>;
  alreadyCanonical: number;
  unconfigured: number;
}

/** Tables whose channel column is the same join key, and must move with the index. */
const CHANNEL_TABLES: Array<{ table: string; connectorColumn: string; channelColumn: string }> = [
  { table: 'connector_event_index', connectorColumn: 'source_connector', channelColumn: 'channel' },
  {
    table: 'connector_event_index_operator_seq_cursors',
    connectorColumn: 'source_connector',
    channelColumn: 'channel',
  },
  {
    table: 'connector_consumer_cursors',
    connectorColumn: 'connector',
    channelColumn: 'channel_id',
  },
  {
    table: 'connector_delta_deliveries',
    connectorColumn: 'connector',
    channelColumn: 'channel_id',
  },
  { table: 'connector_source_cursors', connectorColumn: 'connector', channelColumn: 'channel_id' },
];

type Db = InstanceType<typeof Database>;

export function buildPlan(db: Db, config: Record<string, unknown>): Plan {
  const canonical = new Map<string, Set<string>>();
  const byName = new Map<string, Map<string, string[]>>();

  for (const [connector, raw] of Object.entries(config)) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as { enabled?: unknown; channels?: unknown };
    if (entry.enabled === false) continue;
    if (entry.channels === null || typeof entry.channels !== 'object') continue;
    const channels = entry.channels as Record<string, { name?: unknown }>;
    canonical.set(connector, new Set(Object.keys(channels)));
    const names = new Map<string, string[]>();
    for (const [key, value] of Object.entries(channels)) {
      const name = value?.name;
      if (typeof name !== 'string' || name.trim().length === 0) continue;
      names.set(name, [...(names.get(name) ?? []), key]);
    }
    byName.set(connector, names);
  }

  const rows = db
    .prepare(
      `SELECT source_connector AS connector, channel, COUNT(*) AS n
         FROM connector_event_index GROUP BY 1, 2`
    )
    .all() as Array<{ connector: string; channel: string | null; n: number }>;

  const plan: Plan = { rekeys: [], ambiguous: [], alreadyCanonical: 0, unconfigured: 0 };
  for (const row of rows) {
    const channel = row.channel ?? '';
    const keys = canonical.get(row.connector);
    if (!keys) {
      plan.unconfigured += row.n;
      continue;
    }
    if (keys.has(channel)) {
      plan.alreadyCanonical += row.n;
      continue;
    }
    const candidates = byName.get(row.connector)?.get(channel) ?? [];
    if (candidates.length === 1) {
      plan.rekeys.push({
        connector: row.connector,
        from: channel,
        to: candidates[0],
        events: row.n,
      });
    } else {
      if (candidates.length > 1) {
        plan.ambiguous.push({
          connector: row.connector,
          name: channel,
          candidates: candidates.length,
        });
      }
      plan.unconfigured += row.n;
    }
  }
  return plan;
}

/**
 * Apply one re-key across every table that carries the value.
 *
 * Cursor tables are keyed by (connector, channel), so a re-key can collide with a row that
 * already exists under the canonical key. Deleting the loser would rewind a consumer;
 * keeping the further-along cursor is the only merge that cannot cause redelivery.
 */
export function applyRekey(db: Db, rekey: Rekey): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const { table, connectorColumn, channelColumn } of CHANNEL_TABLES) {
    if (!tableExists(db, table)) continue;
    if (table === 'connector_event_index_operator_seq_cursors') {
      moved[table] = mergeSeqCursor(db, rekey);
      continue;
    }
    if (table === 'connector_consumer_cursors') {
      moved[table] = mergeConsumerCursors(db, rekey);
      continue;
    }
    const result = db
      .prepare(
        `UPDATE "${table}" SET "${channelColumn}" = ?
          WHERE "${connectorColumn}" = ? AND "${channelColumn}" = ?`
      )
      .run(rekey.to, rekey.connector, rekey.from);
    moved[table] = result.changes;
  }
  return moved;
}

function mergeSeqCursor(db: Db, rekey: Rekey): number {
  const target = db
    .prepare(
      `SELECT next_seq FROM connector_event_index_operator_seq_cursors
        WHERE source_connector = ? AND channel = ?`
    )
    .get(rekey.connector, rekey.to) as { next_seq?: number } | undefined;
  const source = db
    .prepare(
      `SELECT next_seq FROM connector_event_index_operator_seq_cursors
        WHERE source_connector = ? AND channel = ?`
    )
    .get(rekey.connector, rekey.from) as { next_seq?: number } | undefined;
  if (!source) return 0;

  if (target === undefined) {
    return db
      .prepare(
        `UPDATE connector_event_index_operator_seq_cursors SET channel = ?
          WHERE source_connector = ? AND channel = ?`
      )
      .run(rekey.to, rekey.connector, rekey.from).changes;
  }
  // Both exist: the merged stream must not hand out a sequence number twice.
  db.prepare(
    `UPDATE connector_event_index_operator_seq_cursors SET next_seq = ?
      WHERE source_connector = ? AND channel = ?`
  ).run(Math.max(target.next_seq ?? 1, source.next_seq ?? 1), rekey.connector, rekey.to);
  db.prepare(
    `DELETE FROM connector_event_index_operator_seq_cursors
      WHERE source_connector = ? AND channel = ?`
  ).run(rekey.connector, rekey.from);
  return 1;
}

function mergeConsumerCursors(db: Db, rekey: Rekey): number {
  const sources = db
    .prepare(
      `SELECT consumer, last_event_index_id, last_event_version, updated_at
         FROM connector_consumer_cursors WHERE connector = ? AND channel_id = ?`
    )
    .all(rekey.connector, rekey.from) as Array<{
    consumer: string;
    last_event_index_id: string;
    last_event_version: number;
    updated_at: number;
  }>;

  let moved = 0;
  for (const source of sources) {
    const target = db
      .prepare(
        `SELECT updated_at FROM connector_consumer_cursors
          WHERE consumer = ? AND connector = ? AND channel_id = ?`
      )
      .get(source.consumer, rekey.connector, rekey.to) as { updated_at?: number } | undefined;

    if (target === undefined) {
      db.prepare(
        `UPDATE connector_consumer_cursors SET channel_id = ?
          WHERE consumer = ? AND connector = ? AND channel_id = ?`
      ).run(rekey.to, source.consumer, rekey.connector, rekey.from);
      moved += 1;
      continue;
    }
    // Keep whichever cursor has seen more. Moving a consumer backwards redelivers events
    // the owner has already been told about, which is the one outcome worse than silence.
    if (source.updated_at > (target.updated_at ?? 0)) {
      db.prepare(
        `UPDATE connector_consumer_cursors
            SET last_event_index_id = ?, last_event_version = ?, updated_at = ?
          WHERE consumer = ? AND connector = ? AND channel_id = ?`
      ).run(
        source.last_event_index_id,
        source.last_event_version,
        source.updated_at,
        source.consumer,
        rekey.connector,
        rekey.to
      );
      moved += 1;
    }
    db.prepare(
      `DELETE FROM connector_consumer_cursors
        WHERE consumer = ? AND connector = ? AND channel_id = ?`
    ).run(source.consumer, rekey.connector, rekey.from);
  }
  return moved;
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table)
  );
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const dbPath = process.env.MAMA_DB_PATH ?? join(homedir(), '.mama', 'mama-memory.db');
  if (!existsSync(dbPath)) {
    console.error(`No index at ${dbPath}`);
    process.exit(1);
  }
  const loaded = loadConnectorConfig();
  if (!loaded.ok) {
    console.error('Connector config is unreadable; refusing to plan a re-key against a guess.');
    process.exit(1);
  }

  const db = new Database(dbPath);
  const plan = buildPlan(db, loaded.config as unknown as Record<string, unknown>);
  const total = plan.rekeys.reduce((sum, rekey) => sum + rekey.events, 0);

  console.log(`already canonical : ${plan.alreadyCanonical}`);
  console.log(`to re-key         : ${total} events across ${plan.rekeys.length} channels`);
  console.log(`left alone        : ${plan.unconfigured} (channels this system was never given)`);
  if (plan.ambiguous.length > 0) {
    console.log(
      `AMBIGUOUS (skipped): ${plan.ambiguous.length} display names map to more than one channel`
    );
  }

  if (!apply) {
    console.log('\nDry run. Nothing was written. Pass --apply to perform the re-key.');
    db.close();
    return;
  }

  const backup = `${dbPath}.before-channel-rekey-${new Date().toISOString().replace(/[:.]/g, '')}`;
  copyFileSync(dbPath, backup);
  console.log(`\nbackup: ${backup}`);

  const moved: Record<string, number> = {};
  const run = db.transaction(() => {
    for (const rekey of plan.rekeys) {
      for (const [table, count] of Object.entries(applyRekey(db, rekey))) {
        moved[table] = (moved[table] ?? 0) + count;
      }
    }
  });
  run();

  for (const [table, count] of Object.entries(moved)) {
    console.log(`  ${table}: ${count}`);
  }
  db.close();
}

// Only run when invoked directly, so the planning and merge logic stay testable.
if (process.argv[1]?.endsWith('backfill-channel-keys.ts')) {
  main();
}

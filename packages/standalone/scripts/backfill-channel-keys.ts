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
 * WHY IT IS NOT JUST ONE UPDATE. The channel value is a join key in six places, and the
 * one that matters is not a table. A seam review found this version carefully merging
 * cursors in three tables that have no reader or writer anywhere in the repo, while
 * missing the live one: ConnectorDeltaRepo keys its partitions `connector\0channel` in
 * ~/.mama/operator/trigger-loop-cursors.json, and `drainNew` starts from 0 when a key is
 * absent. All 22 re-keyed partitions have a live cursor there. Applying the earlier
 * version would have redelivered 15,279 months-old events as new and composed owner
 * reports out of them - precisely the failure this comment claimed to prevent.
 *
 * `memory_scope_id` is the sixth carrier: on all 11,277 channel-scoped rows it is exactly
 * equal to `channel`. Moving one without the other leaves a row holding two names for its
 * own channel, which the pre-grant readers (/api/agent/raw among them) still consult.
 *
 * WHAT IT REFUSES TO DO:
 *   - Guess. A display name that maps to two configured channels is reported and skipped;
 *     an identity that has to be inferred is not an identity.
 *   - Invent. A channel that appears in no config entry is left exactly as it is. Those
 *     rows are correctly invisible: the owner never asked this system to look there.
 *   - Run by accident. Dry run is the default and --apply is required.
 *   - Run while the daemon is up. The deployed build's upsert overwrites `channel` from
 *     the poller on every re-fetch of an existing source_id (42% of slack rows have been
 *     re-upserted at least once), so a repair applied under a live daemon erodes silently,
 *     row by row, with no error.
 *   - Run against a schema whose per-partition sequence would collide. `operator_ingest_seq`
 *     is unique per (connector, channel), so merging two partitions merges two independent
 *     1..N sequences; the moved rows are renumbered above the target's high-water mark
 *     rather than left to abort the transaction on the unique index.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  renumberOperatorSeq(db, rekey);
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
    if (table === 'connector_event_index') {
      // The sixth carrier. Equal to `channel` on every channel-scoped row, so leaving it
      // behind gives the row two names for itself and makes the pre-grant readers
      // disagree with the grant path about the same event.
      moved['memory_scope_id'] = db
        .prepare(
          `UPDATE connector_event_index SET memory_scope_id = ?
            WHERE source_connector = ? AND memory_scope_kind = 'channel' AND memory_scope_id = ?`
        )
        .run(rekey.to, rekey.connector, rekey.from).changes;
    }
  }
  return moved;
}

/**
 * Give the moving rows sequence numbers above the target partition's high-water mark.
 *
 * `operator_ingest_seq` is numbered per (connector, channel) and a unique index enforces
 * it, so merging two partitions merges two independent 1..N sequences. Merging the CURSOR
 * to the higher watermark - which is what the first version did - only governs what is
 * assigned next; it does nothing about the rows already numbered. With one event already
 * polled into the target partition, the whole repair aborted on the unique index, after
 * the backup message had printed.
 *
 * Relative order within the moving set is preserved; interleaving with the target's
 * existing rows is not recoverable, because the two streams were never ordered against
 * each other in the first place.
 */
function renumberOperatorSeq(db: Db, rekey: Rekey): void {
  if (!tableExists(db, 'connector_event_index')) return;
  const high = db
    .prepare(
      `SELECT COALESCE(MAX(operator_ingest_seq), 0) AS high FROM connector_event_index
        WHERE source_connector = ? AND COALESCE(channel, '') = ?`
    )
    .get(rekey.connector, rekey.to) as { high?: number } | undefined;
  const base = Number(high?.high ?? 0);
  if (base === 0) return; // Target partition is empty: the move cannot collide.

  const moving = db
    .prepare(
      `SELECT event_index_id FROM connector_event_index
        WHERE source_connector = ? AND COALESCE(channel, '') = ?
          AND operator_ingest_seq IS NOT NULL
        ORDER BY operator_ingest_seq ASC`
    )
    .all(rekey.connector, rekey.from) as Array<{ event_index_id: string }>;

  const update = db.prepare(
    `UPDATE connector_event_index SET operator_ingest_seq = ? WHERE event_index_id = ?`
  );
  // Two passes through a disjoint high range: assigning directly into base+1.. can collide
  // with a not-yet-moved row of the same partition when the ranges overlap.
  const staging = base + 1_000_000;
  moving.forEach((row, index) => update.run(staging + index, row.event_index_id));
  moving.forEach((row, index) => update.run(base + 1 + index, row.event_index_id));
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

/**
 * Carry the live delta cursors, which are a JSON file rather than a table.
 *
 * ConnectorDeltaRepo keys partitions `connector\0channel` and `drainNew` falls back to 0
 * for an absent key, so an orphaned cursor does not error - it silently redelivers every
 * event in the partition. On the live file all 22 re-keyed partitions have a cursor, and
 * behind them sit 15,279 events that would have been drained as new and turned into owner
 * reports about months-old messages.
 *
 * Where both keys exist the LATER cursor wins, for the same reason as the table merge:
 * moving a consumer backwards is redelivery by another route.
 */
export function carryDeltaCursors(
  cursors: Record<string, number>,
  rekeys: readonly Rekey[]
): { cursors: Record<string, number>; carried: number } {
  const next = { ...cursors };
  let carried = 0;
  for (const rekey of rekeys) {
    const from = `${rekey.connector}\u0000${rekey.from}`;
    const to = `${rekey.connector}\u0000${rekey.to}`;
    if (!(from in next)) continue;
    const fromValue = next[from];
    const toValue = next[to];
    next[to] = toValue === undefined ? fromValue : Math.max(toValue, fromValue);
    delete next[from];
    carried += 1;
  }
  return { cursors: next, carried };
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table)
  );
}

function readCursorFile(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The daemon's pid if it is up. A stale pid file is not a running daemon. */
function runningDaemonPid(): number | null {
  const pidPath = join(homedir(), '.mama', 'mama.pid');
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
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

  const cursorPath = join(homedir(), '.mama', 'operator', 'trigger-loop-cursors.json');
  const cursors = readCursorFile(cursorPath);
  const carriedPreview = carryDeltaCursors(cursors, plan.rekeys).carried;
  console.log(`delta cursors     : ${carriedPreview} of ${plan.rekeys.length} partitions carry`);

  if (!apply) {
    console.log('\nDry run. Nothing was written. Pass --apply to perform the re-key.');
    db.close();
    return;
  }

  // A live daemon re-upserts polled events and its build overwrites `channel` from the
  // poller, so a repair applied underneath it erodes silently, row by row, with no error.
  const daemonPid = runningDaemonPid();
  if (daemonPid !== null) {
    console.error(
      `Refusing to apply while the daemon is running (pid ${daemonPid}).\n` +
        'Its build rewrites channel on every re-poll of an existing event, so the repair ' +
        'would be undone one row at a time with nothing reporting it. Run `mama stop` first.'
    );
    db.close();
    process.exit(1);
  }

  // VACUUM INTO, not copyFileSync: the live database is in WAL mode and a plain file copy
  // omits committed-but-uncheckpointed transactions, so the "backup" would be missing the
  // most recent writes precisely when it is needed.
  const backup = `${dbPath}.before-channel-rekey-${new Date().toISOString().replace(/[:.]/g, '')}`;
  db.prepare('VACUUM INTO ?').run(backup);
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

  const carried = carryDeltaCursors(cursors, plan.rekeys);
  if (carried.carried > 0) {
    writeFileSync(`${cursorPath}.before-channel-rekey`, JSON.stringify(cursors, null, 2));
    writeFileSync(cursorPath, JSON.stringify(carried.cursors, null, 2));
    console.log(`  delta cursors carried: ${carried.carried}`);
  }
  db.close();
}

// Only run when invoked directly, so the planning and merge logic stay testable.
// Matches the compiled .js too: gating on the .ts name alone made a built copy exit
// silently having done nothing.
if (/backfill-channel-keys\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main();
}

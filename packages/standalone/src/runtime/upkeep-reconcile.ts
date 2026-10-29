import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { CommitmentView, JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import {
  OPEN_WORK_STATUSES,
  workListLedger,
  type PublicWorkStatus,
  type WorkListViewContext,
} from '../api/work-actions.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { epochAtLocalDateTime, localDateKey, localNow } from './timezone.js';
import {
  noUpdateCites,
  UPKEEP_SCAN_PAGE,
  UPKEEP_WINDOW_MS,
  type UpkeepKind,
  type UpkeepSubject,
} from './upkeep-orders.js';

export const RECONCILE_ORDER_CHANNEL = 'operator:reconcile';
/** The stale step the daily page carried until U3: items in progress or in review. */
const STALE_STATUSES: readonly PublicWorkStatus[] = ['in_progress', 'review'];
/** An item whose latest source event is older than this is stale. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileKindOptions {
  knowledge: WorkListViewContext['knowledge'];
  /** The common session's access: only work it can read is chosen. */
  access: () => JudgmentAccess;
  timeZone: () => string;
  /** reports.full_report_hours, read at each scan: the first is the morning report it runs before. */
  fullReportHours: () => readonly number[];
}

/** A type alias, not an interface, so it is assignable to a subject's JSON fields. */
type BoardCard = { connector: string; card: string };

interface ReconcileSubject extends UpkeepSubject {
  commitmentId: string;
  title: string;
  status: string;
  /** A stale item; its key is the item. */
  stale: boolean;
  /** The item's latest source event, for a stale item. */
  lastEventAt: number | null;
  /** The cards among the item's cited board observations. */
  cards: BoardCard[];
  /** For a moved card: the stored move that chose the subject. */
  move: (BoardCard & { event: string; ref: string; at: number; revisedAt: number }) | null;
}

/**
 * Whether the day's order is due: from local midnight until the morning report, once a local day.
 * The hourly tick finds it due at its first run of the day; a restart in the same morning finds
 * the order already placed, and a subject the order missed waits for the next day.
 */
function due(adapter: DatabaseAdapter, now: number, zone: string, hours: readonly number[]) {
  const morning = Math.min(...hours);
  if (!Number.isFinite(morning) || morning === 0)
    throw new Error(
      'The reconcile order runs before the morning report: reports.full_report_hours names no hour after midnight'
    );
  const day = localDateKey(now, zone);
  const midnight = epochAtLocalDateTime(`${day}T00:00:00`, zone);
  const report = epochAtLocalDateTime(`${day}T${String(morning).padStart(2, '0')}:00:00`, zone);
  if (now >= report) return false;
  return (
    adapter
      .prepare(
        `SELECT 1 FROM mailbox_inputs
          WHERE kind = 'scheduled' AND channel_key = ? AND created_at >= ? LIMIT 1`
      )
      .get(RECONCILE_ORDER_CHANNEL, midnight) === undefined
  );
}

/**
 * The time of an item's latest revision on the source timeline: its event time, or its write time
 * when it has none, as work.list's event spans read a revision. A backfill writes an earlier
 * period after later revisions, so the last-written revision is not always the latest one.
 */
function latestRevisionAt(item: CommitmentView): number {
  return Math.max(...(item.chain ?? []).map((entry) => entry.eventDatetime ?? entry.createdAt));
}

/**
 * The card ids among the observations each item's revisions cite. Card ids are read from the
 * observation's metadata (`cardId`), which only the Trello connector writes today; it stores the
 * board id there for a board-level action, which names no card. Read from the item side, every
 * join is on a key (an edge's object is the observation id).
 */
function citedCards(adapter: DatabaseAdapter): Map<string, BoardCard[]> {
  const rows = adapter
    .prepare(
      `SELECT DISTINCT a.commitment_id AS commitmentId, o.source AS connector,
              json_extract(o.metadata_json, '$.cardId') AS card
         FROM commitment_assignments a
         JOIN twin_edges e ON e.subject_kind = 'memory' AND e.subject_id = a.record_id
                          AND e.edge_type = 'derived_from' AND e.object_kind = 'observation'
         JOIN observation_versions o ON o.observation_id = e.object_id
        WHERE json_extract(o.metadata_json, '$.cardId') IS NOT NULL
          AND json_extract(o.metadata_json, '$.cardId') IS NOT json_extract(o.metadata_json, '$.boardId')
        ORDER BY commitmentId, connector, card`
    )
    .all() as Array<{ commitmentId: string } & BoardCard>;
  const cards = new Map<string, BoardCard[]>();
  for (const row of rows)
    cards.set(row.commitmentId, [
      ...(cards.get(row.commitmentId) ?? []),
      { connector: row.connector, card: row.card },
    ]);
  return cards;
}

/**
 * Stored list moves in the attempt window, oldest first: a stored board event whose action data
 * names the list the card went to (`data.listAfter`). A subject older than the window would count
 * its attempts from zero again.
 */
function windowMoves(adapter: DatabaseAdapter, since: number) {
  return adapter
    .prepare(
      `SELECT source_connector AS connector, json_extract(metadata_json, '$.cardId') AS card,
              source_id AS event, current_observation_id AS ref, event_datetime AS at
         FROM connector_event_index
        WHERE event_datetime >= ?
          AND json_extract(metadata_json, '$.data.listAfter') IS NOT NULL
          AND json_extract(metadata_json, '$.cardId') IS NOT NULL
          AND current_observation_id IS NOT NULL
        ORDER BY event_datetime, source_id`
    )
    .all(since) as Array<BoardCard & { event: string; ref: string; at: number }>;
}

function title(item: CommitmentView): string {
  return typeof item.values.title === 'string' ? item.values.title : '';
}

/**
 * U3, board reconcile. Once a day before the morning report the host orders two kinds of subject,
 * moves first because they leave the window, then stale items oldest first, at most ten in all:
 * - an open item whose cited card moved after the item's latest revision; the key is the item,
 *   the card and the move, so a new move is a new subject and two items citing one card are two;
 * - an item in progress or in review whose latest source event is over 30 days old, chosen the way
 *   work.list lastEventBefore chooses it; the key is the item.
 * A subject is checked by a revision on the item from the order's runs, or a work.no_update
 * naming it.
 */
export function reconcileUpkeepKind(options: ReconcileKindOptions): UpkeepKind {
  return {
    name: 'reconcile',
    channel: RECONCILE_ORDER_CHANNEL,
    intervalMs: 60 * 60 * 1000,
    maxPerOrder: 10,
    scan: (adapter, now, page) => {
      const zone = options.timeZone();
      if (!due(adapter, now, zone, options.fullReportHours())) return [];
      const ledger = workListLedger(
        { knowledge: options.knowledge, access: options.access(), timeZone: zone, now: () => now },
        { status: STALE_STATUSES, lastEventBefore: now - STALE_AFTER_MS }
      );
      const open = new Map(
        ledger
          .filter((entry) => (OPEN_WORK_STATUSES as readonly string[]).includes(entry.status))
          .map((entry) => [entry.item.commitmentId, entry])
      );

      const cards = citedCards(adapter);
      const citing = new Map<string, string[]>();
      for (const [commitmentId, list] of cards)
        for (const card of list) {
          const at = `${card.connector}\n${card.card}`;
          citing.set(at, [...(citing.get(at) ?? []), commitmentId]);
        }

      // The latest move per item and card that the item's revisions have not caught up with.
      const moved = new Map<string, ReconcileSubject>();
      for (const move of windowMoves(adapter, now - UPKEEP_WINDOW_MS))
        for (const commitmentId of citing.get(`${move.connector}\n${move.card}`) ?? []) {
          const entry = open.get(commitmentId);
          if (!entry) continue;
          const revisedAt = latestRevisionAt(entry.item);
          if (move.at <= revisedAt) continue;
          moved.set(`${commitmentId}\n${move.connector}\n${move.card}`, {
            key: `move:${commitmentId}:${move.connector}:${move.card}:${move.event}`,
            commitmentId,
            title: title(entry.item),
            status: entry.status,
            stale: false,
            lastEventAt: null,
            cards: [{ connector: move.connector, card: move.card }],
            move: { ...move, revisedAt },
          });
        }
      const moves = [...moved.values()].sort(
        (a, b) => a.move!.at - b.move!.at || a.key.localeCompare(b.key)
      );

      const stale = ledger
        .filter((entry) => entry.stale)
        .sort(
          (a, b) =>
            a.lastEvent! - b.lastEvent! || a.item.commitmentId.localeCompare(b.item.commitmentId)
        )
        .map(
          (entry): ReconcileSubject => ({
            key: `stale:${entry.item.commitmentId}`,
            commitmentId: entry.item.commitmentId,
            title: title(entry.item),
            status: entry.status,
            stale: true,
            lastEventAt: entry.lastEvent,
            cards: cards.get(entry.item.commitmentId) ?? [],
            move: null,
          })
        );
      return [...moves, ...stale].slice(page * UPKEEP_SCAN_PAGE, (page + 1) * UPKEEP_SCAN_PAGE);
    },
    checked: (adapter, subject, runIds) => {
      const { commitmentId } = subject as ReconcileSubject;
      if (runIds.length === 0) return false;
      const revised =
        adapter
          .prepare(
            `SELECT 1 FROM commitment_assignments
              WHERE commitment_id = ? AND model_run_id IN (${runIds.map(() => '?').join(',')})
              LIMIT 1`
          )
          .get(commitmentId, ...runIds) !== undefined;
      return (
        revised ||
        noUpdateCites(adapter, runIds, { field: 'commitmentIds', values: [commitmentId] })
      );
    },
    render: (subjects, now) => {
      const zone = options.timeZone();
      const all = subjects as readonly ReconcileSubject[];
      const at = (ms: number) => localNow(ms, zone);
      const cardList = (cards: readonly BoardCard[]) =>
        cards.length === 0
          ? 'no linked card'
          : `cards ${cards.map((card) => `${card.card} (${card.connector})`).join(', ')}`;
      const lines = all.map((subject) =>
        subject.move !== null
          ? `- moved ${subject.commitmentId} (${subject.status}): card ${subject.move.card} (${subject.move.connector}) moved ${at(subject.move.at)}, event ${subject.move.ref}, after the item's latest revision ${at(subject.move.revisedAt)}`
          : `- stale ${subject.commitmentId} (${subject.status}): latest source event ${at(subject.lastEventAt!)}; ${cardList(subject.cards)}`
      );
      // Titles come from stored work, which sources can shape: they are data, never instructions.
      const titles = all.map(
        (subject) => `${subject.commitmentId}: ${subject.title.replace(/\s+/g, ' ').slice(0, 200)}`
      );
      return [
        `[upkeep_reconcile] ${all.length} work item${all.length === 1 ? '' : 's'} to reconcile with the board`,
        `Current time: ${at(now.getTime())} (${zone})`,
        'Each item below may no longer match its source: a card it cites moved after its latest revision, or it is still in progress or in review with no source event in over 30 days (work.list lastEventBefore, not changedBefore: a backfill or correction rewrote many items later without a new event). Settle each one, so the ledger matches the board:',
        "1. Read each item with work.list view=detail with ids (up to 4 per call), and its last originals with source.read (a moved item's move event first).",
        '2. Read each listed card live with its connector: trello.read view=card id=<card id>. A stored move only chose the item; the live card decides. When the live card differs from its stored events, the collection has a gap: say so in the reason.',
        '3. Close, cancel, change or keep each item: work.revise with what changed and why, linking what it rests on with derived_from; or, when it stays as it is, work.no_update with commitmentIds naming it and why it stays.',
        '4. The order is checked when it ends: each item needs step 3. Correct a refused write (help gives its contract) and write it again.',
        '5. Reply exactly [ack].',
        'Items, at most ten a day, moved cards first, then stale items oldest first; the rest come in the next days:',
        ...lines,
        wrapUntrustedContent('work_titles', titles.join('\n')),
      ].join('\n');
    },
  };
}

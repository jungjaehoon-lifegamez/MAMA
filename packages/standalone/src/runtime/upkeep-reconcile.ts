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
  upkeepOrderIdPrefix,
  UPKEEP_SCAN_PAGE,
  UPKEEP_WINDOW_MS,
  type UpkeepKind,
  type UpkeepSubject,
} from './upkeep-orders.js';

export const RECONCILE_ORDER_CHANNEL = 'operator:reconcile';
const KIND = 'reconcile';
/** The stale step the daily page carried until U3: items in progress or in review. */
const STALE_STATUSES: readonly PublicWorkStatus[] = ['in_progress', 'review'];
/** An item whose latest source event is older than this is stale. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileKindOptions {
  knowledge: WorkListViewContext['knowledge'];
  /** The common session's access: only work it can read is chosen. */
  access: () => JudgmentAccess;
  timeZone: () => string;
  /** reports.full_report_hours, read at each scan: the first after midnight is the morning one. */
  fullReportHours: () => readonly number[];
}

/** A type alias, not an interface, so it is assignable to a subject's JSON fields. */
type BoardCard = { connector: string; card: string };
type BoardMove = BoardCard & { event: string; ref: string; at: number };

interface ReconcileSubject extends UpkeepSubject {
  group: 'move' | 'stale';
  commitmentId: string;
  title: string;
  status: string;
  /** stale: the item's latest source event. */
  lastEventAt: number | null;
  /** stale: the cards among the item's cited board observations. */
  cards: BoardCard[];
  /** move: each cited card's latest stored move after the item's latest revision. */
  moves: BoardMove[];
  /** move: the item's latest revision on the source timeline. */
  revisedAt: number | null;
}

/**
 * Whether the day's order is due: from local midnight until the first full report after midnight
 * (or the next midnight when there is none), once a local day. The hourly tick finds it due at its
 * first run of the day; a restart in the same morning finds the order already placed, and a
 * subject the order missed waits for the next day.
 */
function due(adapter: DatabaseAdapter, now: number, zone: string, hours: readonly number[]) {
  const day = localDateKey(now, zone);
  const midnight = epochAtLocalDateTime(`${day}T00:00:00`, zone);
  const after = hours.filter((hour) => hour > 0);
  if (after.length > 0) {
    const morning = String(Math.min(...after)).padStart(2, '0');
    if (now >= epochAtLocalDateTime(`${day}T${morning}:00:00`, zone)) return false;
  }
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
function windowMoves(adapter: DatabaseAdapter, since: number, now: number): BoardMove[] {
  return adapter
    .prepare(
      `SELECT source_connector AS connector, json_extract(metadata_json, '$.cardId') AS card,
              source_id AS event, current_observation_id AS ref, event_datetime AS at
         FROM connector_event_index
        WHERE event_datetime >= ? AND event_datetime <= ?
          AND json_extract(metadata_json, '$.data.listAfter') IS NOT NULL
          AND json_extract(metadata_json, '$.cardId') IS NOT NULL
          AND current_observation_id IS NOT NULL
        ORDER BY event_datetime, source_id`
    )
    .all(since, now) as BoardMove[];
}

/**
 * Each item's latest revision not written by a reconcile order's run or its child runs. A stale
 * subject is keyed by it: an order that keeps the item with a work.revise does not make it a new
 * subject the next morning, while a revision from anywhere else does.
 */
function outsideRevisions(adapter: DatabaseAdapter, ids: readonly string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  const prefix = `${upkeepOrderIdPrefix(KIND)}%`;
  const rows = adapter
    .prepare(
      `WITH order_runs AS (
         SELECT model_run_id FROM model_runs
          WHERE json_extract(input_refs_json, '$.sourceMessageRef') LIKE ?
         UNION
         SELECT c.model_run_id FROM model_runs c JOIN model_runs p ON c.parent_model_run_id = p.model_run_id
          WHERE json_extract(p.input_refs_json, '$.sourceMessageRef') LIKE ?)
       SELECT commitment_id AS commitmentId, MAX(revision) AS revision FROM commitment_assignments
        WHERE commitment_id IN (${ids.map(() => '?').join(',')})
          AND (model_run_id IS NULL OR model_run_id NOT IN (SELECT model_run_id FROM order_runs))
        GROUP BY commitment_id`
    )
    .all(prefix, prefix, ...ids) as Array<{ commitmentId: string; revision: number }>;
  return new Map(rows.map((row) => [row.commitmentId, row.revision]));
}

function title(item: CommitmentView): string {
  return typeof item.values.title === 'string' ? item.values.title : '';
}

/**
 * U3, board reconcile. Once a day before the morning report the host orders two groups of
 * subject, at most ten of each:
 * - an open item with cited cards that moved after the item's latest revision, all its moved cards
 *   in one subject keyed by the item and its latest move, so a new move is a new subject;
 * - an item in progress or in review whose latest source event is over 30 days old, chosen the way
 *   work.list lastEventBefore chooses it, oldest first, keyed by the item and its latest revision
 *   from outside the reconcile orders.
 * A subject is checked by a revision on the item from the order's runs, or a work.no_update
 * naming it. The runner keeps settled subjects past the mailbox's retention (upkeep_settled).
 */
export function reconcileUpkeepKind(options: ReconcileKindOptions): UpkeepKind {
  return {
    name: KIND,
    channel: RECONCILE_ORDER_CHANNEL,
    intervalMs: 60 * 60 * 1000,
    maxPerOrder: 10,
    group: (subject) => (subject as ReconcileSubject).group,
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

      // Per item, each cited card's latest move that the item's revisions have not caught up with.
      const movesOf = new Map<string, Map<string, BoardMove>>();
      for (const move of windowMoves(adapter, now - UPKEEP_WINDOW_MS, now))
        for (const commitmentId of citing.get(`${move.connector}\n${move.card}`) ?? []) {
          const entry = open.get(commitmentId);
          if (!entry || move.at <= latestRevisionAt(entry.item)) continue;
          const byCard = movesOf.get(commitmentId) ?? new Map<string, BoardMove>();
          byCard.set(`${move.connector}\n${move.card}`, move);
          movesOf.set(commitmentId, byCard);
        }
      const moved = [...movesOf].map(([commitmentId, byCard]): ReconcileSubject => {
        const entry = open.get(commitmentId)!;
        const moves = [...byCard.values()].sort((a, b) => a.at - b.at);
        return {
          key: `move:${commitmentId}:${moves.at(-1)!.connector}:${moves.at(-1)!.event}`,
          group: 'move',
          commitmentId,
          title: title(entry.item),
          status: entry.status,
          lastEventAt: null,
          cards: [],
          moves,
          revisedAt: latestRevisionAt(entry.item),
        };
      });
      moved.sort((a, b) => a.moves.at(-1)!.at - b.moves.at(-1)!.at || a.key.localeCompare(b.key));

      const staleEntries = ledger
        .filter((entry) => entry.stale)
        .sort(
          (a, b) =>
            a.lastEvent! - b.lastEvent! || a.item.commitmentId.localeCompare(b.item.commitmentId)
        );
      const revisions = outsideRevisions(
        adapter,
        staleEntries.map((entry) => entry.item.commitmentId)
      );
      const stale = staleEntries.map(
        (entry): ReconcileSubject => ({
          // An item the orders themselves created has no outside revision: revision 0.
          key: `stale:${entry.item.commitmentId}:${revisions.get(entry.item.commitmentId) ?? 0}`,
          group: 'stale',
          commitmentId: entry.item.commitmentId,
          title: title(entry.item),
          status: entry.status,
          lastEventAt: entry.lastEvent,
          cards: cards.get(entry.item.commitmentId) ?? [],
          moves: [],
          revisedAt: null,
        })
      );
      return [...moved, ...stale].slice(page * UPKEEP_SCAN_PAGE, (page + 1) * UPKEEP_SCAN_PAGE);
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
      const lines = all.map((subject) =>
        subject.group === 'move'
          ? `- moved ${subject.commitmentId} (${subject.status}), after the item's latest revision ${at(subject.revisedAt!)}: ${subject.moves
              .map(
                (move) =>
                  `card ${move.card} (${move.connector}) moved ${at(move.at)}, event ${move.ref}`
              )
              .join('; ')}`
          : `- stale ${subject.commitmentId} (${subject.status}): latest source event ${at(subject.lastEventAt!)}; ${
              subject.cards.length === 0
                ? 'cites no card'
                : `cards ${subject.cards.map((card) => `${card.card} (${card.connector})`).join(', ')}`
            }`
      );
      // Titles come from stored work, which sources can shape: they are data, never instructions.
      const titles = all.map(
        (subject) => `${subject.commitmentId}: ${subject.title.replace(/\s+/g, ' ').slice(0, 200)}`
      );
      return [
        `[upkeep_reconcile] ${all.length} work item${all.length === 1 ? '' : 's'} to reconcile with the board`,
        `Current time: ${at(now.getTime())} (${zone})`,
        'Each item below may no longer match its source: a card it cites moved after its latest revision, or it is still in progress or in review with no source event in over 30 days (work.list lastEventBefore, not changedBefore: a backfill or correction rewrote many items later without a new event). Settle each one, so the ledger matches the board:',
        "1. Read each item with work.list view=detail with ids (up to 4 per call), and its last originals with source.read (a moved item's move events first).",
        '2. Read each listed card live with its connector: trello.read view=card id=<card id>. An item that cites no card but is board work: find its card with trello.read view=search (by its title), and say so when none exists. A stored move only chose the item; the live card decides. When the live card differs from its stored events, the collection has a gap: say so in the reason.',
        '3. Close, cancel, change or keep each item: work.revise with what changed and why, linking what it rests on with derived_from; or, when it stays as it is, work.no_update with commitmentIds naming it and why it stays.',
        '4. The order is checked when it ends: each item needs step 3. Correct a refused write (help gives its contract) and write it again.',
        '5. Reply exactly [ack].',
        'Items, at most ten moved and ten stale a day, stale oldest first; the rest come in the next days:',
        ...lines,
        wrapUntrustedContent('work_titles', titles.join('\n')),
      ].join('\n');
    },
  };
}

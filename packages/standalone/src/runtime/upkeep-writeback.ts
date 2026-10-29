import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import { localNow } from './timezone.js';
import {
  noUpdateCites,
  UPKEEP_SCAN_PAGE,
  UPKEEP_WINDOW_MS,
  type UpkeepKind,
  type UpkeepSubject,
} from './upkeep-orders.js';

export const WRITEBACK_ORDER_CHANNEL = 'operator:writeback';

/** How many sources one subject carries: the refs source.read opened first, then search hits. */
const MAX_REFS_PER_SUBJECT = 30;

export interface WritebackKindOptions {
  /**
   * The non-chat connectors the common session reads in full (ownerAccess.connectorWideRead).
   * Their observations carry no memory scope, and the owner read path admits them by connector
   * (observations.ts isObservationVisibilityRowVisible), so the same list decides they are common.
   */
  wideReadConnectors: () => readonly string[];
  /** The common session's principal: its question turns qualify, and its chat scope is common. */
  ownerPrincipalId: string;
  timeZone: () => string;
}

interface WritebackSubject extends UpkeepSubject {
  /** The question turn's model run id. A new turn is a new subject. */
  key: string;
  /** The common-scope observation handles carried, opened first then search hits, up to 30. */
  refs: string[];
  /** Which of `refs` the turn opened with source.read; the rest are search hits. */
  opened: string[];
  /** The question turn's time, for ordering and the order text. */
  askedAt: number;
}

/**
 * The privacy boundary (docs/development/work/ledger-upkeep.md, U2; Codex: "U2 crossed the
 * personal boundary"). It reads the observation's own scope columns, which appendObservationVersion
 * derives from the flat scope bag every connector and chat write carries, and decides "common" the
 * way the common session's reads already do (action-surface.ts ownerAccess):
 * - a non-chat source the owner reads connector-wide, unscoped or scoped to the common principal;
 * - a chat message scoped to the common principal (`user:<owner>`), outside every private
 *   Telegram channel, so no DM, the owner's own included, reaches the common order.
 * Chat is never admitted by connector: its commonness is its scope. Anything else (another
 * principal's scope, an owner-visibility record, an unknown handle) is dropped.
 */
function commonSourceFilter(
  col: string,
  wideReadConnectors: readonly string[],
  ownerPrincipalId: string
): { sql: string; params: string[] } {
  const connectorWide =
    wideReadConnectors.length === 0
      ? ''
      : `(o.source <> 'chat' AND o.source IN (${wideReadConnectors.map(() => '?').join(',')})
           AND (o.memory_scope_kind IS NULL
                OR (o.memory_scope_kind = 'user' AND o.memory_scope_id = ?))) OR`;
  const sql = `EXISTS (
      SELECT 1 FROM observation_versions o
       WHERE o.observation_id = ${col}
         AND (${connectorWide}
              (o.source = 'chat' AND o.memory_scope_kind = 'user' AND o.memory_scope_id = ?
               AND o.channel IS NOT NULL
               AND o.channel NOT IN (SELECT 'telegram:' || external_id FROM external_identities
                                      WHERE connector = 'telegram' AND namespace = 'private'))))`;
  return {
    sql,
    params: [
      ...(wideReadConnectors.length === 0 ? [] : [...wideReadConnectors, ownerPrincipalId]),
      ownerPrincipalId,
    ],
  };
}

/** `${alias}`'s run belongs to the question turn `r`: the turn's own run or a direct child run. */
function inTurnRuns(alias: string): string {
  return `(${alias}.model_run_id = r.model_run_id
     OR ${alias}.model_run_id IN (SELECT model_run_id FROM model_runs
                                   WHERE parent_model_run_id = r.model_run_id))`;
}

/** The observation handles a turn's reads returned in evidence_json, correlated on the turn `r`. */
function readRefsSubquery(
  tool: 'any' | 'read',
  filter?: { sql: string; params: string[] }
): { sql: string; params: string[] } {
  const tools = tool === 'read' ? `'source.read'` : `'source.search', 'source.read'`;
  const sql = `SELECT ref.value AS oref, tr.tool_name AS tool, tr.created_at AS at
     FROM tool_traces tr
     JOIN json_each(json_extract(tr.evidence_json, '$.observationRefs')) ref
    WHERE ${inTurnRuns('tr')}
      AND tr.tool_name IN (${tools})
      AND tr.execution_status = 'completed'
      AND tr.evidence_json IS NOT NULL
      ${filter ? `AND ${filter.sql}` : ''}`;
  return { sql, params: filter?.params ?? [] };
}

/** A completed derived_from edge in these runs that cites one of `refs` (work revision or memory.save). */
function derivedFromCites(
  adapter: DatabaseAdapter,
  runIds: readonly string[],
  refs: readonly string[]
): boolean {
  if (runIds.length === 0 || refs.length === 0) return false;
  return (
    adapter
      .prepare(
        `SELECT 1 FROM twin_edges
          WHERE edge_type = 'derived_from' AND object_kind = 'observation'
            AND object_id IN (${refs.map(() => '?').join(',')})
            AND model_run_id IN (${runIds.map(() => '?').join(',')})
          LIMIT 1`
      )
      .get(...refs, ...runIds) !== undefined
  );
}

/**
 * U2, write-back orders. A subject is one question turn (a committed owner_message run of the
 * common session or an owner-role principal) that read common-scope sources and recorded nothing
 * from them. The order carries only common-scope handles; the question text is never carried. It
 * is checked when the order's run writes a revision or a fact/lesson citing one of the handles, or
 * declares work.no_update naming them.
 */
export function writebackUpkeepKind(options: WritebackKindOptions): UpkeepKind {
  return {
    name: 'writeback',
    channel: WRITEBACK_ORDER_CHANNEL,
    // Hourly, like the closing-summary kind: a question answered off the ledger is worth writing
    // back the same day, and the attempt window and one-order-per-kind cap keep it bounded.
    intervalMs: 60 * 60 * 1000,
    // Each subject already asks for up to 30 sources to read and record; three turns an order
    // keeps the common session's queue, the owner's, workable.
    maxPerOrder: 3,
    scan: (adapter, now, page) => {
      const wide = options.wideReadConnectors();
      // Consulting a source is a search hit or an opened read: a question answered from a search
      // preview without opening the record is the same unrecorded gap. The order still marks which
      // were opened. The turn qualifies when it consulted a common source and cited none of what
      // it consulted.
      const commonRead = readRefsSubquery(
        'any',
        commonSourceFilter('ref.value', wide, options.ownerPrincipalId)
      );
      const allRead = readRefsSubquery('any');
      // A subject older than the attempt window would count its attempts from zero again; the
      // mailbox keeps owner_message rows the same seven days, so the join never loses a newer one.
      // No lower `since`: evidence_json did not exist before the deploy, so earlier turns carry no
      // read receipt and cannot qualify.
      const rows = adapter
        .prepare(
          `SELECT r.model_run_id AS runId, r.created_at AS askedAt
             FROM model_runs r
             JOIN mailbox_inputs m
               ON m.principal_id = json_extract(r.input_refs_json, '$.principalId')
              AND m.stimulus_id = json_extract(r.input_refs_json, '$.sourceMessageRef')
              AND m.kind = 'owner_message'
            WHERE r.status = 'committed'
              AND r.created_at >= ?
              AND (json_extract(r.input_refs_json, '$.principalId') = ?
                   OR json_extract(r.input_refs_json, '$.principalId') IN
                        (SELECT principal_id FROM principal_roles WHERE role = 'owner'))
              AND EXISTS (${commonRead.sql})
              AND NOT EXISTS (
                    SELECT 1 FROM twin_edges e
                     WHERE e.edge_type = 'derived_from' AND e.object_kind = 'observation'
                       AND ${inTurnRuns('e')}
                       AND e.object_id IN (SELECT oref FROM (${allRead.sql})))
            -- One row per turn: mailbox_inputs has no unique (principal_id, stimulus_id) constraint.
            GROUP BY r.model_run_id, r.created_at
            ORDER BY r.created_at, r.model_run_id
            LIMIT ? OFFSET ?`
        )
        .all(
          now - UPKEEP_WINDOW_MS,
          options.ownerPrincipalId,
          ...commonRead.params,
          UPKEEP_SCAN_PAGE,
          page * UPKEEP_SCAN_PAGE
        ) as Array<{ runId: string; askedAt: number }>;
      if (rows.length === 0) return [];

      // Assemble each subject's carried handles: the common-scope refs the turn opened first, then
      // its common-scope search hits, up to thirty, oldest first.
      const common2 = commonSourceFilter('ref.value', wide, options.ownerPrincipalId);
      const refRows = adapter
        .prepare(
          `WITH turn(id) AS (VALUES ${rows.map(() => '(?)').join(',')}),
                runs AS (
                  SELECT id AS turnId, id AS runId FROM turn
                  UNION
                  SELECT turn.id, c.model_run_id FROM model_runs c
                    JOIN turn ON c.parent_model_run_id = turn.id)
           SELECT runs.turnId AS turnId, ref.value AS oref,
                  MAX(CASE WHEN tr.tool_name = 'source.read' THEN 1 ELSE 0 END) AS opened,
                  MIN(tr.created_at) AS at
             FROM runs
             JOIN tool_traces tr ON tr.model_run_id = runs.runId
             JOIN json_each(json_extract(tr.evidence_json, '$.observationRefs')) ref
            WHERE tr.tool_name IN ('source.search', 'source.read')
              AND tr.execution_status = 'completed'
              AND tr.evidence_json IS NOT NULL
              AND ${common2.sql}
            GROUP BY runs.turnId, ref.value
            ORDER BY runs.turnId, opened DESC, at, ref.value`
        )
        .all(...rows.map((row) => row.runId), ...common2.params) as Array<{
        turnId: string;
        oref: string;
        opened: number;
        at: number;
      }>;

      const byTurn = new Map<string, { refs: string[]; opened: string[] }>();
      for (const row of refRows) {
        const entry = byTurn.get(row.turnId) ?? { refs: [], opened: [] };
        if (entry.refs.length < MAX_REFS_PER_SUBJECT) {
          entry.refs.push(row.oref);
          if (row.opened === 1) entry.opened.push(row.oref);
        }
        byTurn.set(row.turnId, entry);
      }
      return rows.flatMap((row): WritebackSubject[] => {
        const entry = byTurn.get(row.runId);
        // A turn with no common-scope handle after assembly carries nothing; it is not a subject.
        if (!entry || entry.refs.length === 0) return [];
        return [{ key: row.runId, refs: entry.refs, opened: entry.opened, askedAt: row.askedAt }];
      });
    },
    checked: (adapter, subject, runIds) => {
      const { refs } = subject as WritebackSubject;
      if (runIds.length === 0 || refs.length === 0) return false;
      return (
        derivedFromCites(adapter, runIds, refs) ||
        noUpdateCites(adapter, runIds, { field: 'observationRefs', values: refs })
      );
    },
    render: (subjects, now) => {
      const zone = options.timeZone();
      const lines = (subjects as readonly WritebackSubject[]).map((subject) => {
        const openedSet = new Set(subject.opened);
        const opened = subject.refs.filter((ref) => openedSet.has(ref));
        const hits = subject.refs.filter((ref) => !openedSet.has(ref));
        const parts = [`- turn ${subject.key} (asked ${localNow(subject.askedAt, zone)}):`];
        if (opened.length > 0) parts.push(`opened ${opened.join(', ')}`);
        if (hits.length > 0)
          parts.push(`${opened.length > 0 ? 'also found' : 'found'} ${hits.join(', ')}`);
        return parts.join(' ');
      });
      return [
        `[upkeep_writeback] ${subjects.length} answered question turn${subjects.length === 1 ? '' : 's'} that read sources and recorded nothing`,
        `Current time: ${localNow(now.getTime(), zone)} (${zone})`,
        'A question was answered from these sources. Record what belongs in the ledger, so the next question reads one place:',
        '1. Read each source with source.read (observationRefs, batched per connector).',
        '2. Record what belongs in the ledger, each with derived_from links to the sources it came from: work.revise or work.create for a work change; memory.save for a fact or lesson (prices, specs and client rules are facts).',
        '3. A matter already recorded, or chatter not worth recording: work.no_update with observationRefs naming those sources and the reason.',
        '4. The order is checked when it ends: at least one write or a no-update must cite these sources. Correct a refused write (help gives its contract) and write it again.',
        '5. Reply exactly [ack].',
        ...lines,
      ].join('\n');
    },
  };
}

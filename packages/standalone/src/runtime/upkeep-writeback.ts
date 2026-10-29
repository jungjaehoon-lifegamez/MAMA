import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
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
   * The common session's scopes (ownerAccess.defaultScopes, not .scopes, which pulls in granted
   * member partitions). Only observations bound within this set, and to nothing outside it, cross
   * into the common write-back order.
   */
  commonScopes: () => readonly MemoryScopeRef[];
  /** The common session's principal: its question turns qualify, and its own DM is never dropped. */
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
 * personal boundary"). A handle `${col}` is carried only when its observation is bound within the
 * common scope set AND to nothing outside it (so a member's personal-scoped record is dropped),
 * and when it is not another person's Telegram DM (so no private chat reaches the common session).
 * The common session's own DM (ownerPrincipalId) is never dropped by the channel clause. Fails
 * closed: an unbound or unknown handle has no common binding and is dropped.
 */
function commonScopeFilter(
  col: string,
  commonScopes: readonly MemoryScopeRef[],
  ownerPrincipalId: string
): { sql: string; params: string[] } {
  const pairs = commonScopes.map(() => '(?,?)').join(',');
  const scopeKey = (alias: string) =>
    `(json_extract(${alias}.value, '$.kind'), coalesce(json_extract(${alias}.value, '$.id'), json_extract(${alias}.value, '$.externalId')))`;
  const pairParams = commonScopes.flatMap((scope) => [scope.kind, scope.id]);
  const sql = `EXISTS (
      SELECT 1 FROM observation_versions o
       WHERE o.observation_id = ${col}
         AND EXISTS (SELECT 1 FROM json_each(json_extract(o.scope_json, '$.scopes')) s
                      WHERE ${scopeKey('s')} IN (VALUES ${pairs}))
         AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(o.scope_json, '$.scopes')) s
                          WHERE ${scopeKey('s')} NOT IN (VALUES ${pairs})))
    AND NOT EXISTS (
      SELECT 1 FROM connector_event_index c
       WHERE c.current_observation_id = ${col} AND c.source_connector = 'chat'
         AND c.channel IN (SELECT 'telegram:' || external_id FROM external_identities
                            WHERE connector = 'telegram' AND namespace = 'private'
                              AND principal_id <> ?))`;
  return { sql, params: [...pairParams, ...pairParams, ownerPrincipalId] };
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
      const common = options.commonScopes();
      // No common scope means nothing may be carried; no subject can qualify.
      if (common.length === 0) return [];
      // Consulting a source is a search hit or an opened read: a question answered from a search
      // preview without opening the record is the same unrecorded gap. The order still marks which
      // were opened. The turn qualifies when it consulted a common source and cited none of what
      // it consulted.
      const commonRead = readRefsSubquery(
        'any',
        commonScopeFilter('ref.value', common, options.ownerPrincipalId)
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
               ON m.stimulus_id = json_extract(r.input_refs_json, '$.sourceMessageRef')
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
            -- One row per turn: a handed-off common input leaves an owner_message row per principal.
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
      const common2 = commonScopeFilter('ref.value', common, options.ownerPrincipalId);
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

import { readableScopeIds, type JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { localNow } from './timezone.js';
import {
  noUpdateNames,
  UPKEEP_WINDOW_MS,
  type UpkeepKind,
  type UpkeepSubject,
} from './upkeep-orders.js';

export const CLOSE_ORDER_CHANNEL = 'operator:close';
const CLOSED_STATUSES = ['done', 'cancelled'];

export interface CloseKindOptions {
  /** Closing revisions written before this instant are not ordered (a script summarizes them). */
  since: number;
  /** The common session's access: only work it can read is chosen. */
  access: () => JudgmentAccess;
  timeZone: () => string;
}

interface CloseSubject extends UpkeepSubject {
  commitmentId: string;
  /** The revision that moved the item's current status to done or cancelled. */
  revision: number;
  title: string;
  status: string;
  closedAt: number;
}

/**
 * U1, closing summaries. A subject is one closing revision: a reopened item that closes again is
 * a new subject. It is checked by a revision from the order's runs that sets a description, or by
 * a work.no_update naming the item; a revision that only sets the status again does not count.
 */
export function closeUpkeepKind(options: CloseKindOptions): UpkeepKind {
  return {
    name: 'close',
    channel: CLOSE_ORDER_CHANNEL,
    intervalMs: 60 * 60 * 1000,
    maxPerOrder: 10,
    scan: (adapter, now) => {
      const scopes = readableScopeIds(options.access());
      // Visibility as core's readWork applies it: an unbound head, or one bound to a read scope.
      const visible = `(NOT EXISTS (SELECT 1 FROM memory_scope_bindings b WHERE b.memory_id = c.head_record_id)${
        scopes.length === 0
          ? ''
          : ` OR EXISTS (SELECT 1 FROM memory_scope_bindings b WHERE b.memory_id = c.head_record_id
                AND b.scope_id IN (${scopes.map(() => '?').join(',')}))`
      })`;
      const rows = adapter
        .prepare(
          // Core folds revisions in the order they were written and drops one whose applies_until
          // has passed; the closing revision is the latest live one that sets the status.
          `WITH live AS (
             SELECT * FROM commitment_assignments WHERE applies_until IS NULL OR applies_until > ?),
           latest AS (
             SELECT commitment_id, MAX(revision) AS revision FROM live
              WHERE json_extract(set_json, '$.status') IS NOT NULL GROUP BY commitment_id),
           titles AS (
             SELECT x.commitment_id, json_extract(x.set_json, '$.title') AS title FROM live x
              WHERE x.revision = (SELECT MAX(y.revision) FROM live y
                                   WHERE y.commitment_id = x.commitment_id
                                     AND json_extract(y.set_json, '$.title') IS NOT NULL))
           SELECT a.commitment_id, a.revision, a.created_at, json_extract(a.set_json, '$.status') AS status,
                  coalesce(t.title, '') AS title
             FROM live a
             JOIN latest l ON l.commitment_id = a.commitment_id AND l.revision = a.revision
             JOIN commitments c ON c.commitment_id = a.commitment_id AND c.withdrawn = 0
             LEFT JOIN titles t ON t.commitment_id = a.commitment_id
            WHERE json_extract(a.set_json, '$.status') IN (${CLOSED_STATUSES.map(() => '?').join(',')})
              AND a.created_at >= ? AND ${visible}
            ORDER BY a.created_at, a.commitment_id
            LIMIT 200`
        )
        .all(
          now,
          ...CLOSED_STATUSES,
          // A subject older than the attempt window would count its attempts from zero again.
          Math.max(options.since, now - UPKEEP_WINDOW_MS),
          ...scopes
        ) as Array<{
        commitment_id: string;
        revision: number;
        created_at: number;
        status: string;
        title: string;
      }>;
      return rows.map(
        (row): CloseSubject => ({
          key: `${row.commitment_id}:${row.revision}`,
          commitmentId: row.commitment_id,
          revision: row.revision,
          title: row.title,
          status: row.status,
          closedAt: row.created_at,
        })
      );
    },
    checked: (adapter, subject, runIds) => {
      const { commitmentId, revision } = subject as CloseSubject;
      if (runIds.length === 0) return false;
      const summarized = adapter
        .prepare(
          `SELECT 1 FROM commitment_assignments
            WHERE commitment_id = ? AND revision > ?
              AND coalesce(json_extract(set_json, '$.description'), '') <> ''
              AND model_run_id IN (${runIds.map(() => '?').join(',')})
            LIMIT 1`
        )
        .get(commitmentId, revision, ...runIds);
      return summarized !== undefined || noUpdateNames(adapter, runIds, [commitmentId]);
    },
    render: (subjects, now) => {
      const zone = options.timeZone();
      const lines = (subjects as readonly CloseSubject[]).map(
        (subject) =>
          `- ${subject.commitmentId} (${subject.status} ${localNow(subject.closedAt, zone)}): ${subject.title}`
      );
      return [
        `[upkeep_close] ${subjects.length} closed work item${subjects.length === 1 ? '' : 's'}`,
        `Current time: ${localNow(now.getTime(), zone)} (${zone})`,
        "Write each item's closing summary, so a later question about it reads one place:",
        '1. Read each item with its history: work.list view=detail with ids (up to 4 per call); page older revisions with history_offset until the first one.',
        "2. Write one work.revise per item that sets description to the summary: the rounds (each submission, each round of outside feedback with the points raised, each internal review, with dates), who did what, how it ended, and what is worth reusing. Link the revisions' evidence with derived_from. Do not change its status, stage or other fields.",
        '3. An item whose description is already such a summary: work.no_update with commitmentIds naming it and the reason.',
        '4. The order is checked when it ends: each item needs step 2 or 3. Correct a refused write (help gives its contract) and write it again.',
        '5. Reply exactly [ack].',
        ...lines,
      ].join('\n');
    },
  };
}

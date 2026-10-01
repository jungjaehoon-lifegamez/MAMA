/**
 * Push a checked backfill file through the owner's own actions. It judges nothing: every work
 * item, revision, link, lesson and page is the reader's, written as the file states it.
 *
 * Each call carries a deterministic operation id, `backfill:<period start>:<key>:...`, which the
 * ledger keeps as the command id. That is the provenance of a backfill write, and it makes a
 * re-run resume: work, link and memory writes replay their first receipt, and a changed payload
 * under the same id is refused rather than written twice. Wiki pages are not command-idempotent,
 * so the pages already published are passed in and skipped.
 */
import type { BackfillFile, BackfillItem } from './format.js';

export interface BackfillSource {
  observationRef: string;
  connector: string;
}

export interface BackfillPushPorts {
  /** One owner action under the period's ceiling; returns its data or throws with the failure. */
  callAction(name: string, input: Record<string, unknown>, operationId: string): Promise<unknown>;
  /** Exact `connector_event_index.source_id`s to observations; throws naming every unresolved id. */
  resolveSources(sourceIds: readonly string[]): ReadonlyMap<string, BackfillSource>;
  /** The earliest event time among existing work's revisions, the bound of an earlier period. */
  firstEventAt(commitmentId: string): number;
  /** Wiki pages an earlier run already published, by operation id. */
  publishedPages: ReadonlySet<string>;
  /** Called after a wiki page is published, so a later run skips it. */
  pagePublished(operationId: string): void;
}

export interface BackfillPushResult {
  created: number;
  revised: number;
  mentions: number;
  links: number;
  lessons: number;
  pagesPublished: number;
  pagesSkipped: number;
  /** Lines the reader judged not to be work; they stay in the file only. */
  notWork: number;
}

function allSources(file: BackfillFile): string[] {
  const ids = new Set<string>();
  const add = (sources: readonly string[] | undefined) => sources?.forEach((id) => ids.add(id));
  for (const item of file.items) {
    item.revisions.forEach((revision) => add(revision.sources));
    item.mentions?.forEach((group) => add(group.sources));
    item.links?.forEach((link) => add(link.sources));
  }
  file.lessons.forEach((lesson) => add(lesson.sources));
  file.wiki.forEach((page) => add(page.sources));
  file.links.forEach((link) => add(link.sources));
  // Not-work lines are resolved too: a period is pushed only when all of it was imported.
  file.noUpdate.forEach((entry) => add(entry.sources));
  return [...ids];
}

function commitmentIdOf(data: unknown, operationId: string): string {
  const id = (data as { commitmentId?: unknown } | null)?.commitmentId;
  if (typeof id !== 'string' || id === '')
    throw new Error(`${operationId} returned no commitmentId`);
  return id;
}

export async function pushBackfill(
  file: BackfillFile,
  ports: BackfillPushPorts
): Promise<BackfillPushResult> {
  const sources = ports.resolveSources(allSources(file));
  const observations = (ids: readonly string[] | undefined): string[] =>
    (ids ?? []).map((id) => sources.get(id)!.observationRef);
  const evidence = (ids: readonly string[]) =>
    observations(ids).map((id) => ({
      relation: 'derived_from',
      target: { kind: 'observation', id },
    }));
  const prefix = `backfill:${file.period.from}:`;
  const result: BackfillPushResult = {
    created: 0,
    revised: 0,
    mentions: 0,
    links: 0,
    lessons: 0,
    pagesPublished: 0,
    pagesSkipped: 0,
    notWork: file.noUpdate.reduce((sum, entry) => sum + entry.sources.length, 0),
  };

  // Every bound is settled before anything is written.
  const bounds = new Map<string, number>();
  for (const item of file.items) {
    if (item.commitmentId === undefined) continue;
    const appliesUntil = item.appliesUntil ?? ports.firstEventAt(item.commitmentId);
    if (appliesUntil <= item.revisions[item.revisions.length - 1]!.at)
      throw new Error(
        `item ${item.key}: its existing revisions start at or before this period's last revision; the period cannot be bounded`
      );
    bounds.set(item.key, appliesUntil);
  }

  // Each piece of work goes in complete, its revisions in event order.
  const ids = new Map<string, string>();
  for (const item of file.items) ids.set(item.key, await pushItem(item));

  async function pushItem(item: BackfillItem): Promise<string> {
    let commitmentId = item.commitmentId;
    const appliesUntil = bounds.get(item.key);
    for (const [n, revision] of item.revisions.entries()) {
      const operationId = `${prefix}${item.key}:r${n}`;
      const fields = {
        summary: revision.summary,
        ...(revision.set === undefined ? {} : { set: revision.set }),
        eventDatetime: revision.at,
        links: evidence(revision.sources),
      };
      if (commitmentId === undefined) {
        commitmentId = commitmentIdOf(
          await ports.callAction(
            'work.create',
            { topic: item.topic ?? item.key, ...fields },
            operationId
          ),
          operationId
        );
        result.created += 1;
        continue;
      }
      await ports.callAction(
        'work.revise',
        {
          commitmentId,
          ...fields,
          ...(revision.clear === undefined ? {} : { clear: revision.clear }),
          ...(appliesUntil === undefined ? {} : { appliesUntil }),
        },
        operationId
      );
      result.revised += 1;
    }
    return commitmentId!;
  }

  for (const item of file.items) {
    const from = ids.get(item.key)!;
    for (const [g, group] of (item.mentions ?? []).entries()) {
      for (const [n, observation] of observations(group.sources).entries()) {
        await ports.callAction(
          'work.link',
          {
            from,
            to: { kind: 'observation', id: observation },
            relation: 'mentions',
            reason: group.reason,
          },
          `${prefix}${item.key}:m${g}.${n}`
        );
        result.mentions += 1;
      }
    }
    for (const [n, link] of (item.links ?? []).entries()) {
      const to = 'item' in link.to ? ids.get(link.to.item)! : link.to.commitmentId;
      await ports.callAction(
        'work.link',
        {
          from,
          to: { kind: 'work', id: to },
          relation: link.relation,
          reason: link.reason,
          ...(link.sources === undefined ? {} : { evidenceRefs: observations(link.sources) }),
        },
        `${prefix}${item.key}:l${n}`
      );
      result.links += 1;
    }
  }

  const workId = (ref: { item: string } | { commitmentId: string }) =>
    'item' in ref ? ids.get(ref.item)! : ref.commitmentId;
  for (const [n, link] of file.links.entries()) {
    await ports.callAction(
      'work.link',
      {
        from: workId(link.from),
        to: { kind: 'work', id: workId(link.to) },
        relation: link.relation,
        reason: link.reason,
        ...(link.sources === undefined ? {} : { evidenceRefs: observations(link.sources) }),
      },
      `${prefix}link:${n}`
    );
    result.links += 1;
  }

  for (const lesson of file.lessons) {
    await ports.callAction(
      'memory.save',
      {
        topic: lesson.topic,
        kind: 'lesson',
        summary: lesson.summary,
        details: lesson.details,
        appliesWhen: lesson.appliesWhen,
        source: { package: 'mama-backfill', source_type: 'backfill' },
        eventDateTime: lesson.at,
        links: evidence(lesson.sources),
      },
      `${prefix}lesson:${lesson.key}`
    );
    result.lessons += 1;
  }

  for (const page of file.wiki) {
    const operationId = `${prefix}wiki:${page.path}`;
    if (ports.publishedPages.has(operationId)) {
      result.pagesSkipped += 1;
      continue;
    }
    await ports.callAction(
      'manage.wiki.publish',
      {
        pages: [
          {
            path: page.path,
            title: page.title,
            content: page.content,
            // A page changed since the reader merged it is refused, not overwritten.
            expectedContentVersion: page.baseContentVersion,
            ...(page.sources === undefined
              ? {}
              : {
                  sourceRefs: (page.sources ?? []).map((id) => ({
                    kind: 'raw',
                    connector: sources.get(id)!.connector,
                    id: sources.get(id)!.observationRef,
                  })),
                }),
          },
        ],
      },
      operationId
    );
    ports.pagePublished(operationId);
    result.pagesPublished += 1;
  }
  return result;
}

interface SourceRow {
  source_id: string;
  source_connector: string;
  current_observation_id: string | null;
}

/** Resolve exact source ids through the connector index; every id must name one observation. */
export function indexSourceResolver(adapter: {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}): BackfillPushPorts['resolveSources'] {
  return (sourceIds) => {
    const found = new Map<string, BackfillSource>();
    const problems: string[] = [];
    for (let start = 0; start < sourceIds.length; start += 500) {
      const batch = sourceIds.slice(start, start + 500);
      const rows = adapter
        .prepare(
          `SELECT source_id, source_connector, current_observation_id FROM connector_event_index
           WHERE source_id IN (${batch.map(() => '?').join(', ')})`
        )
        .all(...batch) as SourceRow[];
      const bySource = new Map<string, SourceRow[]>();
      for (const row of rows)
        bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row]);
      for (const id of batch) {
        const matches = bySource.get(id) ?? [];
        if (matches.length !== 1 || !matches[0]!.current_observation_id)
          problems.push(
            `${id} (${matches.length === 0 ? 'not imported' : `${matches.length} rows`})`
          );
        else
          found.set(id, {
            observationRef: matches[0]!.current_observation_id,
            connector: matches[0]!.source_connector,
          });
      }
    }
    if (problems.length > 0)
      throw new Error(
        `Backfill sources do not resolve; import them first:\n${problems.join('\n')}`
      );
    return found;
  };
}

/**
 * The earliest event time among existing work's unbounded revisions, read through the ledger.
 * Bounded revisions are an earlier backfill's (a re-run finds its own), so they do not count.
 */
export function ledgerFirstEventAt(
  readWork: (query: { commitmentId: string; history: 'all' }) => {
    items: Array<{
      history?: Array<{
        eventDatetime: number | null;
        appliesUntil: number | null;
        createdAt: number;
      }>;
    }>;
  }
): BackfillPushPorts['firstEventAt'] {
  return (commitmentId) => {
    const history = readWork({ commitmentId, history: 'all' }).items[0]?.history ?? [];
    const unbounded = history.filter((revision) => revision.appliesUntil === null);
    if (unbounded.length === 0)
      throw new Error(`Existing work ${commitmentId} has no unbounded revision in the ledger`);
    return Math.min(...unbounded.map((revision) => revision.eventDatetime ?? revision.createdAt));
  };
}

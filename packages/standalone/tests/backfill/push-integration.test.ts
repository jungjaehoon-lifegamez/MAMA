/**
 * The push against the real owner actions on a temporary database: the write contract, the
 * bound on existing work, the time reads and a re-run are checked end to end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge } from '@jungjaehoon/mama-core/knowledge';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { BACKFILL_FORMAT, parseBackfillFile } from '../../src/backfill/format.js';
import {
  indexSourceResolver,
  ledgerFirstEventAt,
  pushBackfill,
  type BackfillPushPorts,
} from '../../src/backfill/push.js';

const at = (text: string) => Date.parse(text);
const SEP_FIRST = '2026-09-01T10:31:00+09:00';

describe('backfill push through the owner actions', () => {
  let root = '';
  let previous: string | undefined;
  let handle: Awaited<ReturnType<typeof openCoreDatabase>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mama-backfill-push-'));
    previous = process.env.MAMA_DB_PATH;
    process.env.MAMA_DB_PATH = join(root, 'memory.db');
    handle = await openCoreDatabase({ path: join(root, 'memory.db') });
  });

  afterEach(async () => {
    await handle.close();
    if (previous === undefined) delete process.env.MAMA_DB_PATH;
    else process.env.MAMA_DB_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a period complete, keeps later work current, answers asOf and resumes', async () => {
    const source = (id: string, time: string) =>
      upsertConnectorEventIndex(handle.adapter, {
        source_connector: 'chatwork',
        source_type: 'message',
        source_id: id,
        channel: 'room-test',
        content: `content ${id}`,
        event_datetime: at(time),
        observation: { observed_at: at(time) },
        content_hash: createHash('sha256').update(id).digest(),
      }).current_observation_id!;
    const parts = source('src:parts', '2026-08-03T09:55:00+09:00');
    source('src:fix', '2026-08-24T16:04:00+09:00');
    source('src:progress', '2026-08-25T12:16:00+09:00');
    source('src:next', '2026-08-26T17:43:00+09:00');
    source('src:lesson', '2026-08-18T18:44:00+09:00');
    source('src:live', SEP_FIRST);

    const knowledge = createKnowledge({ adapter: handle.adapter });
    const surface = createActionSurface({
      adapter: handle.adapter,
      knowledge,
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      timeZone: createTimeZoneSetting('Asia/Seoul'),
      configPath: join(root, 'config.yaml'),
      isOwnerMessageTurn: () => false,
    });
    const call = async (name: string, input: unknown, operationId: string, ceiling?: number) => {
      const result = await surface.hostToolCall(
        name,
        input,
        operationId,
        ceiling === undefined ? {} : { session: { replaySourceEndMs: ceiling } }
      );
      if (result.status !== 'completed')
        throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
      return result.data;
    };
    // September work recorded live, before the August backfill.
    const live = (await call(
      'work.create',
      {
        topic: 'next still',
        summary: 'parts handed to a worker',
        set: { title: 'Next still', status: 'in_progress' },
        eventDatetime: at(SEP_FIRST),
        links: [
          {
            relation: 'derived_from',
            target: {
              kind: 'observation',
              id: indexSourceResolver(handle.adapter)(['src:live']).get('src:live')!.observationRef,
            },
          },
        ],
      },
      'live-create'
    )) as { commitmentId: string };

    const file = parseBackfillFile({
      format: BACKFILL_FORMAT,
      period: { from: '2026-08-01T00:00:00+09:00', until: '2026-09-01T00:00:00+09:00' },
      items: [
        {
          key: 'still-a',
          topic: 'still a',
          revisions: [
            {
              at: '2026-08-03T09:55:00+09:00',
              summary: 'parts received',
              set: { title: 'Still A', status: 'pending' },
              sources: ['src:parts'],
            },
            {
              at: '2026-08-24T16:04:00+09:00',
              summary: 'client FIX',
              set: { status: 'done' },
              sources: ['src:fix'],
            },
          ],
          mentions: { reason: 'a progress note on this still', sources: ['src:progress'] },
          links: [{ to: { item: 'next-still' }, relation: 'builds_on', reason: 'same series' }],
        },
        {
          key: 'next-still',
          commitmentId: live.commitmentId,
          revisions: [
            {
              at: '2026-08-26T17:43:00+09:00',
              summary: 'parts for next month received',
              set: { title: 'Next still', status: 'pending' },
              sources: ['src:next'],
            },
          ],
        },
      ],
      lessons: [
        {
          key: 'no-image-edits',
          at: '2026-08-18T18:44:00+09:00',
          topic: 'image edits',
          summary: 'Workers do not edit the source images',
          details: 'Stated by the coordinator in the worker room',
          appliesWhen: 'when a worker gets a still to set up',
          sources: ['src:lesson'],
        },
      ],
      noUpdate: [{ reason: 'meeting notice', sources: ['src:parts'] }],
    });
    const ports = (): BackfillPushPorts => ({
      callAction: (name, input, operationId) =>
        call(name, input, operationId, file.period.until - 1),
      resolveSources: indexSourceResolver(handle.adapter),
      firstEventAt: ledgerFirstEventAt((query) => knowledge.readWork(query, surface.ownerAccess)),
      publishedPages: new Set(),
      pagePublished: () => undefined,
    });

    const first = await pushBackfill(file, ports());
    const again = await pushBackfill(file, ports());

    expect(first).toEqual(again);
    expect(first).toMatchObject({ created: 1, revised: 2, mentions: 1, links: 1, lessons: 1 });
    const count = (sql: string) => (handle.adapter.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM commitments')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM commitment_assignments')).toBe(4);

    const read = (asOf?: number) =>
      knowledge.readWork(
        { history: 'all', ...(asOf === undefined ? {} : { asOf }) },
        surface.ownerAccess
      ).items;
    const now = read();
    expect(now.find((item) => item.commitmentId === live.commitmentId)!.values).toMatchObject({
      status: 'in_progress',
    });
    const stillA = now.find((item) => item.commitmentId !== live.commitmentId)!;
    expect(stillA.values).toMatchObject({ title: 'Still A', status: 'done' });
    expect(stillA.history!.map((revision) => revision.eventDatetime)).toEqual([
      at('2026-08-03T09:55:00+09:00'),
      at('2026-08-24T16:04:00+09:00'),
    ]);
    const august = read(at('2026-08-28T00:00:00+09:00'));
    expect(august.find((item) => item.commitmentId === live.commitmentId)!.values).toMatchObject({
      status: 'pending',
    });
    const early = read(at('2026-08-10T00:00:00+09:00'));
    expect(early.map((item) => item.values.title)).toEqual(['Still A']);
    expect(early[0]!.values.status).toBe('pending');
    // A changed payload under an operation id that already wrote is refused, not replayed.
    const edited = {
      ...file,
      items: file.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              revisions: item.revisions.map((revision, n) =>
                n === 1 ? { ...revision, summary: 'client FIX, worded differently' } : revision
              ),
            }
          : item
      ),
    };
    await expect(pushBackfill(edited, ports())).rejects.toThrow('COMMAND_CONFLICT');
    expect(count('SELECT COUNT(*) AS n FROM commitment_assignments')).toBe(4);
    // Evidence is the observation the source row names.
    const edges = handle.adapter
      .prepare(
        "SELECT object_id FROM twin_edges WHERE edge_type = 'derived_from' AND object_id = ?"
      )
      .all(parts);
    expect(edges).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';

import { commitConnectorIngressNoUpdateBatch } from '../../src/operator-vnext/connector-ingress-manual-commit.js';
import { commitConnectorIngressWikiBatch } from '../../src/operator-vnext/connector-ingress-manual-wiki-commit.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

function insertRawEvent(
  db: SQLiteDatabase,
  overrides: {
    connector?: string;
    sourceId: string;
    channel?: string;
    timestampMs: number;
  }
): string {
  const connector = overrides.connector ?? 'slack';
  const channel = overrides.channel ?? 'C_PUBLIC_SYNTHETIC';
  const eventIndexId = connectorEventIndexId(connector, overrides.sourceId);
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    connector,
    'message',
    overrides.sourceId,
    `${connector}:${channel}:${overrides.sourceId}`,
    channel,
    'synthetic-user',
    null,
    `synthetic public rollout event ${overrides.sourceId}`,
    overrides.timestampMs,
    new Date(overrides.timestampMs).toISOString().slice(0, 10),
    overrides.timestampMs,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 4),
    '2026-07-03T00:00:00.000Z',
    '2026-07-03T00:00:00.000Z'
  );
  return eventIndexId;
}

function cursorRow(db: SQLiteDatabase) {
  return db
    .prepare(
      `SELECT cursor_name, last_change_seq, last_idempotency_key
       FROM vnext_operator_cursors
       WHERE cursor_name = ?`
    )
    .get('connector:slack:channel:C_PUBLIC_SYNTHETIC');
}

function makeWikiPages(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    path: `projects/${prefix}-${index}.md`,
    title: `${prefix} ${index}`,
    type: 'entity',
    content: 'operator-authored wiki summary',
  }));
}

describe('STORY-VNEXT-PR12-MANUAL-WIKI: connector ingress manual wiki commit', () => {
  describe('AC: reviewed events commit source-linked wiki artifacts atomically', () => {
    it('commits reviewed event pages as changed operator commits without exposing raw content', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      const wikiPublishAdapter = createWikiPublishAdapter({
        mode: 'vnext',
        store,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        nowMs: () => 1710000000000,
      });

      const result = await commitConnectorIngressWikiBatch({
        rawAdapter: db,
        operatorDb: db,
        wikiPublishAdapter,
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        expectedAdvancedThroughSeq: 0,
        eventPages: [
          {
            eventIndexId: first,
            pages: [
              {
                path: 'projects/rollout-one.md',
                title: 'Rollout One',
                type: 'entity',
                content: 'operator-authored wiki summary one',
              },
            ],
          },
          {
            eventIndexId: second,
            pages: [
              {
                path: 'projects/rollout-two.md',
                title: 'Rollout Two',
                type: 'entity',
                content: 'operator-authored wiki summary two',
              },
            ],
          },
        ],
        nowMs: () => 1710000000000,
      });

      expect(result).toEqual({
        ok: true,
        mode: 'manual_wiki_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 2,
        processed: 2,
        advancedThroughSeq: 2,
        firstSeq: 1,
        lastSeq: 2,
        pagesStored: 2,
        commits: [
          { seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true },
          { seq: 2, status: 'changed', outcome: 'committed', cursorAdvanced: true },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(result)).not.toContain('synthetic-user');
      expect(JSON.stringify(result)).not.toContain('metadata_json');
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 2,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);
      expect(countRows(db, 'wiki_artifacts')).toBe(2);
      expect(db.prepare('SELECT DISTINCT status FROM vnext_operator_commits').all()).toEqual([
        { status: 'changed' },
      ]);
      expect(store.getByPath('projects/rollout-one.md')?.sourceRefs).toEqual([
        `raw:slack:${first}`,
      ]);
      expect(store.getByPath('projects/rollout-two.md')?.sourceRefs).toEqual([
        `raw:slack:${second}`,
      ]);
      expect(
        db
          .prepare(
            `SELECT changed_refs_json, source_refs_json
             FROM vnext_operator_commits
             ORDER BY first_change_seq ASC`
          )
          .all()
      ).toEqual([
        {
          changed_refs_json: JSON.stringify(['wiki_page:projects/rollout-one.md']),
          source_refs_json: JSON.stringify([`raw:slack:${first}`]),
        },
        {
          changed_refs_json: JSON.stringify(['wiki_page:projects/rollout-two.md']),
          source_refs_json: JSON.stringify([`raw:slack:${second}`]),
        },
      ]);

      db.close();
    });

    it('rejects request-supplied wiki source refs before durable writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/unsafe.md',
                  title: 'Unsafe',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                  sourceRefs: [{ kind: 'wiki_page', id: 'caller-supplied-ref' }],
                },
              ],
            },
          ],
        })
      ).rejects.toThrow(/source refs are derived from reviewed events/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);

      db.close();
    });

    it('rejects invalid wiki pages before any durable commit writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/valid.md',
                  title: 'Valid',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
            {
              eventIndexId: second,
              pages: [
                {
                  path: 'projects/invalid.md',
                  title: 'Invalid',
                  type: 'unsupported-type',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/type is not supported/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('rejects null wiki pages before any durable commit writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [null as never],
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/non-null object/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('rejects duplicate wiki paths across events before any durable commit writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/shared.md',
                  title: 'Shared One',
                  type: 'entity',
                  content: 'operator-authored wiki summary one',
                },
              ],
            },
            {
              eventIndexId: second,
              pages: [
                {
                  path: './projects/shared.md',
                  title: 'Shared Two',
                  type: 'entity',
                  content: 'operator-authored wiki summary two',
                },
              ],
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/duplicate wiki page path/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('rejects page batches above the publish limit before any durable commit writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });
      const tooManyPages = makeWikiPages(101, 'oversized');

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/valid.md',
                  title: 'Valid',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
            {
              eventIndexId: second,
              pages: tooManyPages,
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/at most 100 pages/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('rejects aggregate page counts above the request limit before durable writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: makeWikiPages(60, 'first'),
            },
            {
              eventIndexId: second,
              pages: makeWikiPages(41, 'second'),
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/at most 100 total pages/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('rejects non-vNext wiki adapters before advancing the operator cursor', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      let publishedPages = 0;
      const wikiPublishAdapter = createWikiPublishAdapter({
        mode: 'legacy',
        publisher: (pages) => {
          publishedPages += pages.length;
        },
      });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/legacy-adapter.md',
                  title: 'Legacy Adapter',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/vNext wiki publish adapter/i);
      expect(publishedPages).toBe(0);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('validates reviewed events after waiting for an in-flight cursor commit', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const store = new WikiArtifactStore(db);
      let nestedCommit: Promise<unknown> | null = null;
      let nestedStarted = false;
      const wikiPublishAdapter = createWikiPublishAdapter({
        mode: 'vnext',
        store,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        nowMs: () => 1710000000000,
        publisher: () => {
          if (!nestedStarted) {
            nestedStarted = true;
            nestedCommit = commitConnectorIngressWikiBatch({
              rawAdapter: db,
              operatorDb: db,
              wikiPublishAdapter,
              connector: 'slack',
              channel: 'C_PUBLIC_SYNTHETIC',
              expectedAdvancedThroughSeq: 1,
              eventPages: [
                {
                  eventIndexId: second,
                  pages: [
                    {
                      path: 'projects/rollout-two.md',
                      title: 'Rollout Two',
                      type: 'entity',
                      content: 'operator-authored wiki summary two',
                    },
                  ],
                },
              ],
              nowMs: () => 1710000000000,
            });
            nestedCommit.catch(() => undefined);
          }
        },
      });

      const firstResult = await commitConnectorIngressWikiBatch({
        rawAdapter: db,
        operatorDb: db,
        wikiPublishAdapter,
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        expectedAdvancedThroughSeq: 0,
        eventPages: [
          {
            eventIndexId: first,
            pages: [
              {
                path: 'projects/rollout-one.md',
                title: 'Rollout One',
                type: 'entity',
                content: 'operator-authored wiki summary one',
              },
            ],
          },
        ],
        nowMs: () => 1710000000000,
      });

      expect(firstResult).toMatchObject({
        ok: true,
        processed: 1,
        advancedThroughSeq: 1,
      });
      await expect(nestedCommit).resolves.toMatchObject({
        ok: true,
        processed: 1,
        advancedThroughSeq: 2,
      });
      expect(cursorRow(db)).toMatchObject({
        last_change_seq: 2,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
      });
      expect(store.getByPath('projects/rollout-two.md')?.sourceRefs).toEqual([
        `raw:slack:${second}`,
      ]);

      db.close();
    });

    it('rejects events already committed as no-update before writing wiki artifacts', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      await commitConnectorIngressNoUpdateBatch({
        rawAdapter: db,
        operatorDb: db,
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        expectedAdvancedThroughSeq: 0,
        eventIndexIds: [first],
        nowMs: () => 1710000000000,
      });
      const store = new WikiArtifactStore(db);
      store.ensureSchema();
      const wikiPublishAdapter = createWikiPublishAdapter({ mode: 'vnext', store });

      await expect(
        commitConnectorIngressWikiBatch({
          rawAdapter: db,
          operatorDb: db,
          wikiPublishAdapter,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventPages: [
            {
              eventIndexId: first,
              pages: [
                {
                  path: 'projects/should-not-write.md',
                  title: 'Should Not Write',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
          ],
          nowMs: () => 1710000000000,
        })
      ).rejects.toThrow(/non-changed operator commit/i);
      expect(countRows(db, 'wiki_artifacts')).toBe(0);
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);

      db.close();
    });
  });
});

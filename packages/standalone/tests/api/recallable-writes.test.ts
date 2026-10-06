import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, createDispatcher } from '@jungjaehoon/mama-core';
import { wikiActionRegistrations } from '../../src/api/wiki-actions.js';
import { reportActionRegistrations } from '../../src/api/report-actions.js';
import { createReportPublisher, createReportStore } from '../../src/api/report-handler.js';
import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';
import { readWikiPageContent } from '../../src/wiki/wiki-read.js';

const access = {
  principalId: 'owner',
  agentId: 'agent',
  scopes: [],
  actions: ['manage.wiki.publish', 'manage.wiki.update', 'report.publish'],
};
// Synthetic shape assembled at runtime; never retain a real credential in fixtures.
const credential = 'gh' + 'p_' + 'a'.repeat(30);
const hash = 'abcdef0123456789'.repeat(4);

describe('recallable wiki and report writes', () => {
  let root: string;
  let writer: ObsidianWriter;
  let store: ReturnType<typeof createReportStore>;
  let dispatch: ReturnType<typeof createDispatcher>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recallable-writes-'));
    writer = new ObsidianWriter(root, '.');
    writer.ensureDirectories();
    store = createReportStore();
    dispatch = createDispatcher(
      createCatalog([
        ...wikiActionRegistrations({
          vault: { path: writer.getWikiPath(), name: null },
          publisher: (pages) => writer.writePagesAtomically(pages),
        }),
        ...reportActionRegistrations({
          publisher: createReportPublisher(store, new Set()),
        }),
      ])
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['content', 'title', 'sourceRef'])(
    'refuses a secret in wiki %s before any page is persisted',
    async (field) => {
      const page = {
        path: 'work/current.md',
        title: field === 'title' ? credential : 'Current work',
        type: 'synthesis',
        content: field === 'content' ? credential : '## History\nA safe note.',
        sourceRefs: [
          { kind: 'raw', connector: 'source', id: field === 'sourceRef' ? credential : 'obs_1' },
        ],
        expectedContentVersion: null,
      };
      const result = await dispatch(
        { action: 'manage.wiki.publish', input: { pages: [page] } },
        { access }
      );
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'secret_material_refused' },
      });
      expect(JSON.stringify(result).includes(credential)).toBe(false);
      expect(readWikiPageContent(writer.getWikiPath(), page.path)).toBeNull();
    }
  );

  it('accepts source references and hashes, then refuses secret edits without changing the page', async () => {
    const created = await dispatch(
      {
        action: 'manage.wiki.publish',
        input: {
          pages: [
            {
              path: 'work/current.md',
              title: 'Current work',
              type: 'synthesis',
              content: `## History\nHash: ${hash}`,
              expectedContentVersion: null,
              sourceRefs: [{ kind: 'raw', connector: 'source', id: 'obs_1' }],
            },
          ],
        },
      },
      { access }
    );
    expect(created.status).toBe('completed');
    const before = readWikiPageContent(writer.getWikiPath(), 'work/current.md')!;
    for (const operation of ['append', 'replace']) {
      const result = await dispatch(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'work/current.md',
            expectedContentVersion: before.version,
            edits: [{ section: '## History', [operation]: credential }],
          },
        },
        { access }
      );
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'secret_material_refused' },
      });
      expect(JSON.stringify(result).includes(credential)).toBe(false);
      expect(readWikiPageContent(writer.getWikiPath(), 'work/current.md')?.version).toBe(
        before.version
      );
    }
    const updated = await dispatch(
      {
        action: 'manage.wiki.update',
        input: {
          path: 'work/current.md',
          expectedContentVersion: before.version,
          edits: [{ section: '## History', append: `Verified ${hash}` }],
        },
      },
      { access }
    );
    expect(updated.status).toBe('completed');
    expect(readWikiPageContent(writer.getWikiPath(), 'work/current.md')?.content).toContain(
      `Verified ${hash}`
    );
  });

  it('refuses a secret report atomically and preserves the previous visible report', async () => {
    const html = `<div class="report-card">Hash: ${hash}</div>`;
    expect(
      (
        await dispatch(
          { action: 'report.publish', input: { slots: { briefing: html } } },
          { access }
        )
      ).status
    ).toBe('completed');
    const result = await dispatch(
      {
        action: 'report.publish',
        input: {
          slots: {
            briefing: '<div class="report-card">replacement</div>',
            decisions: `<div class="report-card">${credential}</div>`,
          },
        },
      },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'secret_material_refused' } });
    expect(JSON.stringify(result).includes(credential)).toBe(false);
    expect(store.get('briefing')?.html).toBe(html);
    expect(store.get('decisions')).toBeUndefined();
  });
});

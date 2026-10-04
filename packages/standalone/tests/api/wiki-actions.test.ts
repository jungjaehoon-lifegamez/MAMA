/**
 * manage.wiki.* action registrations — the §4.2 adapter seam for the wiki lane.
 * The vault binding, page publisher and per-attempt coverage stay host-owned;
 * the catalog reaches them through injected ports. These tests pin the contract
 * (unbound ports, caller-forged authority, contiguous-read coverage) through the
 * real dispatcher — not the executor's tool names.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { wikiActionRegistrations, type WikiPorts } from '../../src/api/wiki-actions.js';
import { readWikiPageContent, wikiContentVersion } from '../../src/wiki/wiki-read.js';
import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';

const OWNER_DATE = '2026-09-06';

const ownerAccess: ActionContext['access'] = {
  // Dispatch compares the call against this grant; these are the actions
  // this file calls.
  actions: ['manage.wiki.move', 'manage.wiki.publish', 'manage.wiki.read', 'manage.wiki.update'],
  principalId: 'principal_owner_1',
  agentId: 'agent',
  scopes: [],
};

const wikiRange = {
  ownerDate: OWNER_DATE,
  rangeStartMs: Date.parse('2026-09-05T15:00:00.000Z'),
  rangeEndMs: Date.parse('2026-09-06T15:00:00.000Z'),
  connectors: ['slack'],
  updatedSince: '2026-09-05T15:00:00.000Z',
  updatedBefore: '2026-09-06T15:00:00.000Z',
};

function dispatch(ports: WikiPorts) {
  return createDispatcher(createCatalog(wikiActionRegistrations(ports)));
}

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-wiki-actions-'));
  mkdirSync(join(root, 'daily'));
  writeFileSync(join(root, 'Home.md'), '# Home');
  return root;
}

describe('manage.wiki.* action registrations', () => {
  it('advertises publish page objects and relative markdown read paths', async () => {
    const contracts = createCatalog(wikiActionRegistrations({})).list();
    const publish = contracts.find((contract) => contract.name === 'manage.wiki.publish');
    const page = publish?.inputSchema.properties?.pages.items;
    expect(page?.required).toEqual(['path', 'title', 'content']);
    expect(page?.properties?.content).toMatchObject({ type: 'string' });
    expect(page?.properties?.expectedContentVersion).toMatchObject({ oneOf: expect.any(Array) });
    const read = contracts.find((contract) => contract.name === 'manage.wiki.read');
    const pathPattern = read?.inputSchema.properties?.paths.items?.pattern;
    expect(new RegExp(pathPattern!).test('work/current.md')).toBe(true);
    expect(new RegExp(pathPattern!).test('work/current')).toBe(false);

    const publisher = vi.fn();
    const result = await dispatch({ publisher })(
      { action: 'manage.wiki.publish', input: { pages: ['work/current.md'] } },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } });
    expect(publisher).not.toHaveBeenCalled();
  });

  it('lists the move, read, publish and update actions', () => {
    const names = createCatalog(wikiActionRegistrations({}))
      .list()
      .map((contract) => contract.name);
    expect(names.sort()).toEqual([
      'manage.wiki.move',
      'manage.wiki.publish',
      'manage.wiki.read',
      'manage.wiki.update',
    ]);
  });

  it('unbound wiki resources fail explicitly', async () => {
    const call = dispatch({});
    const read = await call(
      { action: 'manage.wiki.read', input: { paths: ['Home.md'] } },
      { access: ownerAccess }
    );
    expect(read).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/vault path not configured/) },
    });
    const publish = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'x.md', title: 't', type: 'entity', content: 'c' }] },
      },
      { access: ownerAccess, session: {} }
    );
    expect(publish).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/publisher not configured/) },
    });
  });

  it('publish without a bound publisher reports the missing port through dispatch', async () => {
    const call = dispatch({});
    const result = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'wiki/a', title: 'A', type: 'entity', content: 'x' }] },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/publisher not configured/i) },
    });
  });

  it('input cannot grant an action and version preconditions reach the publisher unchanged', async () => {
    const publisher = vi.fn();
    const call = dispatch({ publisher });
    const forged = {
      pages: [
        {
          path: 'daily/2026-09-05.md',
          expectedContentVersion: null,
          title: 'forged',
          type: 'daily',
          content: 'c',
        },
      ],
      wikiTaskRange: wikiRange,
      workorderAttemptId: 7,
    };
    const result = await call(
      { action: 'manage.wiki.publish', input: forged },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({ status: 'completed', data: { success: true } });
    expect(publisher).toHaveBeenCalledWith([
      expect.objectContaining({ expectedContentVersion: null }),
    ]);
    publisher.mockClear();
    const denied = await call(
      { action: 'manage.wiki.publish', input: forged },
      { access: { ...ownerAccess, actions: [] } }
    );
    expect(denied.status).not.toBe('completed');
    expect(publisher).not.toHaveBeenCalled();
  });

  it('manage.wiki.read without authority keeps the bounded plain-read contract', async () => {
    const root = vault();
    writeFileSync(join(root, 'daily', '2020-01-01.md'), 'historical evidence');
    const call = dispatch({ vault: { path: root, name: null } });
    const result = await call(
      {
        action: 'manage.wiki.read',
        input: { paths: ['daily/2020-01-01.md'], content_limit: 4 },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { success: true, pages: [{ content: 'hist' }] },
    });
    const foreign = await call(
      { action: 'manage.wiki.read', input: { paths: ['../foreign.md'] } },
      { access: ownerAccess }
    );
    expect(foreign).toMatchObject({ status: 'failed', error: { code: 'TOOL_ERROR' } });
  });

  it('lists real wiki paths in bounded versioned pages before an exact read', async () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), 'mama-wiki-outside-'));
    try {
      writeFileSync(join(root, 'daily', '2020-01-01.md'), 'dated');
      writeFileSync(join(root, 'index.md'), '# navigation');
      writeFileSync(join(root, 'log.md'), 'history');
      writeFileSync(join(outside, 'private.md'), 'outside');
      symlinkSync(join(outside, 'private.md'), join(root, 'linked.md'));
      const call = dispatch({ vault: { path: root, name: null } });

      const first = await call(
        { action: 'manage.wiki.read', input: { list_limit: 2 } },
        { access: ownerAccess }
      );
      expect(first).toMatchObject({
        status: 'completed',
        data: {
          paths: ['Home.md', 'daily/2020-01-01.md'],
          returned: 2,
          total: 4,
          nextCursor: 'daily/2020-01-01.md',
          readVersion: expect.any(String),
        },
      });
      const listed = first.data as { nextCursor: string; readVersion: string };
      const next = await call(
        {
          action: 'manage.wiki.read',
          input: {
            list_cursor: listed.nextCursor,
            list_version: listed.readVersion,
            list_limit: 2,
          },
        },
        { access: ownerAccess }
      );
      expect(next).toMatchObject({
        status: 'completed',
        data: { paths: ['index.md', 'log.md'], nextCursor: null, readVersion: listed.readVersion },
      });
      const index = await call(
        { action: 'manage.wiki.read', input: { paths: ['index.md'] } },
        { access: ownerAccess }
      );
      expect(index).toMatchObject({
        status: 'completed',
        data: { pages: [{ path: 'index.md', content: '# navigation' }] },
      });

      writeFileSync(join(root, 'daily', '2021-01-01.md'), 'new');
      const stale = await call(
        {
          action: 'manage.wiki.read',
          input: { list_cursor: listed.nextCursor, list_version: listed.readVersion },
        },
        { access: ownerAccess }
      );
      expect(stale).toMatchObject({
        status: 'failed',
        error: { code: 'TOOL_ERROR', message: expect.stringMatching(/list.*changed|restart/i) },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a bound publishAdapter overrides the default publisher seam', async () => {
    const publishAdapter = { publish: vi.fn(() => ({ pagesPublished: 1, artifactsStored: 3 })) };
    const call = dispatch({ publisher: null, publishAdapter });
    const result = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'wiki/a', title: 'A', type: 'entity', content: 'x' }] },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { success: true, artifactsStored: 3 },
    });
    expect(publishAdapter.publish).toHaveBeenCalledOnce();
  });

  it('wikiContentVersion still keys the read/publish version contract', () => {
    expect(wikiContentVersion('# Home')).toEqual(expect.any(String));
  });

  it('updates a page by sections, keeping its frontmatter, title and human section', async () => {
    const root = vault();
    try {
      const writer = new ObsidianWriter(root, '.');
      writer.ensureDirectories();
      const ports: WikiPorts = {
        vault: { path: writer.getWikiPath(), name: null },
        publisher: (pages) => writer.writePagesAtomically(pages),
      };
      const call = dispatch(ports);
      const created = await call(
        {
          action: 'manage.wiki.publish',
          input: {
            pages: [
              {
                path: 'projects/example.md',
                title: 'Example project',
                type: 'entity',
                content:
                  '## Current state\nDraft in progress.\n\n## History\n- 9/10: draft started.',
                expectedContentVersion: null,
                sourceIds: ['obs_1'],
              },
            ],
          },
        },
        { access: ownerAccess }
      );
      expect(created).toMatchObject({ status: 'completed' });
      const before = readWikiPageContent(writer.getWikiPath(), 'projects/example.md')!;
      const updated = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            expectedContentVersion: before.version,
            edits: [
              { section: '## History', append: '- 9/11: client approved the draft.' },
              { section: '## Current state', replace: 'Approved; delivery at month end.' },
            ],
            sourceIds: ['obs_2'],
          },
        },
        { access: ownerAccess }
      );
      const afterPage = readWikiPageContent(writer.getWikiPath(), 'projects/example.md')!;
      expect(updated).toMatchObject({
        status: 'completed',
        data: { contentVersion: afterPage.version },
      });
      const after = afterPage.content;
      expect(after.match(/^---$/gm)).toHaveLength(2);
      expect(after.match(/^# Example project$/gm)).toHaveLength(1);
      expect(after).toContain('- 9/10: draft started.\n- 9/11: client approved the draft.');
      expect(after).toContain('## Current state\nApproved; delivery at month end.');
      expect(after).not.toContain('Draft in progress.');
      expect(after).toContain('obs_1');
      expect(after).toContain('obs_2');
      const stale = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            expectedContentVersion: before.version,
            edits: [{ section: '## History', append: '- late line' }],
          },
        },
        { access: ownerAccess }
      );
      expect(stale).toMatchObject({ status: 'failed' });
      const staleMessage = (stale as { error: { message: string } }).error.message;
      expect(staleMessage).toContain(`contentVersion is now ${afterPage.version}`);
      const unknownSection = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            expectedContentVersion: afterPage.version,
            edits: [{ section: '2026-09-11', append: '- a dated line' }],
          },
        },
        { access: ownerAccess }
      );
      expect((unknownSection as { error: { message: string } }).error.message).toContain(
        "this page's headings: ## Current state | ## History"
      );
      expect(staleMessage).toContain('- 9/10: draft started.\\n- 9/11: client approved the draft.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows append-only wiki edits without a version and keeps replace versioned', async () => {
    const root = vault();
    try {
      const writer = new ObsidianWriter(root, '.');
      writer.ensureDirectories();
      const call = dispatch({
        vault: { path: writer.getWikiPath(), name: null },
        publisher: (pages) => writer.writePagesAtomically(pages),
      });
      await call(
        {
          action: 'manage.wiki.publish',
          input: {
            pages: [
              {
                path: 'projects/example.md',
                title: 'Example',
                type: 'entity',
                content: '## History\n- started',
                expectedContentVersion: null,
              },
            ],
          },
        },
        { access: ownerAccess }
      );
      const appended = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            edits: [{ section: '## History', append: '- changed today' }],
          },
        },
        { access: ownerAccess }
      );
      expect(appended).toMatchObject({
        status: 'completed',
        data: { contentVersion: expect.any(String) },
      });
      const beforeReplace = readWikiPageContent(writer.getWikiPath(), 'projects/example.md')!;
      const replaceWithoutVersion = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            edits: [{ section: '## History', replace: '- replaced' }],
          },
        },
        { access: ownerAccess }
      );
      expect(replaceWithoutVersion).toMatchObject({
        status: 'failed',
        error: { code: 'invalid_input' },
      });
      const replace = await call(
        {
          action: 'manage.wiki.update',
          input: {
            path: 'projects/example.md',
            expectedContentVersion: beforeReplace.version,
            edits: [{ section: '## History', replace: '- replaced' }],
          },
        },
        { access: ownerAccess }
      );
      expect(replace).toMatchObject({
        status: 'completed',
        data: { contentVersion: expect.any(String) },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('manage.wiki.move', () => {
  const pages = (root: string, ...paths: string[]): void => {
    for (const path of paths) {
      const file = join(root, ...path.split('/'));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `# ${path}`);
    }
  };
  const move = (root: string, moves: Array<{ from: string; to: string }>) =>
    dispatch({ vault: { path: root, name: null } })(
      { action: 'manage.wiki.move', input: { moves } },
      { access: ownerAccess }
    );

  it('moves pages into folders it creates and names what moved', async () => {
    const root = vault();
    try {
      pages(root, 'daily/2026-09-01.md', 'daily/2026-10-01.md');
      const result = await move(root, [
        { from: 'daily/2026-09-01.md', to: 'daily/2026-09/2026-09-01.md' },
        { from: 'daily/2026-10-01.md', to: 'daily/2026-10/2026-10-01.md' },
      ]);
      expect(result).toMatchObject({
        status: 'completed',
        data: {
          success: true,
          moved: [
            { from: 'daily/2026-09-01.md', to: 'daily/2026-09/2026-09-01.md' },
            { from: 'daily/2026-10-01.md', to: 'daily/2026-10/2026-10-01.md' },
          ],
        },
      });
      expect(readWikiPageContent(root, 'daily/2026-09/2026-09-01.md')?.content).toBe(
        '# daily/2026-09-01.md'
      );
      expect(readWikiPageContent(root, 'daily/2026-09-01.md')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a page already at the target', [{ from: 'daily/a.md', to: 'Home.md' }], 'already exists'],
    ['a missing page', [{ from: 'daily/none.md', to: 'x/none.md' }], 'does not exist'],
    ['the generated index', [{ from: 'daily/a.md', to: 'index.md' }], 'reserved'],
    ['a parent traversal', [{ from: 'daily/a.md', to: '../a.md' }], 'traversal'],
    ['a non-page target', [{ from: 'daily/a.md', to: 'daily/a.txt' }], '.md'],
    ['a page moved onto itself', [{ from: 'daily/a.md', to: 'daily/a.md' }], 'same path'],
    [
      'two moves to one target',
      [
        { from: 'daily/a.md', to: 'x/a.md' },
        { from: 'daily/b.md', to: 'x/a.md' },
      ],
      'twice',
    ],
    [
      'two targets that differ only in case',
      [
        { from: 'daily/a.md', to: 'x/A.md' },
        { from: 'daily/b.md', to: 'x/a.md' },
      ],
      'twice',
    ],
    [
      'a hidden folder the wiki does not list',
      [{ from: 'daily/a.md', to: '.obsidian/a.md' }],
      'hidden',
    ],
    [
      'a target that another move empties',
      [
        { from: 'daily/a.md', to: 'x/a.md' },
        { from: 'daily/b.md', to: 'daily/a.md' },
      ],
      "another move's from",
    ],
  ])('refuses the whole batch for %s', async (_name, moves, message) => {
    const root = vault();
    try {
      pages(root, 'daily/a.md', 'daily/b.md');
      const result = await move(root, moves);
      expect(result).toMatchObject({ status: 'failed' });
      expect(JSON.stringify(result)).toContain(message);
      expect(readWikiPageContent(root, 'daily/a.md')?.content).toBe('# daily/a.md');
      expect(readWikiPageContent(root, 'daily/b.md')?.content).toBe('# daily/b.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked page', async () => {
    const root = vault();
    try {
      pages(root, 'daily/a.md');
      symlinkSync(join(root, 'daily', 'a.md'), join(root, 'daily', 'link.md'));
      const result = await move(root, [{ from: 'daily/link.md', to: 'x/link.md' }]);
      expect(JSON.stringify(result)).toContain('symlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('puts earlier moves back when a later move fails', async () => {
    const root = vault();
    try {
      pages(root, 'daily/a.md', 'daily/b.md');
      // The first move makes moved/q.md a page, so the second cannot make it a folder.
      const result = await move(root, [
        { from: 'daily/a.md', to: 'moved/q.md' },
        { from: 'daily/b.md', to: 'moved/q.md/b.md' },
      ]);
      expect(result).toMatchObject({ status: 'failed' });
      expect(JSON.stringify(result)).toContain('moving daily/b.md to moved/q.md/b.md failed');
      expect(readWikiPageContent(root, 'daily/a.md')?.content).toBe('# daily/a.md');
      expect(readWikiPageContent(root, 'moved/q.md')).toBeNull();
      expect(readWikiPageContent(root, 'daily/b.md')?.content).toBe('# daily/b.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

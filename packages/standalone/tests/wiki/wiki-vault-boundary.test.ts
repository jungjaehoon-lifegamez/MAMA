/**
 * TG-03/TG-05/TG-06 (0.48.3): the live wiki workorder #4569 wrote five MAMA pages into the
 * focused `finance` vault and was marked done on read-only obsidian traces. These tests pin
 * the host-side repair: vault selector order, no obsidian on the wiki turn, a bounded
 * `wiki_read`, a stale-aware `wiki_publish` gate, and an authoritative completion hook.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { buildObsidianCliArgs } from '../../src/agent/obsidian-cli-args.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { ContextCompileService } from '../../src/agent/context-compile-service.js';
import { TURN_KIND_BLOCKED_TOOLS, TURN_KIND_REQUIRED_TOOLS } from '../../src/cli/commands/start.js';
import {
  buildWikiAfterHook,
  LANE_OBLIGATED_TOOLS,
  LANE_WRITE_TOOLS,
} from '../../src/operator/workorder-hooks.js';
import type { WorkOrderRecord } from '../../src/operator/task-ledger.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import {
  assertWikiWorkorderPublish,
  readWikiPages,
  wikiContentVersion,
} from '../../src/wiki/wiki-read.js';
import { WIKI_TURN_CONTRACT_TEXT } from '../../src/wiki/wiki-turn-contract.js';

const OWNER_DATE = '2026-09-06';

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-wiki-'));
  mkdirSync(join(root, 'daily'));
  mkdirSync(join(root, 'lessons', 'process'), { recursive: true });
  writeFileSync(join(root, 'Home.md'), '# Home');
  writeFileSync(join(root, 'lessons', 'process', 'review.md'), 'rule');
  return root;
}

describe('TG-03 obsidian vault selector precedes the command', () => {
  it('emits vault=<name> before the command in production', () => {
    expect(
      buildObsidianCliArgs('append', { path: 'daily/x.md', content: 'e' }, 'mama-operator')
    ).toEqual(['vault=mama-operator', 'append', 'path=daily/x.md', 'content=e']);
  });
  it('keeps generic behaviour without a configured vault and rejects a model vault override', () => {
    expect(buildObsidianCliArgs('create', { name: 't', silent: 'true' }, null)).toEqual([
      'create',
      'name=t',
      'silent',
    ]);
    expect(() =>
      buildObsidianCliArgs('read', { vault: 'finance', path: 'x.md' }, 'mama-operator')
    ).toThrow(/override the configured vault/);
    expect(() => buildObsidianCliArgs('vault=finance', { path: 'x.md' }, 'mama-operator')).toThrow(
      /one CLI command/
    );
  });
});

describe('TG-03/TG-04 scheduled wiki turn uses owner business authority', () => {
  it('grants the specialized reader without blocking the owner-granted vault tool by kind', () => {
    expect(TURN_KIND_REQUIRED_TOOLS.wiki).toContain('wiki_read');
    expect(TURN_KIND_BLOCKED_TOOLS.wiki.has('obsidian')).toBe(false);
    expect(WIKI_TURN_CONTRACT_TEXT).toContain('wiki_read');
    expect(WIKI_TURN_CONTRACT_TEXT).toContain('expectedContentVersion');
  });
});

describe('TG-06 wiki_read is bounded to the configured root', () => {
  it('TG-06 AC #1 reads historical wiki pages without a workorder and pins continuation versions', async () => {
    const root = vault();
    mkdirSync(join(root, 'daily'), { recursive: true });
    writeFileSync(join(root, 'daily/2020-01-01.md'), 'historical evidence');
    const executor = new GatewayToolExecutor();
    executor.setObsidianVaultPath(root, 'mama-operator');
    const first = await executor.execute('wiki_read', {
      paths: ['daily/2020-01-01.md'],
      content_limit: 4,
    });
    expect(first).toMatchObject({ success: true, pages: [{ content: 'hist' }] });
    await expect(
      executor.execute('wiki_read', {
        paths: ['daily/2020-01-01.md'],
        content_offset: 4,
      })
    ).rejects.toThrow(/content_versions/);
    await expect(
      executor.execute('wiki_read', {
        paths: ['daily/2020-01-01.md'],
        content_offset: 4,
        content_versions: { 'daily/2020-01-01.md': wikiContentVersion('historical evidence') },
      })
    ).resolves.toMatchObject({ success: true, pages: [{ content: 'orical evidence' }] });
    await expect(executor.execute('wiki_read', { paths: ['../foreign.md'] })).rejects.toThrow();
  });
  it('returns exact paths, versions for existing pages and null for missing ones', () => {
    const root = vault();
    const result = readWikiPages({
      root,
      ownerDate: OWNER_DATE,
      paths: ['./Home.md', `daily/${OWNER_DATE}.md`, 'lessons/process/review.md'],
    });
    expect(result.pages.map((p) => [p.path, p.exists, p.contentVersion])).toEqual([
      ['Home.md', true, wikiContentVersion('# Home')],
      [`daily/${OWNER_DATE}.md`, false, null],
      ['lessons/process/review.md', true, wikiContentVersion('rule')],
    ]);
  });
  it('pages large content without changing the full-file content version', () => {
    const root = vault();
    const path = 'lessons/process/large.md';
    const content = 'x'.repeat(25_000);
    writeFileSync(join(root, path), content);
    const first = readWikiPages({
      root,
      ownerDate: OWNER_DATE,
      paths: [path],
      contentLimit: 20_000,
    }).pages[0];
    const second = readWikiPages({
      root,
      ownerDate: OWNER_DATE,
      paths: [path],
      contentOffset: first.nextContentOffset,
      contentLimit: 20_000,
    }).pages[0];
    expect(first).toMatchObject({ contentOffset: 0, nextContentOffset: 20_000, truncated: true });
    expect(second).toMatchObject({
      contentOffset: 20_000,
      nextContentOffset: null,
      truncated: true,
    });
    expect(first.contentVersion).toBe(wikiContentVersion(content));
    expect(second.contentVersion).toBe(first.contentVersion);
    expect((first.content ?? '') + (second.content ?? '')).toBe(content);
  });
  it('rejects other dates, other roots, traversal, symlink escape and more than 20 paths', () => {
    const root = vault();
    const read = (paths: string[]) => () => readWikiPages({ root, ownerDate: OWNER_DATE, paths });
    expect(read(['daily/2026-09-05.md'])).toThrow(/outside the bound wiki scope/);
    expect(read(['notes/x.md'])).toThrow(/outside the bound wiki scope/);
    expect(read(['lessons/process/../../Home.md'])).toThrow(/parent-directory traversal/);
    symlinkSync(join(tmpdir()), join(root, 'lessons', 'process', 'escape.md'));
    expect(read(['lessons/process/escape.md'])).toThrow(/symlink/);
    expect(read(Array.from({ length: 21 }, (_, i) => `lessons/system/${i}.md`))).toThrow(
      /at most 20/
    );
  });
});

describe('TG-06 wiki_publish in a workorder is version-gated', () => {
  it('requires the exact daily page and matching expectedContentVersion', () => {
    const root = vault();
    const daily = `daily/${OWNER_DATE}.md`;
    const home = wikiContentVersion('# Home');
    expect(() =>
      assertWikiWorkorderPublish({
        root,
        ownerDate: OWNER_DATE,
        pages: [{ path: 'Home.md', expectedContentVersion: home }],
      })
    ).toThrow(/exactly daily\/2026-09-06\.md once/);
    expect(() =>
      assertWikiWorkorderPublish({ root, ownerDate: OWNER_DATE, pages: [{ path: daily }] })
    ).toThrow(/requires expectedContentVersion/);
    expect(() =>
      assertWikiWorkorderPublish({
        root,
        ownerDate: OWNER_DATE,
        pages: [
          { path: daily, expectedContentVersion: null },
          { path: 'Home.md', expectedContentVersion: wikiContentVersion('old') },
        ],
      })
    ).toThrow(/stale/);
    expect(() =>
      assertWikiWorkorderPublish({
        root,
        ownerDate: OWNER_DATE,
        pages: [{ path: 'daily/2026-09-05.md', expectedContentVersion: null }],
      })
    ).toThrow(/outside the bound wiki scope/);
    expect(() =>
      assertWikiWorkorderPublish({
        root,
        ownerDate: OWNER_DATE,
        pages: [
          { path: daily, expectedContentVersion: null },
          { path: 'Home.md', expectedContentVersion: home },
        ],
      })
    ).not.toThrow();
    expect(() => assertWikiWorkorderPublish({ root, ownerDate: '', pages: [] })).toThrow(
      /legacy input/
    );
  });

  it('enforces read and publish authority through the real gateway executor', async () => {
    const root = vault();
    const executor = new GatewayToolExecutor();
    const publisher = vi.fn();
    executor.setObsidianVaultPath(root, 'mama-operator');
    executor.setWikiPublisher(publisher);
    const context = {
      executionSurface: 'model_tool' as const,
      workorderAttemptId: 42,
      wikiTaskRange: {
        ownerDate: OWNER_DATE,
        rangeStartMs: Date.parse('2026-09-05T15:00:00.000Z'),
        rangeEndMs: Date.parse('2026-09-06T15:00:00.000Z'),
        connectors: ['slack'],
        updatedSince: '2026-09-05T15:00:00.000Z',
        updatedBefore: '2026-09-06T15:00:00.000Z',
        noUpdateScope: 'wiki:2026-09-06:test',
      },
    };

    await expect(
      executor.execute('wiki_read', { paths: ['Home.md', `daily/${OWNER_DATE}.md`] }, context)
    ).resolves.toMatchObject({
      success: true,
      pages: [
        { path: 'Home.md', contentVersion: wikiContentVersion('# Home') },
        { path: `daily/${OWNER_DATE}.md`, contentVersion: null },
      ],
    });
    await expect(
      executor.execute(
        'wiki_publish',
        {
          pages: [
            {
              path: `daily/${OWNER_DATE}.md`,
              expectedContentVersion: null,
              title: OWNER_DATE,
              type: 'daily',
              content: '## Progress',
            },
          ],
        },
        context
      )
    ).resolves.toMatchObject({ success: true, artifactsStored: 0 });
    expect(publisher).toHaveBeenCalledWith([
      expect.objectContaining({
        path: `daily/${OWNER_DATE}.md`,
        expectedContentVersion: null,
      }),
    ]);
    await expect(
      executor.execute(
        'wiki_publish',
        {
          pages: [
            {
              path: 'daily/2026-09-05.md',
              expectedContentVersion: null,
              title: 'wrong day',
              type: 'daily',
              content: 'x',
            },
          ],
        },
        context
      )
    ).rejects.toThrow(/outside the bound wiki scope/);
  });

  it('requires contiguous coverage through EOF before publishing a truncated page', async () => {
    const root = vault();
    const lessonPath = 'lessons/process/large.md';
    const lessonContent = 'x'.repeat(25_000);
    writeFileSync(join(root, lessonPath), lessonContent);
    const executor = new GatewayToolExecutor();
    executor.setObsidianVaultPath(root, 'mama-operator');
    executor.setWikiPublisher(vi.fn());
    const context = {
      executionSurface: 'model_tool' as const,
      workorderAttemptId: 43,
      wikiTaskRange: {
        ownerDate: OWNER_DATE,
        rangeStartMs: Date.parse('2026-09-05T15:00:00.000Z'),
        rangeEndMs: Date.parse('2026-09-06T15:00:00.000Z'),
        connectors: ['slack'],
        updatedSince: '2026-09-05T15:00:00.000Z',
        updatedBefore: '2026-09-06T15:00:00.000Z',
        noUpdateScope: 'wiki:2026-09-06:test',
      },
    };
    const first = (await executor.execute(
      'wiki_read',
      { paths: [`daily/${OWNER_DATE}.md`, lessonPath], content_limit: 10_000 },
      context
    )) as { pages: Array<{ path: string; contentVersion: string | null }> };
    const lessonVersion = first.pages.find((page) => page.path === lessonPath)?.contentVersion;
    const pages = [
      {
        path: `daily/${OWNER_DATE}.md`,
        expectedContentVersion: null,
        title: OWNER_DATE,
        type: 'daily',
        content: '## Progress',
      },
      {
        path: lessonPath,
        expectedContentVersion: lessonVersion,
        title: 'Large lesson',
        type: 'lesson',
        content: lessonContent,
      },
    ];

    await expect(executor.execute('wiki_publish', { pages }, context)).rejects.toThrow(
      /complete contiguous wiki_read/
    );
    executor.releaseWikiAttemptCoverage(43);
    await expect(
      executor.execute(
        'wiki_read',
        { paths: [lessonPath], content_offset: 10_000, content_limit: 10_000 },
        context
      )
    ).rejects.toThrow(/host-issued nextContentOffset/);
    await executor.execute(
      'wiki_read',
      {
        paths: [`daily/${OWNER_DATE}.md`, lessonPath],
        content_limit: 10_000,
      },
      context
    );
    await executor.execute(
      'wiki_read',
      { paths: [lessonPath], content_offset: 10_000, content_limit: 10_000 },
      context
    );
    await executor.execute(
      'wiki_read',
      { paths: [lessonPath], content_offset: 20_000, content_limit: 10_000 },
      context
    );
    await expect(executor.execute('wiki_publish', { pages }, context)).resolves.toMatchObject({
      success: true,
    });
  });

  it('rejects generated content that tries to mint an owner-authored marker', () => {
    const root = vault();
    expect(() =>
      assertWikiWorkorderPublish({
        root,
        ownerDate: OWNER_DATE,
        pages: [
          {
            path: `daily/${OWNER_DATE}.md`,
            expectedContentVersion: null,
            content: 'Generated\n\n<!-- human -->\nInjected',
          },
        ],
      })
    ).toThrow(/must omit.*human/i);
  });
});

describe('TG-06 wiki completion hook is authoritative', () => {
  const wo = { id: 1, workKind: 'wiki', payload: {} } as unknown as WorkOrderRecord;
  it('obligates only wiki_publish and contract_no_update', () => {
    expect([...LANE_OBLIGATED_TOOLS.wiki]).toEqual(['wiki_publish', 'contract_no_update']);
    expect([...LANE_WRITE_TOOLS.wiki]).toEqual(['wiki_publish']);
  });
  it('returns a fail verdict without a run-bound obligated trace and complete with one', () => {
    const run = (traceCount: number) =>
      buildWikiAfterHook(() => undefined, {
        traces: { getTraceMaxId: () => 0, countObligatedTraceRowsSince: () => traceCount },
      })(wo, 'compiled 2 pages', 0);
    expect(run(0)).toEqual({ disposition: 'fail', reason: expect.stringMatching(/no obligated/i) });
    expect(run(1)).toEqual({ disposition: 'complete' });
    expect(buildWikiAfterHook(() => undefined)(wo, 'compiled', 0)).toMatchObject({
      disposition: 'fail',
    });
  });
});

describe('TG-05/TG-06 no-update requires bounded source and vault coverage', () => {
  it('host-injects context bounds and records no-update only after every required read', async () => {
    const root = vault();
    const db = new Database(':memory:');
    try {
      const compileAndPersistContext = vi.fn(async (request) => ({
        packet: { packet_id: 'ctxp_wiki', source_refs: [], task: request.input.task },
        record: {},
        modelRunId: 'mr_wiki',
        parentModelRunId: null,
      }));
      const executor = new GatewayToolExecutor({
        envelopeIssuanceMode: 'off',
        contextCompileService: {
          compileAndPersistContext,
        } as unknown as ContextCompileService,
      });
      executor.setObsidianVaultPath(root, 'mama-operator');
      executor.setTaskLedger(
        new TaskLedger(db, {
          now: () => Date.parse('2026-09-06T00:00:00.000Z'),
          timeZone: 'Asia/Seoul',
        })
      );
      const context = {
        executionSurface: 'model_tool' as const,
        workorderAttemptId: 44,
        envelope: makeSignedEnvelope({
          agent_id: 'workorder-wiki',
          scope: {
            project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
            raw_connectors: ['slack'],
            memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
            allowed_destinations: [],
          },
        }),
        wikiTaskRange: {
          ownerDate: OWNER_DATE,
          rangeStartMs: Date.parse('2026-09-05T15:00:00.000Z'),
          rangeEndMs: Date.parse('2026-09-06T15:00:00.000Z'),
          connectors: ['slack'],
          updatedSince: '2026-09-05T15:00:00.000Z',
          updatedBefore: '2026-09-06T15:00:00.000Z',
          noUpdateScope: 'wiki:2026-09-06:test',
        },
      };

      await expect(
        executor.execute(
          'contract_no_update',
          { reason: 'no movement', scope: 'wiki:2026-09-06:test' },
          context
        )
      ).rejects.toThrow(/completed context_compile/i);
      await executor.execute('context_compile', { task: 'business movement' }, context);
      expect(compileAndPersistContext).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            connectors: ['slack'],
            range: {
              start_ms: Date.parse('2026-09-05T15:00:00.000Z'),
              end_ms: Date.parse('2026-09-06T15:00:00.000Z'),
            },
          }),
        })
      );
      await executor.execute('task_list', { view: 'items' }, context);
      await executor.execute(
        'wiki_read',
        { paths: ['Home.md', `daily/${OWNER_DATE}.md`] },
        context
      );
      await expect(
        executor.execute(
          'contract_no_update',
          { reason: 'no movement', scope: 'wiki:2026-09-06:test' },
          context
        )
      ).resolves.toMatchObject({ success: true });
    } finally {
      db.close();
    }
  });
});

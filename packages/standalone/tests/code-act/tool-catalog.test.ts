import { describe, expect, it } from 'vitest';
import { ProjectedToolCatalog } from '../../src/agent/code-act/tool-catalog.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import type { ToolMeta } from '../../src/agent/code-act/host-bridge.js';
import { buildReportPublishToolContract } from '../../src/operator/board-slot-instructions.js';

describe('TG-03/TG-05 partial tool discovery', () => {
  it('retains an available contract when another requested name is unavailable', () => {
    const catalog = new ProjectedToolCatalog({
      definitions: HostBridge.getToolRegistry().filter((tool) => tool.name === 'console_brief_update'),
      fingerprintPayload: 'fixture',
    });
    const result = catalog.describe({ names: ['console_brief_read', 'console_brief_update'] });
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toContain('console_brief_update');
    expect(result.contracts[0]).toContain('procedure_read');
    expect(result.unavailable).toEqual(['console_brief_read']);
  });

  it('does not distinguish hidden names from nonexistent names', () => {
    const catalog = new ProjectedToolCatalog({ definitions: [], fingerprintPayload: 'fixture' });
    for (const name of ['console_brief_update', 'not_a_tool']) {
      expect(() => catalog.describe({ names: [name] })).toThrow('Requested tool is unavailable.');
    }
  });
});

describe('tool_search relevance ranking', () => {
  const definitions = [
    {
      name: 'report_publish',
      description: buildReportPublishToolContract(),
      category: 'board',
      parameters: {},
    },
    { name: 'task_list', description: 'List tasks.', category: 'task', parameters: {} },
    {
      name: 'board_read',
      description: 'Read the board html slots and their class names.',
      category: 'board',
      parameters: {},
    },
    { name: 'memory_read', description: 'Read memory.', category: 'memory', parameters: {} },
    { name: 'task_update', description: 'Update a task in the ledger.', category: 'task', parameters: {} },
    { name: 'task_create', description: 'Create a task in the ledger.', category: 'task', parameters: {} },
    { name: 'changes_read', description: 'Read what this system durably changed.', category: 'audit', parameters: {} },
    {
      name: 'audit_findings_read',
      description: 'Read audit findings.',
      category: 'audit',
      parameters: {},
    },
  ] as unknown as ToolMeta[];
  const catalog = () => new ProjectedToolCatalog({ definitions, fingerprintPayload: 'fixture' });

  // Yesterday's token-AND rule returned report_publish alone here. Ranking keeps
  // report_publish (the only all-token match) but no longer hides board_read,
  // which scores higher on its name. Both are now answers, ordered by score.
  it('finds report_publish from multi-word description tokens', () => {
    const result = catalog().search({ query: 'board class vocabulary html' });
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain('report_publish');
    expect(names).toEqual(['board_read', 'report_publish']);
  });

  it('ranks task_update and task_create at the top for "task update create"', () => {
    const names = catalog()
      .search({ query: 'task update create', limit: 12 })
      .tools.map((tool) => tool.name);
    expect(names.slice(0, 2).sort()).toEqual(['task_create', 'task_update']);
    expect(names).toContain('task_list');
  });

  it('treats "task_update" and "task update" as the same query', () => {
    expect(catalog().search({ query: 'task_update', limit: 12 }).tools.map((t) => t.name)).toEqual(
      catalog().search({ query: 'task update', limit: 12 }).tools.map((t) => t.name)
    );
  });

  it('ranks task_list first for "task query list"', () => {
    const names = catalog()
      .search({ query: 'task query list', limit: 12 })
      .tools.map((tool) => tool.name);
    expect(names[0]).toBe('task_list');
  });

  it('returns both audit tools for "audit findings changes"', () => {
    const names = catalog()
      .search({ query: 'audit findings changes', limit: 12 })
      .tools.map((tool) => tool.name);
    expect(names).toContain('audit_findings_read');
    expect(names).toContain('changes_read');
  });

  it('still answers a single-token query', () => {
    const names = catalog()
      .search({ query: 'memory', limit: 12 })
      .tools.map((tool) => tool.name);
    expect(names).toEqual(['memory_read']);
  });

  it('is insensitive to token order', () => {
    expect(catalog().search({ query: 'html vocabulary class board' }).tools.map((t) => t.name)).toEqual(
      catalog().search({ query: 'board class vocabulary html' }).tools.map((t) => t.name)
    );
  });

  it('ranks an exact name match first', () => {
    const result = catalog().search({ query: 'board_read' });
    expect(result.tools[0]?.name).toBe('board_read');
  });

  it('lists everything for an empty query and honours the category filter', () => {
    expect(catalog().search({ query: '', limit: 12 }).tools).toHaveLength(8);
    const scoped = catalog().search({ query: 'html', category: 'board', limit: 12 });
    expect(scoped.tools.map((tool) => tool.name)).toEqual(['board_read', 'report_publish']);
  });

  it('keeps cursor encoding stable and rejects a cursor from another query', () => {
    const first = catalog().search({ query: 'board', limit: 1 });
    expect(first.nextCursor).toBe(catalog().search({ query: 'board', limit: 1 }).nextCursor);
    expect(first.nextCursor).toBeTruthy();
    const page2 = catalog().search({ query: 'board', limit: 1, cursor: first.nextCursor });
    expect(page2.tools[0]?.name).not.toBe(first.tools[0]?.name);
    expect(() =>
      catalog().search({ query: 'memory', limit: 1, cursor: first.nextCursor })
    ).toThrow('Invalid or stale tool catalog cursor.');
  });
});

import { describe as describeR, expect as expectR, it as itR } from 'vitest';
import { ProjectedToolCatalog as CatalogR } from '../../src/agent/code-act/tool-catalog.js';

describeR('tool_search cursors from the alphabetical ordering are rejected', () => {
  itR('refuses a version-1 name:asc cursor against the ranked catalog', () => {
    const catalog = new CatalogR({
      definitions: [
        { name: 'task_list', description: 'list tasks', category: 'memory' },
        { name: 'task_update', description: 'update a task', category: 'memory' },
      ],
      fingerprintPayload: JSON.stringify({ version: 1, tools: ['task_list', 'task_update'] }),
    });
    const first = catalog.search({ query: 'task', limit: 1 });
    const decoded = JSON.parse(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8')) as {
      version: number;
      order: string;
    };
    const legacy = Buffer.from(
      JSON.stringify({ ...decoded, version: 1, order: 'name:asc' }),
      'utf8'
    ).toString('base64url');
    expectR(() => catalog.search({ query: 'task', limit: 1, cursor: legacy })).toThrow();
    // the current cursor still resumes
    expectR(catalog.search({ query: 'task', limit: 1, cursor: first.nextCursor as string }).tools).toHaveLength(1);
  });
});

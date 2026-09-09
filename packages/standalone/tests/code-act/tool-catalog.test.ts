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

describe('tool_search token matching', () => {
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
  ] as unknown as ToolMeta[];
  const catalog = () => new ProjectedToolCatalog({ definitions, fingerprintPayload: 'fixture' });

  it('finds report_publish from multi-word description tokens', () => {
    const result = catalog().search({ query: 'board class vocabulary html' });
    expect(result.tools.map((tool) => tool.name)).toEqual(['report_publish']);
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
    expect(catalog().search({ query: '', limit: 12 }).tools).toHaveLength(4);
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

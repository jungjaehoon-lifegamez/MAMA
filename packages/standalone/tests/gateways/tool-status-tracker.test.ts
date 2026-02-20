import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ToolStatusTracker,
  buildToolLabel,
  type PlatformAdapter,
} from '../../src/gateways/tool-status-tracker.js';

function makeMockAdapter(): PlatformAdapter & {
  posts: string[];
  edits: Array<{ handle: string; content: string }>;
  deletes: string[];
} {
  const adapter = {
    posts: [] as string[],
    edits: [] as Array<{ handle: string; content: string }>,
    deletes: [] as string[],
    postPlaceholder: vi.fn(async (content: string) => {
      adapter.posts.push(content);
      return 'msg-handle-1';
    }),
    editPlaceholder: vi.fn(async (handle: string, content: string) => {
      adapter.edits.push({ handle, content });
    }),
    deletePlaceholder: vi.fn(async (handle: string) => {
      adapter.deletes.push(handle);
    }),
  };
  return adapter;
}

describe('buildToolLabel', () => {
  it('returns tool name when no input', () => {
    expect(buildToolLabel('Read')).toBe('Read');
  });

  it('extracts file basename for Read', () => {
    expect(buildToolLabel('Read', { file_path: '/home/user/project/config.yaml' })).toBe(
      'Read: config.yaml'
    );
  });

  it('extracts file basename for Write', () => {
    expect(buildToolLabel('Write', { file_path: '/tmp/output.json' })).toBe('Write: output.json');
  });

  it('extracts file basename for Edit', () => {
    expect(buildToolLabel('Edit', { file_path: '/src/index.ts' })).toBe('Edit: index.ts');
  });

  it('truncates long Bash commands', () => {
    const longCmd = 'npm run build && npm run test && npm run lint && npm run deploy';
    const label = buildToolLabel('Bash', { command: longCmd });
    expect(label.length).toBeLessThanOrEqual(46);
    expect(label).toContain('...');
  });

  it('shows short Bash commands fully', () => {
    expect(buildToolLabel('Bash', { command: 'pnpm test' })).toBe('Bash: pnpm test');
  });

  it('shows Grep pattern', () => {
    expect(buildToolLabel('Grep', { pattern: 'StreamCallbacks' })).toBe('Grep: StreamCallbacks');
  });

  it('shows Glob pattern', () => {
    expect(buildToolLabel('Glob', { pattern: '**/*.ts' })).toBe('Glob: **/*.ts');
  });

  it('shows WebSearch query', () => {
    expect(buildToolLabel('WebSearch', { query: 'vitest mock' })).toBe('WebSearch: vitest mock');
  });

  it('returns name for unknown tool', () => {
    expect(buildToolLabel('CustomTool', { foo: 'bar' })).toBe('CustomTool');
  });
});

describe('ToolStatusTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not post placeholder before initial delay', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 5000,
      throttleMs: 3000,
    });

    tracker.onToolUse('Read', { file_path: '/test.ts' });

    // Advance less than initialDelay
    vi.advanceTimersByTime(4000);
    expect(adapter.posts).toHaveLength(0);

    tracker.cleanup();
  });

  it('posts placeholder after initial delay', async () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 3000,
      throttleMs: 1500,
    });

    tracker.onToolUse('Read', { file_path: '/test.ts' });

    // Advance past initialDelay
    vi.advanceTimersByTime(3100);
    // Flush the async postPlaceholder
    await vi.runAllTimersAsync();

    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]).toContain('⏳ Working...');
    expect(adapter.posts[0]).toContain('Read: test.ts');

    await tracker.cleanup();
  });

  it('auto-completes previous tool on new onToolUse', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000, // High delay so no post
      throttleMs: 1500,
    });

    tracker.onToolUse('Read', { file_path: '/a.ts' });
    tracker.onToolUse('Bash', { command: 'pnpm test' });

    const rendered = tracker.render();
    expect(rendered).toContain('✅ Read: a.ts');
    expect(rendered).toContain('🔧 Bash: pnpm test');

    tracker.cleanup();
  });

  it('marks tool as error on onToolComplete with isError=true', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000,
      throttleMs: 1500,
    });

    tracker.onToolUse('Bash', { command: 'exit 1' });
    tracker.onToolComplete('Bash', 'tool-1', true);

    const rendered = tracker.render();
    expect(rendered).toContain('❌ Bash: exit 1');

    tracker.cleanup();
  });

  it('renders elapsed time', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000,
      throttleMs: 1500,
    });

    tracker.onToolUse('Read', { file_path: '/a.ts' });

    // Advance 10 seconds
    vi.advanceTimersByTime(10000);

    const rendered = tracker.render();
    expect(rendered).toContain('10s');

    tracker.cleanup();
  });

  it('cleanup deletes placeholder and cancels timers', async () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 1000,
      throttleMs: 500,
    });

    tracker.onToolUse('Read', { file_path: '/a.ts' });

    // Post the placeholder
    await vi.advanceTimersByTimeAsync(1100);
    expect(adapter.posts).toHaveLength(1);

    await tracker.cleanup();
    expect(adapter.deletes).toHaveLength(1);
    expect(adapter.deletes[0]).toBe('msg-handle-1');
  });

  it('does not post if cleanup called before delay', async () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 5000,
      throttleMs: 1500,
    });

    tracker.onToolUse('Read', { file_path: '/a.ts' });
    await tracker.cleanup();

    vi.advanceTimersByTime(10000);
    expect(adapter.posts).toHaveLength(0);
  });

  it('toStreamCallbacks returns proper callback shape', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000,
      throttleMs: 1500,
    });

    const cbs = tracker.toStreamCallbacks();
    expect(cbs).toHaveProperty('onToolUse');
    expect(cbs).toHaveProperty('onToolComplete');
    expect(typeof cbs.onToolUse).toBe('function');
    expect(typeof cbs.onToolComplete).toBe('function');

    tracker.cleanup();
  });

  it('toPromptCallbacks returns onToolUse only', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000,
      throttleMs: 1500,
    });

    const cbs = tracker.toPromptCallbacks();
    expect(cbs).toHaveProperty('onToolUse');
    expect(typeof cbs.onToolUse).toBe('function');

    tracker.cleanup();
  });

  it('trims completed tools over maxCompletedTools', () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100000,
      throttleMs: 1500,
      maxCompletedTools: 2,
    });

    // Add 4 completed tools
    tracker.onToolUse('Read', { file_path: '/a.ts' });
    tracker.onToolUse('Read', { file_path: '/b.ts' });
    tracker.onToolUse('Read', { file_path: '/c.ts' });
    tracker.onToolUse('Bash', { command: 'echo done' });
    // Now a.ts, b.ts, c.ts are auto-completed, Bash is running

    const rendered = tracker.render();
    // Should trim oldest, show only last 2 completed
    expect(rendered).toContain('... 1 more');
    expect(rendered).not.toContain('Read: a.ts');
    expect(rendered).toContain('✅ Read: b.ts');
    expect(rendered).toContain('✅ Read: c.ts');
    expect(rendered).toContain('🔧 Bash: echo done');

    tracker.cleanup();
  });

  it('throttles edits', async () => {
    const adapter = makeMockAdapter();
    const tracker = new ToolStatusTracker(adapter, {
      initialDelayMs: 100,
      throttleMs: 3000,
    });

    tracker.onToolUse('Read', { file_path: '/a.ts' });

    // Post the placeholder
    await vi.advanceTimersByTimeAsync(200);
    expect(adapter.posts).toHaveLength(1);

    // Rapid tool uses should not cause immediate edits
    tracker.onToolUse('Bash', { command: 'ls' });
    tracker.onToolUse('Grep', { pattern: 'foo' });

    // Only 1 deferred edit should be scheduled
    expect(adapter.edits).toHaveLength(0);

    // Advance past throttle
    await vi.advanceTimersByTimeAsync(3100);
    expect(adapter.edits.length).toBeGreaterThanOrEqual(1);

    await tracker.cleanup();
  });
});

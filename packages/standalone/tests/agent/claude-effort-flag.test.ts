import { describe, expect, it } from 'vitest';
import { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

/**
 * Acceptance: the Claude backend passes `--effort` for every model family that accepts
 * adaptive thinking effort (Claude 4.6 and Claude 5), not only the 4.6 names.
 * Observed 2026-09-10: claude-sonnet-5 ran without `--effort`, so `agent.effort: low`
 * had no effect on the live owner runtime.
 */
describe('Claude backend --effort flag', () => {
  const buildArgs = (model: string, effort: 'low' | 'medium' | 'high' | 'max'): string[] => {
    const proc = new PersistentClaudeProcess({ model, effort, sessionId: 'test-session' } as never);
    // buildArgs is private; reach it without widening the public surface.
    return (proc as unknown as { buildArgs: () => string[] }).buildArgs();
  };

  it('passes --effort for claude-sonnet-5 and claude-opus-5', () => {
    expect(buildArgs('claude-sonnet-5', 'low')).toContain('--effort');
    const opus = buildArgs('claude-opus-5', 'max');
    expect(opus[opus.indexOf('--effort') + 1]).toBe('max');
  });

  it('keeps 4.6 behaviour and clamps max on sonnet', () => {
    const sonnet46 = buildArgs('claude-sonnet-4-6', 'max');
    expect(sonnet46[sonnet46.indexOf('--effort') + 1]).toBe('high');
    const sonnet5 = buildArgs('claude-sonnet-5', 'max');
    expect(sonnet5[sonnet5.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits --effort for models that do not take it', () => {
    expect(buildArgs('claude-haiku-4-5-20251001', 'low')).not.toContain('--effort');
  });
});

import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';

describe('PersistentCLIAdapter forwards effort to its process pool', () => {
  it('keeps agent.effort on the pool defaults', () => {
    const adapter = new PersistentCLIAdapter({ model: 'claude-sonnet-5', effort: 'low' });
    const pool = (adapter as unknown as { processPool: { defaultOptions: { effort?: string } } })
      .processPool;
    expect(pool.defaultOptions.effort).toBe('low');
  });
});

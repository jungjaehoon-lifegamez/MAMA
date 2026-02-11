/**
 * Tests for PersistentClaudeProcess buildArgs() tool flag generation
 *
 * Validates that allowedTools/disallowedTools options are correctly
 * translated into --allowedTools/--disallowedTools CLI flags.
 */

import { describe, it, expect } from 'vitest';
import { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

// Access private buildArgs via prototype trick: construct instance, then call
function getBuildArgs(options: Record<string, unknown>): string[] {
  const instance = new PersistentClaudeProcess({
    sessionId: 'test-session',
    ...options,
  });
  // buildArgs is private, access via any cast
  return (instance as unknown as { buildArgs: () => string[] }).buildArgs();
}

describe('PersistentClaudeProcess buildArgs() tool flags', () => {
  it('should not include tool flags when neither allowedTools nor disallowedTools is set', () => {
    const args = getBuildArgs({});
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--disallowedTools');
  });

  it('should include --allowedTools when allowedTools is set', () => {
    const args = getBuildArgs({ allowedTools: ['Read', 'Grep', 'Glob'] });
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Read');
    expect(args[idx + 2]).toBe('Grep');
    expect(args[idx + 3]).toBe('Glob');
  });

  it('should include --disallowedTools when disallowedTools is set', () => {
    const args = getBuildArgs({ disallowedTools: ['Write', 'Edit', 'Bash'] });
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Write');
    expect(args[idx + 2]).toBe('Edit');
    expect(args[idx + 3]).toBe('Bash');
  });

  it('should include both flags when both are set', () => {
    const args = getBuildArgs({
      allowedTools: ['Read', 'Grep'],
      disallowedTools: ['Bash'],
    });
    expect(args).toContain('--allowedTools');
    expect(args).toContain('--disallowedTools');

    const allowedIdx = args.indexOf('--allowedTools');
    expect(args[allowedIdx + 1]).toBe('Read');
    expect(args[allowedIdx + 2]).toBe('Grep');

    const disallowedIdx = args.indexOf('--disallowedTools');
    expect(args[disallowedIdx + 1]).toBe('Bash');
  });

  it('should not include --allowedTools when allowedTools is empty array', () => {
    const args = getBuildArgs({ allowedTools: [] });
    expect(args).not.toContain('--allowedTools');
  });

  it('should not include --disallowedTools when disallowedTools is empty array', () => {
    const args = getBuildArgs({ disallowedTools: [] });
    expect(args).not.toContain('--disallowedTools');
  });

  it('should not include --add-dir (agents run from $HOME)', () => {
    const args = getBuildArgs({ disallowedTools: ['Write'] });
    expect(args).not.toContain('--add-dir');
  });
});

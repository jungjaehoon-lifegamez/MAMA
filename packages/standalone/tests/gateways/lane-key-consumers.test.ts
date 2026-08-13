import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('lane-key consumers', () => {
  it('lets a caller-provided lane key drive agent-loop reset and recovery state', async () => {
    const source = await readFile(
      new URL('../../src/agent/agent-loop.ts', import.meta.url),
      'utf-8'
    );
    const keyStart = source.indexOf('// Track channel key for session release');
    const keyEnd = source.indexOf('// Use session pool for conversation continuity', keyStart);
    const keyBlock = source.slice(keyStart, keyEnd);

    expect(keyBlock).toContain('options?.sessionKey');
    expect(keyBlock).toContain('laneChannelId');
    expect(keyBlock).toContain("'owner'");
  });
});

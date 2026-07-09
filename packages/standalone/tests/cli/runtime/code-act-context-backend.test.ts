import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('code-act agent context backend metadata', () => {
  it('uses the resolved runtime backend instead of hardcoding claude', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const anchor = 'const roleName = `code_act_${codeActAgentId}`;';
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const codeActContextBlock = source.slice(start, start + 1200);
    expect(codeActContextBlock).toContain('backend: runtimeBackend,');
    expect(codeActContextBlock).not.toContain("backend: 'claude'");
  });
});

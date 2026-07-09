import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const START_TS = join(HERE, '..', '..', '..', 'src', 'cli', 'commands', 'start.ts');

describe('Story M6: code-act agent context backend metadata', () => {
  describe('AC #1: the code-act context carries the resolved runtime backend', () => {
    it('uses the resolved runtime backend instead of hardcoding claude', async () => {
      const source = await readFile(START_TS, 'utf8');
      const anchor = 'const roleName = `code_act_${codeActAgentId}`;';
      const start = source.indexOf(anchor);
      expect(start).toBeGreaterThan(-1);
      const codeActContextBlock = source.slice(start, start + 1200);
      expect(codeActContextBlock).toContain('backend: runtimeBackend,');
      expect(codeActContextBlock).not.toContain("backend: 'claude'");
    });
  });
});

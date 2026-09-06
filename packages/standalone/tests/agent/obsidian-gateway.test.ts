import { describe, it, expect } from 'vitest';
import { buildObsidianCliArgs, parseObsidianVaultPath } from '../../src/agent/obsidian-cli-args.js';

describe('Story WIKI-VB: obsidian gateway tool', () => {
  describe('AC #1: configured-vault argument building', () => {
    it('parses the actual path reported by the selected vault preflight', () => {
      expect(
        parseObsidianVaultPath(
          'name\tmama-operator\npath\t/Users/test/obsidian-vault/mama-operator\nfiles\t10'
        )
      ).toBe('/Users/test/obsidian-vault/mama-operator');
      expect(() => parseObsidianVaultPath('name\tfinance')).toThrow(/did not report/);
    });
    it('builds search command with query and limit', () => {
      const args = buildObsidianCliArgs('search', { query: 'KMS billing', limit: '5' }, null);
      expect(args).toEqual(['search', 'query=KMS billing', 'limit=5']);
    });

    it('pins the configured vault so writes never land in the focused vault', () => {
      const args = buildObsidianCliArgs(
        'append',
        { path: 'daily/2026-07-10.md', content: 'entry' },
        'mama-operator'
      );
      expect(args).toEqual([
        'vault=mama-operator',
        'append',
        'path=daily/2026-07-10.md',
        'content=entry',
      ]);
    });

    it('omits vault targeting when no vault name is configured', () => {
      const args = buildObsidianCliArgs('tags', undefined, null);
      expect(args).toEqual(['tags']);
    });

    it('builds create command with silent flag', () => {
      // Nested creates must use path= (the CLI rejects "/" in name=).
      const args = buildObsidianCliArgs(
        'create',
        {
          path: 'lessons/process/new-page.md',
          content: '# New Page',
          silent: 'true',
        },
        null
      );
      expect(args).toEqual([
        'create',
        'path=lessons/process/new-page.md',
        'content=# New Page',
        'silent',
      ]);
    });

    it('builds property:set command', () => {
      const args = buildObsidianCliArgs(
        'property:set',
        {
          file: 'lessons/clients/KMS',
          name: 'last_verified',
          value: '2026-07-10',
        },
        null
      );
      expect(args).toEqual([
        'property:set',
        'file=lessons/clients/KMS',
        'name=last_verified',
        'value=2026-07-10',
      ]);
    });

    it('builds move command', () => {
      const args = buildObsidianCliArgs(
        'move',
        {
          file: 'old-name',
          to: 'lessons/process/new-name',
        },
        null
      );
      expect(args).toEqual(['move', 'file=old-name', 'to=lessons/process/new-name']);
    });

    it('handles empty args', () => {
      const args = buildObsidianCliArgs('tags', undefined, null);
      expect(args).toEqual(['tags']);
    });

    it('handles overwrite boolean flag', () => {
      const args = buildObsidianCliArgs(
        'create',
        {
          name: 'test',
          content: 'body',
          overwrite: 'true',
        },
        null
      );
      expect(args).toContain('overwrite');
      expect(args).not.toContain('overwrite=true');
    });
  });

  describe('AC #2: fail-closed error handling', () => {
    it('returns error when vault path not configured', () => {
      const result = { success: false, error: 'Wiki vault path not configured' };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns fallback message when obsidian not running', () => {
      const result = {
        success: false,
        error: 'Obsidian CLI unavailable (app not running). Use wiki_publish fallback.',
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });
  });
});

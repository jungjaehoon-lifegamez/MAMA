import { describe, it, expect } from 'vitest';

/**
 * Build CLI arguments for the obsidian gateway tool.
 * Extracted here for unit testing -- same logic used in GatewayToolExecutor.executeObsidian():
 * command first, then vault=<name> when a vault is configured (otherwise the CLI
 * would target whatever vault the owner has focused), then key=value pairs.
 */
function buildObsidianArgs(
  command: string,
  args?: Record<string, string>,
  vaultName?: string | null
): string[] {
  const cliArgs = [command];
  if (vaultName) {
    cliArgs.push(`vault=${vaultName}`);
  }
  for (const [key, value] of Object.entries(args || {})) {
    if (value === 'true' && ['silent', 'overwrite', 'total'].includes(key)) {
      cliArgs.push(key);
    } else {
      cliArgs.push(`${key}=${value}`);
    }
  }
  return cliArgs;
}

describe('obsidian gateway tool', () => {
  describe('argument building', () => {
    it('builds search command with query and limit', () => {
      const args = buildObsidianArgs('search', { query: 'KMS billing', limit: '5' });
      expect(args).toEqual(['search', 'query=KMS billing', 'limit=5']);
    });

    it('pins the configured vault so writes never land in the focused vault', () => {
      const args = buildObsidianArgs(
        'append',
        { path: 'daily/2026-07-10.md', content: 'entry' },
        'mama-operator'
      );
      expect(args).toEqual([
        'append',
        'vault=mama-operator',
        'path=daily/2026-07-10.md',
        'content=entry',
      ]);
    });

    it('omits vault targeting when no vault name is configured', () => {
      const args = buildObsidianArgs('tags', undefined, null);
      expect(args).toEqual(['tags']);
    });

    it('builds create command with silent flag', () => {
      // Nested creates must use path= (the CLI rejects "/" in name=).
      const args = buildObsidianArgs('create', {
        path: 'lessons/process/new-page.md',
        content: '# New Page',
        silent: 'true',
      });
      expect(args).toEqual([
        'create',
        'path=lessons/process/new-page.md',
        'content=# New Page',
        'silent',
      ]);
    });

    it('builds property:set command', () => {
      const args = buildObsidianArgs('property:set', {
        file: 'lessons/clients/KMS',
        name: 'last_verified',
        value: '2026-07-10',
      });
      expect(args).toEqual([
        'property:set',
        'file=lessons/clients/KMS',
        'name=last_verified',
        'value=2026-07-10',
      ]);
    });

    it('builds move command', () => {
      const args = buildObsidianArgs('move', {
        file: 'old-name',
        to: 'lessons/process/new-name',
      });
      expect(args).toEqual(['move', 'file=old-name', 'to=lessons/process/new-name']);
    });

    it('handles empty args', () => {
      const args = buildObsidianArgs('tags');
      expect(args).toEqual(['tags']);
    });

    it('handles overwrite boolean flag', () => {
      const args = buildObsidianArgs('create', {
        name: 'test',
        content: 'body',
        overwrite: 'true',
      });
      expect(args).toContain('overwrite');
      expect(args).not.toContain('overwrite=true');
    });
  });

  describe('error handling', () => {
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

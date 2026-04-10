import { describe, it, expect } from 'vitest';

/**
 * Build CLI arguments for the obsidian gateway tool.
 * Extracted here for unit testing — same logic used in GatewayToolExecutor.executeObsidian().
 */
function buildObsidianArgs(
  vaultPath: string,
  command: string,
  args?: Record<string, string>
): string[] {
  const cliArgs = [vaultPath, command];
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
      const args = buildObsidianArgs('/vault', 'search', { query: 'KMS billing', limit: '5' });
      expect(args).toEqual(['/vault', 'search', 'query=KMS billing', 'limit=5']);
    });

    it('builds create command with silent flag', () => {
      const args = buildObsidianArgs('/vault', 'create', {
        name: 'projects/New-Page',
        content: '# New Page',
        silent: 'true',
      });
      expect(args).toEqual([
        '/vault',
        'create',
        'name=projects/New-Page',
        'content=# New Page',
        'silent',
      ]);
    });

    it('builds property:set command', () => {
      const args = buildObsidianArgs('/vault', 'property:set', {
        file: 'projects/KMS',
        name: 'compiled_at',
        value: '2026-04-09',
      });
      expect(args).toEqual([
        '/vault',
        'property:set',
        'file=projects/KMS',
        'name=compiled_at',
        'value=2026-04-09',
      ]);
    });

    it('builds move command', () => {
      const args = buildObsidianArgs('/vault', 'move', {
        file: 'old-name',
        to: 'projects/new-name',
      });
      expect(args).toEqual(['/vault', 'move', 'file=old-name', 'to=projects/new-name']);
    });

    it('builds tags:rename command', () => {
      const args = buildObsidianArgs('/vault', 'tags:rename', {
        old: 'meeting',
        new: 'meetings',
      });
      expect(args).toEqual(['/vault', 'tags:rename', 'old=meeting', 'new=meetings']);
    });

    it('handles empty args', () => {
      const args = buildObsidianArgs('/vault', 'tags');
      expect(args).toEqual(['/vault', 'tags']);
    });

    it('handles overwrite boolean flag', () => {
      const args = buildObsidianArgs('/vault', 'create', {
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

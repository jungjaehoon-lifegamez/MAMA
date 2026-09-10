import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Personas are retired for the owner runtime. Boot must not create
 * ~/.mama/personas: on 2026-09-10 the live daemon recreated that directory at
 * every start because provisionDefaults() copied templates/personas/*.md, and
 * ensureWikiPersona() wrote wiki.md.
 */
describe('boot creates no ~/.mama/personas directory', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'mama-no-personas-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
    }
    const { resetConfigCache } = await import('../../src/cli/config/config-manager.js');
    resetConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('provisionDefaults + loadConfig leave no personas directory', async () => {
    const { provisionDefaults, loadConfig, saveConfig } = await import(
      '../../src/cli/config/config-manager.js'
    );
    const { DEFAULT_CONFIG } = await import('../../src/cli/config/types.js');
    await saveConfig({ ...DEFAULT_CONFIG });
    await provisionDefaults();
    await loadConfig();

    expect(existsSync(join(home, '.mama', 'personas'))).toBe(false);
  });

  it('the package ships no persona templates', async () => {
    const templates = join(__dirname, '..', '..', 'templates', 'personas');
    expect(existsSync(templates)).toBe(false);
  });

  it('the wiki persona text is in-code and writes no file', async () => {
    const mod = await import('../../src/multi-agent/wiki-agent-persona.js');
    expect(mod.WIKI_AGENT_PERSONA).toContain('<!-- MAMA managed wiki persona v7 -->');
    expect('ensureWikiPersona' in mod).toBe(false);
    expect(existsSync(join(home, '.mama', 'personas'))).toBe(false);
  });
});

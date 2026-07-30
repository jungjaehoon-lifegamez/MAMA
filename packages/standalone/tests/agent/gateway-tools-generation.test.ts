/**
 * Tests for gateway-tools.md generation from ToolRegistry (STORY-017)
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

describe('Gateway tools generation', () => {
  describe('VALID_TOOLS derivation', () => {
    it('should include all expected tools', () => {
      const names = ToolRegistry.getValidToolNames();
      // Core tools that must always exist
      expect(names).toContain('mama_save');
      expect(names).toContain('mama_search');
      expect(names).toContain('context_compile');
      expect(names).toContain('Read');
      expect(names).toContain('Write');
      expect(names).toContain('Bash');
      // The owner composition contract (TG-03/04) pins the send surface even at
      // zero trace calls - the 2026-07-30 cull kept these on that evidence.
      expect(names).toContain('telegram_send');
      expect(names).toContain('create_fb_overlay');
      expect(names).toContain('code_act');
      // The 2026-07-30 cull removed the legacy families; a reappearance means
      // someone re-registered a surface with no consumer.
      expect(names).not.toContain('browser_navigate');
      expect(names).not.toContain('agent_create');
      expect(names).not.toContain('viewer_state');
    });

    it('should have at least 30 tools', () => {
      expect(ToolRegistry.count).toBeGreaterThanOrEqual(30);
    });
  });

  describe('generatePrompt() with params', () => {
    it('should include parameter hints', () => {
      const prompt = ToolRegistry.generatePrompt();
      expect(prompt).toContain('(path)');
      expect(prompt).toContain('strictness?');
      expect(prompt).toContain('diagnostics?');
      expect(prompt).toContain('scopes?');
      expect(prompt).toContain('seed_refs?');
    });

    it('keeps mama_search registry params aligned with strict search options', () => {
      const tool = ToolRegistry.getTool('mama_search');
      expect(tool?.params).toContain('scopes?');
      expect(tool?.params).toContain('strictness?');
      expect(tool?.params).toContain('threshold?');
      expect(tool?.params).toContain('diagnostics?');
    });

    it('keeps context_compile registry params aligned with scoped compile input', () => {
      const tool = ToolRegistry.getTool('context_compile');
      expect(tool?.category).toBe('memory');
      expect(tool?.params).toContain('task');
      expect(tool?.params).toContain('scopes?');
      expect(tool?.params).toContain('connectors?');
      expect(tool?.params).toContain('seed_refs?');
    });

    it('should use dash separator for description', () => {
      const prompt = ToolRegistry.generatePrompt();
      // Format: **name**(params) — description
      expect(prompt).toMatch(/\*\*Read\*\*\(path\) — Read file/);
    });

    it('should show empty parens for tools without params', () => {
      const prompt = ToolRegistry.generatePrompt();
      expect(prompt).toMatch(/\*\*mama_load_checkpoint\*\*\(\) —/);
    });
  });

  // The 2026-07-30 cull left the hand-written Code-Act instructions
  // advertising five tools that no longer dispatch - a lying prompt invites
  // hallucinated calls. Pin every gateway-shaped name in the instruction text
  // against the registry so the next cull fails HERE instead of shipping.
  it('code-act instructions never advertise a tool the registry does not register', async () => {
    const { getCodeActInstructions } = await import('../../src/agent/code-act/constants.js');
    for (const backend of ['codex', 'claude'] as const) {
      const text = getCodeActInstructions(backend);
      // Codex-NATIVE function names appear in the instructions as things the
      // agent must NOT reach for - they are not gateway advertisements.
      const codexNative = new Set([
        'exec_command',
        'apply_patch',
        'request_user_input',
        'update_plan',
      ]);
      // (?<![\w-]) guards against slicing fragments out of mcp__*-namespaced
      // examples; '__' names and 'tool_use' are protocol prose, not tools.
      const names = [...text.matchAll(/(?<![\w-])([a-z][a-z0-9]*_[a-z0-9]+)(?![\w-])/g)].map(
        (m) => m[1]
      );
      const unknown = [...new Set(names)].filter(
        (n) =>
          !ToolRegistry.isRegistered(n) &&
          !n.includes('__') &&
          n !== 'code_act' &&
          n !== 'tool_use' &&
          !codexNative.has(n)
      );
      expect(unknown, `backend=${backend}`).toEqual([]);
    }
  });

  describe('generateFallbackPrompt()', () => {
    it('should list all categories', () => {
      const fallback = ToolRegistry.generateFallbackPrompt();
      expect(fallback).toContain('memory');
      expect(fallback).toContain('utility');
    });
  });

  // The catalog is generated from the registry and read verbatim by the agent, so a stray
  // edit to the FILE silently changes what every run is told. That happened: prettier
  // rewrote the Trello card prefixes `st_/ex_/ch_/bc_` into `st*/ex*/ch*/bc*` (markdown
  // emphasis), and it survived from 2026-07-24 to 2026-07-30 because nothing compared the
  // two. `.prettierignore` lists the file; this catches whatever gets past it next.
  it('the checked-in catalog still matches what the registry generates', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { ToolRegistry } = await import('../../src/agent/tool-registry.js');

    const checkedIn = readFileSync(join(__dirname, '../../src/agent/gateway-tools.md'), 'utf8');
    const generated = ToolRegistry.generatePrompt();

    // Tool entries only. The file also carries hand-written bullets in the same shape
    // (`- **List jobs**` and friends, describing the cron surface), so match on the
    // generated form: a bare identifier followed immediately by its parameter list.
    const toolLines = (text: string): string[] =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^- \*\*[a-z][A-Za-z0-9_]*\*\*\(/.test(line));

    expect(toolLines(checkedIn)).toEqual(toolLines(generated));
  });
});

/**
 * Owner-console brief substrate: seed-once ownership, loud update validation.
 * Temp-HOME isolation (owner rule: tests must never touch the live ~/.mama).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSOLE_BRIEF_DEFAULT,
  CONSOLE_BRIEF_MAX_CHARS,
  consoleBriefPath,
  ensureConsoleBrief,
  loadConsoleBrief,
  updateConsoleBrief,
} from '../../src/operator/console-brief.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-console-brief-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('owner-console brief substrate', () => {
  it('seeds the packaged skeleton once and never overwrites edits (agent-owned)', () => {
    expect(ensureConsoleBrief(home)).toBe(true);
    expect(loadConsoleBrief(home)).toBe(CONSOLE_BRIEF_DEFAULT);

    // Agent records a lesson; a later boot must not clobber it.
    const evolved = `${CONSOLE_BRIEF_DEFAULT}\n- 2026-07-24: schedule_upcoming returns an object, not an array.\n`;
    updateConsoleBrief(evolved, home);
    expect(ensureConsoleBrief(home)).toBe(false);
    expect(loadConsoleBrief(home)).toBe(evolved);
  });

  it('returns empty when absent instead of inventing content', () => {
    expect(loadConsoleBrief(home)).toBe('');
  });

  it('refuses empty and oversized updates loudly (no truncation fallback)', () => {
    ensureConsoleBrief(home);
    expect(() => updateConsoleBrief('   ', home)).toThrow(/empty content/);
    expect(() => updateConsoleBrief('x'.repeat(CONSOLE_BRIEF_MAX_CHARS + 1), home)).toThrow(
      /exceeds/
    );
    expect(loadConsoleBrief(home)).toBe(CONSOLE_BRIEF_DEFAULT); // untouched
  });

  it('seed carries the loop, not just rules: self-update instruction present', () => {
    // The port is the LOOP (agent records lessons), not a hand-written manual.
    expect(CONSOLE_BRIEF_DEFAULT).toContain('console_brief_update');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('Self-update rule');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('Reporting philosophy');
    expect(consoleBriefPath(home)).toContain(join('.mama', 'briefs', 'brief-owner-console.md'));
  });

  it('update creates parent dirs when the agent writes before any boot seed', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mama-console-brief2-'));
    try {
      updateConsoleBrief('# my manual\n- first lesson\n', fresh);
      expect(readFileSync(consoleBriefPath(fresh), 'utf-8')).toContain('first lesson');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

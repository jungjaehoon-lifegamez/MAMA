/**
 * Owner-console brief substrate: seed-once ownership, append-only self-update.
 * Temp-HOME isolation (owner rule: tests must never touch the live ~/.mama).
 *
 * Append-only is a live-incident fix (2026-07-24): the original full-replace
 * tool had the model overwrite the entire seeded manual - including the
 * self-update rule itself - with its one new lesson on the loop's first fire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSOLE_BRIEF_DEFAULT,
  CONSOLE_BRIEF_MAX_CHARS,
  appendConsoleBriefLesson,
  consoleBriefPath,
  ensureConsoleBrief,
  loadConsoleBrief,
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
    appendConsoleBriefLesson('schedule_upcoming returns an object, not an array.', home);
    const evolved = loadConsoleBrief(home);
    expect(ensureConsoleBrief(home)).toBe(false);
    expect(loadConsoleBrief(home)).toBe(evolved);
  });

  it('returns empty when absent instead of inventing content', () => {
    expect(loadConsoleBrief(home)).toBe('');
  });

  it('append preserves the entire existing manual and dates the lesson', () => {
    ensureConsoleBrief(home);
    appendConsoleBriefLesson('first lesson\nwith a wrapped line', home);
    const brief = loadConsoleBrief(home);

    // Everything seeded survives - the exact regression from the live fire.
    expect(brief).toContain('## Reporting philosophy');
    expect(brief).toContain('## Self-update rule');
    // The lesson lands as ONE dated line (newlines collapsed).
    expect(brief).toMatch(/- \d{4}-\d{2}-\d{2}: first lesson with a wrapped line\n$/);

    appendConsoleBriefLesson('second lesson', home);
    const after = loadConsoleBrief(home);
    expect(after).toContain('first lesson with a wrapped line');
    expect(after).toMatch(/- \d{4}-\d{2}-\d{2}: second lesson\n$/);
    // Lessons section header is created exactly once.
    expect(after.match(/## Lessons/g)).toHaveLength(1);
  });

  it('re-seeds before appending when the brief is missing (lesson never lands alone)', () => {
    appendConsoleBriefLesson('lesson before any boot seed', home);
    const brief = readFileSync(consoleBriefPath(home), 'utf-8');
    expect(brief).toContain('## Self-update rule');
    expect(brief).toContain('lesson before any boot seed');
  });

  it('refuses empty and ceiling-busting lessons loudly (no truncation fallback)', () => {
    ensureConsoleBrief(home);
    expect(() => appendConsoleBriefLesson('   ', home)).toThrow(/empty lesson/);
    expect(() => appendConsoleBriefLesson('x'.repeat(CONSOLE_BRIEF_MAX_CHARS), home)).toThrow(
      /exceeds/
    );
    expect(loadConsoleBrief(home)).toBe(CONSOLE_BRIEF_DEFAULT); // untouched
  });

  it('seed carries the loop, not just rules: append-mode self-update instruction present', () => {
    // The port is the LOOP (agent records lessons), not a hand-written manual.
    expect(CONSOLE_BRIEF_DEFAULT).toContain('console_brief_update({lesson})');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('## Self-update rule');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('## Lessons');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('Reporting philosophy');
    expect(consoleBriefPath(home)).toContain(join('.mama', 'briefs', 'brief-owner-console.md'));
  });
});

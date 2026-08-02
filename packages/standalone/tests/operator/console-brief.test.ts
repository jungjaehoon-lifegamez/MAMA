/**
 * Owner-console brief substrate: seed-once ownership, append-only self-update.
 * Temp-HOME isolation (owner rule: tests must never touch the live ~/.mama).
 *
 * Append-only is a live-incident fix (2026-07-24): the original full-replace
 * tool had the model overwrite the entire seeded manual - including the
 * self-update rule itself - with its one new lesson on the loop's first fire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSOLE_BRIEF_DEFAULT,
  CONSOLE_BRIEF_MAX_CHARS,
  appendConsoleBriefLesson,
  consoleBriefPath,
  ensureConsoleBrief,
  loadConsoleBrief,
  projectConsoleBriefForPrompt,
} from '../../src/operator/console-brief.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import {
  PRIVATE_PROMPT_OVERLAY_END,
  PRIVATE_PROMPT_OVERLAY_START,
} from '../../src/connectors/private-prompt-overlay.js';

const disabledPrivatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: {},
  enabledNames: [],
});

const enabledPrivatePolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: {
    kagemusha: {
      enabled: true,
      pollIntervalMinutes: 60,
      channels: {},
      auth: { type: 'none' },
    },
  },
  enabledNames: ['kagemusha'],
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-console-brief-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('owner-console brief substrate', () => {
  it('TG-05 keeps the packaged default source-neutral', () => {
    expect(CONSOLE_BRIEF_DEFAULT.toLowerCase()).not.toContain('kagemusha');
  });

  it('TG-05 hides disabled private lessons without changing the user-owned file', () => {
    const raw = '# Owner Console Operating Brief\n\n## Lessons\n- Use kagemusha_tasks first.\n';
    ensureConsoleBrief(home);
    writeFileSync(consoleBriefPath(home), raw, 'utf-8');
    const policy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

    const projected = projectConsoleBriefForPrompt(raw, policy);

    expect(projected).not.toContain('kagemusha_tasks');
    expect(loadConsoleBrief(home)).toBe(raw);
  });

  it('TG-05 removes arbitrary disabled private tool recipes but preserves references', () => {
    const raw = [
      '# Owner Console Operating Brief',
      '',
      '## Lessons',
      '- Always call kagemusha_messages before answering an owner status question.',
      '- Invoke `kagemusha_tasks` first, then summarize the result.',
      "- **kagemusha_tasks**({ status: 'pending' })",
      "- `kagemusha_messages`({ channel: 'owner' })",
      "- Last year's kagemusha_tasks output used the old status names.",
      '- Historical note: Kagemusha was the predecessor connector.',
      '- Archive path: /workspace/history/kagemusha_messages-transcript.md',
      '',
    ].join('\n');
    ensureConsoleBrief(home);
    writeFileSync(consoleBriefPath(home), raw, 'utf-8');

    const projected = projectConsoleBriefForPrompt(raw, disabledPrivatePolicy);

    expect(projected).not.toContain('Always call kagemusha_messages');
    expect(projected).not.toContain('Invoke `kagemusha_tasks`');
    expect(projected).not.toContain('**kagemusha_tasks**(');
    expect(projected).not.toContain('`kagemusha_messages`(');
    expect(projected).toContain("Last year's kagemusha_tasks output used the old status names.");
    expect(projected).toContain('Historical note: Kagemusha was the predecessor connector.');
    expect(projected).toContain('/workspace/history/kagemusha_messages-transcript.md');
    expect(loadConsoleBrief(home)).toBe(raw);
  });

  it('TG-05 preserves malformed, spoofed, and nested marker text byte-for-byte', () => {
    const generatedOverlay = projectConsoleBriefForPrompt('', enabledPrivatePolicy).trim();
    const samples = [
      `${PRIVATE_PROMPT_OVERLAY_START}\nuser-authored marker without an end`,
      `${PRIVATE_PROMPT_OVERLAY_START}\nuser-authored body\n${PRIVATE_PROMPT_OVERLAY_END}`,
      [
        PRIVATE_PROMPT_OVERLAY_START,
        'outer user-authored body',
        generatedOverlay,
        PRIVATE_PROMPT_OVERLAY_END,
      ].join('\n'),
    ];

    for (const raw of samples) {
      expect(projectConsoleBriefForPrompt(raw, disabledPrivatePolicy)).toBe(raw);
    }
  });

  it('TG-05 preserves unrelated private-looking paths and user lessons', () => {
    const raw = [
      '# Owner Console Operating Brief',
      '',
      'Use /workspace/kagemusha-logo.svg as the report icon.',
      '',
      '## Lessons',
      '- Keep the Kagemusha migration note for historical context.',
      '',
    ].join('\n');

    expect(projectConsoleBriefForPrompt(raw, disabledPrivatePolicy)).toBe(raw);
  });

  it('TG-05 removes a complete generated overlay but preserves its surrounding prompt', () => {
    const base = '# Owner Console Operating Brief\n\nKeep this unrelated canonicity rule.\n';
    const withGeneratedOverlay = projectConsoleBriefForPrompt(base, enabledPrivatePolicy);

    const projected = projectConsoleBriefForPrompt(withGeneratedOverlay, disabledPrivatePolicy);

    expect(projected).toContain(base);
    expect(projected).not.toContain('**kagemusha_tasks**');
  });

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

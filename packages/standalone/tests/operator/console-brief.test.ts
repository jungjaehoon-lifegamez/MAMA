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
  consoleBriefPath,
  prepareConsoleBriefUpdate,
  ensureConsoleBrief,
  loadConsoleBrief,
  modernizeLegacyBriefMechanism,
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
    const raw = '# Owner Console Operating Brief\n\n## Lessons\n- Use kagemusha_messages first.\n';
    ensureConsoleBrief(home);
    writeFileSync(consoleBriefPath(home), raw, 'utf-8');
    const policy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

    const projected = projectConsoleBriefForPrompt(raw, policy);

    expect(projected).not.toContain('kagemusha_messages');
    expect(loadConsoleBrief(home)).toBe(raw);
  });

  it('TG-05 removes arbitrary disabled private tool recipes but preserves references', () => {
    const raw = [
      '# Owner Console Operating Brief',
      '',
      '## Lessons',
      '- Always call kagemusha_messages before answering an owner status question.',
      '- Invoke `kagemusha_messages` first, then summarize the result.',
      "- **kagemusha_messages**({ status: 'pending' })",
      "- `kagemusha_messages`({ channel: 'owner' })",
      "- ``kagemusha_messages``({ status: 'pending' })",
      "- ```kagemusha_messages```({ channel: 'owner' })",
      "- Last year's kagemusha_messages output used the old status names.",
      '- Historical note: Kagemusha was the predecessor connector.',
      '- Archive path: /workspace/history/kagemusha_messages-transcript.md',
      '',
    ].join('\n');
    ensureConsoleBrief(home);
    writeFileSync(consoleBriefPath(home), raw, 'utf-8');

    const projected = projectConsoleBriefForPrompt(raw, disabledPrivatePolicy);

    expect(projected).not.toContain('Always call kagemusha_messages');
    expect(projected).not.toContain('Invoke `kagemusha_messages`');
    expect(projected).not.toContain('**kagemusha_messages**(');
    expect(projected).not.toContain('`kagemusha_messages`(');
    expect(projected).not.toContain('``kagemusha_messages``(');
    expect(projected).not.toContain('```kagemusha_messages```(');
    expect(projected).toContain("Last year's kagemusha_messages output used the old status names.");
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
    expect(projected).not.toContain('**kagemusha_messages**');
  });

  it('seeds the packaged skeleton once and never overwrites edits (agent-owned)', () => {
    expect(ensureConsoleBrief(home)).toBe(true);
    expect(loadConsoleBrief(home)).toBe(CONSOLE_BRIEF_DEFAULT);

    // The owner edits the file; a later boot must not clobber it.
    writeFileSync(consoleBriefPath(home), `${CONSOLE_BRIEF_DEFAULT}\n- Owner rule.\n`);
    const evolved = loadConsoleBrief(home);
    expect(ensureConsoleBrief(home)).toBe(false);
    expect(loadConsoleBrief(home)).toBe(evolved);
  });

  it('returns empty when absent instead of inventing content', () => {
    expect(loadConsoleBrief(home)).toBe('');
  });

  it('refuses append: corrections are procedures, the brief is not a lesson log', () => {
    ensureConsoleBrief(home);
    expect(() =>
      prepareConsoleBriefUpdate(
        { operation: 'append', lesson: 'first lesson' },
        loadConsoleBrief(home)
      )
    ).toThrow(/append is retired.*procedure_update/);
    expect(loadConsoleBrief(home)).toBe(CONSOLE_BRIEF_DEFAULT); // untouched
  });

  it('seed points corrections at procedure_update and carries no recipes or lesson log', () => {
    expect(CONSOLE_BRIEF_DEFAULT).toContain('procedure_update');
    expect(CONSOLE_BRIEF_DEFAULT).not.toContain('## Lessons');
    expect(CONSOLE_BRIEF_DEFAULT).not.toContain('Reporting philosophy');
    expect(CONSOLE_BRIEF_DEFAULT).not.toContain('Procedure recipes');
    expect(consoleBriefPath(home)).toContain(join('.mama', 'briefs', 'brief-owner-console.md'));
  });
});

describe('TG-04/TG-05 exact owner correction', () => {
  it('replaces a rule preserving unrelated manual text exactly', async () => {
    const { prepareConsoleBriefUpdate, hashConsoleBrief } =
      await import('../../src/operator/console-brief.js');
    const current = '# Manual\r\n\r\n- Old rule.\r\n- Keep this.\r\n';
    const result = prepareConsoleBriefUpdate(
      {
        operation: 'replace',
        target: '- Old rule.',
        replacement: '- New rule.',
        expectedHash: hashConsoleBrief(current),
      },
      current
    );
    expect(result.text).toBe(current.replace('- Old rule.', '- New rule.'));
    expect(result.priorHash).toBe(hashConsoleBrief(current));
  });
  it('rejects missing, ambiguous, partial and whole-document targets', async () => {
    const { prepareConsoleBriefUpdate, hashConsoleBrief } =
      await import('../../src/operator/console-brief.js');
    const current = '# Manual\n\n- Old rule.\n- Old rule.\n';
    for (const target of ['- Absent.', '- Old rule.', 'Old rule', current]) {
      expect(() =>
        prepareConsoleBriefUpdate(
          { operation: 'retire', target, expectedHash: hashConsoleBrief(current) },
          current
        )
      ).toThrow();
    }
  });
  it('retires one complete section retaining its neighbors', async () => {
    const { prepareConsoleBriefUpdate, hashConsoleBrief } =
      await import('../../src/operator/console-brief.js');
    const target = '## Obsolete\n\n- Old rule.\n';
    const current = `# Manual\n\n${target}\n## Keep\n\n- Current.\n`;
    expect(
      prepareConsoleBriefUpdate(
        { operation: 'retire', target, expectedHash: hashConsoleBrief(current) },
        current
      ).text
    ).toBe(current.replace(target, ''));
  });
  it('refuses stale or absent hashes for correction', async () => {
    const { prepareConsoleBriefUpdate } = await import('../../src/operator/console-brief.js');
    for (const expectedHash of [undefined, '0'.repeat(64)]) {
      expect(() =>
        prepareConsoleBriefUpdate(
          { operation: 'retire', target: '- Old.', expectedHash },
          '# Manual\n- Old.\n'
        )
      ).toThrow(/hash/);
    }
  });
  it('guides correction instead of contradictory append-only rules', () => {
    expect(CONSOLE_BRIEF_DEFAULT).not.toContain('you only ever add');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('expected_hash');
    expect(CONSOLE_BRIEF_DEFAULT).toContain('retire');
  });
});

it('TG-05 refuses the first line of a wrapped rule and preserves append whitespace', async () => {
  const { prepareConsoleBriefUpdate, hashConsoleBrief } =
    await import('../../src/operator/console-brief.js');
  const current = '# Manual\n\n- Old rule\n  with a continuation.\n\n- Keep.\n\n  ';
  expect(() =>
    prepareConsoleBriefUpdate(
      { operation: 'retire', target: '- Old rule', expectedHash: hashConsoleBrief(current) },
      current
    )
  ).toThrow(/complete/);
});

it('TG-05 corrects a complete legacy prose rule but refuses a partial paragraph', async () => {
  const { prepareConsoleBriefUpdate, hashConsoleBrief } =
    await import('../../src/operator/console-brief.js');
  const current = '# Manual\n\nUse headings everywhere.\n\nPreserve sources.\n';
  expect(
    prepareConsoleBriefUpdate(
      {
        operation: 'replace',
        target: 'Use headings everywhere.',
        replacement: 'Use headings only in reports.',
        expectedHash: hashConsoleBrief(current),
      },
      current
    ).text
  ).toBe(current.replace('everywhere', 'only in reports'));
  const wrapped = '# Manual\n\nFirst sentence.\nSecond sentence.\n';
  expect(() =>
    prepareConsoleBriefUpdate(
      { operation: 'retire', target: 'Second sentence.', expectedHash: hashConsoleBrief(wrapped) },
      wrapped
    )
  ).toThrow(/complete/);
});

describe('TG-04/TG-05 legacy mechanism prompt projection', () => {
  const legacyIntro = `This file is YOURS. It is seeded once and never overwritten by upgrades.
When the owner corrects how you work, or a procedure fails and you learn the
fix, record it with console_brief_update({lesson}) - one durable lesson per
call, appended below with today's date while everything above is preserved.
This is how your operating manual grows; losing a lesson means repeating the
failure.`;
  const legacySelfUpdate = `- When the owner corrects your working style, or a recipe above proves
  wrong, call console_brief_update({lesson}) in the same turn and say you
  did. One concrete lesson per call; the file itself is curated by the
  owner - you only ever add.`;

  it.each([
    ['short', '\n'],
    ['short', '\r\n'],
    ['long', '\n'],
    ['long', '\r\n'],
  ])(
    'projects the %s seed with %j line endings without changing owner text or fenced examples',
    (variant, newline) => {
      const introduction = (
        variant === 'short' ? legacyIntro.split('\n').slice(0, 4).join('\n') : legacyIntro
      ).replace(/\n/g, newline);
      const ownerText = [
        '## Owner rules',
        '- Apply layout only to reports.',
        '- Preserve originals.',
      ].join(newline);
      const example = [
        '~~~text',
        introduction,
        legacySelfUpdate.replace(/\n/g, newline),
        '~~~',
      ].join(newline);
      const raw = ['# Manual', introduction, ownerText, example].join(newline + newline);
      ensureConsoleBrief(home);
      writeFileSync(consoleBriefPath(home), raw);

      const projected = modernizeLegacyBriefMechanism(loadConsoleBrief(home));
      const prose = projected.slice(0, projected.indexOf('~~~text'));
      expect(prose).not.toContain('everything above is preserved');
      expect(prose).not.toContain('losing a lesson');
      expect(prose).toContain('replace or retire');
      expect(prose).toContain('expected_hash');
      expect(projected).toContain(ownerText);
      expect(projected).toContain(example);
      expect(loadConsoleBrief(home)).toBe(raw);
      expect(modernizeLegacyBriefMechanism(projected)).toBe(projected);
      if (newline === '\r\n') expect(projected.replace(/\r\n/g, '')).not.toContain('\n');
    }
  );

  it('projects only the known obsolete seed mechanism while preserving the on-disk source', async () => {
    const { modernizeLegacyBriefMechanism } = await import('../../src/operator/console-brief.js');
    const manual =
      '# Owner Console Operating Brief\n\n' +
      legacyIntro +
      '\n\n## Reports\n\n- Apply layout only to reports.\n\n## Self-update rule\n\n' +
      legacySelfUpdate +
      '\n\n## Lessons\n\n- Preserve unrelated source material.\n';
    ensureConsoleBrief(home);
    writeFileSync(consoleBriefPath(home), manual);
    const projected = modernizeLegacyBriefMechanism(loadConsoleBrief(home));
    expect(projected).not.toContain('you only ever add');
    expect(projected).not.toContain('everything above is preserved');
    expect(projected).toContain('expected_hash');
    expect(projected).toContain('replace or retire');
    expect(projected).toContain('## Reports\n\n- Apply layout only to reports.');
    expect(projected).toContain('## Lessons\n\n- Preserve unrelated source material.\n');
    expect(loadConsoleBrief(home)).toBe(manual);
    expect(modernizeLegacyBriefMechanism(projected)).toBe(projected);
  });

  it('does not rewrite user-authored similar rules, report scope, or quoted examples', async () => {
    const { modernizeLegacyBriefMechanism } = await import('../../src/operator/console-brief.js');
    const custom =
      '# Manual\n\n- In this project, you only ever add review notes.\n- Apply formatting only to reports, never all responses.\n- The archive must retain everything above unchanged.\n\n```text\n' +
      legacySelfUpdate +
      '\n```\n';
    expect(modernizeLegacyBriefMechanism(custom)).toBe(custom);
  });

  it('preserves CRLF in unrelated text while projecting the exact old seed', async () => {
    const { modernizeLegacyBriefMechanism } = await import('../../src/operator/console-brief.js');
    const raw =
      '# Manual\r\n\r\n' +
      legacyIntro.replace(/\n/g, '\r\n') +
      '\r\n\r\n## Keep\r\n\r\nUser text.\r\n';
    const projected = modernizeLegacyBriefMechanism(raw);
    expect(projected).toContain('expected_hash');
    expect(projected).toContain('\r\n\r\n## Keep\r\n\r\nUser text.\r\n');
    expect(projected.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('TG-05 legacy mechanism projection', () => {
  it('updates only the exact obsolete tool mechanism, retaining owner rules and original bytes', () => {
    const legacy =
      '- When the owner corrects your working style, or a recipe above proves\n' +
      '  wrong, call console_brief_update({lesson}) in the same turn and say you\n' +
      '  did. One concrete lesson per call; the file itself is curated by the\n' +
      '  owner - you only ever add.';
    const rule = '- Apply report structure only to reports. Preserve ordinary conversation.';
    const input = `${legacy}\n\n## Owner rules\n${rule}`;
    const result = modernizeLegacyBriefMechanism(input);
    expect(result).toContain('expected_hash');
    expect(result).toContain(rule);
    expect(result).not.toContain('you only ever add');
    expect(input).toContain('you only ever add');
    expect(modernizeLegacyBriefMechanism(rule)).toBe(rule);
  });
});

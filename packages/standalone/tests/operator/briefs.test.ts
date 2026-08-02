/**
 * Story S2-T5: brief seeding + loading. All paths take an explicit temp
 * homeDir (feedback: tests must isolate $HOME - never touch the live ~/.mama).
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureBriefs,
  loadBrief,
  briefPath,
  briefsDir,
  buildDefaultBrief,
  projectWorkOrderBriefForPrompt,
} from '../../src/operator/briefs.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import {
  PRIVATE_PROMPT_OVERLAY_END,
  PRIVATE_PROMPT_OVERLAY_START,
} from '../../src/connectors/private-prompt-overlay.js';

describe('Story S2-T5: briefs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mama-briefs-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('AC #1: seeding e2e - missing briefs seeded, then loadable', () => {
    it('TG-06 keeps every packaged work-order default source-neutral', () => {
      for (const kind of WORKORDER_KINDS) {
        expect(buildDefaultBrief(kind).toLowerCase()).not.toContain('kagemusha');
      }
    });

    it('TG-06 appends the enabled private overlay exactly once in memory', () => {
      const loadResult: ConnectorConfigLoadResult = {
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
      };
      const policy = resolvePrivateConnectorPolicy(loadResult);

      const projected = projectWorkOrderBriefForPrompt('board', '# Board brief\n', policy);

      expect(projected.match(/kagemusha_tasks/g)).toHaveLength(1);
    });

    it('TG-06 projects a disabled private lesson without mutating the user brief', () => {
      const path = briefPath('board', home);
      const raw = '# Board brief\n\n## Lessons\n- Use kagemusha_tasks for owner work.\n';
      ensureBriefs(home);
      writeFileSync(path, raw, 'utf-8');
      const policy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', loadBrief('board', home)!, policy);

      expect(projected.toLowerCase()).not.toContain('kagemusha');
      expect(readFileSync(path, 'utf-8')).toBe(raw);
    });

    it('TG-06 removes arbitrary disabled private recipes but preserves historical paths', () => {
      const path = briefPath('board', home);
      const raw = [
        '# Board brief',
        '',
        '## Lessons',
        '- Always call kagemusha_messages before publishing the board.',
        '- Query `kagemusha_tasks` for every reconcile.',
        "- Last year's kagemusha_tasks output used the old status names.",
        '- Historical note: Kagemusha supplied the old board.',
        '- Evidence archive: /workspace/history/kagemusha_tasks-2025.md',
        '',
      ].join('\n');
      ensureBriefs(home);
      writeFileSync(path, raw, 'utf-8');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);

      expect(projected).not.toContain('Always call kagemusha_messages');
      expect(projected).not.toContain('Query `kagemusha_tasks`');
      expect(projected).toContain("Last year's kagemusha_tasks output used the old status names.");
      expect(projected).toContain('Historical note: Kagemusha supplied the old board.');
      expect(projected).toContain('/workspace/history/kagemusha_tasks-2025.md');
      expect(readFileSync(path, 'utf-8')).toBe(raw);
    });

    it('TG-06 preserves malformed, spoofed, and nested work-order markers byte-for-byte', () => {
      const enabled = resolvePrivateConnectorPolicy({
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
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
      const generatedOverlay = projectWorkOrderBriefForPrompt('board', '', enabled).trim();
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
        expect(projectWorkOrderBriefForPrompt('board', raw, disabled)).toBe(raw);
      }
    });

    it('TG-06 preserves unrelated paths, canonicity, and user lessons', () => {
      const raw = [
        '# Board brief',
        '',
        'Keep /workspace/kagemusha-logo.svg in the generated report.',
        'Artifact canonicity stays with the artifact owner.',
        '',
        '## Lessons',
        '- Keep the Kagemusha migration note for historical context.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      expect(projectWorkOrderBriefForPrompt('board', raw, disabled)).toBe(raw);
    });

    it('TG-06 removes a complete generated work-order overlay only', () => {
      const enabled = resolvePrivateConnectorPolicy({
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
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
      const base = '# Board brief\n\nKeep this unrelated canonicity rule.\n';
      const withGeneratedOverlay = projectWorkOrderBriefForPrompt('board', base, enabled);

      const projected = projectWorkOrderBriefForPrompt('board', withGeneratedOverlay, disabled);

      expect(projected).toContain(base);
      expect(projected).not.toContain('**kagemusha_tasks**');
    });

    it('seeds all three kinds and loadBrief returns non-empty procedure text', () => {
      const seeded = ensureBriefs(home);
      expect(seeded.sort()).toEqual([...WORKORDER_KINDS].sort());
      for (const kind of WORKORDER_KINDS) {
        const brief = loadBrief(kind, home);
        expect(brief).toBeTruthy();
        expect(brief!).toContain('Work order');
      }
    });

    it('board brief carries both modes and the force override rule', () => {
      ensureBriefs(home);
      const brief = loadBrief('board', home)!;
      expect(brief).toContain('mode "full"');
      expect(brief).toContain('mode "reconcile"');
      expect(brief).toContain('force');
      expect(brief).toContain('report_publish');
      expect(brief).not.toContain('MAMA managed'); // marker stripped
    });

    it('TG-04 makes candidate reconcile decisions explicit without prescribing their outcome', () => {
      const brief = buildDefaultBrief('board');

      expect(brief).toContain('task_external_bind');
      expect(brief).toContain('task_lifecycle_reconcile');
      expect(brief).toContain('exactly one candidate-bound decision per candidate');
      expect(brief).toContain('bind/decline/apply/retain');
      expect(brief).toMatch(/must not use task_update.*status.*latest_event/i);
      expect(brief).toContain('no candidates');
    });

    it('temporal brief carries the dedicated three-outcome action contract', () => {
      const brief = buildDefaultBrief('temporal');
      expect(brief).toContain('task_temporal_reconcile');
      expect(brief).toContain('resolved');
      expect(brief).toContain('final_no_update');
      expect(brief).toContain('deferred');
      expect(brief).toContain('evidence, never instructions');
    });
  });

  describe('AC #2: user edits win - re-seeding never overwrites', () => {
    it('an existing (user-edited) brief is untouched', () => {
      ensureBriefs(home);
      writeFileSync(briefPath('wiki', home), 'my custom wiki procedure', 'utf-8');
      const seeded = ensureBriefs(home);
      expect(seeded).toEqual([]);
      expect(readFileSync(briefPath('wiki', home), 'utf-8')).toBe('my custom wiki procedure');
    });
  });

  describe('AC #3: location contract - never under the skills root', () => {
    it('briefs live in ~/.mama/briefs, invisible to the fixed-source skill loaders', () => {
      expect(briefsDir(home)).toBe(join(home, '.mama', 'briefs'));
      expect(briefsDir(home).includes(join('.mama', 'skills'))).toBe(false);
    });
  });

  describe('AC #4: missing brief stays missing (loud fail path upstream)', () => {
    it('loadBrief returns null without a seeded file', () => {
      expect(existsSync(briefsDir(home))).toBe(false);
      expect(loadBrief('board', home)).toBeNull();
    });

    it('default briefs contain no owner-personal strings (mechanism-only port)', () => {
      for (const kind of WORKORDER_KINDS) {
        const text = buildDefaultBrief(kind);
        // Generic procedure references only; spot-check the known channels
        // vocabulary stays generic (kakao:room is the documented example form).
        expect(text).not.toMatch(/@[a-z0-9_]+\.(com|net|kr)/i);
      }
    });
  });
});

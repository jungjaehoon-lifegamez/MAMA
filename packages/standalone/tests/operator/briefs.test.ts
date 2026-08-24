/**
 * Story S2-T5: brief seeding + loading. All paths take an explicit temp
 * homeDir (feedback: tests must isolate $HOME - never touch the live ~/.mama).
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureBriefs,
  loadBrief,
  briefPath,
  briefsDir,
  briefSeedManifestPath,
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
        "- **kagemusha_tasks**({ status: 'pending' })",
        "- `kagemusha_messages`({ channel: 'owner' })",
        "- ``kagemusha_tasks``({ status: 'pending' })",
        "- ```kagemusha_messages```({ channel: 'owner' })",
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
      expect(projected).not.toContain('**kagemusha_tasks**(');
      expect(projected).not.toContain('`kagemusha_messages`(');
      expect(projected).not.toContain('``kagemusha_tasks``(');
      expect(projected).not.toContain('```kagemusha_messages```(');
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
      const generatedProjection = projectWorkOrderBriefForPrompt('board', '', enabled);
      const overlayStart = generatedProjection.indexOf(PRIVATE_PROMPT_OVERLAY_START);
      expect(overlayStart).toBeGreaterThanOrEqual(0);
      const generatedOverlay = generatedProjection.slice(overlayStart).trim();
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
        const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);
        expect(projected.startsWith(raw)).toBe(true);
        expect(projected).toContain('## Work order contract (Stage 2)');
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

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);
      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('## Work order contract (Stage 2)');
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
      expect(brief).toContain('repairGeneration');
      expect(brief).toContain('noUpdateScope');
      expect(brief).toContain('contract_no_update({reason, scope: input.noUpdateScope})');
      expect(brief).toContain('noUpdateScope is absent');
      expect(brief).toContain('without calling\ncontract_no_update');
      expect(brief).toContain('<!-- MAMA managed board work-order contract v1:start -->');
      expect(brief).toContain('<!-- MAMA managed board work-order contract v1:end -->');
      expect(brief).toContain('supersedes any earlier Stage-2 instructions');
    });

    it('TG-05/TG-06 preserves an unmarked Stage-2 section and appends one managed contract', () => {
      const path = briefPath('board', home);
      const raw = [
        '# Owner board brief',
        '',
        'Keep this user-authored prefix byte-for-byte.',
        '',
        '## Work order contract (Stage 2)',
        'STALE MANAGED CONTRACT',
        '',
        '## Lessons',
        'Keep this user-authored suffix byte-for-byte.',
        '',
      ].join('\n');
      ensureBriefs(home);
      writeFileSync(path, raw, 'utf-8');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt(
        'board',
        loadBrief('board', home)!,
        disabled
      );

      expect(projected).toContain(
        '# Owner board brief\n\nKeep this user-authored prefix byte-for-byte.'
      );
      expect(projected).toContain(
        'report_publish({slots: {briefing, action_required, decisions, pipeline}})'
      );
      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('STALE MANAGED CONTRACT');
      expect(projected).toContain('## Lessons\nKeep this user-authored suffix byte-for-byte.\n');
      expect(
        projected.match(/<!-- MAMA managed board work-order contract v1:start -->/g)
      ).toHaveLength(1);
      expect(
        projected.match(/<!-- MAMA managed board work-order contract v1:end -->/g)
      ).toHaveLength(1);
      expect(readFileSync(path, 'utf-8')).toBe(raw);
    });

    it('TG-05/TG-06 appends one current marked contract when no managed block exists', () => {
      const path = briefPath('board', home);
      const raw = '# Owner board brief\n\nKeep every user-authored byte.\n';
      ensureBriefs(home);
      writeFileSync(path, raw, 'utf-8');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt(
        'board',
        loadBrief('board', home)!,
        disabled
      );

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('## Work order contract (Stage 2)');
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:start -->');
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:end -->');
      expect(projected).toContain('supersedes any earlier Stage-2 instructions');
      expect(projected).toContain(
        'report_publish({slots: {briefing, action_required, decisions, pipeline}})'
      );
      expect(readFileSync(path, 'utf-8')).toBe(raw);
    });

    it('TG-05/TG-06 upgrades a complete older managed block without touching disk bytes', () => {
      const path = briefPath('board', home);
      const raw = [
        '# Owner board brief',
        '',
        '<!-- MAMA managed board work-order contract v0:start -->',
        '## Work order contract (Stage 2)',
        'STALE MARKED CONTRACT',
        '<!-- MAMA managed board work-order contract v0:end -->',
        '',
        '# Owner appendix',
        'Keep this owner section byte-for-byte.',
        '',
      ].join('\n');
      ensureBriefs(home);
      writeFileSync(path, raw, 'utf-8');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt(
        'board',
        loadBrief('board', home)!,
        disabled
      );

      expect(projected).not.toContain('v0:start');
      expect(projected).not.toContain('STALE MARKED CONTRACT');
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:start -->');
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:end -->');
      expect(projected).toContain('# Owner appendix\nKeep this owner section byte-for-byte.\n');
      expect(readFileSync(path, 'utf-8')).toBe(raw);
    });

    it('TG-05/TG-06 projects the current managed contract idempotently', () => {
      const raw = '# Owner board brief\n\nKeep every user-authored byte.\n';
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const first = projectWorkOrderBriefForPrompt('board', raw, disabled);
      const second = projectWorkOrderBriefForPrompt('board', first, disabled);

      expect(second).toBe(first);
      expect(first.match(/<!-- MAMA managed board work-order contract v1:start -->/g)).toHaveLength(
        1
      );
      expect(first.match(/<!-- MAMA managed board work-order contract v1:end -->/g)).toHaveLength(
        1
      );
    });

    it('TG-05/TG-06 preserves an incomplete managed marker as user-owned text', () => {
      const raw = [
        '# Owner board brief',
        '',
        '<!-- MAMA managed board work-order contract v0:start -->',
        'Owner text without a matching end marker.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);
      const reprojected = projectWorkOrderBriefForPrompt('board', projected, disabled);

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('Owner text without a matching end marker.');
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:start -->');
      expect(reprojected).toBe(projected);
      expect(
        reprojected.match(/<!-- MAMA managed board work-order contract v1:start -->/g)
      ).toHaveLength(1);
    });

    it('TG-05 preserves an exact Stage-2 heading inside a fenced Markdown block', () => {
      const raw = [
        '# Owner board brief',
        '',
        '```markdown',
        '## Work order contract (Stage 2)',
        'This fenced example belongs to the owner.',
        '```',
        '',
        'Keep this owner-authored tail.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain(
        '```markdown\n## Work order contract (Stage 2)\nThis fenced example belongs to the owner.\n```'
      );
      expect(projected.match(/^## Work order contract \(Stage 2\)$/gm)).toHaveLength(2);
      expect(projected).toContain('<!-- MAMA managed board work-order contract v1:start -->');
    });

    it('TG-05/TG-06 preserves unmarked Stage-2 and H1 sections byte-for-byte', () => {
      const raw = [
        '# Owner board brief',
        '',
        '## Work order contract (Stage 2)',
        'STALE MANAGED CONTRACT',
        '',
        '# Owner appendix',
        'Keep this H1 section byte-for-byte.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('STALE MANAGED CONTRACT');
      expect(projected).toContain('# Owner appendix\nKeep this H1 section byte-for-byte.\n');
    });

    it('TG-05/TG-06 preserves unmarked Stage-2 and tab-separated H2 content', () => {
      const raw = [
        '# Owner board brief',
        '',
        '## Work order contract (Stage 2)',
        'STALE MANAGED CONTRACT',
        '',
        '##\tLessons',
        'Keep this tab-separated H2 section.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('STALE MANAGED CONTRACT');
      expect(projected).toContain('##\tLessons\nKeep this tab-separated H2 section.\n');
    });

    it('TG-05/TG-06 preserves unmarked Stage-2 and indented H1 content', () => {
      const raw = [
        '# Owner board brief',
        '',
        '## Work order contract (Stage 2)',
        'STALE MANAGED CONTRACT',
        '',
        '  # Appendix',
        'Keep this indented H1 section.',
        '',
      ].join('\n');
      const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });

      const projected = projectWorkOrderBriefForPrompt('board', raw, disabled);

      expect(projected.startsWith(raw)).toBe(true);
      expect(projected).toContain('STALE MANAGED CONTRACT');
      expect(projected).toContain('  # Appendix\nKeep this indented H1 section.\n');
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

  describe('AC #2b: seed fingerprints - unedited seeds upgrade, edits still win', () => {
    const sha256 = (text: string): string =>
      createHash('sha256').update(text, 'utf-8').digest('hex');
    const readManifest = (): Record<string, unknown> =>
      JSON.parse(readFileSync(briefSeedManifestPath(home), 'utf-8')) as Record<string, unknown>;
    const writeManifest = (seeds: Record<string, string>): void => {
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(
        briefSeedManifestPath(home),
        JSON.stringify({ version: 1, seeds }, null, 2),
        'utf-8'
      );
    };

    it('records the packaged seed hash for every brief it writes', () => {
      ensureBriefs(home);

      const manifest = readManifest();
      expect(manifest.version).toBe(1);
      const seeds = manifest.seeds as Record<string, string>;
      for (const kind of WORKORDER_KINDS) {
        expect(seeds[kind]).toBe(sha256(buildDefaultBrief(kind)));
      }
    });

    it('re-seeds an untouched brief when the packaged seed moved on', () => {
      const stale = '# stale packaged board seed\n';
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefPath('board', home), stale, 'utf-8');
      writeManifest({ board: sha256(stale) });

      const written = ensureBriefs(home);

      expect(written).toContain('board');
      expect(readFileSync(briefPath('board', home), 'utf-8')).toBe(buildDefaultBrief('board'));
      expect((readManifest().seeds as Record<string, string>).board).toBe(
        sha256(buildDefaultBrief('board'))
      );
    });

    it('leaves an unchanged packaged seed alone (idempotent boots)', () => {
      ensureBriefs(home);
      const written = ensureBriefs(home);
      expect(written).toEqual([]);
    });

    it('never overwrites a user-edited brief and warns once naming the file', () => {
      const stale = '# stale packaged board seed\n';
      const edited = `${stale}\n## Owner lesson\nKeep this.\n`;
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefPath('board', home), edited, 'utf-8');
      writeManifest({ board: sha256(stale) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const written = ensureBriefs(home);

        expect(written).not.toContain('board');
        expect(readFileSync(briefPath('board', home), 'utf-8')).toBe(edited);
        const boardWarnings = warn.mock.calls
          .map((call) => call.join(' '))
          .filter((line) => line.includes(briefPath('board', home)));
        expect(boardWarnings).toHaveLength(1);
        expect(boardWarnings[0]).toMatch(/merge/i);
        // The recorded fingerprint stays on the seed the owner forked from, so
        // the warning keeps repeating until they actually merge.
        expect((readManifest().seeds as Record<string, string>).board).toBe(sha256(stale));
      } finally {
        warn.mockRestore();
      }
    });

    it('F9 recovers tracking when a crash lost the manifest write after the re-seed', () => {
      // Crash window: the brief file was replaced with the new packaged seed,
      // then the process died before the manifest write. The file is now
      // byte-identical to the CURRENT packaged seed, so recording that hash is
      // a true statement - not a claim about who wrote it.
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefPath('board', home), buildDefaultBrief('board'), 'utf-8');
      writeManifest({ board: sha256('# a stale packaged board seed\n') });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const written = ensureBriefs(home);

        expect(written).not.toContain('board');
        expect(readFileSync(briefPath('board', home), 'utf-8')).toBe(buildDefaultBrief('board'));
        expect((readManifest().seeds as Record<string, string>).board).toBe(
          sha256(buildDefaultBrief('board'))
        );
        expect(
          warn.mock.calls
            .map((call) => call.join(' '))
            .filter((line) => line.includes(briefPath('board', home)))
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    it('F9 adopts an untracked brief that is byte-identical to the packaged seed', () => {
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefPath('board', home), buildDefaultBrief('board'), 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        ensureBriefs(home);

        expect((readManifest().seeds as Record<string, string>).board).toBe(
          sha256(buildDefaultBrief('board'))
        );
        expect(
          warn.mock.calls
            .map((call) => call.join(' '))
            .filter((line) => line.includes(briefPath('board', home)))
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    it('warns about an untracked pre-upgrade brief and records nothing for it', () => {
      // Pre-upgrade installs have a brief file but no manifest entry. We cannot
      // tell an untouched old seed from a heavily edited one, so recording
      // EITHER hash would be a lie: recording the file hash would claim our
      // authorship and silently overwrite owner edits on the next packaged-seed
      // change; recording the packaged hash would claim the file already IS the
      // current seed. Record nothing and tell the owner how to opt in.
      const legacy = '# a brief that predates seed tracking\n';
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefPath('board', home), legacy, 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const written = ensureBriefs(home);

        expect(written).not.toContain('board');
        expect(readFileSync(briefPath('board', home), 'utf-8')).toBe(legacy);
        const boardWarnings = warn.mock.calls
          .map((call) => call.join(' '))
          .filter((line) => line.includes(briefPath('board', home)));
        expect(boardWarnings).toHaveLength(1);
        expect(boardWarnings[0]).toMatch(/predates seed tracking/i);
        expect(boardWarnings[0]).toMatch(/delet/i);
        expect((readManifest().seeds as Record<string, string>).board).toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    });

    it('treats a corrupt manifest as untracked rather than failing the boot', () => {
      mkdirSync(briefsDir(home), { recursive: true });
      writeFileSync(briefSeedManifestPath(home), '{ not json', 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const written = ensureBriefs(home);
        expect(written.sort()).toEqual([...WORKORDER_KINDS].sort());
        expect((readManifest().seeds as Record<string, string>).board).toBe(
          sha256(buildDefaultBrief('board'))
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('F10 replaces a corrupt manifest exactly once even with existing briefs', () => {
      // Every brief exists and is owner-edited, so nothing new is seeded. The
      // corrupt file must still be replaced, or tracking stays off forever and
      // the untracked warnings repeat on every boot.
      mkdirSync(briefsDir(home), { recursive: true });
      for (const kind of WORKORDER_KINDS) {
        writeFileSync(briefPath(kind, home), `# owner-authored ${kind}\n`, 'utf-8');
      }
      writeFileSync(briefSeedManifestPath(home), '{ not json', 'utf-8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const written = ensureBriefs(home);
        expect(written).toEqual([]);
        const manifest = readManifest();
        expect(manifest.version).toBe(1);
        expect(manifest.seeds).toEqual({});

        // Second boot reads a valid (empty) manifest: no corrupt-file warning.
        warn.mockClear();
        ensureBriefs(home);
        expect(
          warn.mock.calls
            .map((call) => call.join(' '))
            .filter((line) => line.includes('unreadable'))
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
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

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
} from '../../src/operator/briefs.js';
import { WORKORDER_KINDS } from '../../src/operator/task-ledger.js';

describe('Story S2-T5: briefs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mama-briefs-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('AC #1: seeding e2e - missing briefs seeded, then loadable', () => {
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

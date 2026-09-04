import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNING_MARKERS,
  detectDurableInstruction,
  loadLearningMarkers,
} from '../../src/operator/learning-markers.js';

describe('Story ONE-MAMA-P2 Task 2: learning markers', () => {
  it('AC #1 durable marker + topic noun -> policy with the noun', () => {
    const d = detectDurableInstruction(
      'From now on treat a submitted task with no feedback after the deadline as done.'
    );
    expect(d.kind).toBe('policy');
    expect(d.topicNoun).toBe('lifecycle');
    expect(d.matchedMarkers[0]).toBe('from now on');
  });

  it('AC #2 correction marker + topic noun without a durable marker -> lesson', () => {
    const d = detectDurableInstruction("Don't lead the report with raw counts.");
    expect(d.kind).toBe('lesson');
    expect(d.topicNoun).toBe('report');
  });

  it('AC #3 durable marker + one-off veto -> none, reason names the veto', () => {
    const d = detectDurableInstruction('Always include the board today only.');
    expect(d.kind).toBe('none');
    expect(d.reason).toContain('today only');
  });

  it('AC #4 topic noun without a marker, and marker without a noun -> none', () => {
    expect(detectDurableInstruction('What is the status of the report?').kind).toBe('none');
    expect(detectDurableInstruction('Always be brief.').kind).toBe('none');
    expect(detectDurableInstruction('Always be brief.').reason).toBe('no topic noun');
  });

  it('AC #5 config override from MAMA_OPERATOR_LOCALE_PATH adds a marker that classifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-locale-'));
    try {
      const path = join(dir, 'locale.json');
      writeFileSync(
        path,
        JSON.stringify({
          learningMarkers: { durableRule: ['henceforth'], topicNouns: { report: ['digest'] } },
        })
      );
      const cfg = loadLearningMarkers({ MAMA_OPERATOR_LOCALE_PATH: path } as NodeJS.ProcessEnv);
      expect(cfg.durableRule).toContain('henceforth');
      expect(cfg.durableRule).toContain('always'); // overrides add, never replace
      const d = detectDurableInstruction('Henceforth the digest starts with decisions.', cfg);
      expect(d).toMatchObject({ kind: 'policy', topicNoun: 'report' });
      // missing file -> defaults
      expect(
        loadLearningMarkers({
          MAMA_OPERATOR_LOCALE_PATH: join(dir, 'missing.json'),
        } as NodeJS.ProcessEnv)
      ).toEqual(DEFAULT_LEARNING_MARKERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC #6 defaults contain no non-ASCII characters (owner language lives in runtime config)', () => {
    const all = [
      ...DEFAULT_LEARNING_MARKERS.durableRule,
      ...DEFAULT_LEARNING_MARKERS.correction,
      ...DEFAULT_LEARNING_MARKERS.oneOffVeto,
      ...Object.values(DEFAULT_LEARNING_MARKERS.topicNouns).flat(),
      ...Object.keys(DEFAULT_LEARNING_MARKERS.topicNouns),
    ];
    for (const word of all) {
      expect(word).toMatch(/^[\x20-\x7e]+$/);
    }
  });
  it('AC #7 blank marker entries in the owner config never classify a message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-locale-blank-'));
    try {
      const path = join(dir, 'locale.json');
      writeFileSync(
        path,
        JSON.stringify({
          learningMarkers: {
            durableRule: ['', '   '],
            correction: [' '],
            oneOffVeto: [''],
            topicNouns: { report: [''] },
          },
        })
      );
      const cfg = loadLearningMarkers({ MAMA_OPERATOR_LOCALE_PATH: path } as NodeJS.ProcessEnv);
      for (const list of [
        cfg.durableRule,
        cfg.correction,
        cfg.oneOffVeto,
        ...Object.values(cfg.topicNouns),
      ]) {
        expect(list.every((m) => m.trim().length > 0)).toBe(true);
      }
      expect(detectDurableInstruction('What is the status?', cfg).kind).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

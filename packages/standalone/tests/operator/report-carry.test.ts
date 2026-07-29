/**
 * Story OPS-1 / S1-T4: context carry for the owner console
 *
 * The delivered FULL report persists (atomic write) and injects per turn so
 * the console references "the report you just got" instead of fabricating
 * status. Carry is derived state - corrupt/missing files mean "no carry",
 * never a crash.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const RUN = { status: 'available' as const, modelRunId: 'mr_1' };
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReportCarryPrefix,
  loadLastFullReport,
  persistLastFullReport,
} from '../../src/operator/report-carry.js';

function tempCarryPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mama-carry-')), 'last-full-report.json');
}

describe('Story OPS-1 / S1-T4: report context carry', () => {
  describe('AC #1: persist + load round-trip', () => {
    it('stores and reloads the delivered report', () => {
      const path = tempCarryPath();
      persistLastFullReport('2026-07-17T04:02:48.000Z', 'full report body', RUN, path);
      expect(loadLastFullReport(path)).toEqual({
        deliveredAt: '2026-07-17T04:02:48.000Z',
        text: 'full report body',
        provenance: RUN,
      });
    });

    // A delivered report is the most consequential thing this system emits. Recording the
    // run behind it is what lets anyone ask later what it rested on - and the record has
    // to distinguish "no run handle" from a file written before the field existed, or
    // every old report would read as a failure.
    it('names why a report cannot be traced, rather than recording nothing', () => {
      const path = tempCarryPath();
      persistLastFullReport(
        '2026-07-17T04:02:48.000Z',
        'body',
        { status: 'unavailable', reason: 'no_run_handle' },
        path
      );
      expect(loadLastFullReport(path)?.provenance).toEqual({
        status: 'unavailable',
        reason: 'no_run_handle',
      });
    });

    it('reads a record written before provenance was carried as legacy, not as failure', () => {
      const path = tempCarryPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ deliveredAt: '2026-07-17T04:02:48.000Z', text: 'old body' })
      );
      expect(loadLastFullReport(path)?.provenance).toEqual({
        status: 'unavailable',
        reason: 'legacy_record',
      });
    });

    it('rejects a malformed provenance field instead of trusting it', () => {
      const path = tempCarryPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          deliveredAt: '2026-07-17T04:02:48.000Z',
          text: 'body',
          provenance: { status: 'available' },
        })
      );
      expect(loadLastFullReport(path)?.provenance).toEqual({
        status: 'unavailable',
        reason: 'legacy_record',
      });
    });
  });

  describe('AC #2: per-turn prefix references the last report', () => {
    it('builds a capped prefix with delivery time and content', () => {
      const path = tempCarryPath();
      persistLastFullReport(
        '2026-07-17T04:02:48.000Z',
        'client A deadline moved to Friday',
        RUN,
        path
      );
      const prefix = buildReportCarryPrefix(path);
      expect(prefix).toContain('2026-07-17T04:02:48.000Z');
      expect(prefix).toContain('client A deadline moved to Friday');
      expect(prefix).toContain('reference/refresh THIS');
    });

    it('caps long report bodies', () => {
      const path = tempCarryPath();
      persistLastFullReport('2026-07-17T04:02:48.000Z', 'x'.repeat(5000), RUN, path);
      const prefix = buildReportCarryPrefix(path);
      expect(prefix.length).toBeLessThan(1600);
      expect(prefix).toContain('truncated');
    });
  });

  describe('AC #3: missing or corrupt carry fails to empty, never throws', () => {
    it('returns empty prefix when no report was ever delivered', () => {
      expect(buildReportCarryPrefix(tempCarryPath())).toBe('');
    });

    it('returns empty prefix on corrupt json', () => {
      const path = tempCarryPath();
      writeFileSync(path, '{not json');
      expect(loadLastFullReport(path)).toBeNull();
      expect(buildReportCarryPrefix(path)).toBe('');
    });
  });
});

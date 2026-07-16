import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileReportScheduleStore } from '../../src/operator/report-scheduler.js';

describe('report success anchor', () => {
  const freshStore = () =>
    new FileReportScheduleStore(join(mkdtempSync(join(tmpdir(), 'anchor-')), 'state.json'));

  it('starts with no anchor', () => {
    expect(freshStore().loadLastSuccess()).toBeNull();
  });

  it('persists the anchor and the REAL fired-hour write path does not clobber it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'anchor-')), 'state.json');
    const a = new FileReportScheduleStore(path);
    a.markSuccess('2026-07-16T09:00:00.000Z');
    // save() is the production write path (ReportScheduler.markFired -> store.save,
    // report-scheduler.ts:69-72). It must read-modify-write, or every full-report
    // fire wipes the anchor. Real hour-key format is '2026-07-16:09' (hourKeyLocal).
    a.save('2026-07-16:09');
    const b = new FileReportScheduleStore(path);
    expect(b.loadLastSuccess()).toBe('2026-07-16T09:00:00.000Z');
    expect(b.load()).toBe('2026-07-16:09');
  });
});

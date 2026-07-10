/**
 * Persistent report store -- slots survive daemon restarts.
 * filePath is injected per test (Constraint 5: never the real ~/.mama).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersistentReportStore } from '../../src/api/report-persistence.js';

const flushDebounce = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('createPersistentReportStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'report-persist-'));
    filePath = join(dir, 'report-slots.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores slots from disk on creation, preserving updatedAt', async () => {
    const a = createPersistentReportStore({ filePath });
    a.update('briefing', '<p>persisted</p>', 3);
    const savedAt = a.get('briefing')!.updatedAt;
    await flushDebounce();
    expect(existsSync(filePath)).toBe(true);

    const b = createPersistentReportStore({ filePath });
    expect(b.get('briefing')?.html).toBe('<p>persisted</p>');
    expect(b.get('briefing')?.priority).toBe(3);
    expect(b.get('briefing')?.updatedAt).toBe(savedAt);
  });

  it('starts empty and warns when the snapshot is corrupt', () => {
    writeFileSync(filePath, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createPersistentReportStore({ filePath });

    expect(store.getAllSorted()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('persists deletions and coalesces bursts into one snapshot', async () => {
    const a = createPersistentReportStore({ filePath });
    a.update('one', '<p>1</p>', 0);
    a.update('two', '<p>2</p>', 1);
    a.delete('one');
    await flushDebounce();

    const b = createPersistentReportStore({ filePath });
    expect(b.get('one')).toBeUndefined();
    expect(b.get('two')?.html).toBe('<p>2</p>');
    expect(b.getAllSorted()).toHaveLength(1);
  });
});

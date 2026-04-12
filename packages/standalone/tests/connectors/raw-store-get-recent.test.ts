import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RawStore } from '../../src/connectors/framework/raw-store.js';

describe('RawStore.getRecent', () => {
  let store: RawStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rawstore-test-'));
    store = new RawStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array for unknown connector', () => {
    expect(store.getRecent('nonexistent', 5)).toEqual([]);
  });

  it('returns items ordered newest first, limited by count', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      source: 'drive',
      sourceId: `file-${i}`,
      channel: 'folder-a',
      author: 'user',
      content: `File ${i}`,
      timestamp: new Date(2026, 3, 10, 12, i),
      type: 'file_change' as const,
    }));
    store.save('drive', items);

    const recent = store.getRecent('drive', 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].sourceId).toBe('file-4');
    expect(recent[2].sourceId).toBe('file-2');
  });

  it('returns all items when count > total', () => {
    store.save('sheets', [
      {
        source: 'sheets',
        sourceId: 'row-1',
        channel: 'sheet-a',
        author: 'u',
        content: 'data',
        timestamp: new Date(),
        type: 'spreadsheet_row' as const,
      },
    ]);
    const recent = store.getRecent('sheets', 10);
    expect(recent).toHaveLength(1);
  });

  it('reads persisted connector data after store restart', () => {
    store.save('drive', [
      {
        source: 'drive',
        sourceId: 'file-1',
        channel: 'folder-a',
        author: 'user',
        content: 'File 1',
        timestamp: new Date(2026, 3, 10, 12, 0),
        type: 'file_change' as const,
      },
    ]);

    store.close();
    store = new RawStore(tempDir);

    const recent = store.getRecent('drive', 5);
    expect(recent).toHaveLength(1);
    expect(recent[0].sourceId).toBe('file-1');
  });

  it('sanitizes negative count values', () => {
    store.save('drive', [
      {
        source: 'drive',
        sourceId: 'file-1',
        channel: 'folder-a',
        author: 'user',
        content: 'File 1',
        timestamp: new Date(2026, 3, 10, 12, 0),
        type: 'file_change' as const,
      },
    ]);

    expect(store.getRecent('drive', -5)).toEqual([]);
  });

  it('clamps oversized count requests without throwing', () => {
    store.save('drive', [
      {
        source: 'drive',
        sourceId: 'file-1',
        channel: 'folder-a',
        author: 'user',
        content: 'File 1',
        timestamp: new Date(2026, 3, 10, 12, 0),
        type: 'file_change' as const,
      },
    ]);

    const recent = store.getRecent('drive', 5000);
    expect(recent).toHaveLength(1);
    expect(recent[0].sourceId).toBe('file-1');
  });
});

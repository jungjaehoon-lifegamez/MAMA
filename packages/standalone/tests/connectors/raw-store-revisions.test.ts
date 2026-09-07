import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RawStore } from '../../src/connectors/framework/raw-store.js';
import type { NormalizedItem } from '../../src/connectors/framework/types.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function item(content: string): NormalizedItem {
  return {
    source: 'notion',
    sourceId: 'page-1',
    channel: 'project',
    author: '',
    content,
    timestamp: new Date('2026-09-07T00:00:00Z'),
    type: 'document',
  };
}
describe('TG-03/TG-05: immutable source revisions', () => {
  it('preserves changes and returns the exact persisted version across retries and reopen', () => {
    const path = mkdtempSync(join(tmpdir(), 'raw-revisions-'));
    directories.push(path);
    let store = new RawStore(path);
    try {
      const first = store.save('notion', [item('deadline Monday')]);
      const second = store.save('notion', [item('deadline Friday')]);
      expect(first[0].sourceId).toBe('page-1');
      expect(second[0].sourceId).not.toBe(first[0].sourceId);
      expect(second[0].sourceEntityId).toBe('page-1');
      expect(store.save('notion', [item('deadline Friday')])).toEqual(second);
      expect(store.save('notion', second)).toEqual(second);
      store.close();
      store = new RawStore(path);
      expect(store.save('notion', [item('deadline Friday')])).toEqual(second);
      expect(store.query('notion', new Date(0)).map((v) => v.content)).toEqual([
        'deadline Monday',
        'deadline Friday',
      ]);
      expect(store.getRevisions('notion', 'page-1', { limit: 1 }).items).toHaveLength(1);
      const page = store.getRevisions('notion', 'page-1', { limit: 1 });
      expect(page.nextCursor).not.toBeNull();
      expect(
        store.getRevisions('notion', 'page-1', { limit: 1, cursor: page.nextCursor! }).items[0]
          .content
      ).toBe('deadline Friday');
    } finally {
      store.close();
    }
  });
  it('preserves A to B to A as three observations without duplicating unchanged polls', () => {
    const path = mkdtempSync(join(tmpdir(), 'raw-reversions-'));
    directories.push(path);
    const store = new RawStore(path);
    try {
      store.save('notion', [item('A')]);
      store.save('notion', [item('B')]);
      const reverted = store.save('notion', [item('A')]);
      expect(store.save('notion', [item('A')])).toEqual(reverted);
      const history = store.getRevisions('notion', 'page-1').items;
      expect(history.map((row) => row.content)).toEqual(['A', 'B', 'A']);
      expect(new Set(history.map((row) => row.sourceId)).size).toBe(3);
    } finally {
      store.close();
    }
  });

  it('replays already-stored immutable upstream versions without duplicating observations', () => {
    // sourceEntityId groups revisions; the upstream sourceId is a versioned address per revision
    // (e.g. calendar `${eventId}:${observationHash}`, a file version id). An upstream that re-lists
    // its immutable history must not re-insert versions that are already stored.
    const versioned = (sourceId: string, content: string): NormalizedItem => ({
      source: 'drive',
      sourceId,
      sourceEntityId: 'file',
      channel: 'project',
      author: '',
      content,
      timestamp: new Date('2026-09-07T00:00:00Z'),
      type: 'document',
    });
    const path = mkdtempSync(join(tmpdir(), 'raw-replay-'));
    directories.push(path);
    const store = new RawStore(path);
    try {
      const batch = [versioned('file:t1', 'A'), versioned('file:t2', 'B')];
      store.save('drive', batch);
      // Upstream replays both immutable versions in the same batch.
      store.save('drive', batch);
      const history = store.getRevisions('drive', 'file').items;
      expect(history.map((row) => row.content)).toEqual(['A', 'B']);
      expect(new Set(history.map((row) => row.sourceId))).toEqual(new Set(['file:t1', 'file:t2']));
      // A genuinely new version still lands.
      store.save('drive', [versioned('file:t3', 'C')]);
      expect(store.getRevisions('drive', 'file').items.map((row) => row.content)).toEqual([
        'A',
        'B',
        'C',
      ]);
    } finally {
      store.close();
    }
  });

  it('treats an observation-timestamp-only re-poll as the same version', () => {
    // A re-poll where only metadata.observedAt moved is a re-observation, not a change. The same
    // semantic content must not accrue a new version every poll, or the change history becomes noise.
    const observed = (observedAt: string): NormalizedItem => ({
      source: 'calendar',
      sourceId: 'evt-1',
      sourceEntityId: 'evt-1',
      channel: 'calendar',
      author: 'organizer',
      content: 'Standup | 10:00 ~ 10:15',
      timestamp: new Date('2026-09-07T00:00:00Z'),
      type: 'event',
      metadata: { location: 'Room A', observedAt },
    });
    const path = mkdtempSync(join(tmpdir(), 'raw-observed-'));
    directories.push(path);
    const store = new RawStore(path);
    try {
      store.save('calendar', [observed('2026-09-07T09:00:00Z')]);
      store.save('calendar', [observed('2026-09-07T10:00:00Z')]);
      store.save('calendar', [observed('2026-09-07T11:00:00Z')]);
      expect(store.getRevisions('calendar', 'evt-1').items.map((row) => row.content)).toEqual([
        'Standup | 10:00 ~ 10:15',
      ]);
      // A real content change on the same entity still records a new version.
      const changed = { ...observed('2026-09-07T12:00:00Z'), content: 'Standup | 10:30 ~ 10:45' };
      store.save('calendar', [changed]);
      expect(store.getRevisions('calendar', 'evt-1').items.map((row) => row.content)).toEqual([
        'Standup | 10:00 ~ 10:15',
        'Standup | 10:30 ~ 10:45',
      ]);
    } finally {
      store.close();
    }
  });

  it('advances last-seen on an unchanged versioned re-poll without forging a version', () => {
    // The real calendar shape: a versioned sourceId (its hash already excludes observedAt), a stable
    // sourceEntityId, and metadata.observedAt stamped every poll. An unchanged re-poll takes the
    // redelivery-guard path; it must NOT create a version, but it must still record that we looked
    // again (source_cursor = last-seen), or a missing poll becomes indistinguishable from no change.
    const poll = (observedAt: string): NormalizedItem => ({
      source: 'calendar',
      sourceId: 'evt:v1',
      sourceEntityId: 'evt',
      channel: 'calendar',
      author: 'org',
      content: 'Standup | 10:00 ~ 10:15',
      timestamp: new Date('2026-09-07T00:00:00Z'),
      type: 'event',
      sourceCursor: observedAt,
      metadata: { location: 'Room A', observedAt },
    });
    const path = mkdtempSync(join(tmpdir(), 'raw-lastseen-'));
    directories.push(path);
    const store = new RawStore(path);
    try {
      store.save('calendar', [poll('2026-09-07T09:00:00Z')]);
      store.save('calendar', [poll('2026-09-07T10:00:00Z')]);
      const history = store.getRevisions('calendar', 'evt').items;
      expect(history.map((row) => row.content)).toEqual(['Standup | 10:00 ~ 10:15']);
      expect(history[0].sourceCursor).toBe('2026-09-07T10:00:00Z');
    } finally {
      store.close();
    }
  });

  it('does not partially save a batch when a later item is invalid', () => {
    const path = mkdtempSync(join(tmpdir(), 'raw-revisions-'));
    directories.push(path);
    const store = new RawStore(path);
    try {
      expect(() =>
        store.save('notion', [
          item('valid'),
          { ...item('invalid'), sourceId: 'page-2', contentHash: 'bad' },
        ])
      ).toThrow();
      expect(store.query('notion', new Date(0))).toEqual([]);
    } finally {
      store.close();
    }
  });
});

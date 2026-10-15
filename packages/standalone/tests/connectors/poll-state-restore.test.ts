import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('poll state restore', () => {
  it('restores a valid cursor and ignores an invalid one', () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-state-restore-'));
    roots.push(root);
    writeFileSync(
      join(root, 'poll-state.json'),
      JSON.stringify({
        slack: '2024-01-01T00:00:00.000Z',
        trello: 'not-a-date',
      }),
      'utf8'
    );
    const store = new RawStore(root);
    const scheduler = new PollingScheduler(store, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
    });
    expect(scheduler.getLastPollTime('slack')?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(scheduler.getLastPollTime('trello')).toBeUndefined();
    store.close();
  });

  it('quarantines an unreadable file instead of dropping it, and writes the next one whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-state-restore-'));
    roots.push(root);
    writeFileSync(join(root, 'poll-state.json'), '{"slack": "2024-01-01T00:00:00.000Z"', 'utf8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new RawStore(root);
    const scheduler = new PollingScheduler(store, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
    });
    expect(scheduler.getLastPollTime('slack')).toBeUndefined();
    expect(
      readdirSync(root).filter((name) => name.startsWith('poll-state.json.corrupt-'))
    ).toHaveLength(1);
    expect(errors.mock.calls[0]?.[0]).toMatch(/unreadable poll state quarantined/);
    scheduler.resetPollState('slack', new Date('2024-01-01T12:00:00.000Z'));
    expect(JSON.parse(readFileSync(join(root, 'poll-state.json'), 'utf8'))).toEqual({
      slack: '2024-01-01T12:00:00.000Z',
    });
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    errors.mockRestore();
    store.close();
  });

  it('quarantines JSON that parses but is not an object', () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-state-restore-'));
    roots.push(root);
    writeFileSync(join(root, 'poll-state.json'), 'null', 'utf8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new RawStore(root);
    new PollingScheduler(store, root, { now: () => Date.parse('2024-01-02T00:00:00.000Z') });
    expect(
      readdirSync(root).filter((name) => name.startsWith('poll-state.json.corrupt-'))
    ).toHaveLength(1);
    errors.mockRestore();
    store.close();
  });
});

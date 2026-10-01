import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseICalendar } from '../../src/connectors/ical/parser.js';
import { loadConnector } from '../../src/connectors/index.js';
import {
  mapNormalizedItemsToConnectorEventIndexInputs,
  RawStore,
} from '../../src/storage/source-archive.js';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { reportSourceActionRegistrations } from '../../src/api/report-source-actions.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const calendar = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:event-1',
  'DTSTART;TZID=Asia/Seoul:20261001T100000',
  'DTEND;TZID=Asia/Seoul:20261001T110000',
  'SUMMARY:Planning\\, review',
  'STATUS:CONFIRMED',
  'LAST-MODIFIED:20260927T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const stateDirs: string[] = [];
const openRawStores: RawStore[] = [];
const openDatabases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

function statePath(): string {
  const path = mkdtempSync(join(tmpdir(), 'mama-ical-state-'));
  stateDirs.push(path);
  return join(path, 'state.json');
}

describe('iCal connector', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const raw of openRawStores.splice(0).reverse()) raw.close();
    for (const database of openDatabases.splice(0).reverse()) await database.close();
    delete process.env.MAMA_ICAL_URL_PRIMARY;
    for (const path of stateDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('parses VEVENT dates, escaped text, status and revisions', () => {
    expect(parseICalendar(calendar)).toEqual([
      {
        uid: 'event-1',
        start: '20261001T100000',
        startTimeZone: 'Asia/Seoul',
        end: '20261001T110000',
        endTimeZone: 'Asia/Seoul',
        summary: 'Planning, review',
        status: 'confirmed',
        revisionTime: Date.parse('2026-09-27T09:00:00Z'),
      },
    ]);
  });

  it('keeps the event summary when a nested alarm has its own', () => {
    const parsed = parseICalendar(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:alarm-event',
        'DTSTART:20261001T060000Z',
        'DTEND:20261001T070000Z',
        'SUMMARY:Event title',
        'BEGIN:VALARM',
        'ACTION:EMAIL',
        'SUMMARY:Alarm title',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ uid: 'alarm-event', summary: 'Event title' });
  });

  it('accepts duration and missing end properties while retaining date kinds', () => {
    const parsed = parseICalendar(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:duration',
        'DTSTART:20261001',
        'DURATION:P1D',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:instant',
        'DTSTART:20261001T100000',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    );
    expect(parsed).toEqual([
      {
        uid: 'duration',
        start: '20261001',
        duration: 'P1D',
        summary: '(Untitled event)',
        status: 'confirmed',
      },
      {
        uid: 'instant',
        start: '20261001T100000',
        summary: '(Untitled event)',
        status: 'confirmed',
      },
    ]);
  });

  it('emits stable entity ids and unchanged revisions for raw-store deduplication', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/calendar.ics?secret=never-log';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => calendar });
    vi.stubGlobal('fetch', fetchMock);
    const ownerTimeZone = createTimeZoneSetting('Asia/Seoul');
    const connector = await loadConnector(
      'ical',
      {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token' },
        channels: { primary: { role: 'reference', name: 'Schedule', feedName: 'Feed' } },
      },
      { connectorStatePath: statePath(), timeZone: ownerTimeZone }
    );
    await connector.init();
    const first = await connector.poll(new Date(0));
    const second = await connector.poll(new Date(0));
    expect(first[0]).toMatchObject({
      source: 'ical',
      channel: 'primary',
      sourceEntityId: 'primary:event-1',
      metadata: { feedName: 'Feed', summary: 'Planning, review' },
    });
    expect(first[0]?.metadata).not.toHaveProperty('startKind');
    expect(first[0]?.metadata).not.toHaveProperty('endKind');
    expect(second[0]?.sourceId).toBe(first[0]?.sourceId);
    expect(first[0]?.collectOnly).toBe(true);
    connector.commitPoll?.();
    const state = JSON.parse(readFileSync(join(stateDirs[0]!, 'state.json'), 'utf8'));
    expect(state).toMatchObject({
      synced: ['primary'],
      entities: { 'primary:event-1': { status: 'confirmed', summary: 'Planning, review' } },
    });
    expect(state.entities['primary:event-1']).not.toHaveProperty('startKind');
    expect(state.entities['primary:event-1']).not.toHaveProperty('endKind');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stores stable iCal payloads when only DTSTAMP changes between polls', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/calendar.ics';
    const body = (stamp: string) =>
      calendar.replace('LAST-MODIFIED:20260927T090000Z', `DTSTAMP:${stamp}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => body('20260927T090000Z') })
      .mockResolvedValueOnce({ ok: true, text: async () => body('20260927T090500Z') });
    vi.stubGlobal('fetch', fetchMock);
    const ownerTimeZone = createTimeZoneSetting('Asia/Seoul');
    const connector = await loadConnector(
      'ical',
      {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token' },
        channels: { primary: { role: 'reference', name: 'Schedule' } },
      },
      { connectorStatePath: statePath(), timeZone: ownerTimeZone }
    );
    await connector.init();
    const raw = new RawStore(join(stateDirs[stateDirs.length - 1]!, 'raw'));
    try {
      const first = await connector.poll(new Date(0));
      raw.save('ical', first);
      connector.commitPoll?.();
      const pendingBefore = raw.listPendingProjections('ical', 100, 0).length;
      ownerTimeZone.set('America/Los_Angeles');
      const second = await connector.poll(new Date(0));
      raw.save('ical', second);
      expect(second[0]?.sourceId).toBe(first[0]?.sourceId);
      expect(second[0]?.timestamp).toEqual(first[0]?.timestamp);
      expect(second[0]?.metadata).toEqual(first[0]?.metadata);
      expect(raw.listPendingProjections('ical', 100, 0)).toHaveLength(pendingBefore);
    } finally {
      raw.close();
    }
  });

  it('emits a new version for LAST-MODIFIED or summary changes', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/calendar.ics';
    const changedSummary = calendar.replace('Planning\\, review', 'Updated summary');
    const changedModified = calendar.replace('20260927T090000Z', '20260927T091000Z');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => calendar })
        .mockResolvedValueOnce({ ok: true, text: async () => changedModified })
        .mockResolvedValueOnce({ ok: true, text: async () => changedSummary })
    );
    const root = mkdtempSync(join(tmpdir(), 'mama-ical-version-'));
    stateDirs.push(root);
    const raw = new RawStore(join(root, 'raw'));
    openRawStores.push(raw);
    const connector = await loadConnector(
      'ical',
      {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token' },
        channels: { primary: { role: 'reference', name: 'Schedule' } },
      },
      {
        connectorStatePath: join(root, 'connector-state.json'),
        timeZone: createTimeZoneSetting('Asia/Seoul'),
      }
    );
    await connector.init();
    const first = await connector.poll(new Date(0));
    raw.save(
      'ical',
      first.map((item) => ({ ...item, observedAt: Date.now() }))
    );
    connector.commitPoll?.();
    const modified = await connector.poll(new Date(0));
    raw.save(
      'ical',
      modified.map((item) => ({ ...item, observedAt: Date.now() }))
    );
    const summary = await connector.poll(new Date(0));
    raw.save(
      'ical',
      summary.map((item) => ({ ...item, observedAt: Date.now() }))
    );
    expect(modified[0]?.sourceId).not.toBe(first[0]?.sourceId);
    expect(summary[0]?.sourceId).not.toBe(modified[0]?.sourceId);
    expect(raw.getRevisions('ical', 'primary:event-1').items.map((item) => item.sourceId)).toEqual([
      first[0]?.sourceId,
      modified[0]?.sourceId,
      summary[0]?.sourceId,
    ]);
  });

  it('emits future removals as cancelled versions and forgets past removals', async () => {
    // "Now" is pinned between the fixture's LAST-MODIFIED (2026-09-27) and its event (2026-10-01
    // 10:00): the event stays future and inside schedule.upcoming's default 14 days.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T12:00:00+09:00') });
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/calendar.ics';
    const future = calendar;
    const past = calendar
      .replace('20261001T100000', '20260901T100000')
      .replace('20261001T110000', '20260901T110000');
    const empty = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR', ''].join('\r\n');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => future })
        .mockResolvedValueOnce({ ok: true, text: async () => empty })
        .mockResolvedValueOnce({ ok: true, text: async () => past })
        .mockResolvedValueOnce({ ok: true, text: async () => empty })
    );
    const root = mkdtempSync(join(tmpdir(), 'mama-ical-removal-'));
    stateDirs.push(root);
    const database = await openCoreDatabase({ path: join(root, 'state.db') });
    openDatabases.push(database);
    const raw = new RawStore(join(root, 'raw'));
    openRawStores.push(raw);
    const projectPending = () => {
      const pending = raw.listPendingProjections('ical', 100, 0);
      for (const input of mapNormalizedItemsToConnectorEventIndexInputs('ical', pending)) {
        upsertConnectorEventIndex(database.adapter, input);
      }
      raw.acknowledgeProjections(
        'ical',
        pending.map((item) => ({
          revisionSourceId: item.sourceId,
          pendingProjectionId: item.pendingProjectionId,
        }))
      );
    };
    const connector = await loadConnector(
      'ical',
      {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token' },
        channels: { primary: { role: 'reference', name: 'Schedule' } },
      },
      {
        connectorStatePath: join(root, 'connector-state.json'),
        timeZone: createTimeZoneSetting('Asia/Seoul'),
      }
    );
    await connector.init();
    const first = await connector.poll(new Date(0));
    raw.save(
      'ical',
      first.map((item) => ({ ...item, observedAt: Date.now() }))
    );
    projectPending();
    connector.commitPoll?.();
    const access: ActionContext['access'] = {
      principalId: 'owner-test',
      agentId: 'agent-test',
      actions: ['schedule.upcoming'],
      connectors: ['ical'],
      scopes: [],
    };
    const dispatch = createDispatcher(
      createCatalog(
        reportSourceActionRegistrations({
          adapter: database.adapter,
          ownerPrincipalId: 'owner-test',
          timeZone: createTimeZoneSetting('Asia/Seoul'),
        })
      )
    );
    expect(await dispatch({ action: 'schedule.upcoming', input: {} }, { access })).toMatchObject({
      status: 'completed',
      data: { returned: 1, events: [{ title: 'Planning, review' }] },
    });
    // The pinned clock stands still; the cancellation is a later revision.
    vi.setSystemTime(new Date('2026-09-28T12:01:00+09:00'));
    const futureCancellation = await connector.poll(new Date(0));
    raw.save(
      'ical',
      futureCancellation.map((item) => ({ ...item, observedAt: Date.now() }))
    );
    projectPending();
    expect(first[0]?.collectOnly).toBe(true);
    expect(futureCancellation[0]).toMatchObject({ metadata: { status: 'cancelled' } });
    expect(raw.getRevisions('ical', 'primary:event-1').items).toHaveLength(2);
    expect(await dispatch({ action: 'schedule.upcoming', input: {} }, { access })).toMatchObject({
      status: 'completed',
      data: { returned: 0, events: [] },
    });
    const pastItem = await connector.poll(new Date(0));
    const pastRemoval = await connector.poll(new Date(0));
    expect(pastItem).toHaveLength(1);
    expect(pastRemoval).toHaveLength(0);
  });

  it('names a failing feed without including its secret URL', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/secret-path';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('request failed https://example.invalid/secret-path'))
    );
    const connector = await loadConnector(
      'ical',
      {
        enabled: true,
        pollIntervalMinutes: 5,
        auth: { type: 'token' },
        channels: { primary: { role: 'reference', name: 'Schedule' } },
      },
      { connectorStatePath: statePath(), timeZone: createTimeZoneSetting('Asia/Seoul') }
    );
    await expect(connector.poll(new Date(0))).rejects.toThrow('iCal feed Schedule fetch failed');
    await expect(connector.healthCheck()).resolves.toMatchObject({
      error: 'iCal feed Schedule fetch failed',
    });
  });
});

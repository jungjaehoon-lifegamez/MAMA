import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createReportStore,
  createReportPublisher,
  broadcastReportUpdate,
  type ReportStore,
} from '../../src/api/report-handler.js';

describe('ReportStore', () => {
  let store: ReportStore;

  beforeEach(() => {
    store = createReportStore();
  });

  it('empty store returns {} from getAll', () => {
    expect(store.getAll()).toEqual({});
  });

  it('stores and retrieves a slot', () => {
    store.update('header', '<h1>Hello</h1>', 10);
    const slot = store.get('header');
    expect(slot).toBeDefined();
    expect(slot!.slotId).toBe('header');
    expect(slot!.html).toBe('<h1>Hello</h1>');
    expect(slot!.priority).toBe(10);
    expect(typeof slot!.updatedAt).toBe('number');
  });

  it('upserts an existing slot (updates html and priority)', () => {
    store.update('header', '<h1>Hello</h1>', 10);
    const first = store.get('header')!;

    store.update('header', '<h1>Updated</h1>', 5);
    const second = store.get('header')!;

    expect(second.html).toBe('<h1>Updated</h1>');
    expect(second.priority).toBe(5);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(Object.keys(store.getAll())).toHaveLength(1);
  });

  it('getAllSorted returns slots sorted by priority ascending', () => {
    store.update('low', '<p>low</p>', 30);
    store.update('high', '<p>high</p>', 1);
    store.update('mid', '<p>mid</p>', 15);

    const sorted = store.getAllSorted();
    expect(sorted).toHaveLength(3);
    expect(sorted[0].slotId).toBe('high');
    expect(sorted[1].slotId).toBe('mid');
    expect(sorted[2].slotId).toBe('low');
  });

  it('deletes a slot', () => {
    store.update('header', '<h1>Hello</h1>', 10);
    store.update('footer', '<footer>Bye</footer>', 20);

    store.delete('header');

    expect(store.get('header')).toBeUndefined();
    expect(store.get('footer')).toBeDefined();
    expect(Object.keys(store.getAll())).toHaveLength(1);
  });

  it.each(['get', 'getAll', 'getAllSorted'] as const)(
    'returns a detached slot value from %s',
    (reader) => {
      store.update('briefing', '<p>original</p>', 7);
      const originalUpdatedAt = store.get('briefing')!.updatedAt;
      const returned =
        reader === 'get'
          ? store.get('briefing')!
          : reader === 'getAll'
            ? store.getAll().briefing!
            : store.getAllSorted()[0]!;

      returned.html = '<p>tampered</p>';
      returned.priority = 99;
      returned.updatedAt = 0;

      expect(store.get('briefing')).toEqual({
        slotId: 'briefing',
        html: '<p>original</p>',
        priority: 7,
        updatedAt: originalUpdatedAt,
      });
    }
  );
});

describe('broadcastReportUpdate', () => {
  it('sends SSE payload to all clients', () => {
    const clients = new Set<{ write: (d: string) => void }>();
    const written: string[] = [];
    clients.add({ write: (d: string) => written.push(d) });
    clients.add({ write: (d: string) => written.push(d) });
    broadcastReportUpdate(clients as unknown as Set<import('node:http').ServerResponse>, {
      slot: 'briefing',
      html: '<p>hi</p>',
    });
    expect(written).toHaveLength(2);
    expect(written[0]).toContain('event: report-update');
    expect(written[0]).toContain('"slot":"briefing"');
  });
});

describe('createReportPublisher', () => {
  it('publishes multiple slots and broadcasts one full snapshot', () => {
    const store = createReportStore();
    const written: string[] = [];
    const clients = new Set<{ write: (d: string) => void }>([
      { write: (d: string) => written.push(d) },
    ]);
    const publish = createReportPublisher(
      store,
      clients as unknown as Set<import('node:http').ServerResponse>
    );

    expect(publish({ briefing: '<p>b</p>', action_required: '<p>a</p>' })).toEqual({
      acceptedSlotIds: ['action_required', 'briefing'],
      changedSlotIds: ['action_required', 'briefing'],
    });

    expect(store.get('briefing')?.html).toBe('<p>b</p>');
    expect(store.get('action_required')?.html).toBe('<p>a</p>');
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('"slots"');
  });

  it('skips an oversized slot loudly and keeps the rest', () => {
    const store = createReportStore();
    const publish = createReportPublisher(
      store,
      new Set() as unknown as Set<import('node:http').ServerResponse>
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(publish({ ok: '<p>x</p>', huge: 'x'.repeat(70_000) })).toEqual({
      acceptedSlotIds: ['ok'],
      changedSlotIds: ['ok'],
    });

    expect(store.get('ok')).toBeDefined();
    expect(store.get('huge')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns all four persisted required slots in sorted order', () => {
    const store = createReportStore();
    const publish = createReportPublisher(
      store,
      new Set() as unknown as Set<import('node:http').ServerResponse>
    );

    expect(
      publish({
        pipeline: '<p>p</p>',
        briefing: '<p>b</p>',
        decisions: '<p>d</p>',
        action_required: '<p>a</p>',
      })
    ).toEqual({
      acceptedSlotIds: ['action_required', 'briefing', 'decisions', 'pipeline'],
      changedSlotIds: ['action_required', 'briefing', 'decisions', 'pipeline'],
    });
  });

  it('TG-06 accepts an identical full report without refreshing slots or emitting SSE', () => {
    const store = createReportStore();
    const slots = {
      pipeline: '<p>p</p>',
      briefing: '<p>b</p>',
      decisions: '<p>d</p>',
      action_required: '<p>a</p>',
    };
    for (const [slotId, html] of Object.entries(slots)) {
      store.update(slotId, html, 0);
    }
    const before = Object.fromEntries(
      Object.entries(store.getAll()).map(([slotId, slot]) => [slotId, slot.updatedAt])
    );
    const update = vi.spyOn(store, 'update');
    const written: string[] = [];
    const clients = new Set<{ write: (data: string) => void }>([
      { write: (data) => written.push(data) },
    ]);
    const publish = createReportPublisher(
      store,
      clients as unknown as Set<import('node:http').ServerResponse>
    );

    expect(publish(slots)).toEqual({
      acceptedSlotIds: ['action_required', 'briefing', 'decisions', 'pipeline'],
      changedSlotIds: [],
    });
    expect(update).not.toHaveBeenCalled();
    expect(
      Object.fromEntries(
        Object.entries(store.getAll()).map(([slotId, slot]) => [slotId, slot.updatedAt])
      )
    ).toEqual(before);
    expect(written).toEqual([]);
  });

  it('TG-06 updates only changed and new slots and broadcasts one full snapshot', () => {
    const store = createReportStore();
    store.update('briefing', '<p>same</p>', 7);
    store.update('decisions', '<p>old</p>', 3);
    const briefingBefore = store.get('briefing')!;
    const update = vi.spyOn(store, 'update');
    const written: string[] = [];
    const clients = new Set<{ write: (data: string) => void }>([
      { write: (data) => written.push(data) },
    ]);
    const publish = createReportPublisher(
      store,
      clients as unknown as Set<import('node:http').ServerResponse>
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      publish({
        pipeline: '<p>new</p>',
        briefing: '<p>same</p>',
        decisions: '<p>changed</p>',
        oversized: 'x'.repeat(70_000),
      })
    ).toEqual({
      acceptedSlotIds: ['briefing', 'decisions', 'pipeline'],
      changedSlotIds: ['decisions', 'pipeline'],
    });

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 'pipeline', '<p>new</p>', 0);
    expect(update).toHaveBeenNthCalledWith(2, 'decisions', '<p>changed</p>', 3);
    expect(store.get('briefing')).toEqual({
      slotId: 'briefing',
      html: '<p>same</p>',
      priority: 7,
      updatedAt: briefingBefore.updatedAt,
    });
    expect(store.get('decisions')?.html).toBe('<p>changed</p>');
    expect(store.get('oversized')).toBeUndefined();
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('event: report-update');
    expect(written[0]).toContain('"slotId":"briefing"');
    expect(written[0]).toContain('"slotId":"decisions"');
    expect(written[0]).toContain('"slotId":"pipeline"');
    warn.mockRestore();
  });

  it('returns no persisted IDs and emits no SSE when every slot is rejected', () => {
    const store = createReportStore();
    const written: string[] = [];
    const clients = new Set<{ write: (data: string) => void }>([
      { write: (data) => written.push(data) },
    ]);
    const publish = createReportPublisher(
      store,
      clients as unknown as Set<import('node:http').ServerResponse>
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(publish({ pipeline: 'x'.repeat(70_000) })).toEqual({
      acceptedSlotIds: [],
      changedSlotIds: [],
    });
    expect(store.getAll()).toEqual({});
    expect(written).toEqual([]);
    warn.mockRestore();
  });

  it('preserves an existing slot priority on republish', () => {
    const store = createReportStore();
    store.update('briefing', '<p>old</p>', 7);
    const publish = createReportPublisher(
      store,
      new Set() as unknown as Set<import('node:http').ServerResponse>
    );

    publish({ briefing: '<p>new</p>' });

    expect(store.get('briefing')?.html).toBe('<p>new</p>');
    expect(store.get('briefing')?.priority).toBe(7);
  });
});

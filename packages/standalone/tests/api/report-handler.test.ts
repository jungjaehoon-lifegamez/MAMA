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

    publish({ briefing: '<p>b</p>', action_required: '<p>a</p>' });

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

    publish({ ok: '<p>x</p>', huge: 'x'.repeat(70_000) });

    expect(store.get('ok')).toBeDefined();
    expect(store.get('huge')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { request, type Server, type ServerResponse } from 'node:http';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { renderPipelineSlot } from '../../src/operator/board-pipeline-render.js';
import {
  createReportStore,
  createReportRouter,
  createReportPublisher,
} from '../../src/api/report-handler.js';

// Use real HTTP even when another single-fork suite stubs global fetch.
function fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; json(): Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method, headers: init.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(body) })
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

let db: SQLiteDatabase;
let ledger: TaskLedger;
let now: number;
const servers: Server[] = [];
beforeEach(() => {
  now = Date.parse('2026-09-07T04:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  db = new Database(':memory:');
  ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  db.close();
  vi.restoreAllMocks();
});
function projectedStore() {
  const store = createReportStore();
  const refresh = vi.fn();
  store.setTaskProjectionProvider(
    () =>
      db.transaction(() => {
        const page = ledger.listPage({ includeTerminal: false, order: 'deadline_priority' });
        return {
          basisRevision: ledger.readGeneration(),
          html: renderPipelineSlot(page.tasks, now, page.total),
        };
      })(),
    refresh
  );
  return { store, refresh };
}
function createTask() {
  return ledger.create({
    title: 'verify the source restoration',
    completion_criteria: 'new source message observed in the local database',
  });
}

describe('Story TG-04/TG-06: current board facts without a Board model turn', () => {
  it('TG-06 rejects deletion of the managed pipeline without a deletion event', () => {
    createTask();
    const { store, refresh } = projectedStore();
    const before = store.get('pipeline');
    const notifications = refresh.mock.calls.length;
    expect(() => store.delete('pipeline')).toThrow(/managed task projection/);
    expect(store.get('pipeline')).toEqual(before);
    expect(refresh.mock.calls.length).toBe(notifications);
  });

  it('publishes the same authored basis and timestamp through PUT, SSE and GET', async () => {
    createTask();
    const { store } = projectedStore();
    const write = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(
      '/report',
      createReportRouter(store, new Set([{ write } as unknown as ServerResponse]))
    );
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    const base = `http://127.0.0.1:${address.port}/report`;
    const response = await fetch(`${base}/slots/briefing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>analysis</p>', basisRevision: ledger.readGeneration() }),
    });
    expect(response.status).toBe(200);
    const payload = String(write.mock.calls.at(-1)?.[0]).split('data: ')[1].trim();
    const event = JSON.parse(payload) as { slots: unknown[] };
    const snapshot = (await (await fetch(base)).json()) as { slots: unknown[] };
    expect(event.slots).toEqual(snapshot.slots);
    expect(store.get('briefing')).toMatchObject({ freshness: 'current', updatedAt: now });
  });

  it('serves a task mutation through the actual report API immediately', async () => {
    const task = createTask();
    const { store } = projectedStore();
    const app = express();
    app.use('/report', createReportRouter(store, new Set()));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    ledger.update(task.id, {
      status: 'blocked',
      expected_revision: task.revision,
      latest_event: 'waiting for source verification',
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/report`);
    const body = (await response.json()) as {
      slots: Array<{ slotId: string; html: string; basisRevision: string; freshness: string }>;
    };
    expect(response.status).toBe(200);
    const pipeline = body.slots.find((s) => s.slotId === 'pipeline');
    expect(pipeline?.html).toContain('blocked');
    expect(pipeline?.basisRevision).toBe(ledger.readGeneration());
    expect(pipeline?.freshness).toBe('current');
  });

  it('marks existing analysis stale without changing its authoring time', () => {
    const task = createTask();
    const { store } = projectedStore();
    const basis = ledger.readGeneration();
    store.update('briefing', '<p>reviewed analysis</p>', 0, { basisRevision: basis });
    const authoredAt = store.get('briefing')!.updatedAt;
    now += 1000;
    ledger.update(task.id, {
      status: 'blocked',
      expected_revision: task.revision,
      latest_event: 'new evidence',
    });
    expect(store.get('briefing')).toMatchObject({
      html: '<p>reviewed analysis</p>',
      basisRevision: basis,
      freshness: 'stale',
      updatedAt: authoredAt,
    });
    expect(store.get('pipeline')?.basisRevision).toBe(ledger.readGeneration());
  });

  it('does not treat analysis published without a data basis as current', () => {
    createTask();
    const { store } = projectedStore();
    const publish = createReportPublisher(store, new Set());
    publish({ briefing: '<p>unversioned analysis</p>' });
    expect(store.get('briefing')?.freshness).toBe('unknown');
    publish(
      { briefing: '<p>unversioned analysis</p>' },
      { basisRevision: ledger.readGeneration() }
    );
    expect(store.get('briefing')?.freshness).toBe('current');
  });

  it('does not notify or redate unchanged reads', () => {
    createTask();
    const { store, refresh } = projectedStore();
    const previous = store.get('pipeline');
    refresh.mockClear();
    now += 1000;
    store.getAllSorted();
    store.getAll();
    expect(store.get('pipeline')).toEqual(previous);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not project a rolled-back task change', () => {
    const task = createTask();
    const { store } = projectedStore();
    const before = store.get('pipeline');
    db.exec(`CREATE TRIGGER reject_task_change AFTER UPDATE ON operator_tasks
      BEGIN SELECT RAISE(ABORT, 'rollback'); END`);
    expect(() =>
      ledger.update(task.id, {
        status: 'blocked',
        expected_revision: task.revision,
        latest_event: 'temporary',
      })
    ).toThrow('rollback');
    expect(store.get('pipeline')).toEqual(before);
  });

  it('does not let authored HTML overwrite the managed task projection', () => {
    createTask();
    const { store } = projectedStore();
    expect(() => store.update('pipeline', '<p>all complete</p>', 0)).toThrow(/projection|managed/i);
  });
});

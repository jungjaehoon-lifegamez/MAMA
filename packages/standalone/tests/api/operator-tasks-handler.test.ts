import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOperatorTaskRoutes } from '../../src/api/operator-tasks-handler.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

interface InProcessResponse {
  status: number;
  body: unknown;
}

class InProcessRequest implements PromiseLike<InProcessResponse> {
  private body: unknown;
  private headers: Record<string, string> = {};

  constructor(
    private app: express.Express,
    private method: 'get' | 'patch',
    private url: string
  ) {}

  send(body: unknown): this {
    this.body = body;
    return this;
  }

  set(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  then<TResult1 = InProcessResponse, TResult2 = never>(
    onfulfilled?: ((value: InProcessResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<InProcessResponse> {
    const parsed = new URL(this.url, 'http://localhost');
    const routePath = this.method === 'patch' ? '/api/operator/tasks/:id' : '/api/operator/tasks';
    const router = (this.app as express.Express & { router: { stack: RouteLayer[] } }).router;
    const route = router.stack.find(
      (layer) => layer.route?.path === routePath && layer.route.methods[this.method]
    )?.route;
    if (!route) throw new Error(`route not registered: ${this.method} ${routePath}`);

    const query = Object.fromEntries(parsed.searchParams.entries());
    const params =
      this.method === 'patch'
        ? { id: decodeURIComponent(parsed.pathname.slice('/api/operator/tasks/'.length)) }
        : {};
    const req = {
      method: this.method.toUpperCase(),
      url: `${parsed.pathname}${parsed.search}`,
      originalUrl: `${parsed.pathname}${parsed.search}`,
      path: parsed.pathname,
      headers: this.headers,
      socket: { remoteAddress: '127.0.0.1' },
      query,
      params,
      body: this.body,
    };

    return new Promise((resolve, reject) => {
      let status = 200;
      let settled = false;
      const finish = (body: unknown) => {
        if (!settled) {
          settled = true;
          resolve({ status, body });
        }
      };
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(body: unknown) {
          finish(body);
          return this;
        },
        end() {
          finish(undefined);
          return this;
        },
      };
      const runLayer = (index: number, error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        const layer = route.stack[index];
        if (!layer) {
          finish(undefined);
          return;
        }
        try {
          const result = layer.handle(req, res, (nextError?: unknown) =>
            runLayer(index + 1, nextError)
          );
          if (result instanceof Promise) result.catch(reject);
        } catch (caught) {
          reject(caught);
        }
      };
      runLayer(0);
    });
  }
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown;
    }>;
  };
}

function request(app: express.Express) {
  return {
    get: (url: string) => new InProcessRequest(app, 'get', url),
    patch: (url: string) => new InProcessRequest(app, 'patch', url),
  };
}

describe('Operator tasks API', () => {
  let app: express.Express;
  let db: SQLiteDatabase;
  let dir: string;
  let ledger: TaskLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-tasks-api-'));
    db = new Database(join(dir, 'operator.db'));
    ledger = new TaskLedger(db);
    app = express();
    app.use(express.json());
    registerOperatorTaskRoutes(app, { getTaskLedger: () => ledger });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns at most 50 tasks in deadline and priority order by default', async () => {
    ledger.create({ title: 'no deadline', priority: 'high' });
    ledger.create({ title: 'later', deadline: '2026-08-01', priority: 'low' });
    ledger.create({ title: 'sooner normal', deadline: '2026-07-15', priority: 'normal' });
    ledger.create({ title: 'sooner high', deadline: '2026-07-15', priority: 'high' });
    for (let index = 0; index < 48; index += 1) {
      ledger.create({ title: `filler ${index}` });
    }

    const response = await request(app).get('/api/operator/tasks');

    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(50);
    expect(response.body.tasks.slice(0, 3).map((task: { title: string }) => task.title)).toEqual([
      'sooner high',
      'sooner normal',
      'later',
    ]);
  });

  it('combines status, source_channel, and limit filters', async () => {
    ledger.create({
      title: 'matching one',
      status: 'review',
      source_channel: 'synthetic:channel-a',
      deadline: '2026-07-15',
    });
    ledger.create({
      title: 'matching two',
      status: 'review',
      source_channel: 'synthetic:channel-a',
      deadline: '2026-07-16',
    });
    ledger.create({
      title: 'wrong status',
      status: 'pending',
      source_channel: 'synthetic:channel-a',
    });
    ledger.create({
      title: 'wrong channel',
      status: 'review',
      source_channel: 'synthetic:channel-b',
    });

    const response = await request(app).get(
      '/api/operator/tasks?status=review&source_channel=synthetic%3Achannel-a&limit=1'
    );

    expect(response.status).toBe(200);
    expect(response.body.tasks.map((task: { title: string }) => task.title)).toEqual([
      'matching one',
    ]);
  });

  it('serializes only the documented wire fields', async () => {
    const created = ledger.create({
      title: 'Review release candidate',
      status: 'review',
      priority: 'high',
      assignee: 'worker-a',
      deadline: '2026-07-15',
      source_channel: 'synthetic:channel-a',
      source_event_id: 'event-1',
      latest_event: 'Candidate submitted',
    });

    const response = await request(app).get('/api/operator/tasks');

    expect(response.status).toBe(200);
    expect(response.body.tasks[0]).toEqual({
      id: created.id,
      title: 'Review release candidate',
      status: 'review',
      priority: 'high',
      assignee: 'worker-a',
      due_date: '2026-07-15',
      source_channel: 'synthetic:channel-a',
      latest_event: 'Candidate submitted',
      auto_created: true,
      confirmed: false,
      created_at: created.createdAt,
      updated_at: created.updatedAt,
    });
    expect(response.body.tasks[0]).not.toHaveProperty('source_event_id');
    expect(response.body.tasks[0]).not.toHaveProperty('deadline');
  });

  it.each([
    ['/api/operator/tasks?status=unknown', 'status'],
    ['/api/operator/tasks?limit=0', 'limit'],
    ['/api/operator/tasks?limit=201', 'limit'],
    ['/api/operator/tasks?limit=1.5', 'limit'],
    ['/api/operator/tasks?limit=text', 'limit'],
  ])('rejects invalid query %s', async (url, expectedField) => {
    const response = await request(app).get(url);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(expectedField);
  });

  it('updates every allowed field and persists the external due_date mapping', async () => {
    const created = ledger.create({ title: 'Owner task' });

    const response = await request(app).patch(`/api/operator/tasks/${created.id}`).send({
      status: 'in_progress',
      priority: 'high',
      assignee: 'worker-b',
      due_date: '2026-07-20',
      confirmed: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.task).toMatchObject({
      id: created.id,
      status: 'in_progress',
      priority: 'high',
      assignee: 'worker-b',
      due_date: '2026-07-20',
      confirmed: true,
    });
    expect(ledger.getById(created.id)).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      assignee: 'worker-b',
      deadlineIso: '2026-07-20',
      confirmed: true,
    });
  });

  it('clears due_date and assignee with null', async () => {
    const created = ledger.create({
      title: 'Clear fields',
      assignee: 'worker-a',
      deadline: '2026-07-20',
    });

    const response = await request(app)
      .patch(`/api/operator/tasks/${created.id}`)
      .send({ assignee: null, due_date: null });

    expect(response.status).toBe(200);
    expect(response.body.task.assignee).toBeNull();
    expect(response.body.task.due_date).toBeNull();
    expect(ledger.getById(created.id)?.assignee).toBeNull();
    expect(ledger.getById(created.id)?.deadlineIso).toBeNull();
  });

  it('approves with confirmed only and preserves status and priority', async () => {
    const created = ledger.create({ title: 'Approve task', status: 'review', priority: 'low' });

    const response = await request(app)
      .patch(`/api/operator/tasks/${created.id}`)
      .send({ confirmed: true });

    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({
      confirmed: true,
      status: 'review',
      priority: 'low',
    });
  });

  it('rejects malformed IDs and returns 404 for an absent task', async () => {
    for (const id of ['0', '-1', '1.5', 'abc', '01x']) {
      const response = await request(app)
        .patch(`/api/operator/tasks/${id}`)
        .send({ confirmed: true });
      expect(response.status).toBe(400);
    }
    const missing = await request(app).patch('/api/operator/tasks/9999').send({ confirmed: true });
    expect(missing.status).toBe(404);
  });

  it.each([
    [undefined, 'body'],
    [{}, 'body'],
    [{ title: 'not allowed' }, 'unknown'],
    [{ status: 'unknown' }, 'status'],
    [{ priority: 'urgent' }, 'priority'],
    [{ assignee: 123 }, 'assignee'],
    [{ due_date: '2026-02-30' }, 'due_date'],
    [{ due_date: 123 }, 'due_date'],
    [{ confirmed: 'yes' }, 'confirmed'],
    [[], 'body'],
    ['not an object', 'body'],
  ])('rejects invalid patch body %#', async (body, expectedField) => {
    const created = ledger.create({ title: 'Validation target' });
    const response = await request(app).patch(`/api/operator/tasks/${created.id}`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(expectedField);
  });

  it('returns 503 when the shared ledger is unavailable', async () => {
    const unavailableApp = express();
    unavailableApp.use(express.json());
    registerOperatorTaskRoutes(unavailableApp, { getTaskLedger: () => null });

    const getResponse = await request(unavailableApp).get('/api/operator/tasks');
    const patchResponse = await request(unavailableApp)
      .patch('/api/operator/tasks/1')
      .send({ confirmed: true });

    expect(getResponse.status).toBe(503);
    expect(getResponse.body).toEqual({ error: 'task ledger unavailable' });
    expect(patchResponse.status).toBe(503);
  });

  it('requires authentication for tunnel-style requests', async () => {
    const response = await request(app).get('/api/operator/tasks').set('cf-ray', 'synthetic-ray');

    expect(response.status).toBe(401);
  });
});

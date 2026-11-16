import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { limitLines, readUsage, usageLines } from '../../src/runtime/usage-report.js';
import { statusText } from '../../src/gateways/telegram-commands.js';
import {
  renderConnectorsSnapshot,
  renderRuntimeSnapshot,
  type RuntimeStatusSnapshot,
} from '../../public/viewer/src/modules/system.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function database() {
  const home = mkdtempSync(join(tmpdir(), 'mama-usage-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  return db.adapter;
}

const ZONE = 'Asia/Tokyo';
// 2026-03-10 12:00 in Tokyo.
const NOW = Date.parse('2026-03-10T03:00:00Z');
const HOUR = 3_600_000;

describe('usage report', () => {
  it("counts each person's runs, tokens, sessions and actions, today and over seven days", async () => {
    const adapter = await database();
    adapter
      .prepare(
        `INSERT INTO principals (principal_id, kind, display_name, created_at, updated_at)
         VALUES ('principal_fixture', 'owner', 'Fixture Owner', 1, 1)`
      )
      .run();
    const run = adapter.prepare(
      `INSERT INTO model_runs (model_run_id, agent_id, instance_id, status, created_at,
         input_tokens, output_tokens, cache_read_input_tokens, erased_at, model_provider,
         cache_creation_input_tokens)
       VALUES (?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?)`
    );
    run.run('r1', 'owner-agent', 'operator:record', NOW - HOUR, 1000, 10, 800, null, 'codex', 0);
    run.run('r2', 'owner-agent', 'schedule', NOW - 3 * 24 * HOUR, 2000, 20, 0, null, 'codex', 0);
    // A Claude run's input_tokens leave out cache reads and writes: input is 500 + 100 + 50.
    run.run(
      'r3',
      'member-agent:principal_fixture',
      'dm',
      NOW - 2 * HOUR,
      500,
      5,
      100,
      null,
      'claude',
      50
    );
    // Before the window, and erased: neither is counted.
    run.run('r4', 'owner-agent', 'schedule', NOW - 9 * 24 * HOUR, 9000, 90, 0, null, 'codex', 0);
    run.run('r5', 'member-agent:principal_fixture', 'dm', NOW - HOUR, 7000, 70, 0, 99, 'claude', 0);
    const trace = adapter.prepare(
      `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary,
         execution_status, created_at, erased_at)
       VALUES (?, ?, ?, 'fixture input', 'completed', ?, ?)`
    );
    trace.run('t1', 'r1', 'work.update', NOW - HOUR, null);
    trace.run('t2', 'r1', 'work.update', NOW - HOUR, null);
    trace.run('t3', 'r3', 'memory.search', NOW - HOUR, null);
    trace.run('t4', 'r3', 'memory.search', NOW - HOUR, 99);

    const report = readUsage(adapter, NOW, ZONE);
    expect(report.dayStart).toBe(Date.parse('2026-03-09T15:00:00Z'));
    expect(report.people.map((person) => person.name)).toEqual(['common session', 'Fixture Owner']);
    const [common, owner] = report.people;
    expect(common!.today).toEqual({
      runs: 1,
      inputTokens: 1000,
      outputTokens: 10,
      cachedTokens: 800,
    });
    expect(common!.week).toEqual({
      runs: 2,
      inputTokens: 3000,
      outputTokens: 30,
      cachedTokens: 800,
    });
    expect(common!.sessions.map((session) => session.session)).toEqual([
      'schedule',
      'operator:record',
    ]);
    expect(common!.actions).toEqual([{ tool: 'work.update', count: 2 }]);
    expect(owner!.week.runs).toBe(1);
    expect(owner!.actions).toEqual([{ tool: 'memory.search', count: 1 }]);
    // Nothing a run or trace said reaches the report.
    expect(JSON.stringify(report)).not.toContain('fixture input');

    const own = { ...report, people: report.people.filter((person) => person.principalId) };
    expect(own.people.map((person) => person.name)).toEqual(['Fixture Owner']);
    expect(usageLines(own)).toEqual([
      'usage Fixture Owner: today 1 runs, 650 in (100 cached), 5 out; 7 days 1 runs, 650 in (100 cached), 5 out',
    ]);
    expect(usageLines({ dayStart: 0, weekStart: 0, people: [] })).toEqual([
      'usage: no runs in the last 7 days',
    ]);
  });

  it('starts the seven days at local midnight six days back, across a daylight-saving change', async () => {
    const adapter = await database();
    // 2026-03-10 12:00 in New York; clocks went forward on 03-08.
    const report = readUsage(adapter, Date.parse('2026-03-10T16:00:00Z'), 'America/New_York');
    expect(report.dayStart).toBe(Date.parse('2026-03-10T04:00:00Z'));
    expect(report.weekStart).toBe(Date.parse('2026-03-04T05:00:00Z'));
  });

  it('names each backend window, and says when none was reported', () => {
    const time = (ms: number) => `t${ms}`;
    expect(
      limitLines(
        [
          {
            backend: 'codex',
            observedAt: 2,
            windows: [{ window: '7d', usedPercent: 13, resetsAt: 9 }],
          },
        ],
        time
      )
    ).toEqual(['limit codex: 7d 13% used, resets t9 (reported t2)']);
    expect(limitLines([], time)).toEqual([
      'limit: not reported yet (each CLI reports it during a turn)',
    ]);
  });

  it('/status carries the usage lines it is given', () => {
    const base = {
      version: '0.0.0',
      since: 'fixture',
      conversationRunning: false,
      inputsWaiting: 0,
    };
    expect(statusText({ ...base, usage: ['usage line'] })).toContain('usage line');
    expect(
      statusText({ ...base, usage: ['usage line'], owner: { turnsRunning: 0, sources: [] } })
    ).toContain('usage line');
    expect(statusText(base).some((line) => line.startsWith('usage'))).toBe(false);
  });
});

describe('viewer system views', () => {
  const snapshot: RuntimeStatusSnapshot = {
    running: true,
    version: '0.0.0',
    backend: 'codex',
    model: 'fixture-model',
    startedAt: NOW,
    stage: 'running',
    service: 'launchd (loaded)',
    lastError: null,
    connectors: [
      { name: 'fixture-ok', healthy: true, lastPoll: '2026-03-10T03:00:00Z', error: null },
      {
        name: 'fixture-failing',
        healthy: false,
        lastPoll: null,
        error: 'Room 1: <fixture error>',
      },
    ],
    usage: {
      dayStart: NOW,
      weekStart: NOW,
      people: [
        {
          agentId: 'owner-agent',
          principalId: null,
          name: 'common session',
          today: { runs: 1, inputTokens: 1500, outputTokens: 2, cachedTokens: 0 },
          week: { runs: 1, inputTokens: 1500, outputTokens: 2, cachedTokens: 0 },
          sessions: [
            { session: 'schedule', runs: 1, inputTokens: 1500, outputTokens: 2, cachedTokens: 0 },
          ],
          actions: [{ tool: 'work.update', count: 3 }],
        },
      ],
    },
    limits: [
      {
        backend: 'codex',
        observedAt: NOW,
        windows: [{ window: '7d', usedPercent: 13, resetsAt: null }],
      },
    ],
  };

  it('shows the service, the boot, the limit and each person with sessions and actions', () => {
    const html = renderRuntimeSnapshot(snapshot);
    for (const text of [
      'launchd (loaded)',
      'none since boot',
      'codex 7d',
      '13% used',
      'common session',
      '1.5k in',
      'schedule',
      'work.update 3',
    ])
      expect(html).toContain(text);
    expect(renderRuntimeSnapshot({ ...snapshot, limits: [], usage: null })).toContain(
      'Not reported yet'
    );
  });

  it("shows each connector's last poll and error, escaped", () => {
    const html = renderConnectorsSnapshot(snapshot);
    expect(html).toContain('fixture-failing');
    expect(html).toContain('failing · last poll not yet');
    expect(html).toContain('Room 1: &lt;fixture error&gt;');
    expect(html).not.toContain('<fixture error>');
  });
});

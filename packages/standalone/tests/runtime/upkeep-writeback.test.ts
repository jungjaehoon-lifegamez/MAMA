import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  WRITEBACK_ORDER_CHANNEL,
  writebackUpkeepKind,
} from '../../src/runtime/upkeep-writeback.js';
import {
  UPKEEP_MAX_ATTEMPTS,
  createUpkeepOrders,
  parseUpkeepOrder,
  type UpkeepEvent,
  type UpkeepKind,
} from '../../src/runtime/upkeep-orders.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Adapter = Awaited<ReturnType<typeof openCoreDatabase>>['adapter'];

async function database(): Promise<Adapter> {
  const home = mkdtempSync(join(tmpdir(), 'mama-writeback-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  db.adapter.exec('PRAGMA foreign_keys = OFF');
  return db.adapter;
}

const OWNER = 'owner';
const COMMON: MemoryScopeRef[] = [
  { kind: 'user', id: OWNER },
  { kind: 'channel', id: 'slack' },
];
const NOW = 2_000_000_000_000;
const blob32 = () => Buffer.alloc(32);

/** An observation with its scope set (scope_json) and, for chat, its channel in the index. */
function observation(
  adapter: Adapter,
  ref: string,
  options: { scopes: MemoryScopeRef[]; source?: string; channel?: string }
): void {
  const source = options.source ?? 'slack';
  adapter
    .prepare(
      `INSERT OR IGNORE INTO observation_versions
         (observation_id, source, source_id, body, observed_at, content_hash, metadata_json, scope_json,
          channel, memory_scope_kind, memory_scope_id)
       VALUES (?, ?, ?, 'x', 1, 'hash', '{}', ?, ?, ?, ?)`
    )
    .run(
      ref,
      source,
      ref,
      JSON.stringify({
        scopes: options.scopes.map((scope) => ({ kind: scope.kind, externalId: scope.id })),
      }),
      options.channel ?? null,
      options.scopes[0]?.kind ?? null,
      options.scopes[0]?.id ?? null
    );
  if (options.channel !== undefined)
    adapter
      .prepare(
        `INSERT OR IGNORE INTO connector_event_index
           (source_connector, source_type, source_id, channel, content, source_timestamp_ms,
            content_hash, indexed_at, updated_at, current_observation_id)
         VALUES (?, 'message', ?, ?, 'x', 1, ?, '1', '1', ?)`
      )
      .run(source, ref, options.channel, blob32(), ref);
}

/** A committed owner_message turn: a model run plus the mailbox row the scan joins to. */
function questionTurn(
  adapter: Adapter,
  options: {
    runId: string;
    principalId: string;
    askedAt?: number;
    opened?: string[];
    hits?: string[];
    childRunId?: string;
  }
): void {
  const msgId = `msg:${options.runId}`;
  adapter
    .prepare(
      `INSERT INTO model_runs (model_run_id, status, created_at, input_refs_json)
       VALUES (?, 'committed', ?, ?)`
    )
    .run(
      options.runId,
      options.askedAt ?? NOW,
      JSON.stringify({ sourceMessageRef: msgId, principalId: options.principalId })
    );
  adapter
    .prepare(
      `INSERT INTO mailbox_inputs (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, occurred_at, created_at, status)
       VALUES (?, 'owner_message', ?, 'chat:dm', '[]', '{}', ?, ?, 'acked')`
    )
    .run(msgId, options.principalId, options.askedAt ?? NOW, options.askedAt ?? NOW);
  const trace = (runId: string, tool: 'source.read' | 'source.search', refs: string[]) =>
    adapter
      .prepare(
        `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, execution_status, evidence_json, created_at)
         VALUES (?, ?, ?, 'completed', ?, ?)`
      )
      .run(
        `tr:${runId}:${tool}`,
        runId,
        tool,
        JSON.stringify({ observationRefs: refs }),
        options.askedAt ?? NOW
      );
  const reader = options.childRunId ?? options.runId;
  if (options.childRunId !== undefined)
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, parent_model_run_id) VALUES (?, 'committed', ?, ?)`
      )
      .run(options.childRunId, options.askedAt ?? NOW, options.runId);
  if (options.opened && options.opened.length > 0) trace(reader, 'source.read', options.opened);
  if (options.hits && options.hits.length > 0) trace(reader, 'source.search', options.hits);
}

function ownerRole(adapter: Adapter, principalId: string): void {
  adapter
    .prepare(
      `INSERT OR IGNORE INTO principal_roles (principal_id, role, created_at) VALUES (?, 'owner', 1)`
    )
    .run(principalId);
}

function privateDm(adapter: Adapter, principalId: string, dmId: string): void {
  adapter
    .prepare(
      `INSERT OR IGNORE INTO external_identities (connector, namespace, external_id, principal_id, created_at)
       VALUES ('telegram', 'private', ?, ?, 1)`
    )
    .run(dmId, principalId);
}

/** A derived_from edge, as a work.revise or memory.save writes it, in a given run. */
function cite(adapter: Adapter, runId: string, ref: string): void {
  adapter
    .prepare(
      `INSERT INTO twin_edges (edge_id, edge_type, subject_kind, subject_id, object_kind, object_id, source, model_run_id, content_hash, created_at)
       VALUES (?, 'derived_from', 'memory', ?, 'observation', ?, 'agent', ?, ?, ?)`
    )
    .run(`edge:${runId}:${ref}`, `rec:${runId}:${ref}`, ref, runId, blob32(), NOW);
}

function kind(): UpkeepKind {
  return writebackUpkeepKind({
    commonScopes: () => COMMON,
    ownerPrincipalId: OWNER,
    timeZone: () => 'UTC',
  });
}

function harness(adapter: Adapter, at = NOW, sleep: () => Promise<void> = async () => {}) {
  const events: UpkeepEvent[] = [];
  const accepted: Array<Omit<Stimulus, 'principalId'>> = [];
  let clock = at;
  const orders = createUpkeepOrders({
    adapter,
    accept: (stimulus) => {
      accepted.push(stimulus);
      adapter
        .prepare(
          `INSERT INTO mailbox_inputs (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, occurred_at, created_at, status)
           VALUES (?, 'scheduled', 'owner', ?, '[]', ?, ?, ?, 'claimed')`
        )
        .run(stimulus.id, stimulus.channelKey, JSON.stringify(stimulus.payload), clock, clock);
      return { inputId: stimulus.id, state: 'accepted' };
    },
    kinds: [kind()],
    processStartedAt: 0,
    onEvent: (event) => events.push(event),
    sleep,
    now: () => clock,
  });
  const finish = (index: number): MailboxRow => {
    const stimulus = accepted[index]!;
    adapter
      .prepare(`UPDATE mailbox_inputs SET status = 'acked' WHERE stimulus_id = ?`)
      .run(stimulus.id);
    return {
      id: index + 1,
      stimulusId: stimulus.id,
      principalId: 'owner',
      kind: 'scheduled',
      channelKey: stimulus.channelKey,
      occurredAt: clock,
      refs: [],
      preview: [],
      status: 'claimed',
      attempts: 1,
      createdAt: clock,
      coalesceKey: null,
      payload: stimulus.payload as never,
    };
  };
  const settled = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  /** The runs an order produced, so a test can write the order's revisions. */
  const orderRun = (index: number, runId: string) =>
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, input_refs_json) VALUES (?, 'committed', ?, ?)`
      )
      .run(runId, clock, JSON.stringify({ sourceMessageRef: accepted[index]!.id }));
  return {
    orders,
    events,
    accepted,
    finish,
    settled,
    orderRun,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('write-back scan', () => {
  it('orders a common-session question turn, carrying only common-scope sources, opened first', async () => {
    const adapter = await database();
    observation(adapter, 'obs-common', { scopes: [{ kind: 'user', id: OWNER }] });
    observation(adapter, 'obs-slack', { scopes: [{ kind: 'channel', id: 'slack' }] });
    observation(adapter, 'obs-hit', { scopes: [{ kind: 'user', id: OWNER }] });
    observation(adapter, 'obs-personal', { scopes: [{ kind: 'user', id: 'member-x' }] });
    questionTurn(adapter, {
      runId: 'q1',
      principalId: OWNER,
      opened: ['obs-common', 'obs-slack', 'obs-personal'],
      hits: ['obs-hit', 'obs-personal'],
    });
    const h = harness(adapter);
    h.orders.tick('writeback');
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]!.channelKey).toBe(WRITEBACK_ORDER_CHANNEL);
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects as Array<{
      key: string;
      refs: string[];
      opened: string[];
    }>;
    expect(subjects.map((s) => s.key)).toEqual(['q1']);
    // The personal-scoped observation never crosses into the common order.
    expect(subjects[0]!.refs).toEqual(['obs-common', 'obs-slack', 'obs-hit']);
    expect(subjects[0]!.opened.sort()).toEqual(['obs-common', 'obs-slack']);
    const text = h.orders.render(h.finish(0), new Date(NOW));
    expect(text).toContain('[upkeep_writeback] 1 answered question turn');
    expect(text).toContain('opened obs-common, obs-slack');
    expect(text).not.toContain('obs-personal');
  });

  it('takes an owner-role member turn but never a plain member turn', async () => {
    const adapter = await database();
    ownerRole(adapter, 'member-owner');
    observation(adapter, 'obs-a', { scopes: [{ kind: 'user', id: OWNER }] });
    observation(adapter, 'obs-b', { scopes: [{ kind: 'user', id: OWNER }] });
    questionTurn(adapter, {
      runId: 'q-owner-role',
      principalId: 'member-owner',
      opened: ['obs-a'],
    });
    questionTurn(adapter, { runId: 'q-member', principalId: 'member-plain', opened: ['obs-b'] });
    const h = harness(adapter);
    h.orders.tick('writeback');
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects.map((s) => s.key);
    expect(subjects).toEqual(['q-owner-role']);
  });

  it('drops a personal-scope observation and never orders a turn whose common reads are all personal', async () => {
    const adapter = await database();
    observation(adapter, 'obs-personal-only', { scopes: [{ kind: 'user', id: 'member-x' }] });
    // A mixed binding (common + personal) is not common: it must not cross either.
    observation(adapter, 'obs-mixed', {
      scopes: [
        { kind: 'user', id: OWNER },
        { kind: 'user', id: 'member-x' },
      ],
    });
    questionTurn(adapter, {
      runId: 'q-personal',
      principalId: OWNER,
      opened: ['obs-personal-only', 'obs-mixed'],
    });
    const h = harness(adapter);
    h.orders.tick('writeback');
    expect(h.accepted).toHaveLength(0);
  });

  it("drops another person's DM even when its scope looks common (the channel guard)", async () => {
    const adapter = await database();
    privateDm(adapter, 'member-x', 'dm-x');
    // Worst case: a chat observation mis-scoped to the common user but living in a member DM.
    observation(adapter, 'obs-dm', {
      scopes: [{ kind: 'user', id: OWNER }],
      source: 'chat',
      channel: 'telegram:dm-x',
    });
    observation(adapter, 'obs-common-chat', {
      scopes: [{ kind: 'user', id: OWNER }],
      source: 'chat',
      channel: 'telegram:common',
    });
    questionTurn(adapter, {
      runId: 'q-dm',
      principalId: OWNER,
      opened: ['obs-dm', 'obs-common-chat'],
    });
    const h = harness(adapter);
    h.orders.tick('writeback');
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects as Array<{
      key: string;
      refs: string[];
    }>;
    expect(subjects[0]!.refs).toEqual(['obs-common-chat']);
  });

  it('does not order a turn whose own run already cites what it read', async () => {
    const adapter = await database();
    observation(adapter, 'obs-cited', { scopes: [{ kind: 'user', id: OWNER }] });
    observation(adapter, 'obs-open', { scopes: [{ kind: 'user', id: OWNER }] });
    questionTurn(adapter, { runId: 'q-cited', principalId: OWNER, opened: ['obs-cited'] });
    cite(adapter, 'q-cited', 'obs-cited');
    questionTurn(adapter, { runId: 'q-open', principalId: OWNER, opened: ['obs-open'] });
    const h = harness(adapter);
    h.orders.tick('writeback');
    expect(parseUpkeepOrder(h.accepted[0]!.payload as never).subjects.map((s) => s.key)).toEqual([
      'q-open',
    ]);
  });

  it('orders a turn whose subagent did the reading (the live shape)', async () => {
    const adapter = await database();
    observation(adapter, 'obs-sub-read', { scopes: [{ kind: 'user', id: OWNER }] });
    // The owner turn spawned a subagent that opened the source; nothing cited it.
    questionTurn(adapter, {
      runId: 'q-sub-read',
      principalId: OWNER,
      childRunId: 'q-sub-read-sub',
      opened: ['obs-sub-read'],
    });
    const h = harness(adapter);
    h.orders.tick('writeback');
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects as Array<{
      key: string;
      refs: string[];
    }>;
    expect(subjects.map((s) => s.key)).toEqual(['q-sub-read']);
    expect(subjects[0]!.refs).toEqual(['obs-sub-read']);
  });

  it("counts a child run's citation when deciding a turn already recorded", async () => {
    const adapter = await database();
    observation(adapter, 'obs-child', { scopes: [{ kind: 'user', id: OWNER }] });
    questionTurn(adapter, {
      runId: 'q-child',
      principalId: OWNER,
      childRunId: 'q-child-sub',
      opened: ['obs-child'],
    });
    // A subagent of the turn opened and cited it; the turn recorded what it read.
    cite(adapter, 'q-child-sub', 'obs-child');
    const h = harness(adapter);
    h.orders.tick('writeback');
    expect(h.accepted).toHaveLength(0);
  });

  it('reports a stuck subject lost after three attempts and never orders it again', async () => {
    const adapter = await database();
    observation(adapter, 'obs-stuck', { scopes: [{ kind: 'user', id: OWNER }] });
    questionTurn(adapter, { runId: 'q-stuck', principalId: OWNER, opened: ['obs-stuck'] });
    const h = harness(adapter);
    for (let attempt = 1; attempt <= UPKEEP_MAX_ATTEMPTS; attempt += 1) {
      h.orders.tick('writeback');
      expect(h.accepted).toHaveLength(attempt);
      h.orders.onLost(h.finish(attempt - 1), 'the run failed');
      h.advance(1);
    }
    expect(h.events.at(-1)).toMatchObject({
      type: 'lost',
      subject: 'q-stuck',
      attempt: UPKEEP_MAX_ATTEMPTS,
    });
    h.orders.tick('writeback');
    expect(h.accepted).toHaveLength(UPKEEP_MAX_ATTEMPTS);
  });
});

describe('write-back check', () => {
  async function ordered(): Promise<{
    adapter: Adapter;
    h: ReturnType<typeof harness>;
    row: MailboxRow;
  }> {
    const adapter = await database();
    observation(adapter, 'obs-1', { scopes: [{ kind: 'user', id: OWNER }] });
    observation(adapter, 'obs-2', { scopes: [{ kind: 'user', id: OWNER }] });
    questionTurn(adapter, { runId: 'q', principalId: OWNER, opened: ['obs-1'], hits: ['obs-2'] });
    const h = harness(adapter);
    h.orders.tick('writeback');
    return { adapter, h, row: h.finish(0) };
  }

  it('passes when a memory.save in the order run cites one of the sources', async () => {
    const { adapter, h, row } = await ordered();
    h.orderRun(0, 'run-1');
    // memory.save writes a derived_from edge from its record to the observation.
    cite(adapter, 'run-1', 'obs-1');
    h.orders.onResult(row, 'run-1');
    await h.settled();
    expect(h.events).toContainEqual({ type: 'checked', kind: 'writeback', subject: 'q' });
  });

  it('passes when a work.no_update names the sources', async () => {
    const { adapter, h, row } = await ordered();
    h.orderRun(0, 'run-1');
    adapter
      .prepare(
        `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, execution_status, created_at)
         VALUES ('nu', 'run-1', 'work.no_update', ?, 'completed', ?)`
      )
      .run(JSON.stringify({ reason: 'already recorded', observationRefs: ['obs-2'] }), NOW);
    h.orders.onResult(row, 'run-1');
    await h.settled();
    expect(h.events).toContainEqual({ type: 'checked', kind: 'writeback', subject: 'q' });
  });

  it('retries when the order run neither cited the sources nor named them, then is lost', async () => {
    const { adapter, h, row } = await ordered();
    h.orderRun(0, 'run-1');
    // An unrelated edge in the run citing some other observation does not count.
    cite(adapter, 'run-1', 'obs-unrelated');
    h.orders.onResult(row, 'run-1');
    await h.settled();
    expect(h.events.find((e) => 'subject' in e && e.subject === 'q')?.type).toBe('waiting');
    // It stays a subject for the next tick.
    h.advance(1);
    h.orders.tick('writeback');
    expect(parseUpkeepOrder(h.accepted[1]!.payload as never).subjects.map((s) => s.key)).toEqual([
      'q',
    ]);
  });
});

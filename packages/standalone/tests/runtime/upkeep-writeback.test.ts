import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createCoreRawIndexSink } from '../../src/replay/import-manifest.js';
import { ownerMessageItem } from '../../src/storage/chat-sources.js';
import type { NormalizedItem } from '../../src/storage/source-archive.js';
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
/** Fixture names to the observation ids the real writer generated, for one test. */
const ids = new Map<string, string>();
afterEach(async () => {
  ids.clear();
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
const WIDE_READ = ['slack', 'trello', 'kagemusha'];
const NOW = 2_000_000_000_000;
const blob32 = () => Buffer.alloc(32);

const id = (name: string): string => ids.get(name) ?? name;
const names = (refs: readonly string[]): string[] =>
  refs.map((ref) => [...ids].find(([, value]) => value === ref)?.[0] ?? ref);

let projection = 0;
/**
 * Store items through the same sink connectors and chat use, as the raw store hands them over
 * (with its snapshot time and projection id); returns their observation ids.
 */
function store(adapter: Adapter, source: string, items: NormalizedItem[]): string[] {
  const saved = items.map((item) => ({
    ...item,
    observedAt: NOW,
    pendingProjectionId: (projection += 1),
  }));
  return createCoreRawIndexSink(adapter as unknown as DatabaseInstance)(source, saved).map(
    (result) => result.observationRef
  );
}

/** One source item, written by the real writer, registered under `name`. */
function observation(
  adapter: Adapter,
  name: string,
  options: {
    source?: string;
    channel?: string;
    scope?: { kind: string; id: string };
    sourceId?: string;
    content?: string;
  } = {}
): string {
  const source = options.source ?? 'slack';
  const [ref] = store(adapter, source, [
    {
      source,
      sourceId: options.sourceId ?? name,
      channel: options.channel ?? `${source}:room`,
      author: 'author',
      content: options.content ?? name,
      timestamp: new Date(NOW),
      type: 'message',
      ...(options.scope === undefined
        ? {}
        : { memoryScopeKind: options.scope.kind, memoryScopeId: options.scope.id }),
    },
  ]);
  ids.set(name, ref!);
  return ref!;
}

/** The common chat message, as ChatSources.saveOwnerMessage stores it. */
function ownerChat(adapter: Adapter, name: string, channelKey = 'common'): string {
  const [ref] = store(adapter, 'chat', [
    ownerMessageItem(
      { id: `telegram:${channelKey}:${name}`, channelKey, occurredAt: NOW, text: 'a question' },
      OWNER
    ),
  ]);
  ids.set(name, ref!);
  return ref!;
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
        JSON.stringify({ observationRefs: refs.map(id) }),
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
    .run(`edge:${runId}:${ref}`, `rec:${runId}:${ref}`, id(ref), runId, blob32(), NOW);
}

function kind(): UpkeepKind {
  return writebackUpkeepKind({
    wideReadConnectors: () => WIDE_READ,
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
  it('carries connector and chat observations as the real writer stores them (no $.scopes array)', async () => {
    const adapter = await database();
    observation(adapter, 'obs-slack');
    observation(adapter, 'obs-trello', { source: 'trello' });
    ownerChat(adapter, 'obs-chat');
    // The live shape: a flat scope bag, never a `scopes` array. A predicate over `$.scopes`
    // carries nothing from these rows, which is how the first U2 cut found no subject at all.
    expect(
      adapter
        .prepare(
          `SELECT count(*) AS n FROM observation_versions WHERE json_extract(scope_json, '$.scopes') IS NOT NULL`
        )
        .get()
    ).toEqual({ n: 0 });
    questionTurn(adapter, {
      runId: 'q1',
      principalId: OWNER,
      opened: ['obs-slack', 'obs-chat'],
      hits: ['obs-trello'],
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
    expect(names(subjects[0]!.refs).sort()).toEqual(['obs-chat', 'obs-slack', 'obs-trello']);
    expect(names(subjects[0]!.opened).sort()).toEqual(['obs-chat', 'obs-slack']);
    const text = h.orders.render(h.finish(0), new Date(NOW));
    expect(text).toContain('[upkeep_writeback] 1 answered question turn');
    expect(text).toContain(`found ${id('obs-trello')}`);
    // The question itself is never carried, only handles.
    expect(text).not.toContain('a question');
  });

  it('drops member-scoped, unread-connector and other-principal chat observations', async () => {
    const adapter = await database();
    observation(adapter, 'obs-common');
    observation(adapter, 'obs-member-slack', { scope: { kind: 'user', id: 'member-x' } });
    observation(adapter, 'obs-other-connector', { source: 'unlisted' });
    observation(adapter, 'obs-member-chat', {
      source: 'chat',
      channel: 'telegram:room',
      scope: { kind: 'user', id: 'member-x' },
    });
    observation(adapter, 'obs-unscoped-chat', { source: 'chat', channel: 'telegram:room' });
    const dropped = [
      'obs-member-slack',
      'obs-other-connector',
      'obs-member-chat',
      'obs-unscoped-chat',
    ];
    questionTurn(adapter, {
      runId: 'q-mixed',
      principalId: OWNER,
      opened: [...dropped, 'obs-common'],
    });
    questionTurn(adapter, { runId: 'q-dropped-only', principalId: OWNER, opened: dropped });
    const h = harness(adapter);
    h.orders.tick('writeback');
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects as Array<{
      key: string;
      refs: string[];
    }>;
    expect(subjects.map((s) => s.key)).toEqual(['q-mixed']);
    expect(names(subjects[0]!.refs)).toEqual(['obs-common']);
  });

  it("drops every private Telegram channel, the owner's own DM included, and every version of it", async () => {
    const adapter = await database();
    privateDm(adapter, OWNER, 'dm-owner');
    privateDm(adapter, 'member-x', 'dm-x');
    const common = { kind: 'user', id: OWNER };
    observation(adapter, 'dm-owner-v1', {
      source: 'chat',
      channel: 'telegram:dm-owner',
      scope: common,
      sourceId: 'dm-message',
      content: 'first',
    });
    // The same message edited: a newer version. The older one stays a valid handle a read may
    // have returned, so both must be dropped by the observation's own channel.
    observation(adapter, 'dm-owner-v2', {
      source: 'chat',
      channel: 'telegram:dm-owner',
      scope: common,
      sourceId: 'dm-message',
      content: 'second',
    });
    expect(id('dm-owner-v1')).not.toBe(id('dm-owner-v2'));
    observation(adapter, 'dm-member', {
      source: 'chat',
      channel: 'telegram:dm-x',
      scope: common,
    });
    ownerChat(adapter, 'common-chat');
    questionTurn(adapter, {
      runId: 'q-dm',
      principalId: OWNER,
      opened: ['dm-owner-v1', 'dm-owner-v2', 'dm-member', 'common-chat'],
    });
    const h = harness(adapter);
    h.orders.tick('writeback');
    const subjects = parseUpkeepOrder(h.accepted[0]!.payload as never).subjects as Array<{
      key: string;
      refs: string[];
    }>;
    expect(names(subjects[0]!.refs)).toEqual(['common-chat']);
  });

  it('takes an owner-role member turn but never a plain member turn', async () => {
    const adapter = await database();
    ownerRole(adapter, 'member-owner');
    observation(adapter, 'obs-a');
    observation(adapter, 'obs-b');
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

  it('does not order a turn whose own run already cites what it read', async () => {
    const adapter = await database();
    observation(adapter, 'obs-cited');
    observation(adapter, 'obs-open');
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
    observation(adapter, 'obs-sub-read');
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
    expect(names(subjects[0]!.refs)).toEqual(['obs-sub-read']);
  });

  it("counts a child run's citation when deciding a turn already recorded", async () => {
    const adapter = await database();
    observation(adapter, 'obs-child');
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
    observation(adapter, 'obs-stuck');
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
    observation(adapter, 'obs-1');
    observation(adapter, 'obs-2');
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
      .run(JSON.stringify({ reason: 'already recorded', observationRefs: [id('obs-2')] }), NOW);
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

/**
 * The PUBLIC task tool boundary for the records-vs-tasks policy (v0.48.1 follow-up).
 *
 * Root cause: public task_create required only `title`, so any connector record,
 * principle or open question could become a native owner task. This pins the
 * executor boundary (reject title-only), the new `task_reclassify` dispatch, and
 * every projection an agent can see the tools through: ToolRegistry schema,
 * Code-Act HostBridge params, and the generated tool catalog.
 *
 * Real GatewayToolExecutor + real in-memory TaskLedger; synthetic data only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import Database from '../../src/sqlite.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

const NOW = Date.parse('2026-09-07T04:00:00Z');

function makeExecutor(): { executor: GatewayToolExecutor; ledger: TaskLedger } {
  const executor = new GatewayToolExecutor();
  const ledger = new TaskLedger(new Database(':memory:'), {
    now: () => NOW,
    timeZone: 'Asia/Seoul',
  });
  executor.setTaskLedger(ledger);
  return { executor, ledger };
}

describe('Story TASK-RECAL-2: public task tool boundary', () => {
  it('TG-04 authorizes both source partitions and preserves the actual cross-channel review anchor', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new TaskLedger(db, { now: () => NOW });
      const task = ledger.create({
        title: 'verify delivery',
        completion_criteria: 'delivery accepted',
        source_channel: 'slack:request',
      });
      db.exec(
        'CREATE TABLE connector_event_index(event_index_id TEXT, source_connector TEXT, channel TEXT, event_datetime INTEGER, source_timestamp_ms INTEGER)'
      );
      db.prepare('INSERT INTO connector_event_index VALUES (?, ?, ?, ?, ?)').run(
        'delivery-anchor',
        'slack',
        'delivery',
        NOW,
        NOW
      );
      let channels = ['request'];
      const executor = new GatewayToolExecutor({
        connectorEventAdapter: db,
        channelGrantProvider: () => ({ slack: channels }),
        mamaApi: { appendToolTrace: async () => undefined } as never,
        temporalContextPacketLookup: async () =>
          ({
            packet_id: 'ctxp-cross-source',
            packet_json: JSON.stringify({
              selected_evidence: [
                {
                  ref: {
                    kind: 'raw',
                    raw_id: 'delivery-anchor',
                    connector: 'slack',
                    channel_id: 'delivery',
                  },
                },
              ],
            }),
          }) as never,
      });
      executor.setTaskLedger(ledger);
      const envelope = makeSignedEnvelope({
        scope: {
          project_refs: [],
          raw_connectors: ['slack'],
          memory_scopes: [],
          allowed_destinations: [],
        },
      });
      const execution = { envelope, modelRunId: 'mr-cross-source' };
      const input = {
        id: task.id,
        status: 'review',
        expected_revision: task.revision,
        latest_event: 'delivery submitted',
        context_packet_id: 'ctxp-cross-source',
        review_anchor_ref: 'delivery-anchor',
      };
      expect(await executor.execute('task_update', input as never, execution)).toMatchObject({
        success: false,
        code: 'review_source_not_authorized',
      });
      channels = ['request', 'delivery'];
      expect(await executor.execute('task_update', input as never, execution)).toMatchObject({
        success: true,
      });
      expect(ledger.getById(task.id)).toMatchObject({
        sourceChannel: 'slack:request',
        reviewAnchorSourceChannel: 'slack:delivery',
        reviewAnchorEventId: 'delivery-anchor',
      });
    } finally {
      db.close();
    }
  });
  it('TG-04 distinguishes unselected review evidence from a source authorization failure', async () => {
    const { ledger } = makeExecutor();
    const task = ledger.create({
      title: 'verify outcome',
      completion_criteria: 'source confirms outcome',
    });
    const executor = new GatewayToolExecutor({
      mamaApi: { appendToolTrace: async () => undefined } as never,
      temporalContextPacketLookup: async () =>
        ({
          packet_id: 'ctxp-no-raw',
          packet_json: JSON.stringify({ selected_evidence: [] }),
        }) as never,
    });
    executor.setTaskLedger(ledger);
    const result = await executor.execute(
      'task_update',
      {
        id: task.id,
        status: 'review',
        expected_revision: task.revision,
        latest_event: 'checking result',
        context_packet_id: 'ctxp-no-raw',
        review_anchor_ref: 'guessed-id',
      } as never,
      { envelope: makeSignedEnvelope(), modelRunId: 'mr-review' }
    );
    expect(result).toMatchObject({ success: false, code: 'review_anchor_not_selected' });
    expect(ledger.getById(task.id)?.revision).toBe(task.revision);
  });
  let executor: GatewayToolExecutor;
  let ledger: TaskLedger;

  beforeEach(() => {
    ({ executor, ledger } = makeExecutor());
  });

  describe('Acceptance Criteria #1: task_create requires completion criteria', () => {
    it('rejects a title-only public task_create', async () => {
      await expect(executor.execute('task_create', { title: '열심히 살자' })).rejects.toThrow(
        /completion_criteria/
      );
    });

    it('rejects an empty/whitespace completion_criteria', async () => {
      await expect(
        executor.execute('task_create', { title: 'x', completion_criteria: '   ' })
      ).rejects.toThrow(/completion_criteria/);
    });

    it('rejects an overlong completion_criteria', async () => {
      await expect(
        executor.execute('task_create', { title: 'x', completion_criteria: 'x'.repeat(501) })
      ).rejects.toThrow(/500/);
    });

    it('accepts and persists a concrete completion_criteria', async () => {
      const result = (await executor.execute('task_create', {
        title: 'send the September invoice',
        completion_criteria: 'invoice PDF delivered to the client channel',
      })) as { success: boolean; task: { id: number; completionCriteria: string } };
      expect(result.success).toBe(true);
      expect(result.task.completionCriteria).toBe('invoice PDF delivered to the client channel');
      expect(ledger.getById(result.task.id)?.completionCriteria).toBe(
        'invoice PDF delivered to the client channel'
      );
    });

    it('rejects unsupported task_create fields loudly', async () => {
      await expect(
        executor.execute('task_create', {
          title: 'x',
          completion_criteria: 'y',
          resolution_kind: 'completed_no_issue',
        })
      ).rejects.toThrow(/unsupported field/i);
    });
  });

  describe('Acceptance Criteria #2: progressive legacy qualification', () => {
    it('lets task_update add a completion criterion to a real legacy task', async () => {
      const legacy = ledger.create({ title: 'ship the approved asset' });
      const result = (await executor.execute('task_update', {
        id: legacy.id,
        completion_criteria: 'approved asset is delivered to the client channel',
      })) as { task: { completionCriteria: string } };
      expect(result.task.completionCriteria).toBe(
        'approved asset is delivered to the client channel'
      );
    });

    it('does not let public task_update clear a completion criterion', async () => {
      const task = ledger.create({ title: 'qualified', completion_criteria: 'artifact delivered' });
      await expect(
        executor.execute('task_update', { id: task.id, completion_criteria: null })
      ).rejects.toThrow(/completion_criteria/);
      expect(ledger.getById(task.id)?.completionCriteria).toBe('artifact delivered');
    });

    it('filters one bounded active legacy page without reading the whole board', async () => {
      ledger.create({ title: 'legacy one' });
      ledger.create({ title: 'legacy two' });
      ledger.create({ title: 'qualified', completion_criteria: 'artifact delivered' });
      ledger.create({ title: 'closed legacy', status: 'cancelled' });

      const result = (await executor.execute('task_list', {
        view: 'items',
        qualification: 'legacy_unqualified',
        include_terminal: false,
        limit: 1,
      })) as { total: number; returned: number; tasks: Array<{ completion_criteria: null }> };
      expect(result.total).toBe(2);
      expect(result.returned).toBe(1);
      expect(result.tasks[0]?.completion_criteria).toBeNull();
    });
  });

  describe('Acceptance Criteria #3: task_reclassify dispatch', () => {
    it('closes a past-deadline row as completed_no_issue', async () => {
      const created = (await executor.execute('task_create', {
        title: 'ship the August report',
        completion_criteria: 'report link posted',
        deadline: '2026-09-01',
      })) as { task: { id: number; revision: number } };

      const result = (await executor.execute('task_reclassify', {
        id: created.task.id,
        disposition: 'completed_no_issue',
        reason: 'checked every relevant source through 09-07; no open issue',
        expected_revision: created.task.revision,
      })) as { success: boolean; task: { status: string; resolutionKind: string } };

      expect(result.success).toBe(true);
      expect(result.task.status).toBe('done');
      expect(result.task.resolutionKind).toBe('completed_no_issue');
    });

    it('cancels a record-shaped row as non_task_record', async () => {
      const created = (await executor.execute('task_create', {
        title: 'how should we manage X?',
        completion_criteria: 'placeholder',
      })) as { task: { id: number; revision: number } };

      const result = (await executor.execute('task_reclassify', {
        id: created.task.id,
        disposition: 'non_task_record',
        reason: 'an open question; it belongs in records, not the board',
        expected_revision: created.task.revision,
      })) as { task: { status: string; resolutionKind: string } };

      expect(result.task.status).toBe('cancelled');
      expect(result.task.resolutionKind).toBe('non_task_record');
    });

    it('coerces a string id and rejects a non-numeric one', async () => {
      const created = (await executor.execute('task_create', {
        title: 'x',
        completion_criteria: 'y',
      })) as { task: { id: number; revision: number } };

      const result = (await executor.execute('task_reclassify', {
        id: String(created.task.id),
        disposition: 'non_task_memory',
        reason: 'a durable lesson; save it as memory',
        expected_revision: created.task.revision,
      })) as { task: { status: string } };
      expect(result.task.status).toBe('cancelled');

      await expect(
        executor.execute('task_reclassify', {
          id: 'not-a-number',
          disposition: 'non_task_record',
          reason: 'x',
          expected_revision: 0,
        })
      ).rejects.toThrow(/numeric id/i);
    });

    it('rejects unsupported task_reclassify fields loudly', async () => {
      const created = (await executor.execute('task_create', {
        title: 'x',
        completion_criteria: 'y',
      })) as { task: { id: number; revision: number } };
      await expect(
        executor.execute('task_reclassify', {
          id: created.task.id,
          disposition: 'non_task_record',
          reason: 'r',
          expected_revision: created.task.revision,
          status: 'done',
        })
      ).rejects.toThrow(/unsupported field/i);
    });

    it('fails closed without a ledger', async () => {
      const bare = new GatewayToolExecutor();
      const result = (await bare.execute('task_reclassify', {
        id: 1,
        disposition: 'non_task_record',
        reason: 'r',
        expected_revision: 0,
      })) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('allows owner-event qualification and reclassification across causal channels (TG-03/TG-06)', async () => {
      const db = new Database(':memory:');
      const boundLedger = new TaskLedger(db, { now: () => NOW, timeZone: 'Asia/Seoul' });
      const inbox = new OwnerEventInbox(db, () => NOW);
      inbox.enqueue({
        channelKey: 'slack:C001',
        eventIds: ['evt-current'],
        lines: ['current feedback'],
        activations: [],
      });
      const sameChannel = boundLedger.create({
        title: 'same channel',
        source_channel: 'slack:C001',
      });
      const unrelated = boundLedger.create({
        title: 'unrelated',
        source_channel: 'slack:C999',
      });
      const boundExecutor = new GatewayToolExecutor();
      boundExecutor.setTaskLedger(boundLedger);
      const context = { source: 'owner-event', causeEventIds: ['evt-current'] };

      await expect(
        boundExecutor.execute(
          'task_update',
          {
            id: unrelated.id,
            completion_criteria: 'unrelated task is complete',
            expected_revision: unrelated.revision,
            latest_event: 'owner agent reviewed a related task',
          },
          context
        )
      ).resolves.toMatchObject({ success: true });

      await expect(
        boundExecutor.execute(
          'task_reclassify',
          {
            id: unrelated.id,
            disposition: 'non_task_record',
            reason: 'owner agent reviewed this related record',
            expected_revision: boundLedger.getById(unrelated.id)!.revision,
          },
          context
        )
      ).resolves.toMatchObject({ success: true });
      const allowed = (await boundExecutor.execute(
        'task_reclassify',
        {
          id: sameChannel.id,
          disposition: 'non_task_record',
          reason: 'same channel record',
          expected_revision: sameChannel.revision,
        },
        context
      )) as { task: { status: string } };
      expect(allowed.task.status).toBe('cancelled');
      db.close();
    });
  });

  describe('Acceptance Criteria #4: task_list exposes classification', () => {
    it('the items view carries completion_criteria and resolution_kind', async () => {
      const created = (await executor.execute('task_create', {
        title: 'ship the August report',
        completion_criteria: 'report link posted',
        deadline: '2026-09-01',
      })) as { task: { id: number; revision: number } };
      await executor.execute('task_reclassify', {
        id: created.task.id,
        disposition: 'completed_no_issue',
        reason: 'no open issue on any relevant source',
        expected_revision: created.task.revision,
      });

      const list = (await executor.execute('task_list', {
        view: 'items',
        include_terminal: true,
      })) as { tasks: Array<Record<string, unknown>> };
      const row = list.tasks.find((task) => task.id === created.task.id)!;
      // Without these the agent cannot tell a finished row from one that was never
      // a task, which is the whole reason the board filled with records.
      expect(row.completion_criteria).toBe('report link posted');
      expect(row.resolution_kind).toBe('completed_no_issue');
    });
  });

  describe('Acceptance Criteria #5: agent-visible projections agree', () => {
    it('ToolRegistry advertises task_reclassify with the exact input contract', () => {
      const tool = ToolRegistry.getTool('task_reclassify');
      expect(tool).toBeDefined();
      for (const field of ['id', 'disposition', 'reason', 'expected_revision']) {
        expect(tool!.params).toContain(field);
      }
      for (const disposition of [
        'completed_evidence',
        'completed_no_issue',
        'non_task_record',
        'non_task_memory',
        'reopen',
      ]) {
        expect(tool!.params).toContain(disposition);
      }
      const schema = tool!.inputSchema as { required?: string[]; properties?: object };
      expect(schema?.required?.sort()).toEqual(
        ['disposition', 'expected_revision', 'id', 'reason'].sort()
      );
    });

    it('ToolRegistry task_create advertises completion_criteria as required', () => {
      const tool = ToolRegistry.getTool('task_create');
      expect(tool!.params).toContain('completion_criteria (required');
      expect(tool!.description).toMatch(/record|not a task|completion/i);
    });

    it('the Code-Act bridge exposes both with matching params', () => {
      const bridge = new Map(HostBridge.getToolRegistry().map((tool) => [tool.name, tool]));
      const reclassify = bridge.get('task_reclassify');
      expect(reclassify).toBeDefined();
      expect(
        reclassify!.params
          .filter((p) => p.required)
          .map((p) => p.name)
          .sort()
      ).toEqual(['disposition', 'expected_revision', 'id', 'reason'].sort());
      const create = bridge.get('task_create');
      const criteria = create!.params.find((p) => p.name === 'completion_criteria');
      expect(criteria?.required).toBe(true);
      const list = bridge.get('task_list');
      expect(list?.params.some((param) => param.name === 'qualification')).toBe(true);
      expect(list?.returnType).toContain('completion_criteria: string | null');
      expect(list?.returnType).toContain('resolution_kind: string | null');
      const update = bridge.get('task_update');
      expect(update?.params.some((param) => param.name === 'completion_criteria')).toBe(true);
    });
  });
});

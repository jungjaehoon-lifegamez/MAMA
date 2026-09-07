import { describe, it, expect, vi } from 'vitest';
import { createPersonaReportAsk } from '../../src/operator/report-run.js';
import { LaneManager } from '../../src/concurrency/lane-manager.js';
import { OWNER_RUNTIME_SESSION_KEY } from '../../src/operator/owner-runtime.js';

let nextId = 0;
function exchange(name: string, result: { error?: boolean; body?: string } = {}) {
  const id = `tu_${nextId++}`;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: result.body ?? '{"success":true}',
          is_error: result.error === true,
        },
      ],
    },
  ];
}

describe('createPersonaReportAsk (M3-T4)', () => {
  it('TG-05/TG-06 gives on-demand reports owner priority without overtaking an earlier owner request', async () => {
    const lanes = new LaneManager();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = lanes.enqueueWithSession(OWNER_RUNTIME_SESSION_KEY, () => gate);
    const ask = createPersonaReportAsk({
      run: async (prompt, _ref, options) =>
        lanes.enqueueWithSession(
          OWNER_RUNTIME_SESSION_KEY,
          async () => {
            order.push(prompt);
            return { response: prompt, history: [] };
          },
          undefined,
          { priority: options?.lanePriority ?? 0 }
        ),
      log: () => {},
    });
    const scheduled = ask.compose({
      sourceMessageRef: 'owner-report:test-1',
      prompt: 'scheduled',
      requestKind: 'scheduled_full',
    });
    const owner = lanes.enqueueWithSession(
      OWNER_RUNTIME_SESSION_KEY,
      async () => {
        order.push('earlier-owner');
      },
      undefined,
      { priority: 100 }
    );
    const requested = ask.compose({
      sourceMessageRef: 'owner-report:test-2',
      prompt: 'requested',
      requestKind: 'on_demand_full',
    });
    release();
    await Promise.all([active, scheduled, owner, requested]);
    expect(order).toEqual(['earlier-owner', 'requested', 'scheduled']);
  });

  it('uses the one durable owner runtime key', () => {
    expect(OWNER_RUNTIME_SESSION_KEY).toBe('owner:runtime');
  });

  it('TG-05 carries the scheduled occurrence into the owner runtime turn', async () => {
    const calls: Array<{ prompt: string; sourceMessageRef?: string }> = [];
    const ask = createPersonaReportAsk({
      run: async (prompt, sourceMessageRef) => {
        calls.push({ prompt, sourceMessageRef });
        return { response: 'grounded report', history: [], turns: 1, modelRunId: 'mr_packet' };
      },
      log: () => {},
    });

    const output = await ask.compose({
      requestKind: 'scheduled_full',
      prompt: 'packet prompt',
      sourceMessageRef: 'owner-report:scheduled-1',
    });

    expect(output).toBe('grounded report');
    expect(calls).toEqual([
      {
        prompt: 'packet prompt',
        sourceMessageRef: 'owner-report:scheduled-1',
      },
    ]);
  });

  it('TG-05 permits progressive tool rounds in the same owner turn', async () => {
    const ask = createPersonaReportAsk({
      run: async () => ({ response: 'late report', history: [], turns: 2 }),
      log: () => {},
    });

    await expect(
      ask.compose({
        requestKind: 'scheduled_full',
        prompt: 'progressive report prompt',
        sourceMessageRef: 'owner-report:scheduled-2',
      })
    ).resolves.toBe('late report');
  });

  it('TG-06 does not recover an empty full response from an earlier assistant turn', async () => {
    const ask = createPersonaReportAsk({
      run: async () => ({
        response: '',
        turns: 1,
        history: [{ role: 'assistant', content: [{ type: 'text', text: 'stale earlier report' }] }],
      }),
      log: () => {},
    });

    await expect(
      ask.compose({
        sourceMessageRef: 'owner-report:test-5',
        requestKind: 'scheduled_full',
        prompt: 'packet prompt',
      })
    ).rejects.toThrow('empty report response');
  });

  it('TG-03/TG-04 does not log or bind a bulk evidence packet', async () => {
    const logs: string[] = [];
    const ask = createPersonaReportAsk({
      run: async () => ({ response: 'report', history: [], turns: 1 }),
      log: (line) => logs.push(line),
    });

    await ask.compose({
      requestKind: 'scheduled_full',
      prompt: 'progressive prompt',
      sourceMessageRef: 'owner-report:scheduled-3',
    });

    expect(logs).toEqual([]);
  });
  // The boundary used to return prose and drop everything else, so a delivered report
  // could not be traced to the run that wrote it - the same defect the gateway turn seam
  // had, one layer in.
  it('reports the run behind the report it just composed', async () => {
    const seen: unknown[] = [];
    const ask = createPersonaReportAsk({
      run: async () => ({ response: 'body', history: [], modelRunId: 'mr_7' }),
      log: () => {},
      onRunProvenance: (provenance) => seen.push(provenance),
    });

    await ask.compose({
      sourceMessageRef: 'owner-report:test-7',
      requestKind: 'scheduled_full',
      prompt: 'compose',
    });

    expect(seen).toEqual([{ status: 'available', modelRunId: 'mr_7' }]);
  });

  it('separates a backend that records no run from a run whose handle was lost', async () => {
    const seen: unknown[] = [];
    const askNoRun = createPersonaReportAsk({
      run: async () => ({ response: 'body', history: [] }),
      log: () => {},
      onRunProvenance: (provenance) => seen.push(provenance),
    });
    await askNoRun.compose({
      sourceMessageRef: 'owner-report:test-8',
      requestKind: 'scheduled_full',
      prompt: 'compose',
    });

    const askLost = createPersonaReportAsk({
      run: async () => ({
        response: 'body',
        history: [],
        modelRunId: null,
        modelRunProvenance: 'commit_failed',
      }),
      log: () => {},
      onRunProvenance: (provenance) => seen.push(provenance),
    });
    await askLost.compose({
      sourceMessageRef: 'owner-report:test-9',
      requestKind: 'scheduled_full',
      prompt: 'compose',
    });

    expect(seen).toEqual([
      { status: 'unavailable', reason: 'no_run_handle' },
      { status: 'unavailable', reason: 'commit_failed' },
    ]);
  });

  it('surfaces owner-runtime recovery failure without discarding the report', async () => {
    const onRecoveryFailure = vi.fn();
    const ask = createPersonaReportAsk({
      run: async () => ({
        response: 'body',
        history: [],
        ownerJournalProvenance: 'commit_failed',
      }),
      log: () => {},
      onRecoveryFailure,
    });

    await expect(
      ask.compose({
        sourceMessageRef: 'owner-report:test-10',
        requestKind: 'scheduled_full',
        prompt: 'compose',
      })
    ).resolves.toBe('body');
    expect(onRecoveryFailure).toHaveBeenCalledOnce();
  });

  it('does not infer ordinary report quality from tool history', async () => {
    const logs: string[] = [];
    const run = async () => ({
      response: 'the report',
      history: [...exchange('kagemusha_tasks'), ...exchange('mama_save')],
    });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    const out = await ask.compose({
      sourceMessageRef: 'owner-report:test-11',
      requestKind: 'scheduled_full',
      prompt: 'write the report',
    });
    expect(out).toBe('the report');
    expect(logs).toEqual([]);
  });

  it('empty ordinary response still fails without a gather audit fallback', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: '   ', history: [...exchange('Bash')] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    await expect(
      ask.compose({
        sourceMessageRef: 'owner-report:test-12',
        requestKind: 'scheduled_full',
        prompt: 'write ordinary report',
      })
    ).rejects.toThrow(/empty report response/);
    expect(logs).toEqual([]);
  });

  it('TG-06 rejects an empty final response instead of promoting earlier prose to a report', async () => {
    // Earlier prose can be provisional. Only an explicit final response is deliverable.
    const logs: string[] = [];
    const run = async () => ({
      response: '',
      history: [
        { role: 'assistant', content: [{ type: 'text', text: '1) key situation: quiet day' }] },
        ...exchange('mama_save'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'noop', input: {} }] },
      ],
    });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    await expect(
      ask.compose({
        sourceMessageRef: 'owner-report:test-13',
        requestKind: 'scheduled_full',
        prompt: 'write digest',
      })
    ).rejects.toThrow('empty report response');
    expect(logs).toEqual([]);
  });

  it('a digest prompt does not warn about missing gather tools', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: 'digest', history: [] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    await ask.compose({
      sourceMessageRef: 'owner-report:test-14',
      requestKind: 'scheduled_full',
      prompt: 'short digest',
    });
    expect(logs.join('\n')).not.toMatch(/NO gateway gather tools/);
  });
});

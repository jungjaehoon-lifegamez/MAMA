import { describe, it, expect } from 'vitest';
import type { OwnerReportContextV1 } from '../../src/operator/report-context.js';
import {
  createPersonaReportAsk,
  OPERATOR_REPORT_SESSION_KEY,
} from '../../src/operator/report-run.js';

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

function ownerReportContext(): OwnerReportContextV1 {
  return {
    schemaVersion: 'mama.owner-report-context/v1',
    observedAt: '2026-09-02T03:04:05.000Z',
    windowEvidence: {
      start: '2026-09-01T03:04:05.000Z',
      end: '2026-09-02T03:04:05.000Z',
      channelCount: 1,
      messageCount: 2,
      channels: [],
      triggerActivity: [],
    },
    sources: {
      claims: { state: 'complete', observedAt: '2026-09-02T03:04:05.000Z' },
      tasks: { state: 'complete', observedAt: '2026-09-02T03:04:05.000Z' },
      trello: {
        state: 'partial',
        observedAt: '2026-09-02T03:04:00.000Z',
        reason: 'trello_snapshot_incomplete',
      },
      changes: { state: 'complete', observedAt: '2026-09-02T03:04:05.000Z' },
    },
    packet: { bytes: 2048, truncated: false },
    taskCoverage: { total: 3, returned: 2, truncated: true },
    currentClaims: [],
    tasks: [],
    trello: {
      observedAt: '2026-09-02T03:04:00.000Z',
      complete: false,
      truncated: false,
      boards: [],
      columns: [],
    },
    correlations: {
      coverage: {
        total: 2,
        matched: 1,
        unmatched: 0,
        ambiguous: 0,
        historical_only: 1,
        not_applicable: 0,
      },
      rows: [],
    },
    changes: {
      since: '2026-09-01T03:04:05.000Z',
      total: 4,
      returned: 4,
      coverage: { attributed: 3, unattributed: 1 },
      rows: [],
    },
    caveats: ['trello_snapshot_incomplete'],
    operationalIssues: [],
  };
}

describe('createPersonaReportAsk (M3-T4)', () => {
  it('exposes a stable dedicated session key', () => {
    expect(OPERATOR_REPORT_SESSION_KEY).toBe('operator:report');
  });

  it('TG-05 binds the packet SHA to one fresh full-report model turn', async () => {
    const calls: Array<{ prompt: string; sourceMessageRef?: string }> = [];
    const ask = createPersonaReportAsk({
      run: async (prompt, sourceMessageRef) => {
        calls.push({ prompt, sourceMessageRef });
        return { response: 'grounded report', history: [], turns: 1, modelRunId: 'mr_packet' };
      },
      log: () => {},
    });

    const output = await ask.full({
      prompt: 'packet prompt',
      context: ownerReportContext(),
      contextSha256: 'a'.repeat(64),
    });

    expect(output).toBe('grounded report');
    expect(calls).toEqual([
      {
        prompt: 'packet prompt',
        sourceMessageRef: `owner-report-context:${'a'.repeat(64)}`,
      },
    ]);
  });

  it('TG-05 refuses a full report that required more than one model turn', async () => {
    const ask = createPersonaReportAsk({
      run: async () => ({ response: 'late report', history: [], turns: 2 }),
      log: () => {},
    });

    await expect(
      ask.full({
        prompt: 'packet prompt',
        context: ownerReportContext(),
        contextSha256: 'b'.repeat(64),
      })
    ).rejects.toThrow('exactly one model turn');
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
      ask.full({
        prompt: 'packet prompt',
        context: ownerReportContext(),
        contextSha256: 'c'.repeat(64),
      })
    ).rejects.toThrow('empty report response');
  });

  it('TG-03/TG-04 audits only packet schema, source states, counts, coverage, and completeness', async () => {
    const logs: string[] = [];
    const ask = createPersonaReportAsk({
      run: async () => ({ response: 'report', history: [], turns: 1 }),
      log: (line) => logs.push(line),
    });

    await ask.full({
      prompt: 'packet prompt',
      context: ownerReportContext(),
      contextSha256: 'd'.repeat(64),
    });

    expect(logs).toEqual([expect.stringContaining('schema=mama.owner-report-context/v1')]);
    expect(logs[0]).toContain('trello=partial');
    expect(logs[0]).toContain('messages=2');
    expect(logs[0]).toContain('tasks=2/3');
    expect(logs[0]).toContain('correlations=2');
    expect(logs[0]).toContain('changes=4/4');
    expect(logs[0]).not.toContain('trello_snapshot_incomplete');
    expect(logs.join('\n')).not.toContain('gateway gather tools');
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

    await ask('compose');

    expect(seen).toEqual([{ status: 'available', modelRunId: 'mr_7' }]);
  });

  it('separates a backend that records no run from a run whose handle was lost', async () => {
    const seen: unknown[] = [];
    const askNoRun = createPersonaReportAsk({
      run: async () => ({ response: 'body', history: [] }),
      log: () => {},
      onRunProvenance: (provenance) => seen.push(provenance),
    });
    await askNoRun('compose');

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
    await askLost('compose');

    expect(seen).toEqual([
      { status: 'unavailable', reason: 'no_run_handle' },
      { status: 'unavailable', reason: 'commit_failed' },
    ]);
  });

  it('does not infer ordinary report quality from tool history', async () => {
    const logs: string[] = [];
    const run = async () => ({
      response: 'the report',
      history: [...exchange('kagemusha_tasks'), ...exchange('mama_save')],
    });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    const out = await ask('write the report');
    expect(out).toBe('the report');
    expect(logs).toEqual([]);
  });

  it('empty ordinary response still fails without a gather audit fallback', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: '   ', history: [...exchange('Bash')] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    await expect(ask('write ordinary report')).rejects.toThrow(/empty report response/);
    expect(logs).toEqual([]);
  });

  it('empty FINAL segment recovers the report body from an earlier assistant turn', async () => {
    // Live incident 2026-07-27: on the claude text-gateway path the loop
    // returns only the LAST assistant segment; after a closing tool round it
    // was empty, killing the cadence although the composed report existed in
    // an earlier turn.
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
    const out = await ask('write digest');
    expect(out).toBe('1) key situation: quiet day');
    expect(logs.join('\n')).toMatch(/recovered from an earlier assistant turn/);
  });

  it('a digest prompt does not warn about missing gather tools', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: 'digest', history: [] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l) });
    await ask('short digest');
    expect(logs.join('\n')).not.toMatch(/NO gateway gather tools/);
  });
});

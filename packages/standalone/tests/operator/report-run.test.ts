/**
 * Unit tests for the M3 report tool-use audit (pure). Synthetic history only; no CLI/LLM.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeReportToolUse,
  formatReportToolAudit,
  OPERATOR_REPORT_SESSION_KEY,
} from '../../src/operator/report-run.js';

let nextId = 0;
/** One gateway exchange: assistant tool_use + its paired tool_result in the next user message
 *  (the agent loop pushes results there - agent-loop.ts:1408-1411). */
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

describe('report tool-use audit (M3-T1)', () => {
  it('classifies EXECUTED gateway gather vs write tools (tool_use paired with a good result)', () => {
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      ...exchange('kagemusha_tasks'),
      ...exchange('mama_recall'),
      ...exchange('mama_save'),
      ...exchange('Bash'), // native - executed, but not a gateway tool: unclassified
    ];
    const a = summarizeReportToolUse(history);
    expect(a.gatherTools).toEqual(['kagemusha_tasks', 'mama_recall']);
    expect(a.writeTools).toEqual(['mama_save']);
    expect(a.all).toContain('Bash'); // still inventoried in `all`, just unclassified
  });

  it('ignores non-assistant messages and non-tool_use blocks', () => {
    const a = summarizeReportToolUse([
      { role: 'user', content: [{ type: 'tool_use', name: 'kagemusha_tasks' }] }, // wrong role
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(a.gatherTools).toEqual([]);
    expect(a.writeTools).toEqual([]);
  });

  it('emitted-but-denied does NOT count and still fires the WARNING (envelope regression guard)', () => {
    const history = [
      ...exchange('kagemusha_tasks', { error: true }), // errored execution
      ...exchange('mama_recall', { body: '{"success":false,"code":"envelope_missing"}' }),
      ...exchange('mama_save', { body: '{"success":false,"code":"envelope_missing"}' }),
    ];
    const a = summarizeReportToolUse(history);
    expect(a.gatherTools).toEqual([]); // emissions happened, executions did not
    expect(a.writeTools).toEqual([]);
    expect(a.all).toEqual(['kagemusha_tasks', 'mama_recall', 'mama_save']); // honest inventory
    expect(formatReportToolAudit(a, true).join('\n')).toMatch(/NO gateway gather tools/);
  });

  it('SUCCESSFUL result whose nested payload mentions "success":false is NOT excluded (PR #119)', () => {
    // e.g. a message text discussing a failure - root success is true, so it executed.
    const history = [
      ...exchange('kagemusha_messages', {
        body: '{"success":true,"messages":[{"text":"the deploy returned \\"success\\":false yesterday"}]}',
      }),
    ];
    const a = summarizeReportToolUse(history);
    expect(a.gatherTools).toEqual(['kagemusha_messages']); // counted as executed
    expect(formatReportToolAudit(a, true).join('\n')).not.toMatch(/NO gateway gather tools/);
  });

  it('full report with NO gather tool -> loud warning (no-fallback)', () => {
    const lines = formatReportToolAudit({ gatherTools: [], writeTools: [], all: [] }, true);
    expect(lines.join('\n')).toMatch(/NO gateway gather tools/);
  });

  it('full report with gather tools -> positive gather line, no warning', () => {
    const lines = formatReportToolAudit(
      { gatherTools: ['kagemusha_tasks', 'kagemusha_tasks'], writeTools: [], all: [] },
      true
    );
    expect(lines.join('\n')).toMatch(/gathered via kagemusha_tasks/);
    expect(lines.join('\n')).not.toMatch(/NO gateway gather tools/);
    expect(lines.join('\n')).not.toMatch(/kagemusha_tasks, kagemusha_tasks/); // de-duplicated
  });

  it('writes are logged for observability (both modes)', () => {
    const lines = formatReportToolAudit(
      { gatherTools: ['kagemusha_tasks'], writeTools: ['mama_save'], all: [] },
      true
    );
    expect(lines.join('\n')).toMatch(/wrote via mama_save/);
  });

  it('digest (not full) does not warn about missing gather tools', () => {
    const lines = formatReportToolAudit({ gatherTools: [], writeTools: [], all: [] }, false);
    expect(lines.join('\n')).not.toMatch(/NO gateway gather tools/);
  });

  it('exposes a stable dedicated session key', () => {
    expect(OPERATOR_REPORT_SESSION_KEY).toBe('operator:report');
  });
});

import { createPersonaReportAsk } from '../../src/operator/report-run.js';

describe('createPersonaReportAsk (M3-T4)', () => {
  const TAG = '[operator_full_report]';

  it('audits + logs gathered and written EXECUTIONS, then returns the response', async () => {
    const logs: string[] = [];
    const run = async () => ({
      response: 'the report',
      history: [...exchange('kagemusha_tasks'), ...exchange('mama_save')],
    });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l), fullReportTag: TAG });
    const out = await ask(`${TAG}\nwrite the report`);
    expect(out).toBe('the report');
    expect(logs.join('\n')).toMatch(/gathered via kagemusha_tasks/);
    expect(logs.join('\n')).toMatch(/wrote via mama_save/);
  });

  it('full report with no gateway gather EXECUTION warns loudly (no-fallback)', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: 'report', history: [...exchange('Bash')] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l), fullReportTag: TAG });
    await ask(`${TAG}\nwrite`);
    expect(logs.join('\n')).toMatch(/NO gateway gather tools/);
  });

  it('empty response throws (no-fallback) but the audit is logged BEFORE the throw', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: '   ', history: [...exchange('Bash')] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l), fullReportTag: TAG });
    await expect(ask(`${TAG}\nwrite`)).rejects.toThrow(/empty report response/);
    expect(logs.join('\n')).toMatch(/NO gateway gather tools/);
  });

  it('a digest prompt (no tag) does not warn about missing gather tools', async () => {
    const logs: string[] = [];
    const run = async () => ({ response: 'digest', history: [] });
    const ask = createPersonaReportAsk({ run, log: (l) => logs.push(l), fullReportTag: TAG });
    await ask('short digest, no tag');
    expect(logs.join('\n')).not.toMatch(/NO gateway gather tools/);
  });

  it('issues ONE scoped envelope per report and hands it to the runner', async () => {
    let issued = 0;
    const marker = { envelope_id: 'env-marker' };
    const seen: unknown[] = [];
    const run = async (_prompt: string, envelope?: unknown) => {
      seen.push(envelope);
      return { response: 'r', history: [] };
    };
    const ask = createPersonaReportAsk({
      run,
      issueEnvelope: async () => {
        issued += 1;
        return marker;
      },
      log: () => {},
      fullReportTag: TAG,
    });
    await ask('digest one');
    await ask('digest two');
    expect(issued).toBe(2); // per-report envelope, never reused across runs
    expect(seen).toEqual([marker, marker]); // the runner carries it into runWithContent options
  });

  it('without an issuer (issuance off) the runner receives no envelope', async () => {
    const seen: unknown[] = [];
    const run = async (_prompt: string, envelope?: unknown) => {
      seen.push(envelope);
      return { response: 'r', history: [] };
    };
    const ask = createPersonaReportAsk({ run, log: () => {}, fullReportTag: TAG });
    await ask('digest');
    expect(seen).toEqual([undefined]);
  });

  it('envelope issuance failure propagates loudly (no-fallback); the runner never runs', async () => {
    let ran = 0;
    const ask = createPersonaReportAsk({
      run: async () => {
        ran += 1;
        return { response: 'r', history: [] };
      },
      issueEnvelope: async () => {
        throw new Error('envelope authority unavailable');
      },
      log: () => {},
      fullReportTag: TAG,
    });
    await expect(ask('digest')).rejects.toThrow('envelope authority unavailable');
    expect(ran).toBe(0);
  });
});

describe('report tool-use audit: Code-Act nested gather (v0.27.4 false-positive fix)', () => {
  /** A code_act exchange whose result message carries the nested host tools it executed
   *  (executeCodeAct includes hostToolsInvoked in the successful message JSON). */
  function codeActExchange(
    hostToolsInvoked: unknown,
    opts: { error?: boolean; rawBody?: string } = {}
  ) {
    const body =
      opts.rawBody ??
      JSON.stringify({ value: 'ok', logs: [], metrics: { calls: 1 }, hostToolsInvoked });
    return exchange('code_act', { error: opts.error, body });
  }

  it('classifies nested host gather tools from an executed code_act result', () => {
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'report' }] },
      ...codeActExchange(['kagemusha_overview', 'kagemusha_tasks', 'mama_recall']),
    ];
    const a = summarizeReportToolUse(history);
    expect(a.gatherTools).toEqual(['kagemusha_overview', 'kagemusha_tasks', 'mama_recall']);
    expect(a.all).toEqual(['code_act']);
    expect(formatReportToolAudit(a, true).join('\n')).not.toMatch(/NO gateway gather tools/);
    expect(formatReportToolAudit(a, true).join('\n')).toMatch(/gathered via kagemusha_overview/);
  });

  it('classifies nested writes and still warns when code_act gathered nothing', () => {
    const a = summarizeReportToolUse([...codeActExchange(['mama_save', 'report_publish'])]);
    expect(a.gatherTools).toEqual([]);
    expect(a.writeTools).toEqual(['mama_save', 'report_publish']);
    expect(formatReportToolAudit(a, true).join('\n')).toMatch(/NO gateway gather tools/);
  });

  it('an errored code_act does NOT count its nested tools (executed-only semantics)', () => {
    const a = summarizeReportToolUse([...codeActExchange(['kagemusha_tasks'], { error: true })]);
    expect(a.gatherTools).toEqual([]);
    expect(a.all).toEqual(['code_act']);
  });

  it('malformed or field-less code_act results yield no nested tools and never throw', () => {
    const a = summarizeReportToolUse([
      ...codeActExchange(undefined, { rawBody: '{not json' }),
      ...codeActExchange(undefined, { rawBody: '{"value":"ok","logs":[]}' }),
      ...codeActExchange({ nested: 'wrong-shape' }),
      ...codeActExchange([42, null, 'kagemusha_tasks']), // non-strings ignored, valid one kept
    ]);
    expect(a.gatherTools).toEqual(['kagemusha_tasks']);
  });

  it('mixes direct tool_use and nested code_act gather in one audit', () => {
    const a = summarizeReportToolUse([
      ...exchange('context_compile'),
      ...codeActExchange(['kagemusha_overview', 'mama_save']),
    ]);
    expect(a.gatherTools).toEqual(['context_compile', 'kagemusha_overview']);
    expect(a.writeTools).toEqual(['mama_save']);
  });

  it('duplicate nested names are de-duplicated in the audit line, preserved in counts', () => {
    const a = summarizeReportToolUse([
      ...codeActExchange(['kagemusha_tasks', 'kagemusha_tasks', 'mama_recall']),
    ]);
    expect(a.gatherTools).toEqual(['kagemusha_tasks', 'kagemusha_tasks', 'mama_recall']);
    const line = formatReportToolAudit(a, true).join('\n');
    expect(line.match(/kagemusha_tasks/g)).toHaveLength(1); // uniq() in formatting
  });
});

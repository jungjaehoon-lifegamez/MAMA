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

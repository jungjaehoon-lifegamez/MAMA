/**
 * Wiring guard: the agentLoopClient wrapper must forward totalUsage.
 *
 * The Stage-2 token telemetry (0.27.5) threads usage structurally:
 * AgentLoopResult.totalUsage -> WorkerRunner -> workerRun -> consumer event ->
 * agent_activity. Unit tests inject fake runners that return totalUsage, so
 * they cannot catch the CONCRETE client wrapper stripping the field - which is
 * exactly what shipped in 0.27.5: the first live workorder completion recorded
 * NULL because runWithContent returned `{ response }` only. Source-guard the
 * wrapper the same way code-act-policy.test.ts guards the report-lane wiring.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('agentLoopClient wrapper preserves run usage', () => {
  it('runWithContent returns totalUsage alongside the response', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/cli/runtime/agent-loop-init.ts'),
      'utf-8'
    );
    const wrapper = source.slice(source.indexOf('runWithContent: async'));
    expect(wrapper.length).toBeGreaterThan(0);
    // The wrapper's return must carry the field workerRun reads; a bare
    // `return { response }` here silently re-blinds the telemetry.
    expect(wrapper).toMatch(/totalUsage: result\.totalUsage,/);
    // 0.43.0: the wrapper also dropped stoppedBy, so a budget-stopped run
    // reported as a clean completion (board#4416 live).
    expect(wrapper).toMatch(/stoppedBy: result\.stoppedBy/);
  });
});

describe('run token budget reaches the codex turn', () => {
  it('every agent.prompt() call in AgentLoop passes runTokenBudget (0.44.0: it reached none)', () => {
    const source = readFileSync(join(__dirname, '../../../src/agent/agent-loop.ts'), 'utf-8');
    const calls = source.split('this.agent.prompt(').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const optionsBlock = call.slice(0, call.indexOf('});'));
      expect(optionsBlock).toContain('runTokenBudget: this.runTokenBudget');
    }
  });
});

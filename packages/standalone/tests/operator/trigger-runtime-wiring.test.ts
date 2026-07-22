import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('trigger runtime provider wiring', () => {
  it('selects one trigger agent runtime from runtimeBackend for both author and review', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('createTriggerAgentRuntime(runtimeBackend');
    expect(startSource).toMatch(/askAgent:\s*triggerAgentRuntime\.askAuthor/);
    expect(startSource).toMatch(
      /review:\s*\(trigger, context\)\s*=>\s*reviewTriggerCLI\(trigger, context, triggerAgentRuntime\.askReview\)/
    );
  });

  it('registers the selected trigger runtime for daemon shutdown', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('await triggerAgentRuntime.stop()');
  });

  it('uses one resolved workspace for host policy and the trigger runtime', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('const workspaceRoot = expandPath(');
    expect(startSource).toContain('process.env.MAMA_WORKSPACE = workspaceRoot');
    expect(startSource).toMatch(
      /createTriggerAgentRuntime\(runtimeBackend,[\s\S]*?cwd:\s*workspaceRoot/
    );
  });

  it('preflights temporal compatibility before initializing timer-bearing services', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');
    const preflight = startSource.indexOf('preflightTemporalStartup(process.env');

    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(startSource.indexOf('await initMetrics('));
    expect(startSource.indexOf('const runtimeBackend = requireRuntimeBackend')).toBeLessThan(
      startSource.indexOf('await initMetrics(')
    );
    expect(startSource.indexOf('const temporalEffectiveTools = temporalPolicy')).toBeLessThan(
      startSource.indexOf('await initMetrics(')
    );
    expect(preflight).toBeLessThan(startSource.indexOf('initCronScheduler('));
    expect(preflight).toBeLessThan(startSource.indexOf('initHeartbeat('));
    expect(preflight).toBeLessThan(startSource.indexOf('triggerLoop.start()'));
  });
});

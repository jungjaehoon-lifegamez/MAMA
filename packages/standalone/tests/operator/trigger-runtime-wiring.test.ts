import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('trigger runtime provider wiring', () => {
  it('routes trigger authoring and review through the standing owner runtime', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).not.toContain('createTriggerAgentRuntime(runtimeBackend');
    expect(startSource).toContain('const ownerMaintenanceAsk = async');
    expect(startSource).toMatch(/sessionKey:\s*OWNER_RUNTIME_SESSION_KEY/);
    expect(startSource).toMatch(/askAgent:\s*ownerMaintenanceAsk/);
    expect(startSource).toMatch(
      /review:\s*\(trigger, context\)\s*=>\s*reviewTriggerCLI\(trigger, context, ownerMaintenanceAsk\)/
    );
  });

  it('TG-06 drains the trigger loop without a second model runtime', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('await stopTriggerLoop()');
    expect(startSource).not.toContain('triggerAgentRuntime.stop()');
  });

  it('TG-03/TG-04 removes unreceipted legacy sends and routes heartbeat through the owner', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');
    const routesSource = readFileSync(
      join(__dirname, '../../src/cli/runtime/api-routes-init.ts'),
      'utf-8'
    );
    const serverSource = readFileSync(
      join(__dirname, '../../src/cli/runtime/api-server-init.ts'),
      'utf-8'
    );

    expect(routesSource).not.toContain('agentLoop.run(');
    expect(serverSource).not.toContain('agentLoop.run(');
    expect(routesSource).toContain("['/api/discord/cron', '/api/report']");
    expect(routesSource).toContain('res.status(410)');
    expect(serverSource).toContain("runOwnerStimulus(prompt, 'api-heartbeat')");
    expect(startSource).toContain('onRecoveryFailure: () =>');
    expect(startSource).toContain("signature: 'journal_commit_failed'");
  });

  it('uses one resolved workspace for host policy', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('const workspaceRoot = expandPath(');
    expect(startSource).toContain('process.env.MAMA_WORKSPACE = workspaceRoot');
    expect(startSource).not.toContain('operator:trigger-author');
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

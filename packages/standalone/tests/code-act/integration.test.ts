import { describe, it, expect, beforeAll } from 'vitest';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';
import { CODE_ACT_INSTRUCTIONS, CODE_ACT_MARKER } from '../../src/agent/code-act/constants.js';
import { vi } from 'vitest';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeExecutor(handler?: (name: string, input: any) => any): GatewayToolExecutor {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn().mockImplementation(async (name: string, input: any) => {
      if (handler) return handler(name, input);
      return { success: true };
    }),
  } as unknown as GatewayToolExecutor;
}

describe('Code-Act Integration', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  it('full pipeline: bridge + sandbox + multiple tools', async () => {
    const callLog: string[] = [];
    const executor = makeExecutor((name, _input) => {
      callLog.push(name);
      if (name === 'mama_search') {
        return {
          success: true,
          results: [{ id: '1', topic: 'auth', decision: 'Use JWT' }],
          count: 1,
        };
      }
      if (name === 'discord_send') {
        return { success: true };
      }
      return { success: true };
    });

    const sandbox = new CodeActSandbox();
    const bridge = new HostBridge(executor);
    bridge.injectInto(sandbox, 1);

    const result = await sandbox.execute(`
      var searchResult = mama_search({ query: "auth" });
      var topic = searchResult.results[0].topic;
      discord_send({ channel_id: "dev", message: "Found: " + topic });
      ({ topic: topic, sent: true })
    `);

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ topic: 'auth', sent: true });
    expect(callLog).toEqual(['mama_search', 'discord_send']);
    expect(result.metrics.hostCallCount).toBe(2);
  });

  it('error in one tool does not crash sandbox', async () => {
    const executor = makeExecutor((name) => {
      if (name === 'Read') return { success: false, message: 'File not found' };
      return { success: true };
    });

    const sandbox = new CodeActSandbox();
    const bridge = new HostBridge(executor);
    bridge.injectInto(sandbox, 1);

    const result = await sandbox.execute(`
      var out;
      try { out = Read("/missing.txt"); } catch(e) { out = "error: " + e.message; }
      out;
    `);

    expect(result.success).toBe(true);
    expect(result.value).toContain('error');
  });

  it('data transformation pipeline', async () => {
    const executor = makeExecutor((name) => {
      if (name === 'mama_search') {
        return {
          success: true,
          results: [
            { id: '1', topic: 'db', decision: 'Use SQLite', similarity: 0.9 },
            { id: '2', topic: 'auth', decision: 'Use JWT', similarity: 0.85 },
            { id: '3', topic: 'cache', decision: 'Use Redis', similarity: 0.6 },
          ],
          count: 3,
        };
      }
      return { success: true };
    });

    const sandbox = new CodeActSandbox();
    const bridge = new HostBridge(executor);
    bridge.injectInto(sandbox, 1);

    const result = await sandbox.execute(`
      var data = mama_search({ query: "architecture" });
      var high = data.results.filter(function(r) { return r.similarity >= 0.8; });
      var summary = high.map(function(r) { return r.topic + ": " + r.decision; }).join(", ");
      ({ count: high.length, summary: summary })
    `);

    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      count: 2,
      summary: 'db: Use SQLite, auth: Use JWT',
    });
  });

  it('CODE_ACT_MARKER constant is correct', () => {
    expect(CODE_ACT_MARKER).toBe('code_act');
  });

  it('CODE_ACT_INSTRUCTIONS includes type definition slot', () => {
    expect(CODE_ACT_INSTRUCTIONS).toContain('## Code-Act');
    expect(CODE_ACT_INSTRUCTIONS).toContain('code_act');
    expect(CODE_ACT_INSTRUCTIONS).toContain('console.log');
  });

  it('system prompt combines instructions + type definitions', () => {
    const typeDefs = TypeDefinitionGenerator.generate(1);
    const fullPrompt = CODE_ACT_INSTRUCTIONS + '\n```typescript\n' + typeDefs + '\n```';
    expect(fullPrompt).toContain('declare function mama_search');
    expect(fullPrompt).toContain('declare function Read');
    expect(fullPrompt).toContain('## Code-Act');
    expect(fullPrompt.length).toBeLessThan(8000);
  });

  it('Tier 2 sandbox blocks write tools', async () => {
    const callLog: string[] = [];
    const executor = makeExecutor((name) => {
      callLog.push(name);
      return { success: true, results: [], count: 0 };
    });

    const sandbox = new CodeActSandbox();
    const bridge = new HostBridge(executor);
    bridge.injectInto(sandbox, 2);

    const registered = sandbox.getRegisteredFunctions();
    expect(registered).toContain('mama_search');
    expect(registered).toContain('Read');
    expect(registered).not.toContain('Write');
    expect(registered).not.toContain('Bash');
    expect(registered).not.toContain('discord_send');
  });
});

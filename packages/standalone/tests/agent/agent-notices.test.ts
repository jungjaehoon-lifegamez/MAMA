/**
 * Unit tests for agent_notices gateway tool
 */

import { describe, it, expect, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { AgentEventBus } from '../../src/multi-agent/agent-event-bus.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

describe('agent_notices gateway tool', () => {
  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({ success: true, id: 'test' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
  });

  it('returns formatted notices when eventBus is available', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    const eventBus = new AgentEventBus();

    // Emit some agent:action events
    eventBus.emit({
      type: 'agent:action',
      agent: 'dashboard-agent',
      action: 'publish',
      target: 'briefing',
    });
    eventBus.emit({
      type: 'agent:action',
      agent: 'Wiki Agent',
      action: 'compiled',
      target: 'people/John',
    });

    executor.setAgentEventBus(eventBus);

    const result = await executor.execute('agent_notices', {});
    expect(result.success).toBe(true);

    const data = (result as { success: boolean; data: { notices: unknown[] } }).data;
    expect(data.notices).toHaveLength(2);

    // Most recent first (wiki then dashboard)
    const notices = data.notices as Array<{
      agent: string;
      action: string;
      target: string;
      timestamp: string;
    }>;
    expect(notices[0].agent).toBe('Wiki Agent');
    expect(notices[0].action).toBe('compiled');
    expect(notices[0].target).toBe('people/John');
    expect(notices[1].agent).toBe('dashboard-agent');
    expect(notices[1].action).toBe('publish');
    expect(notices[1].target).toBe('briefing');
  });

  it('returns empty array when eventBus is not available', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    // Do NOT set eventBus

    const result = await executor.execute('agent_notices', {});
    expect(result.success).toBe(true);

    const data = (result as { success: boolean; data: { notices: unknown[]; message: string } })
      .data;
    expect(data.notices).toEqual([]);
    expect(data.message).toBe('Event bus not available');
  });

  it('respects limit parameter', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    const eventBus = new AgentEventBus();

    // Emit 5 events
    for (let i = 0; i < 5; i++) {
      eventBus.emit({
        type: 'agent:action',
        agent: `agent-${i}`,
        action: 'test',
        target: `target-${i}`,
      });
    }

    executor.setAgentEventBus(eventBus);

    const result = await executor.execute('agent_notices', { limit: 2 } as never);
    expect(result.success).toBe(true);

    const data = (result as { success: boolean; data: { notices: unknown[] } }).data;
    expect(data.notices).toHaveLength(2);
  });

  it('formats timestamps as ISO 8601', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    const eventBus = new AgentEventBus();

    eventBus.emit({
      type: 'agent:action',
      agent: 'test-agent',
      action: 'test',
      target: 'test-target',
    });

    executor.setAgentEventBus(eventBus);

    const result = await executor.execute('agent_notices', {});
    const data = (result as { success: boolean; data: { notices: unknown[] } }).data;
    const notices = data.notices as Array<{ timestamp: string }>;

    // ISO 8601 format check: should contain 'T' and end with 'Z'
    expect(notices[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('defaults to limit 10 when not specified', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });
    const eventBus = new AgentEventBus();

    // Emit 15 events
    for (let i = 0; i < 15; i++) {
      eventBus.emit({
        type: 'agent:action',
        agent: `agent-${i}`,
        action: 'test',
        target: `target-${i}`,
      });
    }

    executor.setAgentEventBus(eventBus);

    const result = await executor.execute('agent_notices', {});
    const data = (result as { success: boolean; data: { notices: unknown[] } }).data;
    expect(data.notices).toHaveLength(10);
  });
});

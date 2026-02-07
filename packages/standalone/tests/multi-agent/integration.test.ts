/**
 * Integration Tests for Multi-Agent Swarm Architecture
 *
 * End-to-end tests verifying the interaction between:
 * - ToolPermissionManager
 * - CategoryRouter
 * - TaskContinuationEnforcer
 * - DelegationManager
 * - UltraWorkManager
 * - MultiAgentOrchestrator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MultiAgentOrchestrator } from '../../src/multi-agent/orchestrator.js';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import { CategoryRouter } from '../../src/multi-agent/category-router.js';
import { TaskContinuationEnforcer } from '../../src/multi-agent/task-continuation.js';
import { DelegationManager } from '../../src/multi-agent/delegation-manager.js';
import { UltraWorkManager } from '../../src/multi-agent/ultrawork.js';
import type {
  AgentPersonaConfig,
  MultiAgentConfig,
  MessageContext,
  CategoryConfig,
} from '../../src/multi-agent/types.js';

/**
 * Wait for an UltraWork session to complete (non-blocking startSession).
 */
async function waitForSessionComplete(
  session: { active: boolean },
  timeoutMs = 5000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (session.active && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ============================================================================
// Test Fixtures
// ============================================================================

function makeAgent(overrides: Partial<AgentPersonaConfig> = {}): AgentPersonaConfig {
  return {
    id: 'test',
    name: 'Test',
    display_name: 'Test',
    trigger_prefix: '!test',
    persona_file: '~/.mama/personas/test.md',
    ...overrides,
  };
}

const AGENTS: AgentPersonaConfig[] = [
  makeAgent({
    id: 'sisyphus',
    name: 'Sisyphus',
    display_name: '🏔️ Sisyphus',
    trigger_prefix: '!sis',
    tier: 1,
    can_delegate: true,
    auto_continue: true,
    auto_respond_keywords: ['plan', 'architect'],
  }),
  makeAgent({
    id: 'developer',
    name: 'Developer',
    display_name: '🔧 Developer',
    trigger_prefix: '!dev',
    tier: 2,
    auto_respond_keywords: ['code', 'implement', 'build'],
  }),
  makeAgent({
    id: 'reviewer',
    name: 'Reviewer',
    display_name: '📝 Reviewer',
    trigger_prefix: '!review',
    tier: 3,
    auto_respond_keywords: ['review', 'check'],
  }),
];

const CATEGORIES: CategoryConfig[] = [
  {
    name: 'code_review',
    patterns: ['리뷰해줘', 'review\\s+(this|the)\\s+(code|PR)'],
    agent_ids: ['reviewer'],
    priority: 10,
  },
  {
    name: 'implementation',
    patterns: ['구현해줘', 'implement\\s+the\\s+'],
    agent_ids: ['developer'],
    priority: 5,
  },
  {
    name: 'architecture',
    patterns: ['아키텍처', 'architecture\\s+design'],
    agent_ids: ['sisyphus'],
    priority: 15,
  },
];

function makeConfig(overrides: Partial<MultiAgentConfig> = {}): MultiAgentConfig {
  return {
    enabled: true,
    agents: Object.fromEntries(
      AGENTS.map((a) => {
        const { id, ...rest } = a;
        return [id, rest];
      })
    ),
    loop_prevention: {
      max_chain_length: 5,
      global_cooldown_ms: 100,
      chain_window_ms: 60000,
    },
    categories: CATEGORIES,
    ...overrides,
  };
}

function makeContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    channelId: 'ch1',
    userId: 'user1',
    content: 'test message',
    isBot: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// E2E: Category Routing → Agent Response → Completion
// ============================================================================

describe('E2E: Category Routing Pipeline', () => {
  it('should route via category, not keyword, when pattern matches', () => {
    const config = makeConfig();
    const orchestrator = new MultiAgentOrchestrator(config);

    // "review the code" matches both category pattern AND reviewer keyword
    const result = orchestrator.selectRespondingAgents(
      makeContext({ content: 'Please review the code for bugs' })
    );

    // Category match should take priority over keyword match
    expect(result.reason).toBe('category_match');
    expect(result.selectedAgents).toContain('reviewer');
  });

  it('should fall through to keyword match when no category matches', () => {
    const config = makeConfig();
    const orchestrator = new MultiAgentOrchestrator(config);

    // "code" matches developer keyword but no category pattern
    const result = orchestrator.selectRespondingAgents(
      makeContext({ content: 'Fix the code in main.ts' })
    );

    expect(result.reason).toBe('keyword_match');
    expect(result.selectedAgents).toContain('developer');
  });

  it('should prioritize architecture category over others', () => {
    const config = makeConfig();
    const orchestrator = new MultiAgentOrchestrator(config);

    // architecture category has priority 15 (highest)
    const result = orchestrator.selectRespondingAgents(
      makeContext({ content: '아키텍처 설계를 해주세요' })
    );

    expect(result.reason).toBe('category_match');
    expect(result.selectedAgents).toContain('sisyphus');
  });

  it('should still honor explicit triggers over category', () => {
    const config = makeConfig();
    const orchestrator = new MultiAgentOrchestrator(config);

    // "!dev" is explicit trigger, should override category routing
    const result = orchestrator.selectRespondingAgents(
      makeContext({ content: '!dev review the code' })
    );

    expect(result.reason).toBe('explicit_trigger');
    expect(result.selectedAgents).toEqual(['developer']);
  });
});

// ============================================================================
// E2E: Delegation Chain (Sisyphus → Developer → Reviewer)
// ============================================================================

describe('E2E: Delegation Chain', () => {
  it('should execute delegation from Tier 1 to Tier 2', async () => {
    const permManager = new ToolPermissionManager();
    const delegationManager = new DelegationManager(AGENTS, permManager);

    const executeCallback = vi.fn().mockResolvedValue({
      response: 'Implementation complete. DONE',
      duration_ms: 200,
    });
    const notifyCallback = vi.fn().mockResolvedValue(undefined);

    // Sisyphus delegates to developer
    const request = delegationManager.parseDelegation(
      'sisyphus',
      'I need help. DELEGATE::developer::Build the authentication module'
    );

    expect(request).not.toBeNull();

    const result = await delegationManager.executeDelegation(
      request!,
      executeCallback,
      notifyCallback
    );

    expect(result.success).toBe(true);
    expect(result.response).toContain('Implementation complete');
    expect(executeCallback).toHaveBeenCalledWith(
      'developer',
      expect.stringContaining('Build the authentication')
    );
  });

  it('should prevent Tier 2 from delegating', async () => {
    const delegationManager = new DelegationManager(AGENTS);

    const check = delegationManager.isDelegationAllowed('developer', 'reviewer');
    expect(check.allowed).toBe(false);
  });

  it('should prevent circular delegation during active delegation', async () => {
    const delegationManager = new DelegationManager(AGENTS);

    const executeCallback = vi.fn().mockImplementation(async () => {
      // During execution, verify reverse delegation is blocked
      const reverseCheck = delegationManager.isDelegationAllowed('developer', 'sisyphus');
      expect(reverseCheck.allowed).toBe(false);
      return { response: 'Done', duration_ms: 100 };
    });

    const request = {
      fromAgentId: 'sisyphus',
      toAgentId: 'developer',
      task: 'Test task',
      originalContent: '',
    };

    await delegationManager.executeDelegation(request, executeCallback);
  });
});

// ============================================================================
// E2E: Task Continuation with Delegation
// ============================================================================

describe('E2E: Task Continuation + Delegation', () => {
  it('should continue incomplete responses and then complete', () => {
    const enforcer = new TaskContinuationEnforcer({
      enabled: true,
      max_retries: 3,
    });

    // Step 1: Incomplete response
    const r1 = enforcer.analyzeResponse('sisyphus', 'ch1', "I'll continue with the next part");
    expect(r1.isComplete).toBe(false);
    expect(r1.attempt).toBe(1);

    // Step 2: Build continuation prompt
    const prompt = enforcer.buildContinuationPrompt("I'll continue with the next part");
    expect(prompt).toContain('Continue from where you left off');

    // Step 3: Agent completes
    const r2 = enforcer.analyzeResponse('sisyphus', 'ch1', 'All tasks DONE.');
    expect(r2.isComplete).toBe(true);
    expect(enforcer.getAttemptCount('ch1')).toBe(0);
  });

  it('should stop after max retries', () => {
    const enforcer = new TaskContinuationEnforcer({
      enabled: true,
      max_retries: 2,
    });

    enforcer.analyzeResponse('sisyphus', 'ch1', "I'll continue next");
    const r2 = enforcer.analyzeResponse('sisyphus', 'ch1', '계속하겠습니다');

    expect(r2.maxRetriesReached).toBe(true);
    expect(r2.attempt).toBe(2);
  });
});

// ============================================================================
// E2E: UltraWork Session
// ============================================================================

describe('E2E: UltraWork Session', () => {
  it('should run a full UltraWork session with delegation and completion', async () => {
    const manager = new UltraWorkManager({
      enabled: true,
      max_steps: 10,
      max_duration: 30000,
    });

    let callCount = 0;
    const executeCallback = vi.fn().mockImplementation(async (agentId: string) => {
      callCount++;

      if (callCount === 1) {
        // Lead agent delegates
        return {
          response: 'Let me plan this. DELEGATE::developer::Implement the login feature',
          duration_ms: 100,
        };
      }
      if (callCount === 2 && agentId === 'developer') {
        // Developer completes delegated task
        return {
          response: 'Login feature implemented with JWT authentication. DONE',
          duration_ms: 300,
        };
      }
      if (callCount === 3) {
        // Lead agent delegates review
        return {
          response: 'Now for review. DELEGATE::reviewer::Review the login implementation',
          duration_ms: 50,
        };
      }
      if (callCount === 4 && agentId === 'reviewer') {
        return {
          response: 'Code looks good, approved. DONE',
          duration_ms: 150,
        };
      }
      // Final completion
      return {
        response: 'All tasks completed. Login feature is built and reviewed. DONE',
        duration_ms: 50,
      };
    });

    const notifyCallback = vi.fn().mockResolvedValue(undefined);

    const session = await manager.startSession(
      'ch1',
      'sisyphus',
      'Build and review login feature',
      AGENTS,
      executeCallback,
      notifyCallback
    );

    await waitForSessionComplete(session);

    expect(session.active).toBe(false);
    expect(session.steps.length).toBeGreaterThanOrEqual(3);

    // Verify notifications were sent
    const notifyCalls = notifyCallback.mock.calls.map((c) => c[0]);
    expect(notifyCalls.some((n: string) => n.includes('UltraWork Session Started'))).toBe(true);
    expect(notifyCalls.some((n: string) => n.includes('Complete') || n.includes('Ended'))).toBe(
      true
    );
  });

  it('should stop UltraWork session at max steps', async () => {
    const manager = new UltraWorkManager({
      enabled: true,
      max_steps: 3,
      max_duration: 60000,
    });

    const executeCallback = vi.fn().mockResolvedValue({
      response: "Working on it, I'll continue more",
      duration_ms: 50,
    });
    const notifyCallback = vi.fn().mockResolvedValue(undefined);

    const session = await manager.startSession(
      'ch1',
      'sisyphus',
      'Long running task',
      AGENTS,
      executeCallback,
      notifyCallback
    );

    await waitForSessionComplete(session);

    expect(session.active).toBe(false);
    // Should be limited by max_steps + continuation retries
    expect(session.currentStep).toBeLessThanOrEqual(6); // 3 steps + up to 3 continuations
  });
});

// ============================================================================
// Backward Compatibility
// ============================================================================

describe('Backward Compatibility', () => {
  it('should work without any new config fields', () => {
    const minimalConfig: MultiAgentConfig = {
      enabled: true,
      agents: {
        bot1: {
          name: 'Bot1',
          display_name: 'Bot1',
          trigger_prefix: '!bot1',
          persona_file: '~/.mama/personas/bot1.md',
          auto_respond_keywords: ['hello'],
        },
      },
      loop_prevention: {
        max_chain_length: 3,
        global_cooldown_ms: 500,
        chain_window_ms: 60000,
      },
    };

    const orchestrator = new MultiAgentOrchestrator(minimalConfig);

    const result = orchestrator.selectRespondingAgents(makeContext({ content: 'hello world' }));

    expect(result.selectedAgents).toEqual(['bot1']);
    expect(result.reason).toBe('keyword_match');
  });

  it('should default agents to Tier 1 with full permissions', () => {
    const permManager = new ToolPermissionManager();
    const agent = makeAgent(); // No tier specified

    expect(permManager.resolvePermissions(agent).allowed).toEqual(['*']);
    expect(permManager.resolvePermissions(agent).blocked).toEqual([]);
    expect(permManager.isToolAllowed(agent, 'Bash')).toBe(true);
    expect(permManager.isToolAllowed(agent, 'Write')).toBe(true);
  });

  it('should not break free_chat mode with new features', () => {
    const config = makeConfig({ free_chat: true });
    const orchestrator = new MultiAgentOrchestrator(config);

    const result = orchestrator.selectRespondingAgents(makeContext({ content: 'Hello everyone' }));

    expect(result.reason).toBe('free_chat');
    expect(result.selectedAgents.length).toBe(3); // All agents
  });

  it('should preserve existing selection order: free_chat > trigger > category > keyword > default', () => {
    // Test 1: free_chat takes priority
    const freeChatConfig = makeConfig({ free_chat: true });
    const orch1 = new MultiAgentOrchestrator(freeChatConfig);
    const r1 = orch1.selectRespondingAgents(makeContext({ content: '!dev review the code' }));
    expect(r1.reason).toBe('free_chat');

    // Test 2: trigger takes priority over category
    const config = makeConfig();
    const orch2 = new MultiAgentOrchestrator(config);
    const r2 = orch2.selectRespondingAgents(
      makeContext({ content: '!dev review the code for bugs' })
    );
    expect(r2.reason).toBe('explicit_trigger');
    expect(r2.selectedAgents).toEqual(['developer']);

    // Test 3: category takes priority over keyword
    const r3 = orch2.selectRespondingAgents(makeContext({ content: 'Please review the code' }));
    expect(r3.reason).toBe('category_match');

    // Test 4: keyword fallback
    const r4 = orch2.selectRespondingAgents(makeContext({ content: 'Fix the code please' }));
    expect(r4.reason).toBe('keyword_match');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should handle delegation failure gracefully in UltraWork', async () => {
    const manager = new UltraWorkManager({
      enabled: true,
      max_steps: 5,
      max_duration: 30000,
    });

    let callCount = 0;
    const executeCallback = vi.fn().mockImplementation(async (agentId: string) => {
      callCount++;
      if (callCount === 1) {
        // Lead delegates to non-existent agent
        return {
          response: 'DELEGATE::nonexistent::Do something',
          duration_ms: 50,
        };
      }
      // After failed delegation, complete
      return { response: 'Handled it myself. DONE', duration_ms: 50 };
    });
    const notifyCallback = vi.fn().mockResolvedValue(undefined);

    const session = await manager.startSession(
      'ch1',
      'sisyphus',
      'Edge case task',
      AGENTS,
      executeCallback,
      notifyCallback
    );

    await waitForSessionComplete(session);

    // Should not crash, should continue and complete
    expect(session.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle empty message content in category routing', () => {
    const router = new CategoryRouter(CATEGORIES);
    const result = router.route('', AGENTS);
    expect(result).toBeNull();
  });

  it('should handle agent with all fields set', () => {
    const permManager = new ToolPermissionManager();
    const agent = makeAgent({
      tier: 1,
      can_delegate: true,
      auto_continue: true,
      tool_permissions: {
        allowed: ['*'],
        blocked: ['Bash'],
      },
    });

    expect(permManager.canDelegate(agent)).toBe(true);
    expect(permManager.canAutoContinue(agent)).toBe(true);
    expect(permManager.isToolAllowed(agent, 'Read')).toBe(true);
    expect(permManager.isToolAllowed(agent, 'Bash')).toBe(false);
  });

  it('should handle ToolPermissionManager with all tiers', () => {
    const permManager = new ToolPermissionManager();

    for (const tier of [1, 2, 3] as const) {
      const agent = makeAgent({ tier });
      const perms = permManager.resolvePermissions(agent);
      expect(perms.allowed.length).toBeGreaterThan(0);
    }
  });

  it('should handle concurrent UltraWork trigger detection', () => {
    const manager = new UltraWorkManager({ enabled: true });

    const messages = [
      'Start ultrawork on the project',
      '울트라워크 모드로 작업',
      'Do deep work please',
      'Run this in autonomous mode',
      '자율 작업으로 진행해줘',
    ];

    for (const msg of messages) {
      expect(manager.isUltraWorkTrigger(msg)).toBe(true);
    }
  });

  it('should handle delegation with task containing special characters', async () => {
    const delegationManager = new DelegationManager(AGENTS);
    const response =
      'DELEGATE::developer::Build API with endpoints: /users, /posts?limit=10&offset=0';
    const request = delegationManager.parseDelegation('sisyphus', response);

    expect(request).not.toBeNull();
    expect(request!.task).toContain('/users');
    expect(request!.task).toContain('limit=10');
  });
});

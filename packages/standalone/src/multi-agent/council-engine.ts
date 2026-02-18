/**
 * Council Engine
 *
 * Parses council_plan blocks from Conductor responses,
 * validates agent availability, and executes multi-round
 * discussions among existing named agents.
 *
 * Unlike WorkflowEngine (ephemeral agents, DAG execution),
 * CouncilEngine reuses existing agents and runs sequential rounds
 * with full history accumulation.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  CouncilPlan,
  CouncilConfig,
  CouncilRoundResult,
  CouncilExecution,
  CouncilProgressEvent,
} from './workflow-types.js';

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_ROUND_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes per agent per round

export type CouncilStepExecutor = (
  agentId: string,
  prompt: string,
  timeoutMs: number
) => Promise<string>;

/**
 * CouncilEngine
 *
 * Events:
 * - 'progress': CouncilProgressEvent
 */
export class CouncilEngine extends EventEmitter {
  private config: CouncilConfig;
  private activeExecutions = new Map<string, { cancelled: boolean }>();

  constructor(config: CouncilConfig) {
    super();
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Parse a council_plan JSON block from Conductor's response.
   */
  parseCouncilPlan(response: string): CouncilPlan | null {
    const match = response.match(/```council_plan\s*\n([\s\S]*?)\n```/);
    if (!match) return null;

    try {
      const plan = JSON.parse(match[1].trim()) as CouncilPlan;

      if (
        typeof plan.name !== 'string' ||
        !plan.name.trim() ||
        typeof plan.topic !== 'string' ||
        !plan.topic.trim() ||
        !Array.isArray(plan.agents) ||
        plan.agents.length === 0 ||
        typeof plan.rounds !== 'number' ||
        plan.rounds < 1
      ) {
        return null;
      }

      // Validate agent IDs are strings
      if (!plan.agents.every((a) => typeof a === 'string' && a.trim().length > 0)) {
        return null;
      }

      return plan;
    } catch {
      return null;
    }
  }

  /**
   * Extract text content outside the council_plan block.
   */
  extractNonPlanContent(response: string): string {
    return response.replace(/```council_plan\s*\n[\s\S]*?\n```/, '').trim();
  }

  /**
   * Validate plan against available agents and config limits.
   * Returns error message or null if valid.
   */
  validatePlan(plan: CouncilPlan, availableAgentIds: string[]): string | null {
    const maxRounds = this.config.max_rounds ?? DEFAULT_MAX_ROUNDS;
    if (plan.rounds > maxRounds) {
      return `Too many rounds (${plan.rounds}), max is ${maxRounds}`;
    }

    if (plan.rounds < 1) {
      return 'Rounds must be at least 1';
    }

    const available = new Set(availableAgentIds);
    const missing = plan.agents.filter((id) => !available.has(id));
    if (missing.length > 0) {
      return `Unknown agent(s): ${missing.join(', ')}`;
    }

    if (plan.agents.length < 2) {
      return 'Council requires at least 2 agents';
    }

    return null;
  }

  /**
   * Execute a council discussion plan.
   */
  async execute(
    plan: CouncilPlan,
    executeStep: CouncilStepExecutor,
    agentDisplayNames: Map<string, string>
  ): Promise<{ result: string; execution: CouncilExecution }> {
    const executionId = randomUUID();
    const executionState = { cancelled: false };
    this.activeExecutions.set(executionId, executionState);

    const maxDuration = plan.timeout_ms ?? this.config.max_duration_ms ?? DEFAULT_MAX_DURATION_MS;
    const execution: CouncilExecution = {
      id: executionId,
      planName: plan.name,
      topic: plan.topic,
      startedAt: Date.now(),
      status: 'running',
      rounds: [],
    };

    const allResults: CouncilRoundResult[] = [];

    const globalTimeout = setTimeout(() => {
      executionState.cancelled = true;
    }, maxDuration);

    try {
      for (let round = 1; round <= plan.rounds; round++) {
        if (executionState.cancelled) break;

        for (const agentId of plan.agents) {
          if (executionState.cancelled) break;

          const displayName = agentDisplayNames.get(agentId) ?? agentId;

          this.emitProgress({
            type: 'council-round-started',
            executionId,
            round,
            agentId,
            agentDisplayName: displayName,
          });

          const prompt = this.buildRoundPrompt(plan.topic, allResults, round, agentId, displayName);
          const start = Date.now();

          try {
            const response = await executeStep(agentId, prompt, DEFAULT_ROUND_TIMEOUT_MS);
            const duration_ms = Date.now() - start;

            const roundResult: CouncilRoundResult = {
              round,
              agentId,
              agentDisplayName: displayName,
              response,
              duration_ms,
              status: 'success',
            };
            allResults.push(roundResult);
            execution.rounds.push(roundResult);

            this.emitProgress({
              type: 'council-round-completed',
              executionId,
              round,
              agentId,
              agentDisplayName: displayName,
              response: response.substring(0, 500),
              duration_ms,
            });
          } catch (error) {
            const duration_ms = Date.now() - start;
            const errorMsg = error instanceof Error ? error.message : String(error);

            const roundResult: CouncilRoundResult = {
              round,
              agentId,
              agentDisplayName: displayName,
              response: '',
              duration_ms,
              status: errorMsg.includes('timeout') ? 'timeout' : 'failed',
              error: errorMsg,
            };
            allResults.push(roundResult);
            execution.rounds.push(roundResult);

            this.emitProgress({
              type: 'council-round-failed',
              executionId,
              round,
              agentId,
              agentDisplayName: displayName,
              error: errorMsg,
              duration_ms,
            });
            // Council continues even if an agent fails
          }
        }
      }

      if (executionState.cancelled && execution.status === 'running') {
        execution.status = 'cancelled';
      } else if (execution.status === 'running') {
        execution.status = 'completed';
      }
    } finally {
      clearTimeout(globalTimeout);
      this.activeExecutions.delete(executionId);
    }

    execution.completedAt = Date.now();

    const result = this.buildFinalResult(plan, execution);

    this.emitProgress({
      type: 'council-completed',
      executionId,
      summary: result,
      duration_ms: execution.completedAt - execution.startedAt,
    });

    return { result, execution };
  }

  /**
   * Cancel a running council execution.
   */
  cancel(executionId: string): boolean {
    const state = this.activeExecutions.get(executionId);
    if (state) {
      state.cancelled = true;
      return true;
    }
    return false;
  }

  /**
   * Build prompt for a specific round + agent, including all previous responses.
   */
  buildRoundPrompt(
    topic: string,
    previousResults: CouncilRoundResult[],
    currentRound: number,
    currentAgentId: string,
    currentDisplayName: string
  ): string {
    const parts: string[] = [];

    parts.push(`## Council Discussion: ${topic}`);
    parts.push(
      `You are **${currentDisplayName}** participating in Round ${currentRound} of a council discussion.`
    );
    parts.push(`Topic: ${topic}`);
    parts.push('');

    if (previousResults.length > 0) {
      parts.push('### Previous Responses');
      for (const r of previousResults) {
        if (r.status === 'success') {
          const marker = r.agentId === currentAgentId ? ' (you)' : '';
          parts.push(`**${r.agentDisplayName}${marker}** (Round ${r.round}):`);
          parts.push(r.response);
          parts.push('');
        }
      }
    }

    parts.push(`### Your Turn (Round ${currentRound})`);
    if (currentRound === 1) {
      parts.push('Share your perspective on the topic. Be specific and provide reasoning.');
    } else {
      parts.push(
        'Consider what others have said, then share your updated perspective. You may agree, disagree, or build on previous points.'
      );
    }

    return parts.join('\n');
  }

  /**
   * Build final combined result from all rounds.
   */
  private buildFinalResult(plan: CouncilPlan, execution: CouncilExecution): string {
    if (execution.status === 'cancelled') {
      return `Council "${plan.name}" was cancelled.`;
    }

    const parts: string[] = [];
    const totalMs = execution.completedAt
      ? execution.completedAt - execution.startedAt
      : Date.now() - execution.startedAt;
    const totalSec = Math.round(totalMs / 1000);

    parts.push(`## Council: ${plan.name} (${totalSec}s)`);
    parts.push(`**Topic:** ${plan.topic}`);
    parts.push('');

    // Group by round
    for (let round = 1; round <= plan.rounds; round++) {
      const roundResults = execution.rounds.filter((r) => r.round === round);
      if (roundResults.length === 0) continue;

      parts.push(`### Round ${round}`);
      for (const r of roundResults) {
        if (r.status === 'success') {
          parts.push(`**${r.agentDisplayName}:**`);
          parts.push(r.response);
        } else {
          parts.push(`**${r.agentDisplayName}:** ❌ ${r.status}: ${r.error}`);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  private emitProgress(event: CouncilProgressEvent): void {
    this.emit('progress', event);
  }
}

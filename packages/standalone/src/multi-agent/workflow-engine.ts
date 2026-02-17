/**
 * Workflow Engine
 *
 * Parses workflow plans from Conductor responses, validates DAGs,
 * executes steps in topological order with parallel execution per level,
 * and emits progress events for platform handlers.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  WorkflowPlan,
  WorkflowStep,
  WorkflowConfig,
  StepResult,
  WorkflowExecution,
  WorkflowProgressEvent,
  EphemeralAgentDef,
} from './workflow-types.js';

const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_EPHEMERAL = 5;
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export class StepExecutionError extends Error {
  duration_ms: number;
  stepId: string;
  agentId: string;

  constructor(message: string, stepId: string, agentId: string, duration_ms: number) {
    super(message);
    this.name = 'StepExecutionError';
    this.stepId = stepId;
    this.agentId = agentId;
    this.duration_ms = duration_ms;
  }
}

export type StepExecutor = (
  agent: EphemeralAgentDef,
  prompt: string,
  timeoutMs: number
) => Promise<string>;

/**
 * WorkflowEngine
 *
 * Events:
 * - 'progress': WorkflowProgressEvent
 */
export class WorkflowEngine extends EventEmitter {
  private config: WorkflowConfig;
  private activeExecutions = new Map<string, { cancelled: boolean }>();

  constructor(config: WorkflowConfig) {
    super();
    this.config = config;
  }

  /**
   * Parse a workflow_plan JSON block from Conductor's response.
   * Returns null if no valid plan is found.
   */
  parseWorkflowPlan(response: string): WorkflowPlan | null {
    const match = response.match(/```workflow_plan\s*\n([\s\S]*?)\n```/);
    if (!match) return null;

    try {
      const plan = JSON.parse(match[1].trim()) as WorkflowPlan;
      if (!plan.name || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        return null;
      }

      // Validate each step has required fields
      for (const step of plan.steps) {
        if (!step.id || !step.agent || !step.prompt) return null;
        if (
          !step.agent.id ||
          !step.agent.display_name ||
          !step.agent.backend ||
          !step.agent.model ||
          !step.agent.system_prompt
        ) {
          return null;
        }
      }

      return plan;
    } catch {
      return null;
    }
  }

  /**
   * Extract text content outside the workflow_plan block (for display as Conductor's direct message).
   */
  extractNonPlanContent(response: string): string {
    return response.replace(/```workflow_plan\s*\n[\s\S]*?\n```/, '').trim();
  }

  /**
   * Validate DAG structure: no cycles, valid dependencies, agent limits.
   * Returns error message or null if valid.
   */
  validatePlan(plan: WorkflowPlan): string | null {
    const maxAgents = this.config.max_ephemeral_agents ?? DEFAULT_MAX_EPHEMERAL;
    if (plan.steps.length > maxAgents) {
      return `Too many steps (${plan.steps.length}), max is ${maxAgents}`;
    }

    const stepIds = new Set(plan.steps.map((s) => s.id));

    // Check for duplicate step IDs
    if (stepIds.size !== plan.steps.length) {
      return 'Duplicate step IDs detected';
    }

    // Check dependency references
    for (const step of plan.steps) {
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          if (!stepIds.has(dep)) {
            return `Step "${step.id}" depends on unknown step "${dep}"`;
          }
          if (dep === step.id) {
            return `Step "${step.id}" depends on itself`;
          }
        }
      }
    }

    // Cycle detection via topological sort
    const sorted = this.topologicalSort(plan.steps);
    if (!sorted) {
      return 'Cycle detected in workflow DAG';
    }

    return null;
  }

  /**
   * Topological sort of workflow steps.
   * Returns sorted steps or null if a cycle exists.
   */
  topologicalSort(steps: WorkflowStep[]): WorkflowStep[] | null {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    const stepMap = new Map<string, WorkflowStep>();

    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    for (const step of steps) {
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          if (!adjacency.has(dep)) {
            throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
          }
          adjacency.get(dep)!.push(step.id);
          inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: WorkflowStep[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(stepMap.get(id)!);
      for (const neighbor of adjacency.get(id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return sorted.length === steps.length ? sorted : null;
  }

  /**
   * Group steps into execution levels (steps at same level run in parallel).
   */
  buildExecutionLevels(steps: WorkflowStep[]): WorkflowStep[][] {
    const sorted = this.topologicalSort(steps);
    if (!sorted) return [];

    const levelMap = new Map<string, number>();

    for (const step of sorted) {
      let maxDepLevel = -1;
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          const depLevel = levelMap.get(dep) ?? 0;
          if (depLevel > maxDepLevel) maxDepLevel = depLevel;
        }
      }
      levelMap.set(step.id, maxDepLevel + 1);
    }

    const levels: WorkflowStep[][] = [];
    for (const step of sorted) {
      const level = levelMap.get(step.id) ?? 0;
      while (levels.length <= level) levels.push([]);
      levels[level].push(step);
    }

    return levels;
  }

  /**
   * Execute a workflow plan.
   *
   * @param plan - Validated workflow plan
   * @param executeStep - Callback to execute a single step (provided by platform handler)
   * @returns Execution result with all step outputs
   */
  async execute(
    plan: WorkflowPlan,
    executeStep: StepExecutor
  ): Promise<{ result: string; execution: WorkflowExecution }> {
    const executionId = randomUUID();
    const executionState = { cancelled: false };
    this.activeExecutions.set(executionId, executionState);

    const maxDuration = this.config.max_duration_ms ?? DEFAULT_MAX_DURATION_MS;
    const execution: WorkflowExecution = {
      id: executionId,
      planName: plan.name,
      startedAt: Date.now(),
      status: 'running',
      steps: [],
    };

    const stepResults = new Map<string, StepResult>();
    const levels = this.buildExecutionLevels(plan.steps);

    // Global timeout
    const globalTimeout = setTimeout(() => {
      executionState.cancelled = true;
    }, maxDuration);

    try {
      for (const level of levels) {
        if (executionState.cancelled) break;

        const levelResults = await Promise.allSettled(
          level.map((step) =>
            this.executeStep(step, stepResults, executeStep, executionId, executionState)
          )
        );

        for (let i = 0; i < levelResults.length; i++) {
          const step = level[i];
          const levelResult = levelResults[i];

          if (levelResult.status === 'fulfilled') {
            stepResults.set(step.id, levelResult.value);
            execution.steps.push(levelResult.value);
          } else {
            const reason = levelResult.reason;
            const duration_ms = reason instanceof StepExecutionError ? reason.duration_ms : 0;
            const failedResult: StepResult = {
              stepId: step.id,
              agentId: step.agent.id,
              result: '',
              duration_ms,
              status: 'failed',
              error: reason?.message || String(reason),
            };
            stepResults.set(step.id, failedResult);
            execution.steps.push(failedResult);

            if (!step.optional) {
              execution.status = 'failed';
              break;
            }
          }
        }

        if (execution.status === 'failed') break;
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

    // Build final result
    const result = this.buildFinalResult(plan, stepResults, execution);

    this.emitProgress({
      type: 'workflow-completed',
      executionId,
      summary: result,
      duration_ms: execution.completedAt - execution.startedAt,
    });

    return { result, execution };
  }

  /**
   * Cancel a running workflow execution.
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
   * Check if workflow orchestration is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  private async executeStep(
    step: WorkflowStep,
    previousResults: Map<string, StepResult>,
    executeStep: StepExecutor,
    executionId: string,
    executionState: { cancelled: boolean }
  ): Promise<StepResult> {
    if (executionState.cancelled) {
      return {
        stepId: step.id,
        agentId: step.agent.id,
        result: '',
        duration_ms: 0,
        status: 'skipped',
      };
    }

    this.emitProgress({
      type: 'step-started',
      executionId,
      stepId: step.id,
      agentDisplayName: step.agent.display_name,
      agentBackend: step.agent.backend,
      agentModel: step.agent.model,
    });

    // Interpolate previous step results into prompt
    const resolvedPrompt = this.interpolatePrompt(step.prompt, previousResults);
    const timeout = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
    const start = Date.now();

    try {
      const result = await executeStep(step.agent, resolvedPrompt, timeout);
      const duration_ms = Date.now() - start;

      this.emitProgress({
        type: 'step-completed',
        executionId,
        stepId: step.id,
        agentDisplayName: step.agent.display_name,
        agentBackend: step.agent.backend,
        agentModel: step.agent.model,
        result: result.substring(0, 500),
        duration_ms,
      });

      return {
        stepId: step.id,
        agentId: step.agent.id,
        result,
        duration_ms,
        status: 'success',
      };
    } catch (error) {
      const duration_ms = Date.now() - start;
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.emitProgress({
        type: 'step-failed',
        executionId,
        stepId: step.id,
        agentDisplayName: step.agent.display_name,
        agentBackend: step.agent.backend,
        agentModel: step.agent.model,
        error: errorMsg,
        duration_ms,
      });

      if (step.optional) {
        return {
          stepId: step.id,
          agentId: step.agent.id,
          result: '',
          duration_ms,
          status: 'failed',
          error: errorMsg,
        };
      }

      throw new StepExecutionError(errorMsg, step.id, step.agent.id, duration_ms);
    }
  }

  /**
   * Replace {{step_id.result}} placeholders with actual step results.
   */
  private interpolatePrompt(prompt: string, results: Map<string, StepResult>): string {
    return prompt.replace(/\{\{(\w[\w-]*)\.result\}\}/g, (_match, stepId: string) => {
      const result = results.get(stepId);
      if (!result || result.status !== 'success') {
        return `[Step "${stepId}" not available]`;
      }
      return result.result;
    });
  }

  /**
   * Build the final combined result from all step outputs.
   */
  private buildFinalResult(
    plan: WorkflowPlan,
    results: Map<string, StepResult>,
    execution: WorkflowExecution
  ): string {
    if (execution.status === 'cancelled') {
      return `Workflow "${plan.name}" was cancelled.`;
    }

    // If synthesis step is defined, use its template
    if (plan.synthesis?.prompt_template) {
      return this.interpolatePrompt(plan.synthesis.prompt_template, results);
    }

    // Default: concatenate all successful step results
    const parts: string[] = [];
    for (const step of plan.steps) {
      const result = results.get(step.id);
      if (result && result.status === 'success' && result.result) {
        parts.push(`### ${step.agent.display_name}\n${result.result}`);
      } else if (result && result.status === 'failed') {
        parts.push(`### ${step.agent.display_name}\n❌ Failed: ${result.error}`);
      }
    }

    const totalMs = execution.completedAt
      ? execution.completedAt - execution.startedAt
      : Date.now() - execution.startedAt;
    const totalSec = Math.round(totalMs / 1000);

    return `## Workflow: ${plan.name} (${totalSec}s)\n\n${parts.join('\n\n')}`;
  }

  private emitProgress(event: WorkflowProgressEvent): void {
    this.emit('progress', event);
  }
}

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
  AgentBackend,
  WorkflowPlan,
  WorkflowStep,
  WorkflowConfig,
  StepResult,
  WorkflowExecution,
  WorkflowProgressEvent,
  EphemeralAgentDef,
} from './workflow-types.js';

const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_EPHEMERAL = 20;
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
    const candidates = this.extractWorkflowPlanCandidates(response);
    if (candidates.length === 0) {
      return null;
    }

    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0;

    for (const block of candidates) {
      try {
        const content = this.stripWorkflowFence(block);
        const plan = this.parseWorkflowPlanContent(content);
        if (!plan) {
          continue;
        }

        if (!isNonEmptyString(plan.name) || !Array.isArray(plan.steps) || plan.steps.length === 0) {
          continue;
        }

        const hasValidDependsOn = (deps: unknown): deps is string[] =>
          deps === undefined || (Array.isArray(deps) && deps.every((d) => isNonEmptyString(d)));

        // Validate each step has required fields
        let isValid = true;
        for (const step of plan.steps) {
          if (!isNonEmptyString(step.id) || !step.agent || !isNonEmptyString(step.prompt)) {
            isValid = false;
            break;
          }
          if (!hasValidDependsOn(step.depends_on)) {
            isValid = false;
            break;
          }
          if (
            !isNonEmptyString(step.agent.id) ||
            !isNonEmptyString(step.agent.display_name) ||
            !isNonEmptyString(step.agent.backend) ||
            !isNonEmptyString(step.agent.model) ||
            !isNonEmptyString(step.agent.system_prompt)
          ) {
            isValid = false;
            break;
          }
        }
        if (!isValid) {
          continue;
        }

        return plan;
      } catch {
        continue;
      }
    }

    return null;
  }

  private extractWorkflowPlanBlock(response: string): string | null {
    const openMatch = response.match(/```workflow_plan\b[^\n]*\n?/i);
    if (!openMatch || openMatch.index === undefined) {
      return null;
    }

    const openIndex = openMatch.index;
    const closeIndex = response.indexOf('```', openIndex + openMatch[0].length);
    return closeIndex === -1
      ? response.slice(openIndex)
      : response.slice(openIndex, closeIndex + 3);
  }

  private extractWorkflowPlanCandidates(response: string): string[] {
    const candidates = new Set<string>();
    const blockMatches = response.matchAll(/```workflow_plan\b[^\n]*\n?[\s\S]*?(?:```|$)/gi);
    for (const match of blockMatches) {
      if (match[0]) {
        candidates.add(match[0].trim());
      }
    }

    const plainMatch = this.extractFirstJsonObject(response);
    if (plainMatch) {
      candidates.add(plainMatch);
    }

    if (response.toLowerCase().includes('workflow_plan') && candidates.size === 0) {
      const body = response.replace(/```workflow_plan[\s\S]*/i, '').trim();
      if (body) {
        candidates.add(body);
      }
    }

    return [...candidates];
  }

  private stripWorkflowFence(block: string): string {
    let withoutHeader = block.replace(/^```workflow_plan\b[^\n]*\n?/i, '');
    withoutHeader = withoutHeader.replace(/^\n*```json\s*\n?/i, '');
    withoutHeader = withoutHeader.replace(/\n*```\s*$/i, '');
    return withoutHeader.trim();
  }

  private parseWorkflowPlanContent(content: string): WorkflowPlan | null {
    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }

    const directParse = (): WorkflowPlan | null => {
      try {
        return JSON.parse(trimmed) as WorkflowPlan;
      } catch {
        return null;
      }
    };

    const parsedDirect = directParse();
    if (parsedDirect) {
      return parsedDirect;
    }

    const jsonCandidate = this.extractFirstJsonObject(trimmed);
    if (!jsonCandidate) {
      return null;
    }

    try {
      return JSON.parse(jsonCandidate) as WorkflowPlan;
    } catch {
      return null;
    }
  }

  private extractFirstJsonObject(text: string): string | null {
    let inString = false;
    let escaped = false;
    let braces = 0;
    let start = -1;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (ch === '"' && !escaped) {
        inString = !inString;
        continue;
      }

      if (inString) {
        escaped = ch === '\\' && !escaped;
        continue;
      }

      if (ch === '{') {
        if (start === -1) {
          start = i;
        }
        braces += 1;
      } else if (ch === '}') {
        if (start === -1) {
          return null;
        }
        braces -= 1;
        if (braces === 0) {
          return text.slice(start, i + 1);
        }
      }

      escaped = false;
    }

    return null;
  }

  /**
   * Extract text content outside the workflow_plan block (for display as Conductor's direct message).
   */
  extractNonPlanContent(response: string): string {
    // 1) Fenced ```workflow_plan block
    const block = this.extractWorkflowPlanBlock(response);
    if (block) {
      return response.replace(block, '').trim();
    }

    // 2) Unfenced JSON plan — parseWorkflowPlan can parse these,
    //    so we must strip them too to avoid raw JSON in Slack.
    const jsonObj = this.extractFirstJsonObject(response);
    if (jsonObj) {
      try {
        const parsed = JSON.parse(jsonObj);
        if (parsed && parsed.name && Array.isArray(parsed.steps)) {
          return response.replace(jsonObj, '').trim();
        }
      } catch {
        // not valid JSON, keep response as-is
      }
    }

    return response.trim();
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
          if (typeof dep !== 'string') {
            return null;
          }
          const dependents = adjacency.get(dep);
          if (!dependents) {
            return null;
          }
          dependents.push(step.id);
          inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    const sorted: WorkflowStep[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const currentStep = stepMap.get(id);
      if (!currentStep) {
        return null;
      }
      sorted.push(currentStep);
      for (const neighbor of adjacency.get(id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return sorted.length === steps.length ? sorted : null;
  }

  /**
   * Group steps into execution levels (steps at same level run in parallel).
   */
  buildExecutionLevels(steps: WorkflowStep[]): WorkflowStep[][] {
    const sorted = this.topologicalSort(steps);
    if (!sorted) {
      return [];
    }

    const levelMap = new Map<string, number>();

    for (const step of sorted) {
      let maxDepLevel = -1;
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          const depLevel = levelMap.get(dep) ?? 0;
          if (depLevel > maxDepLevel) {
            maxDepLevel = depLevel;
          }
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

    if (this.config.backend_balancing !== false) {
      this.balanceBackends(plan.steps);
    }

    const levels = this.buildExecutionLevels(plan.steps);
    const totalSteps = plan.steps.length;
    const completedCounter = { count: 0 };

    // Global timeout
    const globalTimeout = setTimeout(() => {
      executionState.cancelled = true;
    }, maxDuration);

    try {
      for (const level of levels) {
        if (executionState.cancelled) {
          break;
        }

        const maxConcurrent = this.config.max_concurrent_steps ?? 3;
        const levelResults = await this.runWithConcurrencyLimit(level, maxConcurrent, (step) =>
          this.executeStep(
            step,
            stepResults,
            executeStep,
            executionId,
            executionState,
            totalSteps,
            completedCounter
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
            const duration_ms =
              reason instanceof StepExecutionError
                ? reason.duration_ms
                : typeof reason?.duration_ms === 'number'
                  ? reason.duration_ms
                  : 0;
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

        if (execution.status === 'failed') {
          break;
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
    executionState: { cancelled: boolean },
    totalSteps?: number,
    completedCounter?: { count: number }
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
      completedSteps: completedCounter?.count,
      totalSteps,
    });

    // Interpolate previous step results into prompt
    const resolvedPrompt = this.interpolatePrompt(step.prompt, previousResults);
    const timeout = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
    const start = Date.now();

    try {
      const result = await executeStep(step.agent, resolvedPrompt, timeout);
      const duration_ms = Date.now() - start;

      if (completedCounter) {
        completedCounter.count++;
      }
      this.emitProgress({
        type: 'step-completed',
        executionId,
        stepId: step.id,
        agentDisplayName: step.agent.display_name,
        agentBackend: step.agent.backend,
        agentModel: step.agent.model,
        result: result.substring(0, 500),
        duration_ms,
        completedSteps: completedCounter?.count,
        totalSteps,
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

      if (completedCounter) {
        completedCounter.count++;
      }
      this.emitProgress({
        type: 'step-failed',
        executionId,
        stepId: step.id,
        agentDisplayName: step.agent.display_name,
        agentBackend: step.agent.backend,
        agentModel: step.agent.model,
        error: errorMsg,
        duration_ms,
        completedSteps: completedCounter?.count,
        totalSteps,
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

  private async runWithConcurrencyLimit<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<StepResult>
  ): Promise<PromiseSettledResult<StepResult>[]> {
    const results: PromiseSettledResult<StepResult>[] = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        try {
          results[i] = { status: 'fulfilled', value: await fn(items[i]) };
        } catch (e) {
          results[i] = { status: 'rejected', reason: e };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private balanceBackends(steps: WorkflowStep[]): void {
    const backends: AgentBackend[] = ['claude', 'codex-mcp'];
    let idx = 0;
    for (const step of steps) {
      if (step.agent.backend === 'codex-mcp') continue;
      step.agent.backend = backends[idx % backends.length];
      if (step.agent.backend === 'codex-mcp') {
        step.agent.model = 'codex';
      }
      idx++;
    }
  }

  private emitProgress(event: WorkflowProgressEvent): void {
    this.emit('progress', event);
  }
}

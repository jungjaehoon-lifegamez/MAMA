import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import type { AgentProcessManager } from '../multi-agent/agent-process-manager.js';
import type { DelegationManager } from '../multi-agent/delegation-manager.js';
import type { RawStore } from '../connectors/framework/raw-store.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { ValidationSessionService } from '../validation/session-service.js';
import type { ValidationSessionRow } from '../validation/types.js';
import { getLatestVersion, logActivity, updateActivityScore } from '../db/agent-store.js';
import type { GatewayToolResult } from './types.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
  };
};
const securityLogger = new DebugLogger('SecurityAudit');

export type DelegationRoutingContext = {
  agentId: string;
  source: string;
  channelId: string;
};

export type AgentTestInput = {
  agent_id: string;
  sample_count?: number;
  test_data?: Array<{ input: string; expected?: string }>;
};

export type DelegateInput = {
  agentId: string;
  task: string;
  background?: boolean;
  skill?: string;
};

export type DelegationExecutorDeps = {
  agentProcessManager: AgentProcessManager | null;
  delegationManagerRef: DelegationManager | null;
  rawStore?: RawStore | null;
  sessionsDb?: SQLiteDatabase | null;
  validationService?: ValidationSessionService | null;
  retryDelayMs: number;
  resolveManagedAgentId: (id: string) => string;
  checkViewerOnly: () => string | null;
};

function summarizeActivityOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  if (typeof output === 'string') {
    return output.slice(0, 500);
  }
  try {
    return JSON.stringify(output).slice(0, 500);
  } catch {
    return String(output).slice(0, 500);
  }
}

function resolveSkillPath(skillName: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
    return null;
  }
  const skillsDir = join(homedir(), '.mama', 'skills');
  const resolved = resolve(skillsDir, `${skillName}.md`);
  if (!resolved.startsWith(skillsDir)) {
    return null;
  }
  return resolved;
}

function normalizeRouting(routing: DelegationRoutingContext): DelegationRoutingContext {
  return {
    agentId: routing.agentId || 'conductor',
    source: routing.source || 'viewer',
    channelId: routing.channelId || 'default',
  };
}

export class DelegationExecutor {
  private readonly testInFlight = new Map<string, Promise<GatewayToolResult>>();

  constructor(private readonly deps: DelegationExecutorDeps) {}

  async runAgentTest(
    input: AgentTestInput,
    routing: DelegationRoutingContext
  ): Promise<GatewayToolResult> {
    const permError = this.deps.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError } as GatewayToolResult;
    }

    const { agent_id } = input;
    const sample_count = Number.parseInt(String(input.sample_count ?? 2), 10);
    const resolvedAgentId = this.deps.resolveManagedAgentId(agent_id);
    if (!Number.isFinite(sample_count) || sample_count < 1) {
      securityLogger.warn('[Agent test] Invalid sample_count received', {
        agent_id: resolvedAgentId,
        sample_count: input.sample_count ?? null,
      });
      return {
        success: false,
        error: `Invalid sample_count for '${resolvedAgentId}': ${String(input.sample_count)}. Must be >= 1.`,
      } as GatewayToolResult;
    }

    if (this.testInFlight.has(resolvedAgentId)) {
      return { success: false, error: 'test_already_running' } as GatewayToolResult;
    }

    const promise = this.runAgentTestInternal(
      resolvedAgentId,
      sample_count,
      routing,
      input.test_data
    );
    this.testInFlight.set(resolvedAgentId, promise);
    try {
      return await promise;
    } finally {
      this.testInFlight.delete(resolvedAgentId);
    }
  }

  async runDelegate(
    input: DelegateInput,
    routing: DelegationRoutingContext
  ): Promise<GatewayToolResult> {
    return this.runDelegateInternal(input, routing);
  }

  private cleanupValidationSessionOnTelemetryFailure(
    session: ValidationSessionRow | null,
    error: unknown,
    label: string
  ): null {
    if (!session || !this.deps.validationService) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.deps.validationService.finalizeSession(session.id, {
        execution_status: 'failed',
        error_message: `${label}: ${message}`,
      });
    } catch (cleanupErr) {
      securityLogger.warn(
        `[Delegation telemetry] Failed to clean up validation session ${session.id}`,
        cleanupErr
      );
    }
    return null;
  }

  private async runAgentTestInternal(
    agentId: string,
    sampleCount: number,
    routing: DelegationRoutingContext,
    testData?: Array<{ input: string; expected?: string }>
  ): Promise<GatewayToolResult> {
    const processManager = this.deps.agentProcessManager;
    const delegationManager = this.deps.delegationManagerRef;
    if (!processManager || !delegationManager) {
      return {
        success: false,
        error: 'agent_timeout: multi-agent not configured',
      } as GatewayToolResult;
    }

    const startTime = Date.now();

    let items: Array<{ input: string; expected?: string }>;
    if (testData && testData.length > 0) {
      const normalizedItems: Array<{ input: string; expected?: string }> = [];
      for (let index = 0; index < testData.length; index++) {
        const rawItem = testData[index] as unknown as Record<string, unknown>;
        if (typeof rawItem.input !== 'string') {
          return {
            success: false,
            error: `Invalid test_data[${index}].input: expected string`,
          } as GatewayToolResult;
        }
        if (rawItem.expected !== undefined && typeof rawItem.expected !== 'string') {
          return {
            success: false,
            error: `Invalid test_data[${index}].expected: expected string`,
          } as GatewayToolResult;
        }
        normalizedItems.push({
          input: rawItem.input,
          ...(typeof rawItem.expected === 'string' ? { expected: rawItem.expected } : {}),
        });
      }
      items = normalizedItems;
    } else if (this.deps.rawStore) {
      const agentConfig = delegationManager.getAgentConfig(agentId);
      const connectors: string[] = (agentConfig?.connectors as string[]) ?? [];
      if (connectors.length === 0) {
        return {
          success: false,
          error: 'connector_unavailable: no connectors configured',
        } as GatewayToolResult;
      }
      const allItems: Array<{ input: string }> = [];
      const missingConnectors: string[] = [];
      for (const conn of connectors) {
        if (!this.deps.rawStore.hasConnector(conn)) {
          missingConnectors.push(conn);
          continue;
        }
        const recent = this.deps.rawStore.getRecent(conn, sampleCount);
        for (const item of recent) {
          allItems.push({ input: `[${item.type}] ${item.content}` });
        }
        if (allItems.length >= sampleCount) {
          break;
        }
      }
      if (allItems.length === 0) {
        const detail =
          missingConnectors.length > 0
            ? `connector(s) not found: ${missingConnectors.join(', ')}`
            : 'no recent data';
        return {
          success: false,
          error: `connector_unavailable: ${detail}`,
        } as GatewayToolResult;
      }
      items = allItems.slice(0, sampleCount);
    } else {
      return {
        success: false,
        error: 'connector_unavailable: rawStore not available',
      } as GatewayToolResult;
    }

    const testVer = this.deps.sessionsDb ? getLatestVersion(this.deps.sessionsDb, agentId) : null;
    const testAgentVersion = testVer?.version ?? 0;
    let testValSession: ValidationSessionRow | null = null;
    try {
      testValSession =
        this.deps.validationService?.startSession(agentId, testAgentVersion, 'agent_test', {
          goal: `Test with ${items.length} items`,
          customBeforeSnapshot: JSON.stringify({
            schema_version: 1,
            test_input_summary: items.map((i) => i.input.slice(0, 80)).join('; '),
            sample_count: items.length,
          }),
        }) ?? null;
    } catch (telemetryErr) {
      securityLogger.warn('[Agent test telemetry] Failed to start validation session', {
        agentId,
        testAgentVersion,
        error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
      });
    }

    let testRunId: number | null = null;
    if (this.deps.sessionsDb) {
      try {
        const row = logActivity(this.deps.sessionsDb, {
          agent_id: agentId,
          agent_version: testAgentVersion,
          type: 'test_run',
          input_summary: `Testing with ${items.length} items`,
          run_id: testValSession?.id,
          execution_status: 'started',
          trigger_reason: 'agent_test',
        });
        testRunId = row.id;
        if (testValSession && this.deps.validationService) {
          this.deps.validationService.recordRun(testValSession.id, { activityId: row.id });
        }
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to persist startup activity', {
          agentId,
          testValSessionId: testValSession?.id ?? null,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
        testValSession = this.cleanupValidationSessionOnTelemetryFailure(
          testValSession,
          telemetryErr,
          'agent_test startup telemetry failed'
        );
        testRunId = null;
      }
    }

    const results: Array<{ input: string; output?: string; error?: string }> = [];
    const workerCount = Math.min(3, items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const currentIndex = nextIndex;
        nextIndex++;
        if (currentIndex >= items.length) {
          return;
        }
        const item = items[currentIndex];
        try {
          const r = await this.runDelegateInternal(
            {
              agentId,
              task: `Process this data:\n${item.input}`,
            },
            routing
          );
          const rAny = r as Record<string, unknown>;
          const output = r.success
            ? String((rAny.data as Record<string, unknown>)?.response ?? '')
            : undefined;
          results[currentIndex] = {
            input: item.input,
            output,
            error: r.success ? undefined : String(rAny.error ?? 'unknown'),
          };
        } catch (err) {
          results[currentIndex] = { input: item.input, error: String(err) };
        }
      }
    });
    await Promise.all(workers);

    const passed = results.filter((r, index) => {
      if (r.error) {
        return false;
      }
      const expected = items[index]?.expected;
      if (expected === undefined) {
        return true;
      }
      return (r.output ?? '').trim() === expected.trim();
    }).length;
    const failed = results.length - passed;
    const autoScore = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;

    if (this.deps.sessionsDb && testRunId) {
      try {
        updateActivityScore(
          this.deps.sessionsDb,
          testRunId,
          autoScore,
          {
            total: results.length,
            passed,
            failed,
            items: results.map((r, index) => ({
              input: r.input.slice(0, 100),
              result:
                r.error ||
                (items[index]?.expected !== undefined &&
                  (r.output ?? '').trim() !== items[index]!.expected!.trim())
                  ? 'fail'
                  : 'pass',
            })),
          },
          'completed'
        );
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to persist test score', {
          agentId,
          testRunId,
          autoScore,
          totalResults: results.length,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
      }
    }

    const testDurationMs = Date.now() - startTime;
    if (testValSession && this.deps.validationService) {
      try {
        this.deps.validationService.finalizeSession(testValSession.id, {
          execution_status: 'completed',
          metrics: {
            duration_ms: testDurationMs,
            completion_rate: results.length > 0 ? passed / results.length : 0,
            auto_score: autoScore,
          },
          test_input_summary: items.map((i) => i.input.slice(0, 80)).join('; '),
        });
      } catch (telemetryErr) {
        securityLogger.warn('[Agent test telemetry] Failed to finalize validation session', {
          agentId,
          testValSessionId: testValSession.id,
          autoScore,
          totalResults: results.length,
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
      }
    }

    return {
      success: true,
      data: {
        test_run_id: testRunId,
        agent_id: agentId,
        results,
        auto_score: autoScore,
        duration_ms: testDurationMs,
        validation_session_id: testValSession?.id ?? null,
        ...(testRunId === null ? { warning: 'score_not_persisted' } : {}),
      },
    } as GatewayToolResult;
  }

  private async runDelegateInternal(
    input: DelegateInput,
    routing: DelegationRoutingContext
  ): Promise<GatewayToolResult> {
    const { agentId, task, background } = input;
    const processManager = this.deps.agentProcessManager;
    const delegationManager = this.deps.delegationManagerRef;
    if (!processManager || !delegationManager) {
      return { success: false, error: 'Multi-agent not configured' } as GatewayToolResult;
    }

    const {
      agentId: activeAgentId,
      source: activeSource,
      channelId: activeChannelId,
    } = normalizeRouting(routing);
    const sourceAgentId = activeAgentId || 'conductor';
    const check = delegationManager.isDelegationAllowed(sourceAgentId, agentId);
    if (!check.allowed) {
      return {
        success: false,
        error: `Delegation denied: ${check.reason}`,
      } as GatewayToolResult;
    }

    if (background) {
      const source = activeSource || 'viewer';
      const channelId = activeChannelId || 'default';

      let bgAgentVersion = 0;
      let bgValSession: ValidationSessionRow | null = null;
      try {
        const bgVer = this.deps.sessionsDb ? getLatestVersion(this.deps.sessionsDb, agentId) : null;
        bgAgentVersion = bgVer?.version ?? 0;
        bgValSession =
          this.deps.validationService?.startSession(agentId, bgAgentVersion, 'delegate_run') ??
          null;

        if (this.deps.sessionsDb) {
          const row = logActivity(this.deps.sessionsDb, {
            agent_id: agentId,
            agent_version: bgAgentVersion,
            type: 'task_start',
            input_summary: task?.slice(0, 200),
            run_id: bgValSession?.id,
            execution_status: 'started',
            trigger_reason: 'delegate_run',
          });
          if (bgValSession && this.deps.validationService) {
            this.deps.validationService.recordRun(bgValSession.id, { activityId: row.id });
          }
        }
      } catch (telemetryErr) {
        securityLogger.warn('[Delegation telemetry] Background bootstrap failed', telemetryErr);
        bgAgentVersion = 0;
        bgValSession = this.cleanupValidationSessionOnTelemetryFailure(
          bgValSession,
          telemetryErr,
          'background delegate bootstrap failed'
        );
      }

      const bgStartTime = Date.now();
      void (async () => {
        try {
          const process = await processManager.getProcess(source, channelId, agentId);
          let delegationPrompt = delegationManager.buildDelegationPrompt(sourceAgentId, task);
          if (input.skill) {
            const skillPath = resolveSkillPath(input.skill);
            if (skillPath && existsSync(skillPath)) {
              const skillContent = readFileSync(skillPath, 'utf-8');
              delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
            }
          }
          const result = await process.sendMessage(delegationPrompt);
          const durationMs = Date.now() - bgStartTime;

          try {
            if (this.deps.sessionsDb) {
              const row = logActivity(this.deps.sessionsDb, {
                agent_id: agentId,
                agent_version: bgAgentVersion,
                type: 'task_complete',
                input_summary: task?.slice(0, 200),
                output_summary: summarizeActivityOutput(result?.response),
                duration_ms: durationMs,
                run_id: bgValSession?.id,
                execution_status: 'completed',
                trigger_reason: 'delegate_run',
              });
              if (bgValSession && this.deps.validationService) {
                this.deps.validationService.recordRun(bgValSession.id, {
                  activityId: row.id,
                  duration_ms: durationMs,
                });
              }
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background completion activity failed',
              telemetryErr
            );
          }

          try {
            if (bgValSession && this.deps.validationService) {
              this.deps.validationService.finalizeSession(bgValSession.id, {
                execution_status: 'completed',
                metrics: { duration_ms: durationMs },
              });
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background completion finalize failed',
              telemetryErr
            );
          }
        } catch (err) {
          const durationMs = Date.now() - bgStartTime;
          try {
            if (this.deps.sessionsDb) {
              const row = logActivity(this.deps.sessionsDb, {
                agent_id: agentId,
                agent_version: bgAgentVersion,
                type: 'task_error',
                input_summary: task?.slice(0, 200),
                error_message: String(err),
                duration_ms: durationMs,
                run_id: bgValSession?.id,
                execution_status: 'failed',
                trigger_reason: 'delegate_run',
              });
              if (bgValSession && this.deps.validationService) {
                this.deps.validationService.recordRun(bgValSession.id, {
                  activityId: row.id,
                  duration_ms: durationMs,
                });
              }
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background failure activity failed',
              telemetryErr
            );
          }
          try {
            if (bgValSession && this.deps.validationService) {
              this.deps.validationService.finalizeSession(bgValSession.id, {
                execution_status: 'failed',
                error_message: String(err),
                metrics: { duration_ms: durationMs },
              });
            }
          } catch (telemetryErr) {
            securityLogger.warn(
              '[Delegation telemetry] Background failure finalize failed',
              telemetryErr
            );
          }
        }
      })();

      return {
        success: true,
        data: { agentId, background: true, message: 'Background task submitted' },
      } as GatewayToolResult;
    }

    const source = activeSource || 'viewer';
    const channelId = activeChannelId || 'default';
    const startTime = Date.now();

    let agentVersion = 0;
    let valSession: ValidationSessionRow | null = null;
    try {
      const ver = this.deps.sessionsDb ? getLatestVersion(this.deps.sessionsDb, agentId) : null;
      agentVersion = ver?.version ?? 0;
      valSession =
        this.deps.validationService?.startSession(agentId, agentVersion, 'delegate_run') ?? null;

      if (this.deps.sessionsDb) {
        const row = logActivity(this.deps.sessionsDb, {
          agent_id: agentId,
          agent_version: agentVersion,
          type: 'task_start',
          input_summary: task?.slice(0, 200),
          run_id: valSession?.id,
          execution_status: 'started',
          trigger_reason: 'delegate_run',
        });
        if (valSession && this.deps.validationService) {
          this.deps.validationService.recordRun(valSession.id, { activityId: row.id });
        }
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Validation bootstrap failed', telemetryErr);
      agentVersion = 0;
      valSession = this.cleanupValidationSessionOnTelemetryFailure(
        valSession,
        telemetryErr,
        'delegate bootstrap failed'
      );
    }

    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const process = await processManager.getProcess(source, channelId, agentId);
        let delegationPrompt = delegationManager.buildDelegationPrompt(sourceAgentId, task);

        if (input.skill) {
          const skillPath = resolveSkillPath(input.skill);
          if (skillPath && existsSync(skillPath)) {
            const skillContent = readFileSync(skillPath, 'utf-8');
            delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
          }
        }

        const sessionId = process.getSessionId?.();
        if (!sessionId || attempt > 0) {
          try {
            const { getChannelHistory } = await import('../gateways/channel-history.js');
            const channelHistory = getChannelHistory();
            if (channelHistory) {
              const historyContext = channelHistory.formatForContext(channelId, '', agentId);
              if (historyContext) {
                delegationPrompt = `${historyContext}\n\n${delegationPrompt}`;
              }
            }
          } catch {
            // Channel history injection is best-effort.
          }
        }

        const result = await process.sendMessage(delegationPrompt);
        const durationMs = Date.now() - startTime;

        try {
          if (this.deps.sessionsDb) {
            const row = logActivity(this.deps.sessionsDb, {
              agent_id: agentId,
              agent_version: agentVersion,
              type: 'task_complete',
              input_summary: task?.slice(0, 200),
              output_summary: summarizeActivityOutput(result.response),
              duration_ms: durationMs,
              run_id: valSession?.id,
              execution_status: 'completed',
              trigger_reason: 'delegate_run',
            });
            if (valSession && this.deps.validationService) {
              this.deps.validationService.recordRun(valSession.id, {
                activityId: row.id,
                duration_ms: durationMs,
              });
            }
          }
        } catch (telemetryErr) {
          securityLogger.warn('[Delegation telemetry] Completion activity failed', telemetryErr);
        }

        try {
          if (valSession && this.deps.validationService) {
            this.deps.validationService.finalizeSession(valSession.id, {
              execution_status: 'completed',
              metrics: { duration_ms: durationMs },
            });
          }
        } catch (telemetryErr) {
          securityLogger.warn('[Delegation telemetry] Completion finalize failed', telemetryErr);
        }

        return {
          success: true,
          data: { agentId, response: result.response, duration_ms: durationMs },
        } as GatewayToolResult;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isBusy = lastError.message.includes('busy');
        const isCrash = lastError.message.includes('exited with code');

        if (isCrash) {
          processManager.stopProcess(source, channelId, agentId);
        }

        if (attempt < MAX_RETRIES - 1 && (isBusy || isCrash)) {
          await new Promise((r) => setTimeout(r, this.deps.retryDelayMs * (attempt + 1)));
          continue;
        }
        break;
      }
    }

    const failedDurationMs = Date.now() - startTime;
    try {
      if (this.deps.sessionsDb) {
        const row = logActivity(this.deps.sessionsDb, {
          agent_id: agentId,
          agent_version: agentVersion,
          type: 'task_error',
          input_summary: task?.slice(0, 200),
          error_message: lastError?.message,
          duration_ms: failedDurationMs,
          run_id: valSession?.id,
          execution_status: 'failed',
          trigger_reason: 'delegate_run',
        });
        if (valSession && this.deps.validationService) {
          this.deps.validationService.recordRun(valSession.id, {
            activityId: row.id,
            duration_ms: failedDurationMs,
          });
        }
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Failure activity failed', telemetryErr);
    }

    try {
      if (valSession && this.deps.validationService) {
        this.deps.validationService.finalizeSession(valSession.id, {
          execution_status: 'failed',
          error_message: lastError?.message,
          metrics: { duration_ms: failedDurationMs },
        });
      }
    } catch (telemetryErr) {
      securityLogger.warn('[Delegation telemetry] Failure finalize failed', telemetryErr);
    }

    return {
      success: false,
      error: `Delegation to ${agentId} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    } as GatewayToolResult;
  }
}

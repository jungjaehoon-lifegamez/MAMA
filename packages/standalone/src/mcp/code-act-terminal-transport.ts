import { DEFAULT_SANDBOX_CONFIG } from '../agent/code-act/types.js';

export const CODE_ACT_MCP_REQUEST_TIMEOUT_MS =
  DEFAULT_SANDBOX_CONFIG.timeoutMs + DEFAULT_SANDBOX_CONFIG.mutationSettlementGraceMs + 5_000;

export type TerminalMutationCode =
  | 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT'
  | 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN';

export interface TerminalMutationFailure {
  terminalCode: TerminalMutationCode;
  error: string;
}

interface HostToolExecutionAudit {
  name: string;
  success: boolean;
  code?: string;
}

interface CodeActMcpPayload {
  value?: unknown;
  logs?: string[];
  metrics?: unknown;
}

interface CodeActMcpSourceResult extends CodeActMcpPayload {
  success: boolean;
  error?: string;
  errorCode?: string;
  terminalCode?: string;
  retryable?: boolean;
  abort?: boolean;
  hostToolExecutions?: Array<{ name: string; success: boolean; code?: string }>;
}

export class CodeActPostSendTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeActPostSendTransportError';
  }
}

export function terminalMutationFailure(result: {
  success: boolean;
  error?: string;
  terminalCode?: string;
  retryable?: boolean;
  abort?: boolean;
}): TerminalMutationFailure | undefined {
  const terminalCode: TerminalMutationCode | undefined =
    result.terminalCode === 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT' ||
    result.terminalCode === 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN'
      ? result.terminalCode
      : undefined;
  if (result.success || !terminalCode || result.retryable !== false || result.abort !== true) {
    return undefined;
  }
  return {
    terminalCode,
    error: result.error || 'Mutation outcome is ambiguous',
  };
}

function normalizeHostToolExecutions(value: unknown): HostToolExecutionAudit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const executions: HostToolExecutionAudit[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.success !== 'boolean') {
      continue;
    }
    executions.push({
      name: record.name,
      success: record.success,
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
    });
  }
  return executions;
}

export function codeActMcpResult(result: CodeActMcpSourceResult): Record<string, unknown> {
  const hostToolExecutions = normalizeHostToolExecutions(result.hostToolExecutions);
  const successfulNames = new Set<string>();
  const hostToolsInvoked: string[] = [];
  for (const execution of hostToolExecutions) {
    if (execution.success && !successfulNames.has(execution.name)) {
      successfulNames.add(execution.name);
      hostToolsInvoked.push(execution.name);
    }
  }
  const envelope = {
    protocol: 'mama.code_act.result',
    version: 1,
    success: result.success,
    hostToolExecutions,
    hostToolsInvoked,
    payload: {
      ...(result.value !== undefined ? { value: result.value } : {}),
      ...(result.logs !== undefined ? { logs: result.logs } : {}),
      ...(result.metrics !== undefined ? { metrics: result.metrics } : {}),
    },
    ...(result.success
      ? {}
      : {
          error: {
            message: result.error ?? 'Unknown error',
            ...(result.errorCode || result.terminalCode
              ? { code: result.errorCode ?? result.terminalCode }
              : {}),
          },
          ...(typeof result.retryable === 'boolean' ? { retryable: result.retryable } : {}),
          ...(result.abort === true ? { abort: true } : {}),
        }),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    ...(result.success ? {} : { isError: true }),
  };
}

export function terminalMcpResult(failure: TerminalMutationFailure): Record<string, unknown> {
  return {
    ...codeActMcpResult({
      success: false,
      error: failure.error,
      terminalCode: failure.terminalCode,
      retryable: false,
      abort: true,
    }),
    _meta: {
      mama: {
        terminalCode: failure.terminalCode,
        retryable: false,
        abort: true,
      },
    },
  };
}

export class TerminalMutationLatch {
  private failure?: TerminalMutationFailure;

  current(): TerminalMutationFailure | undefined {
    return this.failure;
  }

  record(
    result: Parameters<typeof terminalMutationFailure>[0]
  ): TerminalMutationFailure | undefined {
    const terminal = terminalMutationFailure(result);
    if (!terminal) {
      return undefined;
    }
    this.failure ??= terminal;
    return this.failure;
  }
}

export class SerializedCodeActQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.tail.then(operation);
    this.tail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }
}

export class SerializedCodeActGate {
  private readonly latch = new TerminalMutationLatch();
  private readonly queue = new SerializedCodeActQueue();

  run<T extends Parameters<typeof terminalMutationFailure>[0]>(
    operation: () => Promise<T>
  ): Promise<{ result?: T; terminal?: TerminalMutationFailure }> {
    return this.queue.run(async () => {
      const latched = this.latch.current();
      if (latched) {
        return { terminal: latched };
      }
      try {
        const result = await operation();
        const terminal = this.latch.record(result);
        return terminal ? { terminal } : { result };
      } catch (error) {
        if (!(error instanceof CodeActPostSendTransportError)) {
          throw error;
        }
        const terminal = this.latch.record({
          success: false,
          error: error.message,
          terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
          retryable: false,
          abort: true,
        });
        return { terminal };
      }
    });
  }
}

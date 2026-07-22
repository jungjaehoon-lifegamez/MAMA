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

export function terminalMcpResult(failure: TerminalMutationFailure): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: `[${failure.terminalCode}] ${failure.error}. Automatic retry is forbidden.`,
      },
    ],
    isError: true,
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

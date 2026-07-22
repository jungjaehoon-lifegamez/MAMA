export interface SandboxConfig {
  memoryLimitBytes: number; // default: 32MB
  maxStackSizeBytes: number; // default: 512KB
  timeoutMs: number; // default: 300_000
  maxConcurrentCalls: number; // default: 50
  maxConcurrentExecutions: number; // default: 8 (process-wide hard maximum)
  mutationSettlementGraceMs: number; // default: 5_000 (bounded ambiguous-write drain)
}

export const CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT = 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT';
export const CODE_ACT_MUTATION_OUTCOME_UNKNOWN = 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN';
export type CodeActTerminalMutationCode =
  | typeof CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT
  | typeof CODE_ACT_MUTATION_OUTCOME_UNKNOWN;

export interface ExecutionResult {
  success: boolean;
  value?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: CodeActTerminalMutationCode;
    retryable?: boolean;
  };
  logs: string[];
  metrics: {
    durationMs: number;
    hostCallCount: number;
    memoryUsedBytes: number;
  };
}

export interface SandboxExecutionOptions {
  /** Cancellation for the owning model turn or HTTP request. */
  signal?: AbortSignal;
}

export type HostFunction = (...args: unknown[]) => Promise<unknown>;

export interface HostFunctionContext {
  signal: AbortSignal;
  deadlineMs: number;
}

export type AbortableHostFunction = (
  context: HostFunctionContext,
  ...args: unknown[]
) => Promise<unknown>;

export interface HostFunctionRegistrationOptions {
  /** Keep the module slot for the bounded mutation settlement grace after abort. */
  settleOnAbort?: boolean;
}

export interface FunctionDescriptor {
  name: string;
  params: ParamDescriptor[];
  returnType: string;
  description: string;
  category: 'memory' | 'file' | 'communication' | 'browser' | 'os' | 'cron' | 'mcp' | 'system';
}

export interface ParamDescriptor {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackSizeBytes: 512 * 1024,
  timeoutMs: 300_000,
  maxConcurrentCalls: 50,
  maxConcurrentExecutions: 8,
  mutationSettlementGraceMs: 5_000,
};

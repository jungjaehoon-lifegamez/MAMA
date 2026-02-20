export interface SandboxConfig {
  memoryLimitBytes: number; // default: 32MB
  maxStackSizeBytes: number; // default: 512KB
  timeoutMs: number; // default: 10_000
  maxConcurrentCalls: number; // default: 50
}

export interface ExecutionResult {
  success: boolean;
  value?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  logs: string[];
  metrics: {
    durationMs: number;
    hostCallCount: number;
    memoryUsedBytes: number;
  };
}

export type HostFunction = (...args: unknown[]) => Promise<unknown>;

export interface FunctionDescriptor {
  name: string;
  params: ParamDescriptor[];
  returnType: string;
  description: string;
  category: 'memory' | 'file' | 'communication' | 'browser' | 'os' | 'cron' | 'mcp';
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
  timeoutMs: 10_000,
  maxConcurrentCalls: 50,
};

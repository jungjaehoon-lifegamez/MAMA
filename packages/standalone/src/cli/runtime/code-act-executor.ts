import type { RunContextRegistry } from '../../agent/code-act/run-context-registry.js';
import type {
  CodeActInput,
  GatewayToolExecutionContext,
  GatewayToolResult,
} from '../../agent/types.js';
import type { CodeActExecutionContext, CodeActResult } from '../../api/graph-api-types.js';

const TERMINAL_MUTATION_CODES = new Set([
  'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT',
  'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
]);

interface CodeActGatewayExecutor {
  execute(
    toolName: 'code_act',
    input: CodeActInput,
    context: GatewayToolExecutionContext
  ): Promise<GatewayToolResult>;
}

export interface CreateCodeActExecutorOptions {
  registry: RunContextRegistry;
  gatewayToolExecutor: CodeActGatewayExecutor;
  executeLegacy: (code: string, context?: CodeActExecutionContext) => Promise<CodeActResult>;
}

function normalizeHostToolExecutions(
  value: unknown
): Array<{ name: string; success: boolean; code?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: Array<{ name: string; success: boolean; code?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.success !== 'boolean') {
      continue;
    }
    normalized.push({
      name: record.name,
      success: record.success,
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
    });
  }
  return normalized;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function normalizeMetrics(value: unknown): CodeActResult['metrics'] {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.durationMs !== 'number' ||
    typeof record.hostCallCount !== 'number' ||
    typeof record.memoryUsedBytes !== 'number'
  ) {
    return undefined;
  }
  return {
    durationMs: record.durationMs,
    hostCallCount: record.hostCallCount,
    memoryUsedBytes: record.memoryUsedBytes,
  };
}

function serializeGatewayResult(result: GatewayToolResult): CodeActResult {
  const record = result as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const hostToolExecutions = normalizeHostToolExecutions(record.hostToolExecutions);
  const hostToolsInvoked = normalizeStringArray(record.hostToolsInvoked);
  const logs = normalizeStringArray(record.logs);
  const metrics = normalizeMetrics(record.metrics);
  return {
    success: result.success,
    ...('value' in record ? { value: record.value } : {}),
    ...(logs ? { logs } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(code && TERMINAL_MUTATION_CODES.has(code)
      ? {
          terminalCode: code as NonNullable<CodeActResult['terminalCode']>,
        }
      : code
        ? { errorCode: code }
        : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(typeof record.abort === 'boolean' ? { abort: record.abort } : {}),
    ...(metrics ? { metrics } : {}),
    ...(hostToolExecutions ? { hostToolExecutions } : {}),
    ...(hostToolsInvoked ? { hostToolsInvoked } : {}),
  };
}

export function createCodeActExecutor(options: CreateCodeActExecutorOptions) {
  return async (code: string, context?: CodeActExecutionContext): Promise<CodeActResult> => {
    if (!context?.contextKey) {
      return options.executeLegacy(code, context);
    }

    const acquired = options.registry.acquire(context.contextKey);
    if (!acquired) {
      return {
        success: false,
        error: 'Code-Act run context is unavailable.',
        errorCode: 'CODE_ACT_CONTEXT_UNAVAILABLE',
        retryable: false,
      };
    }

    try {
      const result = await options.gatewayToolExecutor.execute(
        'code_act',
        {
          code,
          ...(context.allowedTools ? { allowedTools: context.allowedTools } : {}),
          ...(context.blockedTools ? { blockedTools: context.blockedTools } : {}),
        },
        acquired.context
      );
      return serializeGatewayResult(result);
    } finally {
      acquired.releasePin();
    }
  };
}

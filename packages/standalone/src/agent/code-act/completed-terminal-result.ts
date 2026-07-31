import { isHostToolTerminalCode } from '../model-runner.js';
import type { CompletedToolExchange, PromptTerminalError } from '../types.js';
import { isCodeActMutatingTool } from './host-bridge.js';

const CLAUDE_CODE_ACT_TOOL_NAME = 'mcp__code-act__code_act';

/** Decode only the trusted, versioned terminal contract from a paired local MCP exchange. */
export function completedCodeActTerminalError(
  exchanges: readonly CompletedToolExchange[] | undefined
): PromptTerminalError | undefined {
  if (!exchanges) {
    return undefined;
  }

  for (const exchange of exchanges) {
    if (exchange.toolUse.name !== CLAUDE_CODE_ACT_TOOL_NAME) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(exchange.toolResult.content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const root = parsed as Record<string, unknown>;
      const error = root.error;
      if (
        root.protocol !== 'mama.code_act.result' ||
        root.version !== 1 ||
        root.success !== false ||
        root.retryable !== false ||
        root.abort !== true ||
        typeof error !== 'object' ||
        error === null ||
        Array.isArray(error)
      ) {
        continue;
      }
      const terminal = error as Record<string, unknown>;
      if (isHostToolTerminalCode(terminal.code) && typeof terminal.message === 'string') {
        return { code: terminal.code, message: terminal.message };
      }
    } catch {
      // Only a structurally valid, host-authored result envelope is trusted here.
    }
  }

  return undefined;
}

export function completedCodeActMutationWasObserved(
  exchanges: readonly CompletedToolExchange[] | undefined
): boolean {
  if (!exchanges) {
    return false;
  }

  for (const exchange of exchanges) {
    if (exchange.toolUse.name !== CLAUDE_CODE_ACT_TOOL_NAME) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(exchange.toolResult.content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const root = parsed as Record<string, unknown>;
      if (
        root.protocol !== 'mama.code_act.result' ||
        root.version !== 1 ||
        typeof root.success !== 'boolean' ||
        !Array.isArray(root.hostToolExecutions)
      ) {
        continue;
      }
      if (
        root.hostToolExecutions.some((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            return false;
          }
          const execution = entry as Record<string, unknown>;
          return (
            execution.success === true &&
            typeof execution.name === 'string' &&
            isCodeActMutatingTool(execution.name)
          );
        })
      ) {
        return true;
      }
    } catch {
      // Invalid or unversioned content cannot prove that a mutation executed.
    }
  }

  return false;
}

import type { AgentLoopResult, Message } from '../agent/types.js';
import { extractCodexAuthFailure } from '../agent/codex-auth.js';
import type { MemoryAuditAckLike } from './audit-task-queue.js';

function collectToolNames(history: Message[]): string[] {
  const toolNames: string[] = [];

  for (const message of history) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolNames.push(block.name);
      }
    }
  }

  return toolNames;
}

export function buildMemoryAuditAckFromAgentResult(
  result: AgentLoopResult,
  beforeDecisionCount: number,
  afterDecisionCount: number
): MemoryAuditAckLike {
  const toolNames = collectToolNames(result.history);
  const usedSaveTool = toolNames.includes('mama_save');

  if (afterDecisionCount > beforeDecisionCount) {
    return {
      status: 'applied',
      action: 'save',
      event_ids: [],
      reason: result.response,
    };
  }

  const authFailure = extractCodexAuthFailure(result.response || '');
  if (authFailure) {
    return {
      status: 'failed',
      action: 'no_op',
      event_ids: [],
      reason: authFailure,
    };
  }

  if (usedSaveTool) {
    return {
      status: 'failed',
      action: 'save',
      event_ids: [],
      reason: result.response || 'mama_save was invoked but no new decision was persisted',
    };
  }

  return {
    status: 'skipped',
    action: 'no_op',
    event_ids: [],
    reason: result.response || 'memory agent did not invoke mama_save',
  };
}

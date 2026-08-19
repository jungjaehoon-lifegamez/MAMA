/**
 * Receipt-only terminal classification for a MAMA owner-event turn.
 *
 * Assistant prose is never evidence. Direct tools count only when paired with
 * a successful tool_result. Nested Code-Act calls count only from the
 * host-authored root execution ledger.
 */

export interface OwnerEventHistoryMessage {
  role: string;
  content: unknown;
}

export type OwnerEventOutcome =
  | { status: 'acted'; tools: string[] }
  | { status: 'delegated'; tools: string[] }
  | { status: 'no_update'; tools: string[] }
  | { status: 'retry'; tools: string[]; reason: string };

const EFFECT_TOOLS = new Set(['telegram_send', 'drive_upload']);
const DELEGATION_TOOLS = new Set(['workorder_request']);

function normalizeToolName(name: string): string {
  const match = /^mcp__[A-Za-z0-9_-]+__(.+)$/.exec(name);
  return match ? match[1] : name;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function successfulResult(value: unknown, isError: boolean | undefined): boolean {
  if (isError === true) return false;
  const parsed = parseObject(value);
  return parsed?.success !== false && parsed?.code !== 'envelope_missing';
}

function nestedHostTools(value: unknown): string[] {
  const parsed = parseObject(value);
  if (!parsed) return [];
  const trustedWrapper =
    (parsed.protocol === 'mama.code_act.result' && parsed.version === 1) ||
    (parsed.protocol === undefined && Array.isArray(parsed.hostToolExecutions));
  if (!trustedWrapper || !Array.isArray(parsed.hostToolExecutions)) return [];
  return parsed.hostToolExecutions.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const execution = entry as Record<string, unknown>;
    return execution.success === true && typeof execution.name === 'string' ? [execution.name] : [];
  });
}

function executedTools(history: ReadonlyArray<OwnerEventHistoryMessage>): string[] {
  const results = new Map<string, { ok: boolean; content: unknown }>();
  for (const message of history) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      results.set(block.tool_use_id, {
        ok: successfulResult(block.content, block.is_error as boolean | undefined),
        content: block.content,
      });
    }
  }

  const tools: string[] = [];
  for (const message of history) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (
        block.type !== 'tool_use' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string'
      ) {
        continue;
      }
      const result = results.get(block.id);
      if (!result) continue;
      const name = normalizeToolName(block.name);
      if (name === 'code_act') {
        tools.push(...nestedHostTools(result.content));
      } else if (result.ok) {
        tools.push(name);
      }
    }
  }
  return [...new Set(tools)];
}

export function classifyOwnerEventOutcome(input: {
  history: ReadonlyArray<OwnerEventHistoryMessage>;
  noUpdateRecorded: boolean;
}): OwnerEventOutcome {
  const tools = executedTools(input.history);
  const delegated = tools.filter((tool) => DELEGATION_TOOLS.has(tool));
  if (delegated.length > 0) return { status: 'delegated', tools: delegated };

  const acted = tools.filter((tool) => EFFECT_TOOLS.has(tool));
  if (acted.length > 0) return { status: 'acted', tools: acted };
  if (input.noUpdateRecorded) return { status: 'no_update', tools: [] };
  return {
    status: 'retry',
    tools: [],
    reason: 'no durable action or exact no-update receipt',
  };
}

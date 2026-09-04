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
  | { status: 'acted'; tools: string[]; ownerDecisionRequested: boolean }
  | { status: 'no_update'; tools: string[] }
  | { status: 'retry'; tools: string[]; reason: string };

/** The marker that turns a send-only turn into a completed one: a question only the owner can answer. */
export const OWNER_DECISION_MARKER = /^\s*\[decision\]/i;

/**
 * A batch is complete when it durably changed what the system knows or holds.
 * Notification is not completion: a turn that only sends a Telegram line has
 * moved nothing, and counting it produced 362 sends against a dead ledger.
 */
const LEDGER_EFFECT_TOOLS = new Set([
  'task_create',
  'task_update',
  'mama_save',
  'mama_update',
  'drive_upload',
]);
const NOTIFY_TOOLS = new Set(['telegram_send']);

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

/**
 * Did a SUCCESSFUL direct telegram_send carry the [decision] marker in the text it actually
 * sent? Read from the tool_use input, never from the assistant's final prose: a run can say
 * "[decision]" in its response while the message it delivered was a plain notification.
 * Nested Code-Act sends carry no input in the host ledger and therefore never qualify.
 */
function sentOwnerDecision(history: ReadonlyArray<OwnerEventHistoryMessage>): boolean {
  const okResults = new Set<string>();
  for (const message of history) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      if (successfulResult(block.content, block.is_error as boolean | undefined)) {
        okResults.add(block.tool_use_id);
      }
    }
  }
  for (const message of history) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (typeof block.name !== 'string' || normalizeToolName(block.name) !== 'telegram_send') {
        continue;
      }
      if (!okResults.has(block.id)) continue;
      const input = parseObject(block.input);
      const text = input?.message;
      if (typeof text === 'string' && OWNER_DECISION_MARKER.test(text)) return true;
    }
  }
  return false;
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
  const ledger = tools.filter((tool) => LEDGER_EFFECT_TOOLS.has(tool));
  const notified = tools.filter((tool) => NOTIFY_TOOLS.has(tool));
  const ownerDecisionRequested = notified.length > 0 && sentOwnerDecision(input.history);
  if (ledger.length > 0) {
    return { status: 'acted', tools: [...ledger, ...notified], ownerDecisionRequested };
  }
  if (ownerDecisionRequested) {
    return { status: 'acted', tools: notified, ownerDecisionRequested: true };
  }
  if (input.noUpdateRecorded) return { status: 'no_update', tools: [] };
  return {
    status: 'retry',
    tools: [],
    reason:
      notified.length > 0
        ? 'notification without a ledger change'
        : 'no durable action or exact no-update receipt',
  };
}

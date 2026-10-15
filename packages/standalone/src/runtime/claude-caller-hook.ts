import { readFileSync } from 'node:fs';
import type { NativeToolCaller } from '@jungjaehoon/mama-core/action-contracts';
import { readWebFetchTurnMode, webFetchDecision } from './web-fetch-scope.js';

export const CLAUDE_CALLER_FIELD = '__mama_caller';

/** Claude 2.1.x PreToolUse: updatedInput replaces the entire input object. */
export function callerHookOutput(
  input: NativeToolCaller & { tool_input: unknown; [key: string]: unknown }
) {
  const { session_id, tool_use_id, agent_id, agent_type } = input;
  if (
    !session_id ||
    !tool_use_id ||
    !input.tool_input ||
    typeof input.tool_input !== 'object' ||
    Array.isArray(input.tool_input)
  ) {
    throw new Error('Claude caller hook requires session_id, tool_use_id and object tool_input');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...input.tool_input,
        [CLAUDE_CALLER_FIELD]: {
          session_id,
          tool_use_id,
          ...(agent_id === undefined ? {} : { agent_id }),
          ...(agent_type === undefined ? {} : { agent_type }),
        },
      },
    },
  };
}

/** WebFetch in a turn with no person in it reaches only configured hosts (owner, 2026-10-15). */
export function webFetchHookOutput(input: { tool_input?: { url?: unknown } }, modePath: string) {
  const decision = webFetchDecision(readWebFetchTurnMode(modePath), input.tool_input?.url);
  return decision.allow
    ? {}
    : {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      };
}

if (require.main === module) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const modePath = process.argv[2];
    process.stdout.write(
      `${JSON.stringify(
        input.tool_name === 'WebFetch'
          ? // Without its mode file the hook cannot tell the turn, so it refuses.
            webFetchHookOutput(input, modePath ?? '')
          : callerHookOutput(input)
      )}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

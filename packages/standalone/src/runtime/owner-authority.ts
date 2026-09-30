/**
 * Whose word a rule is (owner, 2026-10-01): the owner's own conversation carries authority, and
 * every connector message is observation, including the owner's own lines in a client room. A
 * rule (lesson, preference, constraint, workflow) written in an owner-chat turn is an owner rule,
 * and only an owner-chat turn replaces or retires it. Rules learned in other turns are memory too,
 * and any turn may add or change them.
 *
 * Decided from the message refs the messenger gateways write for owner messages (telegram.ts,
 * discord.ts, slack.ts), not from the mailbox, which drops handled rows after seven days while a
 * rule lasts. A subagent's calls carry `subagent:<thread>`: the agent that heard the owner records
 * the correction.
 */
import type { ActionContext, ActionRegistration, DatabaseInstance } from '@jungjaehoon/mama-core';

export const RULE_KINDS = ['lesson', 'preference', 'constraint', 'workflow'] as const;

const OWNER_CHAT_REF = /^(?:telegram|discord|slack):[^:]+:[^:]+$/;

export function isOwnerChatRef(ref: unknown): boolean {
  return typeof ref === 'string' && OWNER_CHAT_REF.test(ref);
}

/** The ids among these that are owner rules. */
export function ownerRuleIds(adapter: DatabaseInstance, ids: readonly string[]): Set<string> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = adapter
    .prepare(
      `SELECT id, kind, provenance_json FROM decisions WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{ id: string; kind: string; provenance_json: string | null }>;
  return new Set(
    rows
      .filter(
        (row) =>
          (RULE_KINDS as readonly string[]).includes(row.kind) &&
          row.provenance_json !== null &&
          isOwnerChatRef(
            (JSON.parse(row.provenance_json) as { source_message_ref?: unknown }).source_message_ref
          )
      )
      .map((row) => row.id)
  );
}

function ownerSpeaking(context: ActionContext, ownerPrincipalId: string): boolean {
  return (
    context.access.principalId === ownerPrincipalId &&
    context.session?.replaySourceEndMs === undefined &&
    isOwnerChatRef(context.session?.sourceMessageRef)
  );
}

/** The records a memory.save replaces, or the one a memory.retire retires. */
function targets(action: string, input: unknown): string[] {
  const named =
    action === 'memory.retire'
      ? [(input as { memory_id?: unknown }).memory_id]
      : (() => {
          const replaces = (input as { replaces?: unknown }).replaces;
          return Array.isArray(replaces)
            ? replaces.map((entry) => (entry as { id?: unknown } | null)?.id)
            : [];
        })();
  return named.filter((id): id is string => typeof id === 'string');
}

/** memory.save or memory.retire that refuses to change an owner rule outside an owner-chat turn. */
export function guardOwnerRules(
  registration: ActionRegistration,
  adapter: DatabaseInstance,
  ownerPrincipalId: string
): ActionRegistration {
  const action = registration.contract.name;
  return {
    ...registration,
    exec: async (input, context) => {
      const owned = ownerRuleIds(adapter, targets(action, input));
      if (owned.size > 0 && !ownerSpeaking(context, ownerPrincipalId)) {
        const error = new Error(
          `${[...owned].join(', ')} ${owned.size === 1 ? 'is an owner rule' : 'are owner rules'}: ` +
            'only the owner changes one, in an owner chat turn. Save what you learned as a lesson ' +
            'without replacing it, or ask the owner in your reply or report.'
        );
        error.name = 'denied';
        throw error;
      }
      return await registration.exec(input, context);
    },
  };
}

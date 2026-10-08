/**
 * Whose word a rule is (owner, 2026-10-01): the owner's own conversation carries authority, and
 * every connector message is observation, including the owner's own lines in a client room. A
 * rule (lesson, preference, constraint, workflow) written in an owner-chat turn is an owner rule,
 * and only an owner-chat turn replaces or retires it. Rules learned in other turns are memory too,
 * and any turn may add or change them.
 *
 * Authorship comes from the durable judgment command binding, and the message ref identifies
 * the chat turn. The mailbox drops handled rows after seven days while a rule lasts. A
 * subagent's calls carry `subagent:<thread>`: the agent that heard the owner records the correction.
 */
import type { ActionContext, ActionRegistration, DatabaseInstance } from '@jungjaehoon/mama-core';

export const RULE_KINDS = ['lesson', 'preference', 'constraint', 'workflow'] as const;
export const POLICY_UPDATE_ACTION = 'manage.policy.update';

const OWNER_CHAT_REF = /^(?:telegram|discord|slack):[^:]+:[^:]+$/;

export function isOwnerChatRef(ref: unknown): boolean {
  return typeof ref === 'string' && OWNER_CHAT_REF.test(ref);
}

/**
 * Owner-authored chat rules among these ids. Migration 075 left earlier records without command
 * bindings; without authenticated authorship they remain learned rules, even with a chat ref.
 */
export function ownerRuleIds(
  adapter: DatabaseInstance,
  ids: readonly string[],
  ownerPrincipalId: string
): Set<string> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = adapter
    .prepare(
      `SELECT d.id, d.kind, d.provenance_json FROM decisions d
       WHERE d.id IN (${ids.map(() => '?').join(',')})
         AND EXISTS (
           SELECT 1 FROM judgment_commands j
           JOIN command_bindings b ON b.command_id = j.command_id
           WHERE j.record_id = d.id AND b.principal_id = ?
             AND b.action = 'judgment.append' AND b.receipt_kind = 'judgment'
             AND b.receipt_key = d.id
         )`
    )
    .all(...ids, ownerPrincipalId) as Array<{
    id: string;
    kind: string;
    provenance_json: string | null;
  }>;
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

export function ownerSpeaking(context: ActionContext, ownerPrincipalId: string): boolean {
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

/** Policy revisions have one writer; other owner rules change only in owner chat. */
export function guardOwnerRules(
  registration: ActionRegistration,
  adapter: DatabaseInstance,
  ownerPrincipalId: string
): ActionRegistration {
  const action = registration.contract.name;
  return {
    ...registration,
    exec: async (input, context) => {
      const body = input as {
        source?: { source_type?: unknown };
        provenance?: { tool_name?: unknown };
      };
      const ids = targets(action, input);
      const revisions =
        ids.length === 0
          ? []
          : (
              adapter
                .prepare(
                  `SELECT id, provenance_json FROM decisions WHERE id IN (${ids.map(() => '?').join(',')})`
                )
                .all(...ids) as Array<{ id: string; provenance_json: string | null }>
            ).filter(
              (row) =>
                row.provenance_json !== null &&
                (JSON.parse(row.provenance_json) as { tool_name?: unknown }).tool_name ===
                  POLICY_UPDATE_ACTION
            );
      // Policy history has one writer even in owner chat; kind and topic confer no authority.
      if (
        revisions.length > 0 ||
        body.source?.source_type === POLICY_UPDATE_ACTION ||
        body.provenance?.tool_name === POLICY_UPDATE_ACTION ||
        context.session?.toolName === POLICY_UPDATE_ACTION
      ) {
        const error = new Error(
          `Owner policy revisions are written only by ${POLICY_UPDATE_ACTION}`
        );
        error.name = 'denied';
        throw error;
      }
      const owned = ownerRuleIds(adapter, ids, ownerPrincipalId);
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

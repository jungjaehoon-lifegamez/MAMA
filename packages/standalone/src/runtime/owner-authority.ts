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
import { createPrincipalRepository, type PrincipalRepository } from '@jungjaehoon/mama-core';

export function holdsOwnerRole(
  repository: Pick<PrincipalRepository, 'listRoles'>,
  principalId: string
): boolean {
  return repository.listRoles(principalId).some(({ role }) => role === 'owner');
}

export const RULE_KINDS = ['lesson', 'preference', 'constraint', 'workflow'] as const;
export const POLICY_UPDATE_ACTION = 'manage.policy.update';

const OWNER_CHAT_REF = /^(?:telegram|discord|slack):[^:]+:[^:]+$/;

export function isOwnerChatRef(ref: unknown): boolean {
  return typeof ref === 'string' && OWNER_CHAT_REF.test(ref);
}

export interface OwnerMessageAuthority {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  isOwnerMessageTurn(sourceMessageRef: string, principalId: string): boolean;
}

/** The host's message binding names the person; the common session itself is no person. */
export function messageTurnCaller(
  context: ActionContext,
  ports: OwnerMessageAuthority
): string | undefined {
  const ref = context.session?.sourceMessageRef;
  const principalId = context.access.principalId;
  if (
    context.session?.replaySourceEndMs !== undefined ||
    !isOwnerChatRef(ref) ||
    !ports.isOwnerMessageTurn(ref!, principalId)
  )
    return undefined;
  if (principalId !== ports.ownerPrincipalId) return principalId;
  const row = ports.adapter
    .prepare(
      `SELECT json_extract(payload_json, '$.senderPrincipalId') AS sender
     FROM mailbox_inputs WHERE stimulus_id=? AND principal_id=? AND kind='owner_message'
     ORDER BY id DESC LIMIT 1`
    )
    .get(ref, principalId) as { sender: string | null } | undefined;
  return row?.sender ?? undefined;
}

/** Re-read status and role at execution, inside the shared serial turn slot. */
export function activeOwnerMessageCaller(
  context: ActionContext,
  ports: OwnerMessageAuthority
): string | undefined {
  const caller = messageTurnCaller(context, ports);
  if (!caller) return undefined;
  const repository = createPrincipalRepository(ports.adapter);
  const principal = repository.findById(caller);
  return principal?.kind === 'member' &&
    principal.status === 'active' &&
    holdsOwnerRole(repository, caller)
    ? caller
    : undefined;
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
export function amendedRecordIds(action: string, input: unknown): string[] {
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
      const ids = amendedRecordIds(action, input);
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
            'change it in the common channel. Save what you learned as a personal lesson ' +
            'without replacing it, or ask the owner in your reply or report.'
        );
        error.name = 'denied';
        throw error;
      }
      return await registration.exec(input, context);
    },
  };
}

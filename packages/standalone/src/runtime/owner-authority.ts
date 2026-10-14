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
import {
  referenceExists,
  admittedScopeIds,
  readableScopeIds,
  type RecordLink,
  type JudgmentAmendment,
} from '@jungjaehoon/mama-core/knowledge';
import { roomChannel } from './principal-access.js';
import type {
  ActionContext,
  ActionRegistration,
  DatabaseInstance,
  MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { createPrincipalRepository, type PrincipalRepository } from '@jungjaehoon/mama-core';

export function holdsOwnerRole(
  repository: Pick<PrincipalRepository, 'listRoles'>,
  principalId: string
): boolean {
  return repository.listRoles(principalId).some(({ role }) => role === 'owner');
}

export const RULE_KINDS = ['lesson', 'preference', 'constraint', 'workflow'] as const;
const COMMON_RULE_TOOL = 'common-channel-rule';

export const POLICY_UPDATE_ACTION = 'manage.policy.update';

const OWNER_CHAT_REF = /^(?:telegram|discord|slack):[^:]+:[^:]+$/;

export function isOwnerChatRef(ref: unknown): boolean {
  return typeof ref === 'string' && OWNER_CHAT_REF.test(ref);
}

export interface OwnerMessageAuthority {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  isOwnerMessageTurn(sourceMessageRef: string, principalId: string): boolean;
  /** With one configured, a common-session turn speaks for a person only from this channel. */
  commonChannelId?: string;
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
  // Another allowed group reaches the common session too, but management, enrollment, the time
  // zone and common skills change only from the common channel, as owner policy does.
  if (ports.commonChannelId !== undefined && !ref!.startsWith(`telegram:${ports.commonChannelId}:`))
    return undefined;
  const row = ports.adapter
    .prepare(
      `SELECT json_extract(payload_json, '$.senderPrincipalId') AS sender
     FROM mailbox_inputs WHERE stimulus_id=? AND principal_id=? AND kind='owner_message'
     ORDER BY id DESC LIMIT 1`
    )
    .get(ref, principalId) as { sender: string | null } | undefined;
  return row?.sender ?? undefined;
}

/** Re-read status and role when the action executes, including after a target-chain wait. */
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
           WHERE j.record_id = d.id AND (b.principal_id = ? OR
             json_extract(d.provenance_json, '$.tool_name') = ?)
             AND b.action = 'judgment.append' AND b.receipt_kind = 'judgment'
             AND b.receipt_key = d.id
         )`
    )
    .all(...ids, ownerPrincipalId, COMMON_RULE_TOOL) as Array<{
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

export function ownerSpeaking(
  context: ActionContext,
  ownerPrincipalId: string,
  commonChannelId?: string
): boolean {
  const ref = context.session?.sourceMessageRef;
  // With a common channel configured, owner policy changes come only from its messages: the
  // common session's turn or a room session there, never another allowed group.
  return (
    (context.access.principalId === ownerPrincipalId ||
      (commonChannelId !== undefined && roomChannel(context.access) === commonChannelId)) &&
    (commonChannelId === undefined || ref?.startsWith(`telegram:${commonChannelId}:`) === true) &&
    context.session?.replaySourceEndMs === undefined &&
    isOwnerChatRef(ref)
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
  ownerPrincipalId: string,
  commonChannelId?: string,
  /** Whether the caller's own source reads (channels, enrollment floor) reach an observation. */
  observationVisible: (observationId: string, context: ActionContext) => boolean = () => false
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
      // Core checks only that a linked observation exists. Any caller other than the common
      // session links an observation, or an edge with one at either end, only if its own source
      // reads reach it.
      if (context.access.principalId !== ownerPrincipalId) {
        const links = (input as { links?: RecordLink[] }).links ?? [];
        const linkedObservations = links.flatMap((link) => {
          if (link.target.kind === 'observation') return [link.target.id];
          if (link.target.kind !== 'edge') return [];
          const edge = adapter
            .prepare(
              'SELECT subject_kind, subject_id, object_kind, object_id FROM twin_edges WHERE edge_id = ?'
            )
            .get(link.target.id) as
            | { subject_kind: string; subject_id: string; object_kind: string; object_id: string }
            | undefined;
          if (!edge) return [];
          return [
            ...(edge.subject_kind === 'observation' ? [edge.subject_id] : []),
            ...(edge.object_kind === 'observation' ? [edge.object_id] : []),
          ];
        });
        for (const id of linkedObservations) {
          if (!observationVisible(id, context)) {
            const error = new Error(`A judgment reference is unavailable: observation ${id}`);
            error.name = 'denied';
            throw error;
          }
        }
      }
      const owned = ownerRuleIds(adapter, ids, ownerPrincipalId);
      if (owned.size > 0 && !ownerSpeaking(context, ownerPrincipalId, commonChannelId)) {
        const error = new Error(
          `${[...owned].join(', ')} ${owned.size === 1 ? 'is an owner rule' : 'are owner rules'}: ` +
            'change it in the common channel. Save what you learned as a personal lesson ' +
            'without replacing it, or ask the owner in your reply or report.'
        );
        error.name = 'denied';
        throw error;
      }
      if (
        owned.size > 0 &&
        context.access.principalId !== ownerPrincipalId &&
        ownerSpeaking(context, ownerPrincipalId, commonChannelId)
      ) {
        const command = input as {
          kind?: string;
          links?: RecordLink[];
          amends?: JudgmentAmendment[];
        };
        if (
          ids.some((id) => !owned.has(id)) ||
          (action === 'memory.save' && !(RULE_KINDS as readonly unknown[]).includes(command.kind))
        ) {
          const error = new Error(
            'Common rule corrections may replace or retire only owner rules and must keep a rule kind'
          );
          error.name = 'denied';
          throw error;
        }
        // Check references under the original authority before admitting the rule targets.
        // The common scope below authorizes only the named owner rules and the new rule.
        for (const [refs, scopeIds] of [
          [(command.links ?? []).map((link) => link.target), readableScopeIds(context.access)],
          [
            (command.amends ?? []).map((amendment) => amendment.target),
            admittedScopeIds(context.access),
          ],
        ] as const) {
          for (const ref of refs) {
            if (!referenceExists(adapter, ref, scopeIds)) {
              const error = new Error(`A judgment reference is unavailable: ${ref.kind} ${ref.id}`);
              error.name = 'denied';
              throw error;
            }
          }
        }
        // A common rule's correction is common; a rule saved only in a partition keeps that
        // partition instead of being promoted into the common records.
        const common = { kind: 'user' as const, id: ownerPrincipalId };
        const bound = (
          adapter
            .prepare(
              `SELECT DISTINCT s.kind, s.external_id FROM memory_scope_bindings b
               JOIN memory_scopes s ON s.id = b.scope_id
               WHERE b.memory_id IN (${[...owned].map(() => '?').join(',')})`
            )
            .all(...owned) as Array<{ kind: string; external_id: string }>
        ).map((row) => ({ kind: row.kind, id: row.external_id }) as MemoryScopeRef);
        const scopes =
          bound.length === 0 ||
          bound.some((scope) => scope.kind === common.kind && scope.id === common.id)
            ? [common]
            : bound;
        // A partition rule is corrected only by a room that still holds that partition.
        if (
          scopes === bound &&
          !bound.every((target) =>
            context.access.scopes.some(
              (scope) => scope.kind === target.kind && scope.id === target.id
            )
          )
        ) {
          const error = new Error('The rule is bound to a project outside your grants');
          error.name = 'denied';
          throw error;
        }
        return await registration.exec(
          action === 'memory.save' ? { ...(input as object), scopes } : input,
          {
            ...context,
            session: { ...context.session, toolName: COMMON_RULE_TOOL },
            access: {
              ...context.access,
              scopes: [
                ...context.access.scopes.filter(
                  (scope) =>
                    !scopes.some((target) => target.kind === scope.kind && target.id === scope.id)
                ),
                ...scopes,
              ],
              defaultScopes: scopes,
            },
          }
        );
      }
      // Stamp the host-selected common-channel rule path, never a scope supplied by the caller.
      const kind = (input as { kind?: unknown }).kind;
      if (
        action === 'memory.save' &&
        (RULE_KINDS as readonly unknown[]).includes(kind) &&
        ownerSpeaking(context, ownerPrincipalId, commonChannelId)
      ) {
        return await registration.exec(input, {
          ...context,
          session: { ...context.session, toolName: COMMON_RULE_TOOL },
        });
      }
      return await registration.exec(input, context);
    },
  };
}

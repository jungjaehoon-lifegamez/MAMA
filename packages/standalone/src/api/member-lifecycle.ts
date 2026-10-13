import {
  createPrincipalRepository,
  type ActionRegistration,
  type ActionContext,
  type ActionContract,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { validateMemberMemoryGrant, resolvePrincipalAccess } from '../runtime/principal-access.js';
import type { TimeZoneSetting } from '../runtime/timezone.js';
import { activeOwnerMessageCaller, holdsOwnerRole } from '../runtime/owner-authority.js';
import type { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { createSerialTurnChain } from '../runtime/principal-sessions.js';

/**
 * A display name reaches other sessions' turn headers as host text, so it carries letters, digits,
 * spaces and name punctuation only: no ':' '/' '@' or other characters that could make it read as
 * an instruction or an address (Codex security review on #479).
 */
export function memberNameAllowed(name: string): boolean {
  return /^[\p{L}\p{M}\p{N} .'\-·]+$/u.test(name.trim());
}

export const MEMBER_MANAGEMENT_ACTIONS = [
  'manage.member.grant',
  'manage.member.revoke',
  'manage.member.suspend',
  'manage.member.resume',
  'manage.member.offboard',
  'manage.member.list',
  'manage.member.name',
] as const;

export type MemberManagementContext = ActionContext & { memberManagementQueued?: boolean };

export interface MemberLifecyclePorts {
  mailbox(): Mailbox;
  resumeQueued(): void;
  isStopping(): boolean;
  turnChain(principalId: string): ReturnType<typeof createSerialTurnChain>;
  resetSession(principalId: string): Promise<void>;
  retire(principalId: string): Promise<void>;
  resume(principalId: string): Promise<void>;
  cancelQueued(principalId: string, reason: string): number;
}

/** The surface queues all changes on the target chain, then uses the member directory lane. */
export function memberLifecycleRegistrations(options: {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  ownerAccess(): JudgmentAccess;
  isOwnerMessageTurn(sourceMessageRef: string, principalId: string): boolean;
  timeZone: TimeZoneSetting;
  ports?: MemberLifecyclePorts;
  scheduleChange(name: string, input: unknown, context: MemberManagementContext): Promise<unknown>;
}): ActionRegistration[] {
  let principals: ReturnType<typeof createPrincipalRepository> | undefined;
  const properties: NonNullable<ActionContract['inputSchema']['properties']> = {
    principalId: {
      type: 'string',
      pattern: '\\S',
      description: 'Registry member principal id, never a transport identity.',
    },
    name: {
      type: 'string',
      pattern: '\\S',
      description:
        'Owner supplied member display name: 1 to 120 characters after trimming. Telegram names are not used.',
    },
    scopeKind: { type: 'string', enum: ['project'] },
    scopeId: {
      type: 'string',
      pattern: '\\S',
      description: 'Project partition id. Owner default partitions cannot be granted.',
    },
  };
  return MEMBER_MANAGEMENT_ACTIONS.map((name): ActionRegistration => {
    const change = name.slice('manage.member.'.length);
    const scopeChange = change === 'grant' || change === 'revoke';
    return {
      contract: {
        name,
        summary:
          {
            grant:
              'Grant project-partition memory read access to an active member. Reset its native session; keep workspace files and personal start context. Source-channel grants are not offered.',
            revoke:
              'Revoke a project-partition memory grant. Reset the member native session; keep workspace files, other grants and personal start context.',
            suspend:
              'Suspend an active member, end and unserve its session, and set its runtime directory aside under member_root and its temp directory aside under the member temp root. Keep grants and identity.',
            resume:
              'Resume a suspended member with retained grants. Move any remaining runtime and temp directories aside and serve a fresh environment.',
            offboard:
              'Permanently offboard an active or suspended member; revoke every grant atomically, end and unserve its session, move runtime/temp aside, and keep its identity binding.',
            list: 'List member display names when set, principal ids, registry roles (including owner), statuses and unrevoked grants, including grants retained during suspension, and the latest enrollment receipts from the common record (created, exists or refused, with the reason), in either room. Receipts carry the owner-local time of each pick. Never returns transport identities or record content.',
            name: "Set a member display name: your own, or a member without the owner role (an owner-role member names itself). Letters, digits, spaces and . - ' · only. Only people in the member registry can be named; the common session cannot. Use the name the owner supplies, never a Telegram name.",
          }[change]! +
          ' Only an active owner-role caller in its own DM or recorded common-channel message turn is allowed; delta, scheduled/report, replay, plain-member and subagent turns are denied.' +
          (change === 'name'
            ? ''
            : ' Grants/revocations run on the target chain. Suspend, resume and offboard wait for running member turns and hold new member turns while changing directories. The common session continues. Changes cancel queued target inputs with a host reason. A waiting change returns scheduled with a commandId; the final result is stored in the common management receipt. Caller authority is checked again when the change runs.'),
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties:
            change === 'list'
              ? {}
              : change === 'name'
                ? { principalId: properties.principalId, name: properties.name }
                : scopeChange
                  ? {
                      principalId: properties.principalId,
                      scopeKind: properties.scopeKind,
                      scopeId: properties.scopeId,
                    }
                  : { principalId: properties.principalId },
          required:
            change === 'list'
              ? []
              : change === 'name'
                ? ['principalId', 'name']
                : scopeChange
                  ? ['principalId', 'scopeKind', 'scopeId']
                  : ['principalId'],
        },
      },
      exec: async (input, context: MemberManagementContext) => {
        const caller = activeOwnerMessageCaller(context, options);
        if (!caller) {
          throw Object.assign(
            new Error(
              "Member management requires a registered person's message turn from an active owner-role member. Discord and Slack common turns have no registered sender; use Telegram."
            ),
            { name: 'denied' }
          );
        }
        const repo = (principals ??= createPrincipalRepository(options.adapter));
        if (change === 'list') {
          const timeZone = options.timeZone.get();
          // Each users_shared pick ends in a host receipt in the common conversation record; a
          // refused or failed pick leaves no registry row, so the receipt is its only trace.
          const enrollmentReceipts = options.adapter
            .prepare(
              `SELECT m.source_timestamp_ms AS at, r.content AS receipt
               FROM connector_event_index m
               JOIN connector_event_index r ON r.source_connector = 'chat'
                 AND r.source_entity_id = m.source_entity_id || ':reply'
                 AND json_extract(r.metadata_json, '$.deliveryVerified') = 1
               WHERE m.source_connector = 'chat' AND m.memory_scope_kind = 'user'
                 AND m.memory_scope_id = ?
                 AND json_extract(m.metadata_json, '$.input.enrollmentSelection') = 1
               ORDER BY m.source_timestamp_ms DESC, m.rowid DESC LIMIT 5`
            )
            .all(options.ownerPrincipalId) as Array<{ at: number; receipt: string }>;
          return {
            recentEnrollments: enrollmentReceipts.map(({ at, receipt }) => ({
              at: `${new Date(at).toLocaleString('ko-KR', { timeZone })} (${timeZone})`,
              receipt,
            })),
            members: repo.listMembers().map(({ principalId, displayName, status }) => ({
              principalId,
              ...(displayName === undefined ? {} : { displayName }),
              roles: repo.listRoles(principalId).map(({ role }) => role),
              status,
              grants: repo
                .listRetainedGrants(principalId)
                .map(({ scope }) =>
                  scope.kind === 'source' ? { kind: scope.kind, connector: scope.connector } : scope
                ),
            })),
          };
        }
        const { principalId, scopeKind, scopeId } = input as {
          principalId: string;
          scopeKind: 'project';
          scopeId: string;
        };
        const principal = repo.findById(principalId);
        if (!principal) throw new Error(`Unknown principal: ${principalId}`);
        const refuse = (reason: string) => {
          throw Object.assign(new Error(reason), { name: 'denied' });
        };
        if (principal.kind !== 'member')
          refuse('The common principal cannot be a member-management target');
        if (change === 'name') {
          const requested = (input as { name: string }).name;
          if (!memberNameAllowed(requested))
            refuse("A name may use letters, digits, spaces and . - ' · only");
          // An owner's name sits in that owner's own privileged turns; only that owner sets it.
          if (holdsOwnerRole(repo, principalId) && principalId !== caller)
            refuse("Only that owner can set an owner-role member's name");
          const displayName = repo.setDisplayName({
            principalId,
            displayName: requested,
            now: Date.now(),
          });
          return { principalId, change, displayName };
        }
        if (change === 'suspend' && principalId === caller) refuse('You cannot suspend yourself');
        if (holdsOwnerRole(repo, principalId) && change !== 'suspend' && change !== 'resume')
          refuse(
            change === 'offboard'
              ? 'An owner-role member cannot be offboarded'
              : 'Grants cannot be changed for an owner-role member'
          );
        const ports = options.ports;
        if (!ports)
          throw new Error('Member management requires member_root and a running member runtime');
        if (!context.memberManagementQueued) return options.scheduleChange(name, input, context);
        if (scopeChange) {
          const scope = { kind: 'memory' as const, scopeKind, scopeId: scopeId.trim() };
          const ownerAccess = options.ownerAccess();
          // A suspended member keeps its grants and has no session; the owner may still revoke one.
          const served = principal.status === 'active';
          // A revoke only removes access, so it is never refused for the state it repairs: only a
          // grant can make the member's next turn or the owner's boot fail.
          if (change === 'grant') {
            if (!served) throw new Error(`Cannot grant to a ${principal.status} member`);
            // This overlap makes resolvePrincipalAccess throw at the next turn and at boot.
            validateMemberMemoryGrant(scope, ownerAccess);
            resolvePrincipalAccess(principalId, {
              adapter: options.adapter,
              ownerAccess,
              agentId: `member-agent:${principalId}`,
            });
          }
          // Reset first: a crash after the grant transaction cannot resume an old native context.
          if (served) await ports.resetSession(principalId);
          const result = options.adapter.transaction(() => {
            const mutation = {
              targetPrincipalId: principalId,
              ownerPrincipalId: options.ownerPrincipalId,
              scope,
              now: Date.now(),
            };
            const status =
              change === 'grant' ? repo.grantScope(mutation) : repo.revokeScope(mutation);
            if (change === 'grant')
              resolvePrincipalAccess(principalId, {
                adapter: options.adapter,
                ownerAccess,
                agentId: `member-agent:${principalId}`,
              });
            return { status, cancelledInputs: ports.cancelQueued(principalId, `member_${change}`) };
          });
          return { principalId, change, scope, ...result, sessionReset: served, setAside: false };
        }
        if (change === 'resume') {
          if (principal.status !== 'suspended')
            throw new Error(`Cannot resume a ${principal.status} member`);
          // Cancel before serving: once served, a queued input is a fresh one the member just sent.
          const cancelledInputs = ports.cancelQueued(principalId, 'member_resume');
          // The port moves residual directories before activating, so an interrupted retry is safe.
          await ports.resume(principalId);
          return {
            principalId,
            change,
            status: 'active',
            sessionReset: true,
            freshEnvironment: true,
            cancelledInputs,
          };
        }
        const cancelledInputs = options.adapter.transaction(() => {
          // An explicit retry of the same change must still finish a failed stop/move without
          // attempting a forbidden suspended -> suspended or offboarded -> offboarded transition.
          if (change === 'suspend') {
            if (principal.status !== 'suspended') repo.suspend(principalId, Date.now());
          } else if (principal.status !== 'offboarded') repo.offboard(principalId, Date.now());
          return ports.cancelQueued(principalId, `member_${change}`);
        });
        // Inactive registry state denies new turns even if process stop or a move fails.
        await ports.retire(principalId);
        return {
          principalId,
          change,
          status: change === 'suspend' ? 'suspended' : 'offboarded',
          sessionEnded: true,
          setAside: true,
          cancelledInputs,
        };
      },
    };
  });
}

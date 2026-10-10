import {
  createPrincipalRepository,
  type ActionRegistration,
  type ActionContract,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { validateMemberMemoryGrant, resolvePrincipalAccess } from '../runtime/principal-access.js';

export const MEMBER_MANAGEMENT_ACTIONS = [
  'manage.member.grant',
  'manage.member.revoke',
  'manage.member.suspend',
  'manage.member.resume',
  'manage.member.offboard',
  'manage.member.list',
] as const;

export interface MemberLifecyclePorts {
  resetSession(principalId: string): Promise<void>;
  retire(principalId: string): Promise<void>;
  resume(principalId: string): Promise<void>;
  cancelQueued(principalId: string, reason: string): number;
}

/** Host lifecycle effects execute inside the owner's already-held shared serial turn slot. */
export function memberLifecycleRegistrations(options: {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  ownerAccess(): JudgmentAccess;
  isOwnerMessageTurn(sourceMessageRef: string): boolean;
  ports?: MemberLifecyclePorts;
}): ActionRegistration[] {
  const properties: NonNullable<ActionContract['inputSchema']['properties']> = {
    principalId: {
      type: 'string',
      pattern: '\\S',
      description: 'Registry member principal id, never a transport identity.',
    },
    scopeKind: { type: 'string', enum: ['project'] },
    scopeId: {
      type: 'string',
      pattern: '\\S',
      description: 'Project partition id. Owner default partitions cannot be granted.',
    },
  };
  return MEMBER_MANAGEMENT_ACTIONS.map((name) => {
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
              'Suspend an active member, end and unserve its session, and move runtime and temp directories aside under member_root. Keep grants and identity.',
            resume:
              'Resume a suspended member with retained grants. Move any remaining runtime and temp directories aside and serve a fresh environment.',
            offboard:
              'Permanently offboard an active or suspended member; revoke every grant atomically, end and unserve its session, move runtime/temp aside, and keep its identity binding.',
            list: 'List member principal ids, statuses and unrevoked grants, including grants retained during suspension. Never returns transport identities or record content.',
          }[change]! +
          ' Only the owner own message turn is allowed; delta, scheduled/report, replay, member and subagent turns are denied. Changes apply after the running member turn on the shared serial chain and cancel queued inputs with a host reason.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties:
            change === 'list'
              ? {}
              : scopeChange
                ? properties
                : { principalId: properties.principalId },
          required:
            change === 'list'
              ? []
              : scopeChange
                ? ['principalId', 'scopeKind', 'scopeId']
                : ['principalId'],
        },
      },
      exec: async (input, context) => {
        const ref = context.session?.sourceMessageRef;
        if (
          context.access.principalId !== options.ownerPrincipalId ||
          context.session?.replaySourceEndMs !== undefined ||
          !ref ||
          !options.isOwnerMessageTurn(ref)
        ) {
          throw Object.assign(
            new Error('Member management is available only in an owner message turn'),
            { name: 'denied' }
          );
        }
        const repo = createPrincipalRepository(options.adapter);
        if (change === 'list') {
          return {
            members: repo.listMembers().map(({ principalId, status }) => ({
              principalId,
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
        if (principal.kind !== 'member')
          throw Object.assign(
            new Error('The owner principal cannot be a member-management target'),
            { name: 'denied' }
          );
        const ports = options.ports;
        if (!ports) throw new Error('Member management requires a running member runtime');
        if (scopeChange) {
          const scope = { kind: 'memory' as const, scopeKind, scopeId: scopeId.trim() };
          const ownerAccess = options.ownerAccess();
          // This overlap makes resolvePrincipalAccess throw at the next turn and at boot.
          validateMemberMemoryGrant(scope, ownerAccess);
          resolvePrincipalAccess(principalId, {
            adapter: options.adapter,
            ownerAccess,
            agentId: `member-agent:${principalId}`,
          });
          // Reset first: a crash after the grant transaction cannot resume an old native context.
          await ports.resetSession(principalId);
          const result = options.adapter.transaction(() => {
            const mutation = {
              targetPrincipalId: principalId,
              ownerPrincipalId: options.ownerPrincipalId,
              scope,
              now: Date.now(),
            };
            const status =
              change === 'grant' ? repo.grantScope(mutation) : repo.revokeScope(mutation);
            resolvePrincipalAccess(principalId, {
              adapter: options.adapter,
              ownerAccess,
              agentId: `member-agent:${principalId}`,
            });
            return { status, cancelledInputs: ports.cancelQueued(principalId, `member_${change}`) };
          });
          return { principalId, change, scope, ...result, sessionReset: true, setAside: false };
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
          if (change === 'suspend') repo.suspend(principalId, Date.now());
          // Terminal status already blocks admission. An explicit retry must still finish a
          // failed stop/move without attempting the forbidden offboarded -> offboarded transition.
          else if (principal.status !== 'offboarded') repo.offboard(principalId, Date.now());
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

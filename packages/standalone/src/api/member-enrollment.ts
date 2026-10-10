import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  createPrincipalRepository,
  type ActionContext,
  type ActionDispatcher,
  type ActionRegistration,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { MEMBER_CLAUDE_TMP_PARENT, physicalReadPath } from '../runtime/backend-security.js';
import { ensureMemberPaths, memberClaudeTmpDir } from '../runtime/member-paths.js';
import { resolvePrincipalAccess } from '../runtime/principal-access.js';

/** Transport facts supplied by the gateway only, never by action arguments. */
export interface MemberSelection {
  sourceMessageRef: string;
  ownerUserId: string;
  userId: string;
}

export interface MemberEnrollmentPorts {
  memberRoot?: string;
  ownerUserIds: readonly string[];
  requestSelection(sourceMessageRef: string): Promise<void>;
  serveMember?(principalId: string): void;
}

export function createMemberEnrollment(options: {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  isOwnerMessageTurn(sourceMessageRef: string): boolean;
  ownerAccess(): JudgmentAccess;
  ports?: MemberEnrollmentPorts;
}) {
  // A completion exists only while a host-issued dispatcher operation is executing.
  const completions = new Map<string, MemberSelection>();
  const registration: ActionRegistration = {
    contract: {
      name: 'manage.member.enroll',
      summary:
        "Ask the owner to pick one member with a Telegram button in the owner's DM. Only an owner message turn may request enrollment; delta, scheduled, replay, member and subagent turns are denied. Requires member_root and a daemon restart after configuring it. The host registers the selected identity; this action accepts no person, chat or grants. Returns pending; enrollment grants no shared access and does not admit member messages.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      examples: [{ title: 'Ask the owner to choose a member', input: {} }],
    },
    exec: async (_input, context: ActionContext) => {
      const ref = context.session?.sourceMessageRef;
      if (
        context.access.principalId !== options.ownerPrincipalId ||
        context.session?.replaySourceEndMs !== undefined ||
        !ref ||
        !options.isOwnerMessageTurn(ref)
      ) {
        throw Object.assign(new Error('Enrollment is available only in an owner message turn'), {
          name: 'denied',
        });
      }
      const ports = options.ports;
      if (!ports)
        throw Object.assign(new Error("Enrollment requires Telegram as the owner's messenger"), {
          name: 'denied',
        });
      if (!ports.memberRoot)
        throw Object.assign(new Error('Set member_root and restart the daemon before enrollment'), {
          name: 'denied',
        });
      const selection = context.operationId ? completions.get(context.operationId) : undefined;
      if (!selection) {
        await ports.requestSelection(ref);
        return { status: 'pending' };
      }
      const repo = createPrincipalRepository(options.adapter);
      const current = repo.resolveByExternal('telegram', 'private', selection.userId);
      const receipt = (
        status: 'created' | 'exists' | 'refused',
        principalId: string | null,
        message?: string
      ) => ({
        status,
        principalId,
        connector: 'telegram',
        namespace: 'private',
        ...(message ? { message } : {}),
      });
      if (selection.userId === selection.ownerUserId)
        return receipt(
          'refused',
          options.ownerPrincipalId,
          "The owner's own identity cannot be enrolled"
        );
      if (ports.ownerUserIds.includes(selection.userId))
        return receipt(
          'refused',
          current?.principalId ?? null,
          'The selected identity is an owner listed in Telegram owner_user_ids; an owner is not enrolled as a member'
        );
      if (current && current.status !== 'active')
        return receipt(
          'refused',
          current.principalId,
          `The selected principal is ${current.status}`
        );
      if (current?.kind === 'member') {
        ports.serveMember?.(current.principalId);
        return receipt('exists', current.principalId);
      }
      if (current && current.principalId !== options.ownerPrincipalId)
        return receipt(
          'refused',
          current.principalId,
          'The selected identity belongs to another owner'
        );
      const principalId = options.adapter.transaction(() => {
        const identity = {
          connector: 'telegram',
          namespace: 'private',
          externalId: selection.userId,
          now: Date.now(),
        };
        const id = current
          ? repo.moveIdentityToMember({
              ...identity,
              expectedPrincipalId: options.ownerPrincipalId,
            })
          : repo.registerMember(identity);
        resolvePrincipalAccess(id, {
          adapter: options.adapter,
          ownerAccess: options.ownerAccess(),
          agentId: `member-agent:${id}`,
        });
        // Validate the old smoke paths before removing anything, including symlink containment.
        const paths = ensureMemberPaths(ports.memberRoot!, id);
        const temp = memberClaudeTmpDir(id);
        const expectedTemp = join(
          physicalReadPath(dirname(MEMBER_CLAUDE_TMP_PARENT)),
          basename(MEMBER_CLAUDE_TMP_PARENT),
          basename(temp)
        );
        if (physicalReadPath(temp) !== expectedTemp)
          throw new Error('Member temp path must not be a symlink');
        rmSync(paths.runtimeRoot, { recursive: true, force: true });
        rmSync(temp, { recursive: true, force: true });
        ensureMemberPaths(ports.memberRoot!, id);
        mkdirSync(temp, { recursive: true, mode: 0o700 });
        return id;
      });
      ports.serveMember?.(principalId);
      return receipt('created', principalId);
    },
  };
  return {
    registration,
    complete: async (selection: MemberSelection, dispatch: ActionDispatcher) => {
      const operationId = `member-enrollment:${randomUUID()}`;
      completions.set(operationId, selection);
      try {
        return await dispatch(
          { action: registration.contract.name, input: {}, operationId },
          {
            access: options.ownerAccess(),
            session: { sourceMessageRef: selection.sourceMessageRef },
          }
        );
      } finally {
        completions.delete(operationId);
      }
    },
  };
}

import { randomUUID } from 'node:crypto';
import {
  createPrincipalRepository,
  type ActionContext,
  type ActionDispatcher,
  type ActionRegistration,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { clearMemberSmokeState } from './member-smoke-state.js';
import { memberNameAllowed } from './member-lifecycle.js';
import { activeOwnerMessageCaller } from '../runtime/owner-authority.js';
import { resolvePrincipalAccess } from '../runtime/principal-access.js';

/** Transport facts supplied by the gateway only, never by action arguments. */
export interface MemberSelection {
  sourceMessageRef: string;
  ownerUserId: string;
  userId: string;
  /** Optional name supplied by the acting owner in the enrollment action. */
  name?: string;
}

export interface MemberEnrollmentPorts {
  memberRoot?: string;
  requestSelection(sourceMessageRef: string, ownerUserId: string, name?: string): Promise<void>;
  cancelSelection?(principalId: string): void;
  serveMember?(principalId: string): void | 'next_start' | 'after_erasure';
}

export function createMemberEnrollment(options: {
  adapter: DatabaseInstance;
  ownerPrincipalId: string;
  isOwnerMessageTurn(sourceMessageRef: string, principalId: string): boolean;
  ownerAccess(): JudgmentAccess;
  ports?: MemberEnrollmentPorts;
  directoryChange?: <T>(work: () => Promise<T>) => Promise<T>;
}) {
  // A completion exists only while a host-issued dispatcher operation is executing.
  const completions = new Map<string, MemberSelection>();
  const registration: ActionRegistration = {
    contract: {
      name: 'manage.member.enroll',
      summary:
        "Enrollment runs in an active owner-role caller's own message turn (DM or the common channel), sending the Choose member button to the owner's own Telegram DM. Requires member_root and a daemon restart after configuring it. The host registers the selected identity; this action accepts an optional owner supplied name for the new member, but no identity, chat or grants. Telegram names are not used. Returns pending; enrollment grants no shared access. Active members' own messages are admitted by the registry.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            pattern: '\\S',
            description: 'Optional member display name: 1 to 120 characters after trimming.',
          },
        },
      },
      examples: [{ title: 'Ask the owner to choose a member', input: {} }],
    },
    exec: async (input, context: ActionContext & { memberEnrollmentQueued?: boolean }) => {
      const name = (input as { name?: string }).name?.trim();
      if (name !== undefined && !memberNameAllowed(name))
        throw Object.assign(new Error("A name may use letters, digits, spaces and . - ' · only"), {
          name: 'denied',
        });
      const ref = context.session?.sourceMessageRef;
      const caller = activeOwnerMessageCaller(context, options);
      if (!caller) {
        throw Object.assign(
          new Error(
            "Enrollment requires a registered person's message turn from an active owner-role member. Discord and Slack common turns have no registered sender; use Telegram."
          ),
          { name: 'denied' }
        );
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
        const callerAccess = resolvePrincipalAccess(caller, {
          adapter: options.adapter,
          ownerAccess: options.ownerAccess(),
          agentId: `member-agent:${caller}`,
        });
        const dm = callerAccess.destinations!.find(
          (destination) => destination.kind === 'telegram'
        )!;
        await ports.requestSelection(ref!, dm.id, name);
        return { status: 'pending' };
      }
      if (!context.memberEnrollmentQueued)
        return options.directoryChange!(async () =>
          registration.exec(input, { ...context, memberEnrollmentQueued: true } as ActionContext)
        );
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
        return receipt('refused', caller, "The owner's own identity cannot be enrolled");
      if (current && current.status !== 'active')
        return receipt(
          'refused',
          current.principalId,
          `The selected principal is ${current.status}`
        );
      if (current?.kind === 'member') {
        const serving = ports.serveMember?.(current.principalId);
        return receipt(
          'exists',
          current.principalId,
          serving === 'next_start'
            ? 'The member is registered and will be served at the next start'
            : serving === 'after_erasure'
              ? "The member's personal records are being erased; it is served again when that ends"
              : undefined
        );
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
        if (name !== undefined)
          repo.setDisplayName({ principalId: id, displayName: name, now: identity.now });
        resolvePrincipalAccess(id, {
          adapter: options.adapter,
          ownerAccess: options.ownerAccess(),
          agentId: `member-agent:${id}`,
        });
        clearMemberSmokeState(ports.memberRoot!, id);
        return id;
      });
      const serving = ports.serveMember?.(principalId);
      return receipt(
        'created',
        principalId,
        serving === 'next_start'
          ? 'The member is registered and will be served at the next start'
          : undefined
      );
    },
  };
  return {
    registration,
    complete: async (selection: MemberSelection, dispatch: ActionDispatcher) => {
      const repository = createPrincipalRepository(options.adapter);
      const person = repository.resolveByExternal('telegram', 'private', selection.ownerUserId);
      if (person?.kind !== 'member')
        throw new Error('Enrollment caller must be a registered member');
      const personalAccess = resolvePrincipalAccess(person.principalId, {
        adapter: options.adapter,
        ownerAccess: options.ownerAccess(),
        agentId: `member-agent:${person.principalId}`,
      });
      // The original request may be a common-channel turn; retain that room's host binding.
      const access = options.isOwnerMessageTurn(selection.sourceMessageRef, person.principalId)
        ? personalAccess
        : options.ownerAccess();
      const operationId = `member-enrollment:${randomUUID()}`;
      completions.set(operationId, selection);
      try {
        return await dispatch(
          {
            action: registration.contract.name,
            input: selection.name === undefined ? {} : { name: selection.name },
            operationId,
          },
          {
            access,
            session: { sourceMessageRef: selection.sourceMessageRef },
          }
        );
      } finally {
        completions.delete(operationId);
      }
    },
  };
}

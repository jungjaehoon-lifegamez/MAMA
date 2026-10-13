import type { ActionRegistration } from '@jungjaehoon/mama-core';
import {
  activeOwnerMessageCaller,
  type OwnerMessageAuthority,
} from '../runtime/owner-authority.js';
import type { SkillStore } from '../runtime/skills.js';

export function skillActionRegistrations(
  skills: SkillStore,
  authority: OwnerMessageAuthority
): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'skill.list',
        summary:
          'List your personal and common skills, both workflow records and SKILL.md folders. Returns ids for skill.read; nobody else personal skills are listed.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: ['personal', 'common'] },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      exec: async (input, context) => {
        const {
          scope,
          offset = 0,
          limit = 100,
        } = input as { scope?: 'personal' | 'common'; offset?: number; limit?: number };
        const all = (await skills.list(context.access.principalId)).filter(
          (skill) => scope === undefined || skill.scope === scope
        );
        return {
          skills: all.slice(offset, offset + limit),
          total: all.length,
          nextOffset: offset + limit < all.length ? offset + limit : null,
        };
      },
    },
    {
      contract: {
        name: 'skill.read',
        summary:
          'Read one skill by id from skill.list: workflow steps and evidence checks, or SKILL.md text plus supporting file paths. Run a script with your own shell in your workspace.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: '\\S' } },
        },
      },
      exec: async (input, context) =>
        skills.read(context.access.principalId, (input as { id: string }).id),
    },
    ...(['publish', 'unpublish'] as const).map(
      (action): ActionRegistration => ({
        contract: {
          name: `skill.${action}`,
          summary:
            action === 'publish'
              ? 'Publish skills/<name> from the common session workspace into the read-only common tools_root/skills folder. Only a common-channel message with a recorded active owner sender may publish; source links are refused and the complete folder is swapped atomically.'
              : 'Remove a published common file skill. Only a common-channel message with a recorded active owner sender may remove it.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
          },
        },
        exec: async (input, context) => {
          if (
            context.access.principalId !== authority.ownerPrincipalId ||
            !activeOwnerMessageCaller(context, authority)
          )
            throw Object.assign(
              new Error(
                'Common skills publish or unpublish only in a common-channel message turn from an active owner'
              ),
              { name: 'denied' }
            );
          return skills[action]((input as { name: string }).name);
        },
      })
    ),
  ];
}

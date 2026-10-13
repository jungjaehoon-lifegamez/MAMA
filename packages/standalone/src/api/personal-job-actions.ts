import { createPrincipalRepository, type ActionRegistration } from '@jungjaehoon/mama-core';
import type { PersonalJobStore } from '../runtime/personal-jobs.js';
import { messageTurnCaller, type OwnerMessageAuthority } from '../runtime/owner-authority.js';
export const PERSONAL_JOB_ACTIONS = [
  'schedule.job.create',
  'schedule.job.list',
  'schedule.job.update',
  'schedule.job.delete',
] as const;
export function personalJobRegistrations(
  store: PersonalJobStore,
  authority: OwnerMessageAuthority
): ActionRegistration[] {
  const fields = {
    cron: {
      type: 'string',
      pattern: '\\S',
      description:
        'Five numeric fields: minute hour day month weekday; *, lists, ranges, steps. At least 60 minutes apart.',
    },
    timeZone: {
      type: 'string',
      pattern: '\\S',
      description: 'IANA zone; defaults to the owner time-zone setting.',
    },
    instruction: { type: 'string', pattern: '\\S' },
    enabled: { type: 'boolean' },
    id: { type: 'string', pattern: '\\S' },
  } as const;
  return PERSONAL_JOB_ACTIONS.map((name) => {
    const kind = name.split('.').at(-1)!;
    const selected =
      kind === 'create'
        ? ['cron', 'timeZone', 'instruction']
        : kind === 'update'
          ? ['id', 'cron', 'timeZone', 'instruction', 'enabled']
          : kind === 'delete'
            ? ['id']
            : [];
    return {
      contract: {
        name,
        summary: `${kind} your personal cron/heartbeat jobs in your own DM message turn only. Job results go to your DM; [ack] means nothing to tell. No other person or common session can manage them.`,
        ...(kind === 'list' ? {} : { recallableWrite: true }),
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            selected.map((key) => [key, fields[key as keyof typeof fields]])
          ),
          required: kind === 'create' ? ['cron', 'instruction'] : kind === 'list' ? [] : ['id'],
        },
      },
      exec: async (input, context) => {
        const caller = messageTurnCaller(context, authority);
        const person = createPrincipalRepository(authority.adapter).findById(
          context.access.principalId
        );
        if (
          caller !== context.access.principalId ||
          person?.kind !== 'member' ||
          person.status !== 'active'
        )
          throw Object.assign(
            new Error('Personal jobs require your own DM message turn as an active person'),
            { name: 'denied' }
          );
        if (kind === 'list') return { jobs: store.list(caller).map(store.view) };
        if (!context.operationId)
          throw Object.assign(new Error('Personal job changes require an operation id'), {
            name: 'invalid_input',
          });
        if (kind === 'create')
          return store.create(input as Parameters<PersonalJobStore['create']>[0], context);
        if (kind === 'update')
          return store.update(input as Parameters<PersonalJobStore['update']>[0], context);
        return store.delete((input as { id: string }).id, context);
      },
    };
  });
}

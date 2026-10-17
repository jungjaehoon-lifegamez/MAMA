import { invalidInput } from '../utils/invalid-input.js';
import type { ActionRegistration } from '@jungjaehoon/mama-core';

/**
 * Kagemusha's `contract_no_update`: a record order that finds nothing to record says so, with
 * its reason, instead of ending in silence. The tool trace of this call is the record; the host
 * reads it when it checks the order.
 */
export function workNoUpdateActionRegistrations(): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.no_update',
        summary:
          'Declare that an order needs no work change, with the reason (chatter, already recorded, not work). Cite the observations the decision covers, the work items it covers (commitmentIds), or both.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1 },
            observationRefs: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
            commitmentIds: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        examples: [
          {
            title: 'Nothing to record',
            input: { reason: 'greetings only', observationRefs: ['obs_reference'] },
          },
          {
            title: 'Summary already current',
            input: {
              reason: 'its description already summarizes it',
              commitmentIds: ['commitment_id'],
            },
          },
        ],
      },
      exec: (input) => {
        const body = input as {
          reason?: unknown;
          observationRefs?: unknown;
          commitmentIds?: unknown;
        };
        if (typeof body.reason !== 'string' || body.reason.trim() === '')
          throw invalidInput('reason must be nonblank');
        const listed = (value: unknown) =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((ref) => typeof ref === 'string' && ref.trim() !== '');
        if (body.observationRefs !== undefined && !listed(body.observationRefs))
          throw invalidInput('observationRefs must list the observations the decision covers');
        if (body.commitmentIds !== undefined && !listed(body.commitmentIds))
          throw invalidInput('commitmentIds must list the work items the decision covers');
        // The host checks an order by what the no-update names, so it must name something.
        if (body.observationRefs === undefined && body.commitmentIds === undefined)
          throw invalidInput(
            'name the observations (observationRefs) or the work items (commitmentIds) the decision covers'
          );
        return { recorded: false, reason: body.reason.trim() };
      },
    },
  ];
}

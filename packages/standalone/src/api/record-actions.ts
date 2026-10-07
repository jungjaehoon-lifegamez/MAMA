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
          'Declare that a record order needs no work change, with the reason (chatter, already recorded, not work). Cite the observations the decision covers.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'observationRefs'],
          properties: {
            reason: { type: 'string', minLength: 1 },
            observationRefs: {
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
        ],
      },
      exec: (input) => {
        const body = input as { reason?: unknown; observationRefs?: unknown };
        if (typeof body.reason !== 'string' || body.reason.trim() === '')
          throw invalidInput('reason must be nonblank');
        if (
          !Array.isArray(body.observationRefs) ||
          body.observationRefs.length === 0 ||
          body.observationRefs.some((ref) => typeof ref !== 'string' || ref.trim() === '')
        )
          throw invalidInput('observationRefs must list the observations the decision covers');
        return { recorded: false, reason: body.reason.trim() };
      },
    },
  ];
}

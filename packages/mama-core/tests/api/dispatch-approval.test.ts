/**
 * An action that writes on someone's behalf may declare that it runs only after a person approved
 * it. The approval is a host-stated session fact, never call input.
 */
import { describe, expect, it } from 'vitest';

import { createCatalog, createDispatcher } from '../../src/index.js';

const ran: unknown[] = [];
const dispatch = createDispatcher(
  createCatalog(
    (['always', 'outsideOwnerTurn'] as const).map((approval) => ({
      contract: {
        name: `test.${approval}`,
        summary: 'test-only write',
        approval,
        inputSchema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: { text: { type: 'string' as const } },
        },
      },
      exec: (input: unknown) => {
        ran.push(input);
        return { ok: true };
      },
    }))
  )
);
const access = {
  principalId: 'p',
  agentId: 'a',
  scopes: [],
  actions: ['test.always', 'test.outsideOwnerTurn'],
};

describe('approval-required actions', () => {
  it('refuses an always-approval action without an approved proposal', async () => {
    ran.length = 0;
    const result = await dispatch({ action: 'test.always', input: { text: 'x' } }, { access });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'approval_required' } });
    expect(ran).toEqual([]);
  });

  it('runs it when the session states an approved proposal', async () => {
    ran.length = 0;
    const result = await dispatch(
      { action: 'test.always', input: { text: 'x' } },
      { access, session: { approvedProposalId: 'proposal-1' } }
    );
    expect(result).toMatchObject({ status: 'completed' });
    expect(ran).toEqual([{ text: 'x' }]);
  });

  it('ignores an approvedProposalId in the call input', async () => {
    ran.length = 0;
    const result = await dispatch(
      { action: 'test.always', input: { text: 'x', approvedProposalId: 'proposal-1' } },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed' });
    expect(ran).toEqual([]);
  });

  it('leaves outsideOwnerTurn to the action', async () => {
    ran.length = 0;
    const result = await dispatch(
      { action: 'test.outsideOwnerTurn', input: { text: 'x' } },
      { access }
    );
    expect(result).toMatchObject({ status: 'completed' });
  });
});

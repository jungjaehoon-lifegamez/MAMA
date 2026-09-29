import { describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { judgeActionRegistrations } from '../../src/api/judge-actions.js';

function dispatcher(ask: Parameters<typeof judgeActionRegistrations>[0]['ask']) {
  const dispatch = createDispatcher(createCatalog(judgeActionRegistrations({ ask })));
  const context = {
    access: { principalId: 'owner-test', agentId: 'agent-test', scopes: [], actions: ['judge'] },
  } as unknown as ActionContext;
  return (input: unknown) => dispatch({ action: 'judge', input }, context);
}

describe('judge action', () => {
  it('sends the state and each question by id, and returns the answers', async () => {
    const ask = vi.fn(async () => ({ settles: { type: 'choice', choice: 'done' } }));
    const judge = dispatcher(ask);
    const example = judgeActionRegistrations({ ask }).at(0)!.contract.examples![0]!.input;
    const result = await judge(example);
    expect(result).toMatchObject({
      status: 'completed',
      data: { answers: { settles: { choice: 'done' } } },
    });
    expect(ask).toHaveBeenCalledWith({
      state: (example as { state: unknown }).state,
      questions: {
        settles: {
          type: 'choice',
          instructions: 'What do `messages` say about the state of `item`?',
          criteria: expect.objectContaining({ unrelated: expect.any(String) }),
        },
      },
    });
  });

  it('accepts every documented example', async () => {
    const ask = vi.fn(async () => ({}));
    const judge = dispatcher(ask);
    for (const example of judgeActionRegistrations({ ask })[0]!.contract.examples ?? [])
      expect(await judge(example.input)).toMatchObject({ status: 'completed' });
  });

  it('refuses a repeated id, a choice without options and a score without levels', async () => {
    const ask = vi.fn(async () => ({}));
    const judge = dispatcher(ask);
    const noul = { id: 'a', type: 'noul', instructions: 'Is it done?' };
    for (const [questions, message] of [
      [[noul, noul], 'questions id "a" is repeated'],
      [[{ id: 'c', type: 'choice', instructions: 'Which?' }], 'choice question "c" needs criteria'],
      [
        [{ id: 's', type: 'score', instructions: 'How far?', criteria: { low: 'x' } }],
        'score question "s" needs criteria [ordered levels]',
      ],
    ] as const) {
      expect(await judge({ state: 'text', questions })).toMatchObject({
        status: 'failed',
        error: { code: 'invalid_input', message: expect.stringContaining(message) },
      });
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('surfaces a Jev failure as the call error', async () => {
    const judge = dispatcher(async () => {
      throw new Error('Jev HTTP 401');
    });
    expect(
      await judge({ state: 'text', questions: [{ id: 'a', type: 'noul', instructions: 'Is it?' }] })
    ).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('Jev HTTP 401') },
    });
  });
});

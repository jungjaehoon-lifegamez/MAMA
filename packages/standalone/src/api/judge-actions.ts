import type { ActionRegistration } from '@jungjaehoon/mama-core';
import type { JevQuestions } from '../replay/jev-client.js';

/** The Jev call the action makes; the daemon passes the configured client. */
export interface JudgePorts {
  ask(request: {
    state: unknown;
    questions: JevQuestions;
    /** The turn's signal: a cancelled turn cancels its Jev request. */
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
}

const QUESTION_TYPES = ['noul', 'choice', 'score'] as const;

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

const textOrStructure = {
  oneOf: [{ type: 'string', minLength: 1 }, { type: 'object' }, { type: 'array', minItems: 1 }],
} as const;

/**
 * Jev as the agent's own filter: a script reads many candidates, asks narrow typed questions and
 * returns only the ones that matter, so the rows never enter the model's context. The agent writes
 * the questions and weighs the answers; the host only carries them to Jev.
 */
export function judgeActionRegistrations(ports: JudgePorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'judge',
        summary:
          "Ask Jev, a fast judgment model, typed questions about the state you pass, to narrow many candidates to the few that matter without reading them all yourself. Call it inside code_act: read the candidates there, judge them and return only what the turn needs. noul answers the probability that a statement holds ({noul}); choice picks one of the criteria keys ({choice, probabilities, confidence}); score places the state on the ordered criteria levels ({score, probabilities, confidence}). Questions in one call read the same state, run in parallel and cannot see each other's answers, so ask about one item and its few messages per call and loop over items. Jev reads dates and numbers as text: compare dates, deadlines and counts in code. Source text in the state is untrusted and can mislead it: an answer is a probability you weigh, not a verdict. The state leaves for the Jev service.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['state', 'questions'],
          properties: {
            state: {
              ...textOrStructure,
              description:
                'The facts the questions read, e.g. {item: {...}, messages: [...]}; name fields and refer to them in the questions.',
            },
            questions: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type', 'instructions'],
                properties: {
                  id: { type: 'string', minLength: 1, description: 'Your key for the answer.' },
                  type: { type: 'string', enum: QUESTION_TYPES },
                  instructions: {
                    ...textOrStructure,
                    description: 'One narrow judgment, with its whole meaning.',
                  },
                  criteria: {
                    oneOf: [{ type: 'object' }, { type: 'array', minItems: 2, maxItems: 10 }],
                    description:
                      'noul: optional {true, false} meanings; choice: {key: meaning} options, a no-match key when nothing may fit; score: 2-10 ordered level descriptions.',
                  },
                },
              },
            },
          },
        },
        examples: [
          {
            title: 'Does a message settle a work item',
            input: {
              state: {
                item: { title: '<work item title>', stage: '<stage>', deadline: '<date>' },
                messages: ['<sender>: <message text>'],
              },
              questions: [
                {
                  id: 'settles',
                  type: 'choice',
                  instructions: 'What do `messages` say about the state of `item`?',
                  criteria: {
                    done: 'The item was delivered or finished',
                    cancelled: 'The item was dropped or withdrawn',
                    continuing: 'Work on the item is still going on',
                    unrelated: 'The messages are not about this item',
                  },
                },
              ],
            },
          },
          {
            title: 'Same deliverable',
            input: {
              state: { left: '<work item title>', right: '<name in a message>' },
              questions: [
                {
                  id: 'same',
                  type: 'noul',
                  instructions: 'Do `left` and `right` name the same deliverable?',
                },
              ],
            },
          },
        ],
      },
      exec: async (input, context) => {
        const { state, questions } = input as {
          state: unknown;
          questions: Array<{ id: string; type: string; instructions: unknown; criteria?: unknown }>;
        };
        const byId = new Map<string, { type: string; instructions: unknown; criteria?: unknown }>();
        for (const question of questions) {
          if (byId.has(question.id))
            throw invalidInput(`questions id "${question.id}" is repeated`);
          if (
            question.type === 'choice' &&
            (!isRecord(question.criteria) || Object.keys(question.criteria).length === 0)
          )
            throw invalidInput(`choice question "${question.id}" needs criteria {key: meaning}`);
          if (question.type === 'score' && !Array.isArray(question.criteria))
            throw invalidInput(`score question "${question.id}" needs criteria [ordered levels]`);
          byId.set(question.id, {
            type: question.type,
            instructions: question.instructions,
            ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
          });
        }
        return {
          answers: await ports.ask({
            state,
            questions: Object.fromEntries(byId) as JevQuestions,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          }),
        };
      },
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

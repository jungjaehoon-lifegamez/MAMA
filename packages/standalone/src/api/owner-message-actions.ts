import type { ActionRegistration } from '@jungjaehoon/mama-core';
import { offsetIsoTime } from './work-actions.js';

export interface OwnerExchange {
  /** When the owner sent the message, epoch ms. */
  at: number;
  owner: string;
  /** The delivered reply; null while the turn has none. */
  reply: string | null;
}

export interface OwnerMessagePorts {
  /** The owner's messages in [since, before), oldest first, each with your reply. */
  exchanges(since: number, before: number): readonly OwnerExchange[];
  now?(): number;
}

const DEFAULT_CHARS = 400;
const MAX_CHARS = 4_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

function time(value: unknown, field: string): number {
  const parsed = offsetIsoTime(value);
  if (parsed !== undefined) return parsed;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw invalidInput(
    `owner.messages ${field} must be epoch milliseconds or an ISO time with its offset`
  );
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/**
 * The owner conversation for a span, read by the agent when a turn needs it: a daily page's
 * "what the owner decided" is spread over that day's exchanges, and nothing else reads them.
 */
export function ownerMessageActionRegistrations(ports: OwnerMessagePorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'owner.messages',
        summary:
          'Read your conversation with the owner in a time span: each owner message with your reply, oldest first, in pages of 20 (50 max). A line longer than chars (400 by default) ends with …; read that span again with a larger chars.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['since'],
          properties: {
            since: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description:
                'Start of the span (epoch ms or ISO with offset), e.g. the day at 00:00.',
            },
            before: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description: 'End of the span, exclusive; defaults to now.',
            },
            offset: { type: 'integer', minimum: 0, description: 'Skip this many exchanges.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
            chars: {
              type: 'integer',
              minimum: 100,
              maximum: MAX_CHARS,
              description: 'Longest message or reply text returned; longer text is cut.',
            },
          },
        },
        examples: [
          {
            title: 'One day of conversation',
            input: { since: '2026-01-01T00:00:00+09:00', before: '2026-01-02T00:00:00+09:00' },
          },
        ],
      },
      exec: (input) => {
        const body = input as {
          since?: unknown;
          before?: unknown;
          offset?: unknown;
          limit?: unknown;
          chars?: unknown;
        };
        const now = ports.now?.() ?? Date.now();
        const since = time(body.since, 'since');
        const before = body.before === undefined ? now : time(body.before, 'before');
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        const limit = typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT;
        const chars = typeof body.chars === 'number' ? body.chars : DEFAULT_CHARS;
        const all = ports.exchanges(since, before);
        const page = all.slice(offset, offset + limit);
        const next = offset + page.length;
        return {
          total: all.length,
          messages: page.map((exchange) => ({
            at: exchange.at,
            owner: clip(exchange.owner, chars),
            reply: exchange.reply === null ? null : clip(exchange.reply, chars),
          })),
          nextOffset: next < all.length ? next : null,
        };
      },
    },
  ];
}

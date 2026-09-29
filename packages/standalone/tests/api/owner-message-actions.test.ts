import { describe, expect, it } from 'vitest';
import { ownerMessageActionRegistrations } from '../../src/api/owner-message-actions.js';

const DAY = 86_400_000;

function action(exchanges: Array<{ at: number; owner: string; reply: string | null }>) {
  const calls: Array<[number, number]> = [];
  const [registration] = ownerMessageActionRegistrations({
    exchanges: (since, before) => {
      calls.push([since, before]);
      return exchanges.filter((exchange) => exchange.at >= since && exchange.at < before);
    },
    retentionMs: 7 * DAY,
    now: () => 10 * DAY,
  });
  return { exec: (input: unknown) => registration!.exec(input as never, {} as never), calls };
}

describe('owner.messages', () => {
  it('pages the conversation of a span oldest first and clips long lines', async () => {
    const { exec, calls } = action([
      ...Array.from({ length: 23 }, (_, index) => ({
        at: 9 * DAY + index,
        owner: `message ${index}`,
        reply: index === 0 ? 'x'.repeat(500) : null,
      })),
    ]);
    const first = (await exec({ since: 9 * DAY })) as {
      total: number;
      messages: Array<{ at: number; owner: string; reply: string | null }>;
      nextOffset: number | null;
    };
    expect(calls[0]).toEqual([9 * DAY, 10 * DAY]);
    expect(first.total).toBe(23);
    expect(first.messages).toHaveLength(20);
    expect(first.messages[0]!.reply).toHaveLength(400);
    expect(first.nextOffset).toBe(20);
    expect(first).not.toHaveProperty('retention');
    const rest = (await exec({ since: 9 * DAY, offset: 20 })) as typeof first;
    expect(rest.messages.map((message) => message.owner)).toEqual([
      'message 20',
      'message 21',
      'message 22',
    ]);
    expect(rest.nextOffset).toBeNull();
  });

  it('takes ISO times with an offset and says when the span is older than what is kept', async () => {
    const { exec, calls } = action([]);
    const result = (await exec({
      since: '1970-01-02T09:00:00+09:00',
      before: '1970-01-03T09:00:00+09:00',
    })) as { retention?: string };
    expect(calls[0]).toEqual([DAY, 2 * DAY]);
    expect(result.retention).toContain('seven days');
    await expect(async () => exec({ since: '1970-01-02 09:00' })).rejects.toThrow(
      /ISO time with its offset/
    );
  });
});

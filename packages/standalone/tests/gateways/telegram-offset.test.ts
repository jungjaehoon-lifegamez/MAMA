/**
 * The library half of "bot.stop confirms the offset" (docs/development/work/update.md, PR 4): the
 * gateway's stop calls grammY's `bot.stop()` (telegram-commands.test.ts), and this pins what that
 * does in the grammY version MAMA installs. An /update the stopping daemon answered is confirmed,
 * so the next daemon does not receive it again; a daemon killed before it confirms gets it again,
 * which runtime/update-request.json then refuses.
 */
import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';

describe('grammY stop', () => {
  it('confirms the offset past the last update it handled', async () => {
    const asked: Array<{ method: string; body: Record<string, unknown> }> = [];
    let served = false;
    let handled: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const fetch = (async (url: string, init: { body?: string; signal?: AbortSignal }) => {
      const method = String(url).split('/').pop()!;
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      asked.push({ method, body });
      let result: unknown = true;
      if (method === 'getUpdates' && body.limit !== 1) {
        if (!served) {
          served = true;
          result = [
            {
              update_id: 500,
              message: {
                message_id: 31,
                date: 1,
                chat: { id: 7101, type: 'private' },
                from: { id: 7101, is_bot: false, first_name: 'fixture' },
                text: '/update',
                entities: [{ type: 'bot_command', offset: 0, length: 7 }],
              },
            },
          ];
        } else {
          // Long polling waits until the stop aborts it.
          await new Promise((_, reject) =>
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            )
          );
        }
      } else if (method === 'getUpdates') result = [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result }),
      };
    }) as unknown as typeof globalThis.fetch;
    const bot = new Bot('fixture-token', {
      botInfo: {
        id: 101,
        is_bot: true,
        first_name: 'fixture',
        username: 'fixture_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      } as never,
      client: { fetch },
    });
    bot.on('message', () => handled());
    void bot.start({ drop_pending_updates: false });
    await seen;
    await bot.stop();
    const confirm = asked.filter((call) => call.method === 'getUpdates').at(-1)!;
    expect(confirm.body).toMatchObject({ offset: 501, limit: 1 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramResponsePresenter } from '../../src/gateways/telegram-response-presenter.js';

function makeAdapter() {
  return {
    send: vi.fn(async (_text: string) => 'message-1'),
    edit: vi.fn(async (_handle: string, _text: string) => {}),
    delete: vi.fn(async (_handle: string) => {}),
  };
}

describe('TelegramResponsePresenter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with one progress placeholder', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);

    await presenter.start();

    expect(adapter.send).toHaveBeenCalledWith('⏳');
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('replaces the placeholder with an explicit queue status', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();

    presenter.markQueued();
    await vi.advanceTimersByTimeAsync(800);

    expect(adapter.edit).toHaveBeenCalledWith(
      'message-1',
      '⏳ Waiting for the earlier task to finish.'
    );
  });

  it('continues without a placeholder when the initial send fails', async () => {
    const adapter = makeAdapter();
    adapter.send.mockRejectedValueOnce(new Error('placeholder unavailable'));
    const presenter = new TelegramResponsePresenter(adapter);

    await expect(presenter.start()).resolves.toBeUndefined();
    await presenter.finalize('Final answer');

    expect(adapter.send).toHaveBeenNthCalledWith(2, 'Final answer');
    expect(adapter.edit).not.toHaveBeenCalled();
  });

  it('accumulates deltas and edits no faster than the throttle', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();

    const callbacks = presenter.callbacks();
    callbacks.onDelta?.('hello');
    callbacks.onDelta?.(' world');
    expect(adapter.edit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(799);
    expect(adapter.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(adapter.edit).toHaveBeenCalledWith('message-1', 'hello world');
    expect(adapter.edit).toHaveBeenCalledTimes(1);
  });

  it('shows concise tool progress only before response text arrives', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();
    const callbacks = presenter.callbacks();

    callbacks.onToolUse?.('code_act', {});
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.edit).toHaveBeenLastCalledWith('message-1', '🔧 code_act...');

    callbacks.onDelta?.('actual response');
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.edit).toHaveBeenLastCalledWith('message-1', 'actual response');
  });

  it('never streams a partial leading reasoning decoration', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();
    const callbacks = presenter.callbacks();

    callbacks.onDelta?.('||🔧 code_act');
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.edit).not.toHaveBeenCalled();

    callbacks.onDelta?.(' | ⏱️ 1 turns||\nresponse');
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.edit).toHaveBeenCalledWith('message-1', 'response');
    expect(adapter.edit.mock.calls.flat().join('\n')).not.toContain('turns');
  });

  it('finalizes the same placeholder without the reasoning header or tool progress', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();
    presenter.callbacks().onToolUse?.('code_act', {});

    await presenter.finalize('||🔧 code_act | ⏱️ 1 turns||\nCompleted.');

    expect(adapter.edit).toHaveBeenLastCalledWith('message-1', 'Completed.');
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('redacts inbound attachment paths from a custom MAMA_WORKSPACE', async () => {
    const previousWorkspace = process.env.MAMA_WORKSPACE;
    process.env.MAMA_WORKSPACE = '/private/custom workspace';
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize(
      'Saved at /private/custom workspace/media/inbound/telegram/private-image.png'
    );

    expect(adapter.edit).toHaveBeenCalledWith('message-1', 'Saved at [attachment]');
    if (previousWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
    else process.env.MAMA_WORKSPACE = previousWorkspace;
  });

  it('edits the first long-response chunk and sends the remaining chunks', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 10 });
    await presenter.start();

    await presenter.finalize('1234567890abcdefghijXYZ');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '1234567890');
    expect(adapter.send).toHaveBeenNthCalledWith(2, 'abcdefghij');
    expect(adapter.send).toHaveBeenNthCalledWith(3, 'XYZ');
  });

  it('keeps a Unicode surrogate pair together when chunking a response', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });
    await presenter.start();

    await presenter.finalize('1234😀tail');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '1234😀');
    expect(adapter.send).toHaveBeenNthCalledWith(2, 'tail');
  });

  it('does not retry an ambiguously failed later chunk and can publish a visible failure notice', async () => {
    const adapter = makeAdapter();
    adapter.send
      .mockResolvedValueOnce('message-1')
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce('failure-message');
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });
    await presenter.start();

    await expect(presenter.finalize('123456789')).rejects.toThrow('chunk failed');
    await presenter.fail('Response delivery stopped after a partial send.');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '12345');
    expect(adapter.send).toHaveBeenCalledWith('6789');
    expect(
      adapter.send.mock.calls
        .slice(2)
        .map(([text]) => text)
        .join('')
    ).toBe('Response delivery stopped after a partial send.');
  });

  it('sends all chunks normally when no placeholder exists', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });

    await presenter.finalize('123456789');

    expect(adapter.edit).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenNthCalledWith(1, '12345');
    expect(adapter.send).toHaveBeenNthCalledWith(2, '6789');
  });

  it('deletes a stale placeholder and sends the final response when editing fails', async () => {
    const adapter = makeAdapter();
    adapter.edit.mockRejectedValueOnce(new Error('Bad Request: message to edit not found'));
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('Final answer');

    expect(adapter.delete).toHaveBeenCalledWith('message-1');
    expect(adapter.send).toHaveBeenNthCalledWith(2, 'Final answer');
  });

  it('treats Telegram message-not-modified as a successful final edit', async () => {
    const adapter = makeAdapter();
    adapter.edit.mockRejectedValueOnce(new Error('Bad Request: message is not modified'));
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('Final answer');

    expect(adapter.delete).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it('turns empty final output into an explicit error', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('  ');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', 'No response was generated.');
  });

  it('bounds every streaming edit to the Telegram limit', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 8, throttleMs: 10 });
    await presenter.start();

    presenter.callbacks().onDelta?.('1234567890');
    await vi.advanceTimersByTimeAsync(10);

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '34567890');
  });

  it('cancels pending streaming edits after finalization', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();
    presenter.callbacks().onDelta?.('intermediate');

    await presenter.finalize('final');
    await vi.advanceTimersByTimeAsync(800);

    expect(adapter.edit).toHaveBeenCalledTimes(1);
    expect(adapter.edit).toHaveBeenCalledWith('message-1', 'final');
  });

  it('waits for an in-flight streaming edit before writing the final answer', async () => {
    const adapter = makeAdapter();
    let releaseStreamingEdit: (() => void) | undefined;
    adapter.edit.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStreamingEdit = resolve;
        })
    );
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 10 });
    await presenter.start();
    presenter.callbacks().onDelta?.('intermediate');
    await vi.advanceTimersByTimeAsync(10);

    const finalization = presenter.finalize('final');
    expect(adapter.edit).toHaveBeenCalledTimes(1);
    releaseStreamingEdit?.();
    await finalization;

    expect(adapter.edit.mock.calls).toEqual([
      ['message-1', 'intermediate'],
      ['message-1', 'final'],
    ]);
  });

  it('does not resend completed chunks when a later chunk send fails', async () => {
    const adapter = makeAdapter();
    adapter.send
      .mockResolvedValueOnce('message-1')
      .mockResolvedValueOnce('message-2')
      .mockRejectedValueOnce(new Error('third chunk failed'));
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });
    await presenter.start();

    await expect(presenter.finalize('12345abcdeXYZ')).rejects.toThrow('third chunk failed');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '12345');
    expect(adapter.send.mock.calls.map(([text]) => text)).toEqual(['⏳', 'abcde', 'XYZ']);
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('persists each uncertain attempt and confirmed next chunk in order', async () => {
    const adapter = makeAdapter();
    const progress: Array<[number, boolean]> = [];
    const presenter = new TelegramResponsePresenter(adapter, {
      maxLength: 5,
      onChunkProgress: async (nextIndex, uncertain) => {
        progress.push([nextIndex, uncertain]);
      },
    });
    await presenter.start();

    await presenter.finalize('12345abcdeXYZ');

    expect(progress).toEqual([
      [0, true],
      [1, false],
      [1, true],
      [2, false],
      [2, true],
      [3, false],
    ]);
  });

  it('resumes a recovered response from the first unconfirmed chunk', async () => {
    const adapter = makeAdapter();
    const progress: Array<[number, boolean]> = [];
    const presenter = new TelegramResponsePresenter(adapter, {
      maxLength: 5,
      resumeFromChunk: 2,
      onChunkProgress: async (nextIndex, uncertain) => {
        progress.push([nextIndex, uncertain]);
      },
    });

    await presenter.finalize('12345abcdeXYZ');

    expect(adapter.edit).not.toHaveBeenCalled();
    expect(adapter.send.mock.calls.map(([text]) => text)).toEqual(['XYZ']);
    expect(progress).toEqual([
      [2, true],
      [3, false],
    ]);
  });
});

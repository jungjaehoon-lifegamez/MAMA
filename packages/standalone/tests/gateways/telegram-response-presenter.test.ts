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

  it('edits the first long-response chunk and sends the remaining chunks', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 10 });
    await presenter.start();

    await presenter.finalize('1234567890abcdefghijXYZ');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', '1234567890');
    expect(adapter.send).toHaveBeenNthCalledWith(2, 'abcdefghij');
    expect(adapter.send).toHaveBeenNthCalledWith(3, 'XYZ');
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
    adapter.edit.mockRejectedValueOnce(new Error('edit failed'));
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('Final answer');

    expect(adapter.delete).toHaveBeenCalledWith('message-1');
    expect(adapter.send).toHaveBeenNthCalledWith(2, 'Final answer');
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
});

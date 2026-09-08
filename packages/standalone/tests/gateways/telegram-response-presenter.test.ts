import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramResponsePresenter } from '../../src/gateways/telegram-response-presenter.js';
import type { TelegramFormattedText } from '../../src/gateways/telegram-format.js';

function makeAdapter() {
  return {
    send: vi.fn(async (_message: TelegramFormattedText) => 'message-1'),
    edit: vi.fn(async (_handle: string, _message: TelegramFormattedText) => {}),
    delete: vi.fn(async (_handle: string) => {}),
  };
}

type Adapter = ReturnType<typeof makeAdapter>;

function sentTexts(adapter: Adapter): string[] {
  return adapter.send.mock.calls.map(([message]) => message.text);
}

function editedTexts(adapter: Adapter): string[] {
  return adapter.edit.mock.calls.map(([, message]) => message.text);
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

    expect(sentTexts(adapter)).toEqual(['⏳']);
  });

  it('replaces the placeholder with an explicit queue status', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();

    presenter.markQueued();
    await vi.advanceTimersByTimeAsync(800);

    expect(adapter.edit).toHaveBeenCalledWith('message-1', {
      text: '⏳ Waiting for the earlier task to finish.',
      entities: [],
    });
  });

  it('continues without a placeholder when the initial send fails', async () => {
    const adapter = makeAdapter();
    adapter.send.mockRejectedValueOnce(new Error('placeholder unavailable'));
    const presenter = new TelegramResponsePresenter(adapter);

    await expect(presenter.start()).resolves.toBeUndefined();
    await presenter.finalize('Final answer');

    expect(sentTexts(adapter)[1]).toBe('Final answer');
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

    expect(editedTexts(adapter)).toEqual(['hello world']);
  });

  it('shows concise tool progress only before response text arrives', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();
    const callbacks = presenter.callbacks();

    callbacks.onToolUse?.('code_act', {});
    await vi.advanceTimersByTimeAsync(800);
    expect(editedTexts(adapter).at(-1)).toBe('🔧 code_act...');

    callbacks.onDelta?.('actual response');
    await vi.advanceTimersByTimeAsync(800);
    expect(editedTexts(adapter).at(-1)).toBe('actual response');
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
    expect(editedTexts(adapter)).toEqual(['response']);
    expect(editedTexts(adapter).join('\n')).not.toContain('turns');
  });

  it('finalizes the same placeholder without the reasoning header or tool progress', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();
    presenter.callbacks().onToolUse?.('code_act', {});

    await presenter.finalize('||🔧 code_act | ⏱️ 1 turns||\nCompleted.');

    expect(editedTexts(adapter).at(-1)).toBe('Completed.');
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('delivers the final answer as Telegram entities, not as raw markup', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('<b>Status</b>\nAll clear.');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', {
      text: 'Status\nAll clear.',
      entities: [{ type: 'bold', offset: 0, length: 6 }],
    });
  });

  it('TG-01 preserves formatting when a streamed span exceeds the message limit', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 10, throttleMs: 1 });
    await presenter.start();

    presenter.callbacks().onDelta?.('<b>12345678901234567890</b>');
    await vi.advanceTimersByTimeAsync(1);

    expect(adapter.edit).toHaveBeenLastCalledWith('message-1', {
      text: '1234567890',
      entities: [{ type: 'bold', offset: 0, length: 10 }],
    });
  });

  it('carries entities onto every chunk of a long formatted answer', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });
    await presenter.start();

    await presenter.finalize('<b>1234567</b>');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', {
      text: '12345',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
    });
    expect(adapter.send).toHaveBeenLastCalledWith({
      text: '67',
      entities: [{ type: 'bold', offset: 0, length: 2 }],
    });
  });

  it('sends unparseable markup as literal text rather than dropping the answer', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('<b>unterminated answer');

    expect(adapter.edit).toHaveBeenCalledWith('message-1', {
      text: '<b>unterminated answer',
      entities: [],
    });
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

    expect(editedTexts(adapter)).toEqual(['Saved at [attachment]']);
    if (previousWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
    else process.env.MAMA_WORKSPACE = previousWorkspace;
  });

  it('edits the first long-response chunk and sends the remaining chunks', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 10 });
    await presenter.start();

    await presenter.finalize('1234567890abcdefghijXYZ');

    expect(editedTexts(adapter)).toEqual(['1234567890']);
    expect(sentTexts(adapter)).toEqual(['⏳', 'abcdefghij', 'XYZ']);
  });

  it('keeps a Unicode surrogate pair together when chunking a response', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });
    await presenter.start();

    const emoji = String.fromCodePoint(0x1f600);
    await presenter.finalize(`1234${emoji}tail`);

    const delivered = [...editedTexts(adapter), ...sentTexts(adapter).slice(1)];
    expect(delivered.join('')).toBe(`1234${emoji}tail`);
    for (const chunk of delivered) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
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

    expect(editedTexts(adapter)).toEqual(['12345']);
    expect(sentTexts(adapter)).toContain('6789');
    expect(sentTexts(adapter).slice(2).join('')).toBe(
      'Response delivery stopped after a partial send.'
    );
  });

  it('sends all chunks normally when no placeholder exists', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 5 });

    await presenter.finalize('123456789');

    expect(adapter.edit).not.toHaveBeenCalled();
    expect(sentTexts(adapter)).toEqual(['12345', '6789']);
  });

  it('deletes a stale placeholder and sends the final response when editing fails', async () => {
    const adapter = makeAdapter();
    adapter.edit.mockRejectedValueOnce(new Error('Bad Request: message to edit not found'));
    const presenter = new TelegramResponsePresenter(adapter);
    await presenter.start();

    await presenter.finalize('Final answer');

    expect(adapter.delete).toHaveBeenCalledWith('message-1');
    expect(sentTexts(adapter)[1]).toBe('Final answer');
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

    expect(editedTexts(adapter)).toEqual(['No response was generated.']);
  });

  it('bounds every streaming edit to the Telegram limit', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { maxLength: 8, throttleMs: 10 });
    await presenter.start();

    presenter.callbacks().onDelta?.('1234567890');
    await vi.advanceTimersByTimeAsync(10);

    expect(editedTexts(adapter)).toEqual(['34567890']);
  });

  it('never shows raw markup while the answer streams in', async () => {
    // Every prefix of a formatted answer is a snapshot the owner can actually
    // see. One open tag used to make the whole snapshot literal, so the
    // placeholder flickered between styled text and raw HTML.
    const answer =
      '<b>Status</b>\nsee <a href="https://example.com/x">the source</a> and ' +
      '<i>note</i> <code>id-1</code>\n<blockquote>quoted</blockquote>';
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 10 });
    await presenter.start();
    const callbacks = presenter.callbacks();

    for (const character of answer) {
      callbacks.onDelta?.(character);
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(editedTexts(adapter).length).toBeGreaterThan(10);
    for (const text of editedTexts(adapter)) {
      expect(text).not.toContain('<b');
      expect(text).not.toContain('href=');
    }
    expect(editedTexts(adapter).at(-1)).toBe('Status\nsee the source and note id-1\nquoted');
  });

  it('cancels pending streaming edits after finalization', async () => {
    const adapter = makeAdapter();
    const presenter = new TelegramResponsePresenter(adapter, { throttleMs: 800 });
    await presenter.start();
    presenter.callbacks().onDelta?.('intermediate');

    await presenter.finalize('final');
    await vi.advanceTimersByTimeAsync(800);

    expect(editedTexts(adapter)).toEqual(['final']);
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

    expect(editedTexts(adapter)).toEqual(['intermediate', 'final']);
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

    expect(editedTexts(adapter)).toEqual(['12345']);
    expect(sentTexts(adapter)).toEqual(['⏳', 'abcde', 'XYZ']);
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
    expect(sentTexts(adapter)).toEqual(['XYZ']);
    expect(progress).toEqual([
      [2, true],
      [3, false],
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUICommands = vi.fn();
const showToast = vi.fn();

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: {
    getUICommands,
    // reportPageContext references this export, but these tests only cover polling.
    pushPageContext: vi.fn(),
  },
}));

vi.mock('../../public/viewer/src/utils/dom.js', () => ({
  showToast,
}));

describe('viewer ui-commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start overlapping polls while a request is in flight', async () => {
    let resolveCommands:
      | ((value: { commands: Array<{ type: string; payload: object }> }) => void)
      | null = null;
    getUICommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommands = resolve;
        })
    );

    const { startUICommandPolling } = await import('../../public/viewer/src/utils/ui-commands.js');
    const stopPolling = startUICommandPolling(vi.fn());

    await vi.advanceTimersByTimeAsync(3000);
    expect(getUICommands).toHaveBeenCalledTimes(1);

    resolveCommands?.({ commands: [] });
    await Promise.resolve();
    stopPolling();
  });
});

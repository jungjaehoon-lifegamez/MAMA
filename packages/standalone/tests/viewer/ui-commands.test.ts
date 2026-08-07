import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUICommands = vi.fn();
const pushPageContext = vi.fn();
const ackUICommands = vi.fn();
const showToast = vi.fn();

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: {
    getUICommands,
    ackUICommands: ackUICommands.mockResolvedValue({ success: true }),
    pushPageContext: pushPageContext.mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../public/viewer/src/utils/dom.js', () => ({
  showToast,
}));

describe('viewer ui-commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // The module reads no browser storage: the channel id is the fixed
    // frontdoor constant. A stub that throws on access would prove that, but a
    // bare object is enough to keep the environment shaped like a browser.
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('reports page context to the stable viewer frontdoor channel', async () => {
    const { reportPageContext } = await import('../../public/viewer/src/utils/ui-commands.js');

    reportPageContext('agents', { pageType: 'agent-list' });
    await Promise.resolve();

    expect(pushPageContext).toHaveBeenCalledWith(
      'agents',
      { pageType: 'agent-list' },
      undefined,
      'mama_os_main'
    );
  });

  it('re-publishes the last page context while polling so the backend can recover after restart', async () => {
    getUICommands.mockResolvedValue({ commands: [] });
    const { startUICommandPolling, reportPageContext } =
      await import('../../public/viewer/src/utils/ui-commands.js');

    reportPageContext('dashboard', { pageType: 'tab-switch', tab: 'dashboard' });
    await Promise.resolve();
    expect(pushPageContext).toHaveBeenCalledTimes(1);

    const stopPolling = startUICommandPolling(vi.fn());
    await vi.advanceTimersByTimeAsync(5000);

    expect(pushPageContext).toHaveBeenCalledTimes(2);
    expect(pushPageContext).toHaveBeenLastCalledWith(
      'dashboard',
      { pageType: 'tab-switch', tab: 'dashboard' },
      undefined,
      'mama_os_main'
    );

    stopPolling();
  });

  it('acknowledges navigation commands after the async tab switch completes', async () => {
    const switchTab = vi.fn().mockResolvedValue(undefined);
    getUICommands.mockResolvedValue({
      commands: [
        {
          id: 'ui_1',
          type: 'navigate',
          payload: { route: 'operator/tasks', params: { taskId: '42' } },
        },
      ],
    });

    const { startUICommandPolling } = await import('../../public/viewer/src/utils/ui-commands.js');
    const stopPolling = startUICommandPolling(switchTab);

    await vi.advanceTimersByTimeAsync(1000);

    expect(switchTab).toHaveBeenCalledWith('operator/tasks', { taskId: '42' });
    expect(ackUICommands).toHaveBeenCalledWith(['ui_1']);

    stopPolling();
  });
});

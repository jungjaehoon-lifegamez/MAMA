import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUICommands = vi.fn();
const pushPageContext = vi.fn();
const showToast = vi.fn();

vi.mock('../../public/viewer/src/utils/api.js', () => ({
  API: {
    getUICommands,
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
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key === 'mama_chat_session_id') {
            return 'session_legacy_viewer_id';
          }
          return null;
        }),
      },
    });
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
});

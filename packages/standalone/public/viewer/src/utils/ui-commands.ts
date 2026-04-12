/**
 * UI Command Polling + Page Context Reporting
 *
 * Ported from SmartStore's NavigationContext + Layout command polling pattern.
 * - startUICommandPolling(): 1s interval, drains commands, executes navigate/notify
 * - reportPageContext(): sends current page state to agent
 */

import { API } from './api.js';
import { showToast } from './dom.js';

type SwitchTabFn = (tab: string, params?: Record<string, string>) => void;

let polling = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
const VIEWER_FRONTDOOR_CHANNEL_ID = 'mama_os_main';

function getViewerChannelId(): string {
  try {
    const sessionId = window.localStorage.getItem('mama_chat_session_id');
    if (sessionId && !sessionId.startsWith('session_')) {
      return sessionId;
    }
  } catch {
    /* ignore */
  }
  return VIEWER_FRONTDOOR_CHANNEL_ID;
}

export function startUICommandPolling(switchTab: SwitchTabFn): () => void {
  if (polling) {
    return () => {};
  }
  polling = true;

  pollingInterval = setInterval(async () => {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const { commands } = await API.getUICommands();
      for (const cmd of commands) {
        if (cmd.type === 'navigate') {
          const p = cmd.payload as { route?: string; params?: Record<string, string> };
          if (p.route) {
            switchTab(p.route, p.params);
          }
        } else if (cmd.type === 'notify') {
          const p = cmd.payload as { message?: string };
          if (p.message) {
            showToast(p.message);
          }
        }
      }
    } catch {
      // Silently ignore polling errors (server may be restarting)
    } finally {
      pollInFlight = false;
    }
  }, 1000);

  return () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    pollInFlight = false;
    polling = false;
  };
}

export function reportPageContext(
  route: string,
  data: Record<string, unknown>,
  selectedItem?: { type: string; id: string }
): void {
  API.pushPageContext(route, data, selectedItem, getViewerChannelId()).catch(() => {
    /* ignore */
  });
}

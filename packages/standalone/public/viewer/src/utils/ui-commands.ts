/**
 * UI Command Polling + Page Context Reporting
 *
 * Ported from SmartStore's NavigationContext + Layout command polling pattern.
 * - startUICommandPolling(): 1s interval, drains commands, executes navigate/notify
 * - reportPageContext(): sends current page state to agent
 */

import { API } from './api.js';
import { showToast } from './dom.js';

type SwitchTabFn = (tab: string, params?: Record<string, string>) => void | Promise<void>;

let polling = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
const VIEWER_FRONTDOOR_CHANNEL_ID = 'mama_os_main';
const PAGE_CONTEXT_REPUBLISH_MS = 5000;

type StoredPageContext = {
  route: string;
  data: Record<string, unknown>;
  selectedItem?: { type: string; id: string };
};

let lastReportedPageContext: StoredPageContext | null = null;
let lastPageContextPublishAt = 0;

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
      const acknowledgedCommandIds: string[] = [];
      for (const cmd of commands) {
        if (cmd.type === 'navigate') {
          const p = cmd.payload as { route?: string; params?: Record<string, string> };
          if (p.route) {
            await switchTab(p.route, p.params);
            if (cmd.id) {
              acknowledgedCommandIds.push(cmd.id);
            }
          }
        } else if (cmd.type === 'notify') {
          const p = cmd.payload as { message?: string };
          if (p.message) {
            showToast(p.message);
            if (cmd.id) {
              acknowledgedCommandIds.push(cmd.id);
            }
          }
        }
      }

      if (acknowledgedCommandIds.length > 0) {
        await API.ackUICommands(acknowledgedCommandIds);
      }

      if (
        lastReportedPageContext &&
        Date.now() - lastPageContextPublishAt >= PAGE_CONTEXT_REPUBLISH_MS
      ) {
        lastPageContextPublishAt = Date.now();
        await API.pushPageContext(
          lastReportedPageContext.route,
          lastReportedPageContext.data,
          lastReportedPageContext.selectedItem,
          getViewerChannelId()
        );
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
  lastReportedPageContext = { route, data, selectedItem };
  lastPageContextPublishAt = Date.now();
  API.pushPageContext(route, data, selectedItem, getViewerChannelId()).catch(() => {
    /* ignore */
  });
}

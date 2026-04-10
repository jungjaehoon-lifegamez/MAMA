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

export function startUICommandPolling(switchTab: SwitchTabFn): void {
  if (polling) return;
  polling = true;

  setInterval(async () => {
    try {
      const { commands } = await API.getUICommands();
      for (const cmd of commands) {
        if (cmd.type === 'navigate') {
          const p = cmd.payload as { route?: string; params?: Record<string, string> };
          if (p.route) switchTab(p.route, p.params);
        } else if (cmd.type === 'notify') {
          const p = cmd.payload as { message?: string };
          if (p.message) showToast(p.message);
        }
      }
    } catch {
      // Silently ignore polling errors (server may be restarting)
    }
  }, 1000);
}

export function reportPageContext(route: string, data: Record<string, unknown>): void {
  API.pushPageContext(route, data).catch(() => {
    /* ignore */
  });
}

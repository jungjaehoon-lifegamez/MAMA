/**
 * ReportStore implementation that survives daemon restarts.
 *
 * Owns its Map directly (rather than wrapping createReportStore) so restored
 * slots keep their original updatedAt verbatim. Writes are debounced 250ms to
 * coalesce publish bursts into one snapshot.
 *
 * filePath is injection-only: the production path is resolved solely at the
 * daemon runtime call site (api-server-init.ts), never inside this module --
 * createApiServer's default stays the in-memory store so its ~30 test call
 * sites never touch the real ~/.mama (the PR #126 pollution class).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReportSlot, ReportStore } from './report-handler.js';

const WRITE_DEBOUNCE_MS = 250;

export function createPersistentReportStore(opts: { filePath: string }): ReportStore {
  const slots = new Map<string, ReportSlot>();

  if (existsSync(opts.filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(opts.filePath, 'utf-8')) as Record<string, ReportSlot>;
      for (const [id, slot] of Object.entries(parsed)) {
        slots.set(id, slot);
      }
    } catch (err) {
      // fail loud, start empty -- a corrupt snapshot must never take the board down
      console.warn(`[Report] corrupt slot snapshot at ${opts.filePath}, starting empty:`, err);
    }
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWrite = (): void => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        mkdirSync(dirname(opts.filePath), { recursive: true });
        writeFileSync(opts.filePath, JSON.stringify(Object.fromEntries(slots)), 'utf-8');
      } catch (err) {
        console.warn(`[Report] failed to persist slots to ${opts.filePath}:`, err);
      }
    }, WRITE_DEBOUNCE_MS);
    // Never keep the daemon alive just to flush a board snapshot.
    writeTimer.unref?.();
  };

  return {
    get: (slotId) => slots.get(slotId),
    update(slotId, html, priority) {
      slots.set(slotId, { slotId, html, priority, updatedAt: Date.now() });
      scheduleWrite();
    },
    delete(slotId) {
      slots.delete(slotId);
      scheduleWrite();
    },
    getAll: () => Object.fromEntries(slots),
    getAllSorted: () => Array.from(slots.values()).sort((a, b) => a.priority - b.priority),
  };
}

/**
 * ReportStore implementation that survives daemon restarts.
 *
 * Seeds the shared store with saved slots so their original updatedAt and
 * analysis basis survive verbatim. Writes are debounced 250ms to
 * coalesce publish bursts into one snapshot.
 *
 * filePath is injection-only: the production path is resolved solely at the
 * daemon runtime call site (api-server-init.ts), never inside this module --
 * createApiServer's default stays the in-memory store so its ~30 test call
 * sites never touch the real ~/.mama (the PR #126 pollution class).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createReportStore, type ReportSlot, type ReportStore } from './report-handler.js';

const WRITE_DEBOUNCE_MS = 250;

// One process-exit hook flushes every store's pending debounced write, so a
// publish landing right before a graceful stop (SIGTERM path) is not lost.
// SIGKILL restarts still lose the window -- unavoidable, and self-healing on
// the next publish.
const pendingExitFlushes = new Set<() => void>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const flush of pendingExitFlushes) flush();
  });
}

export function createPersistentReportStore(opts: { filePath: string }): ReportStore {
  let snapshot: Record<string, ReportSlot> = {};

  if (existsSync(opts.filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(opts.filePath, 'utf-8')) as Record<string, ReportSlot>;
      snapshot = parsed;
    } catch (err) {
      // fail loud, start empty -- a corrupt snapshot must never take the board down
      console.warn(`[Report] corrupt slot snapshot at ${opts.filePath}, starting empty:`, err);
    }
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  const writeSnapshot = (): void => {
    try {
      mkdirSync(dirname(opts.filePath), { recursive: true });
      writeFileSync(opts.filePath, JSON.stringify(snapshot), 'utf-8');
    } catch (err) {
      console.warn(`[Report] failed to persist slots to ${opts.filePath}:`, err);
    }
  };

  const flushPending = (): void => {
    if (!writeTimer) return;
    clearTimeout(writeTimer);
    writeTimer = null;
    writeSnapshot();
  };
  installExitHook();
  pendingExitFlushes.add(flushPending);

  const scheduleWrite = (): void => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeSnapshot();
    }, WRITE_DEBOUNCE_MS);
    // Never keep the daemon alive just to flush a board snapshot.
    writeTimer.unref?.();
  };

  return createReportStore({
    initialSlots: snapshot,
    onChange(next) {
      snapshot = next;
      scheduleWrite();
    },
  });
}

/**
 * Shadow capture store (Stage-2 S2-T4) - TEMPORARY migration harness.
 *
 * At MAMA_STAGE2_WORKORDERS=shadow, board workorder runs get a capture
 * publisher injected via reportPublisherOverride: their report_publish calls
 * land HERE (JSONL under ~/.mama/operator/) instead of the live report store.
 * The T6 equivalence gate compares these captures (brief-driven output)
 * against the legacy live publishes (persona-driven output) by kagemusha-id
 * overlap.
 *
 * KILL-LIST: this whole file is deleted at cutover (plan T6) - keep it
 * self-contained.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function shadowCapturePath(homeDir: string = homedir()): string {
  return join(homeDir, '.mama', 'operator', 'shadow-capture.jsonl');
}

export interface ShadowCapture {
  /** Drop-in report_publish target - appends, never touches the live store. */
  publisher: (slots: Record<string, string>) => void;
}

export function createShadowCapture(homeDir: string = homedir()): ShadowCapture {
  const path = shadowCapturePath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  return {
    publisher: (slots) => {
      appendFileSync(path, `${JSON.stringify({ ts: Date.now(), slots })}\n`, 'utf-8');
      console.log(
        `[stage2] shadow capture: ${Object.keys(slots).length} slot(s) -> ${path} (live store untouched)`
      );
    },
  };
}

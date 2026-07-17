/**
 * Context carry for the owner console (plan v6 S1-T4).
 *
 * Kagemusha's continuity mechanism, minimal form: the chat persona can
 * reference "the report you just received" because the last DELIVERED full
 * report is persisted at delivery time and injected per turn. Carry is
 * DERIVED state (storage-layer, never session accumulation - owner principle
 * "session = cache").
 *
 * Injection rides the user-message prefix path - the only channel that flows
 * on EVERY turn including CONTINUE (per-call system prompts never reach a
 * pooled CLI process).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface LastFullReport {
  deliveredAt: string;
  text: string;
}

const CARRY_SUMMARY_MAX_CHARS = 700;

export function defaultCarryPath(): string {
  return join(homedir(), '.mama', 'operator', 'last-full-report.json');
}

/** Persist the delivered full report (atomic write, same pattern as the schedule store). */
export function persistLastFullReport(
  deliveredAtIso: string,
  text: string,
  path: string = defaultCarryPath()
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.last-full-report.${process.pid}.tmp`);
  // 0600: the carried report is owner operational data.
  writeFileSync(
    tmp,
    JSON.stringify({ deliveredAt: deliveredAtIso, text } satisfies LastFullReport),
    {
      mode: 0o600,
    }
  );
  renameSync(tmp, path);
}

/** Load the last delivered full report; null when none exists or the file is unreadable. */
export function loadLastFullReport(path: string = defaultCarryPath()): LastFullReport | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Missing file is the normal no-report-yet state.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LastFullReport>;
    if (typeof parsed.deliveredAt !== 'string' || typeof parsed.text !== 'string') {
      console.warn(`[report-carry] carry file has invalid shape, ignoring: ${path}`);
      return null;
    }
    return { deliveredAt: parsed.deliveredAt, text: parsed.text };
  } catch (error) {
    // Corrupt state must be LOUD (repo rule), then fall back to no-carry.
    console.warn(
      `[report-carry] carry file corrupt, ignoring (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/**
 * Build the per-turn carry prefix for the owner console. Empty string when no
 * report has been delivered yet (nothing to carry - the persona should use
 * report_request/board_read instead).
 */
export function buildReportCarryPrefix(path: string = defaultCarryPath()): string {
  const last = loadLastFullReport(path);
  if (!last) {
    return '';
  }
  const summary =
    last.text.length > CARRY_SUMMARY_MAX_CHARS
      ? `${last.text.slice(0, CARRY_SUMMARY_MAX_CHARS)}\n[... truncated - full text was delivered to the owner channel]`
      : last.text;
  // The report is agent-authored but SUMMARIZES third-party content; wrapping
  // it keeps reproduced instructions inert across every future turn it rides.
  return (
    `[Operator context] The last FULL situation report was delivered at ${last.deliveredAt}.\n` +
    `If the owner asks for a report or current status, reference/refresh THIS instead of ` +
    `reconstructing state from memory. Content:\n${wrapUntrustedContent(
      'operator-report-carry',
      summary
    )}\n---\n`
  );
}

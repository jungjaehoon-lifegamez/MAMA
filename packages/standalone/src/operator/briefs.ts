/**
 * Brief files - the procedural knowledge of the Stage-2 workers.
 *
 * Location: ~/.mama/briefs/brief-<kind>.md - a DEDICATED directory, not
 * ~/.mama/skills/ (plan A5/F5: skills-root flat files leak into the chat
 * system prompt, the skills UI, and PromptEnhancer keyword injection; the
 * consumer reads by path, so loader invisibility is the desired property).
 *
 * Missing brief -> the caller fails the workorder loudly (never a silent
 * skip). Seeding of packaged defaults is ensureBriefs() (S2-T5).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkOrderKind } from './task-ledger.js';

export function briefsDir(homeDir: string = homedir()): string {
  return join(homeDir, '.mama', 'briefs');
}

export function briefPath(kind: WorkOrderKind, homeDir: string = homedir()): string {
  return join(briefsDir(homeDir), `brief-${kind}.md`);
}

/** null = missing (caller fails the workorder); read errors propagate loudly. */
export function loadBrief(kind: WorkOrderKind, homeDir: string = homedir()): string | null {
  const path = briefPath(kind, homeDir);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

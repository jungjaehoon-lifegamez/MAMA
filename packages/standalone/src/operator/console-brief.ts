/**
 * Owner-console operating brief - the agent-owned operations manual.
 *
 * Kagemusha's 23.8KB system prompt was not designed upfront: it accreted one
 * line per operational failure and owner correction, compiled into the prompt
 * by the agent across sessions. This module ports the LOOP, not the manual:
 * the system seeds a mechanism skeleton once and provides the write path;
 * the agent fills it from experience (console_brief_update, log-loud).
 *
 * Same ownership contract as the Stage-2 workorder briefs (briefs.ts): seeded
 * only when missing, agent/user edits always win, NO managed auto-upgrade.
 * The immutable behavioural floor (act-vs-ask boundary, evidence rules) stays
 * code-owned in message-router's discipline - this file layers the EVOLVING
 * knowledge on top and must never be treated as the security boundary.
 *
 * English mechanism only; personal/channel strings belong in runtime data.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Full-replace ceiling. Kagemusha's mature manual is ~24KB; leave headroom
 *  while keeping a runaway self-edit from bloating every future prompt. */
export const CONSOLE_BRIEF_MAX_CHARS = 32_000;

export const CONSOLE_BRIEF_DEFAULT = `# Owner Console Operating Brief

This file is YOURS. It is seeded once and never overwritten by upgrades.
When the owner corrects how you work, or a procedure fails and you learn the
fix, record the lesson here with console_brief_update - one durable line per
lesson, dated. This is how your operating manual grows; losing a lesson means
repeating the failure.

## Reporting philosophy

- A report is analysis, not a listing. Cross-check at least two sources
  (board/tasks vs channel messages) before stating a situation.
- Cite where each claim came from, with the source timestamp. An uncited
  claim is a guess.
- Quote the key channel line when it drives a conclusion; name the room and
  sender exactly as the source shows them.
- Lead with what changed and what needs the owner; keep the quiet parts to
  one line.

## Procedure recipes (grow this section from experience)

- Status questions: artifacts first (board_read, workorder_status,
  audit_findings_read), then live queries; memory recall last and cited.
- Business data: progressive exploration - kagemusha_overview() then
  kagemusha_entities({activeOnly:true}) then kagemusha_tasks({...}) then
  kagemusha_messages({channelId, since}) on the busiest channels. Never
  widen a since window you were given.
- Cross-channel synthesis: anchor items on their task id (relatedTaskId)
  so the same work seen in two rooms stays one item.

## Situational awareness

- Delta events name what changed since your last look; answer against the
  delta first, then the wider window.
- After a context gap (compaction, restart), rebuild from storage - recall
  and artifacts - never from what you assume you remember.

## Self-update rule

- When the owner corrects your working style, or a recipe above proves
  wrong, update this brief in the same turn and say you did. Keep edits
  small and dated; never delete the owner's own edits.
`;

export function consoleBriefPath(homeDir: string = homedir()): string {
  return join(homeDir, '.mama', 'briefs', 'brief-owner-console.md');
}

/** Boot seeding - write the packaged default ONLY when missing (agent/user
 *  edits always win; deliberate no-auto-upgrade, mirroring ensureBriefs). */
export function ensureConsoleBrief(homeDir: string = homedir()): boolean {
  const path = consoleBriefPath(homeDir);
  if (existsSync(path)) return false;
  mkdirSync(join(homeDir, '.mama', 'briefs'), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, CONSOLE_BRIEF_DEFAULT, 'utf-8');
  renameSync(tmpPath, path);
  return true;
}

/** Read the current brief; empty string when absent (caller seeds on boot). */
export function loadConsoleBrief(homeDir: string = homedir()): string {
  const path = consoleBriefPath(homeDir);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

/** Full-replace write for the agent's self-update tool. Loud validation, no
 *  fallback: an empty or oversized brief is refused, never truncated. */
export function updateConsoleBrief(content: string, homeDir: string = homedir()): void {
  if (!content.trim()) {
    throw new Error('console brief update refused: empty content');
  }
  if (content.length > CONSOLE_BRIEF_MAX_CHARS) {
    throw new Error(
      `console brief update refused: ${content.length} chars exceeds ${CONSOLE_BRIEF_MAX_CHARS}`
    );
  }
  const path = consoleBriefPath(homeDir);
  mkdirSync(join(homeDir, '.mama', 'briefs'), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

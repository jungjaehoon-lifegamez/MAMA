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
fix, record it with console_brief_update({lesson}) - one durable lesson per
call, appended below with today's date while everything above is preserved.
This is how your operating manual grows; losing a lesson means repeating the
failure.

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
  wrong, call console_brief_update({lesson}) in the same turn and say you
  did. One concrete lesson per call; the file itself is curated by the
  owner - you only ever add.

## Lessons
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

/**
 * Append one dated lesson for the agent's self-update tool. APPEND, never
 * replace: on the loop's first live fire (2026-07-24) the model answered a
 * full-replace contract with just its new lesson, wiping the seeded manual
 * including the self-update rule itself. Accretion is the mechanism Kagemusha
 * actually validated - the agent only ever adds; reorganizing the file is the
 * owner's (or an owner-directed session's) manual edit.
 *
 * Loud validation, no fallback: an empty lesson is refused, and a brief that
 * would exceed the ceiling is refused (the manual needs owner curation),
 * never truncated.
 */
export function appendConsoleBriefLesson(lesson: string, homeDir: string = homedir()): string {
  const trimmed = lesson.trim();
  if (!trimmed) {
    throw new Error('console brief update refused: empty lesson');
  }
  // A brief absent at call time (deleted, first run) is re-seeded so the
  // lesson lands inside the full manual, not alone in an empty file.
  let existing = loadConsoleBrief(homeDir);
  if (!existing.trim()) {
    ensureConsoleBrief(homeDir);
    existing = loadConsoleBrief(homeDir);
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date}: ${trimmed.replace(/\s*\n\s*/g, ' ')}`;
  const base = existing.replace(/\s+$/, '');
  const next = `${base}\n${base.includes('\n## Lessons') ? '' : '\n## Lessons\n'}${entry}\n`;
  if (next.length > CONSOLE_BRIEF_MAX_CHARS) {
    throw new Error(
      `console brief update refused: ${next.length} chars exceeds ${CONSOLE_BRIEF_MAX_CHARS} - ` +
        'ask the owner to curate the brief before recording more lessons'
    );
  }
  const path = consoleBriefPath(homeDir);
  mkdirSync(join(homeDir, '.mama', 'briefs'), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, next, 'utf-8');
  renameSync(tmpPath, path);
  return next;
}

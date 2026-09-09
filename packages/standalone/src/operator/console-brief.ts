/**
 * Owner-console operating brief - the agent-owned operations manual.
 *
 * A mature operating prompt accretes one line per operational failure and
 * owner correction. This module preserves that learning LOOP, not a private
 * deployment's manual:
 * the system seeds a mechanism skeleton once and provides the write path;
 * the agent fills it from experience (console_brief_update, log-loud).
 *
 * Ownership contract: seeded only when missing, agent/user edits always win, NO
 * managed auto-upgrade. Since One MAMA this is the ONE brief every turn (chat,
 * event, scheduled) starts from; scheduled turns append a host turn-kind section.
 * The immutable behavioural floor (act-vs-ask boundary, evidence rules) stays
 * code-owned in message-router's discipline - this file layers the EVOLVING
 * knowledge on top and must never be treated as the security boundary.
 *
 * English mechanism only; personal/channel strings belong in runtime data.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hashProcedureDocument } from './procedure-projection.js';
import { join } from 'node:path';
import { type PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';
import {
  buildPrivatePromptOverlay,
  stripDisabledPrivatePromptRecipes,
  stripMarkedPrivatePromptOverlays,
} from '../connectors/private-prompt-overlay.js';

/** Full-replace ceiling with headroom for a mature manual while preventing a
 * runaway self-edit from bloating every future prompt. */
export const CONSOLE_BRIEF_MAX_CHARS = 32_000;

const LEGACY_CONSOLE_PRIVATE_LINES = new Set([
  '- Business data: progressive exploration - kagemusha_overview() then',
  'kagemusha_entities({activeOnly:true}) then kagemusha_tasks({...}) then',
  'kagemusha_messages({channelId, since}) on the busiest channels. Never',
  'widen a since window you were given.',
  '- Use kagemusha_tasks first.',
]);

export const CONSOLE_BRIEF_DEFAULT = `# Owner Console Operating Brief

This file is yours; upgrades never overwrite it. It holds standing operating rules only.
How you work is learned from the owner's corrections: store each one with procedure_update
(when_to_use / when_not_to_use) in the turn it arrives. This brief is not a lesson log.
Correct one of its rules with console_brief_update (replace or retire an exact target with the
expected_hash from procedure_read({id:"owner-console-brief"})). Saving is not proof of changed behavior.
`;

/** Upgrade only the known, code-owned legacy tool mechanism when rendering a modern runtime.
 * The stored original and all owner business rules remain untouched. */
export function modernizeLegacyBriefMechanism(raw: string): string {
  const shortIntroduction =
    'When the owner corrects how you work, or a procedure fails and you learn the\n' +
    'fix, record it with console_brief_update({lesson}) - one durable lesson per\n' +
    "call, appended below with today's date while everything above is preserved.";
  const oldIntroduction =
    shortIntroduction +
    '\n' +
    'This is how your operating manual grows; losing a lesson means repeating the\n' +
    'failure.';
  const oldSelfUpdate =
    '- When the owner corrects your working style, or a recipe above proves\n' +
    '  wrong, call console_brief_update({lesson}) in the same turn and say you\n' +
    '  did. One concrete lesson per call; the file itself is curated by the\n' +
    '  owner - you only ever add.';
  const correctedIntroduction =
    'Store owner corrections with procedure_update (when_to_use / when_not_to_use). Correct one existing brief rule with console_brief_update replace or retire and expected_hash; the brief is not a lesson log. Saving is not proof of changed behavior.';
  const replacements = [
    // Replace the longer seed first so its obsolete continuation cannot survive.
    [oldIntroduction, correctedIntroduction],
    [shortIntroduction, correctedIntroduction],
    [
      oldSelfUpdate,
      '- Store the correction with procedure_update in the same turn; correct a contradicted brief rule with console_brief_update replace or retire and expected_hash, preserving unrelated rules.',
    ],
  ];
  const project = (text: string): string =>
    replacements.reduce(
      (value, [before, after]) =>
        value
          .replace(before, after)
          .replace(before.replace(/\n/g, '\r\n'), after.replace(/\n/g, '\r\n')),
      text
    );
  let output = '';
  let prose = '';
  let fence: { char: string; length: number } | null = null;
  for (const line of raw.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && marker) {
      output += project(prose) + line;
      prose = '';
      fence = { char: marker[1][0], length: marker[1].length };
    } else if (fence) {
      output += line;
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
    } else {
      prose += line;
    }
  }
  return output + project(prose);
}

export function consoleBriefPath(homeDir: string = homedir()): string {
  return join(homeDir, '.mama', 'briefs', 'brief-owner-console.md');
}

/** Boot seeding - write the packaged default ONLY when missing (agent/user
 *  edits always win; deliberate no-auto-upgrade, mirroring ensureBriefs). */
export function ensureConsoleBrief(homeDir: string = homedir()): boolean {
  const path = consoleBriefPath(homeDir);
  if (existsSync(path)) return false;
  mkdirSync(join(homeDir, '.mama', 'briefs'), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, CONSOLE_BRIEF_DEFAULT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    // Exclusive publication keeps a concurrent human-created brief intact.
    linkSync(tmpPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(tmpPath);
  }
}

/** Read the current brief; empty string when absent (caller seeds on boot). */
export function loadConsoleBrief(homeDir: string = homedir()): string {
  const path = consoleBriefPath(homeDir);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

function removeLegacyConsolePrivateLines(raw: string): string {
  const parts = raw.split(/(\r?\n)/);
  let projected = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const separator = parts[index + 1] ?? '';
    if (!LEGACY_CONSOLE_PRIVATE_LINES.has(line)) {
      projected += line + separator;
    }
  }
  return projected;
}

/** Project a user-owned brief for one prompt without modifying its file. */
export function projectConsoleBriefForPrompt(raw: string, policy: PrivateConnectorPolicy): string {
  const overlay = buildPrivatePromptOverlay('owner_console', policy);
  const projected = stripDisabledPrivatePromptRecipes(
    removeLegacyConsolePrivateLines(stripMarkedPrivatePromptOverlays(raw)),
    overlay.length > 0
  );
  if (!overlay) {
    return projected;
  }
  const separator = projected.endsWith('\n\n') ? '' : projected.endsWith('\n') ? '\n' : '\n\n';
  return `${projected}${separator}${overlay}\n`;
}

export const hashConsoleBrief = hashProcedureDocument;

export function readConsoleBriefSnapshot(homeDir: string = homedir()): {
  path: string;
  text: string;
  hash: string | null;
} {
  const path = consoleBriefPath(homeDir);
  const text = loadConsoleBrief(homeDir);
  return { path, text, hash: existsSync(path) ? hashConsoleBrief(text) : null };
}

export interface ConsoleBriefUpdate {
  operation: 'append' | 'replace' | 'retire';
  lesson?: string;
  target?: string;
  replacement?: string;
  expectedHash?: string;
}

/** Pure preparation: the canonical store commits this text and its old revision
 * before attempting Markdown publication. No full-document replace operation.
 */
export function prepareConsoleBriefUpdate(
  input: ConsoleBriefUpdate,
  current: string
): {
  text: string;
  priorHash: string;
  hash: string;
} {
  const priorHash = hashConsoleBrief(current);
  if (input.expectedHash !== undefined && input.expectedHash !== priorHash) {
    throw new Error('console brief update refused: expected hash conflict');
  }
  let text: string;
  if (input.operation === 'append') {
    // Retired 2026-09-09: dated lesson lines accreted into a 10K brief with contradictory
    // rules. Corrections are procedures now; the brief only ever changes by exact target.
    throw new Error(
      'console brief update refused: append is retired; store the correction with procedure_update'
    );
  } else if (input.operation === 'replace' || input.operation === 'retire') {
    if (!input.expectedHash) {
      throw new Error('console brief update refused: expected hash required');
    }
    const target = input.target;
    if (!target?.trim() || target.trim() === current.trim()) {
      throw new Error('console brief update refused: exact partial target required');
    }
    const offset = current.indexOf(target);
    if (offset < 0 || current.indexOf(target, offset + 1) >= 0) {
      throw new Error('console brief update refused: missing or ambiguous target');
    }
    const end = offset + target.length;
    if (
      (offset > 0 && current[offset - 1] !== '\n') ||
      (end < current.length && !target.endsWith('\n') && !/^[\r\n]/.test(current.slice(end)))
    ) {
      throw new Error(
        'console brief update refused: target must contain a complete rule or section'
      );
    }
    const section = /^(#{2,6})[ \t]+/.exec(target);
    if (section) {
      const level = section[1].length;
      const nextHeading = /^(#{1,6})[ \t]+/gm;
      nextHeading.lastIndex = offset + target.split('\n')[0].length + 1;
      let boundary = current.length;
      let match: RegExpExecArray | null;
      while ((match = nextHeading.exec(current)) !== null) {
        if (match[1].length <= level) {
          boundary = match.index;
          break;
        }
      }
      if (end > boundary || current.slice(end, boundary).trim()) {
        throw new Error(
          'console brief update refused: target must contain exactly one complete section'
        );
      }
    } else {
      const isListRule = /^[-*+] |^\d+[.)] /.test(target);
      const precedingLine =
        current
          .slice(0, offset)
          .replace(/\r?\n$/, '')
          .split(/\r?\n/)
          .pop() ?? '';
      if (
        /^#/.test(target) ||
        /\n(?:#{1,6} |[-*+] |\d+[.)] )/.test(target) ||
        (!isListRule && (precedingLine.trim() || /\r?\n\s*\r?\n/.test(target.trim())))
      ) {
        throw new Error(
          'console brief update refused: target must contain one complete rule or section'
        );
      }
    }
    if (!section) {
      const remainder = current.slice(end).replace(/^\r?\n/, '');
      const followingLine = remainder.split(/\r?\n/)[0];
      if (followingLine.trim() && !/^(?:#{1,6} |[-*+] |\d+[.)] )/.test(followingLine)) {
        throw new Error(
          'console brief update refused: target must contain the complete wrapped rule'
        );
      }
    }
    const replacement = input.operation === 'retire' ? '' : input.replacement;
    if (replacement === undefined || (input.operation === 'replace' && !replacement.trim())) {
      throw new Error('console brief update refused: nonempty replacement required');
    }
    text = current.slice(0, offset) + replacement + current.slice(end);
  } else {
    throw new Error('console brief update refused: unsupported operation');
  }
  if (text.length > CONSOLE_BRIEF_MAX_CHARS) {
    throw new Error(
      `console brief update refused: ${text.length} chars exceeds ${CONSOLE_BRIEF_MAX_CHARS}`
    );
  }
  return { text, priorHash, hash: hashConsoleBrief(text) };
}

/** Legacy append-only API, preserving its return value and seed-on-missing behavior. */

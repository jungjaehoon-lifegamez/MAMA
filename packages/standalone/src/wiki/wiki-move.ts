/** Moves pages inside the configured wiki root, all or none. */
import { existsSync, mkdirSync, realpathSync, renameSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { normalizeWikiPagePath } from './path-safety.js';
import { resolveInsideRoot } from './wiki-read.js';

/** The live wiki held 234 pages when the owner asked to reorganise it; one call moves them all. */
export const WIKI_MOVE_MAX = 500;

export interface WikiMove {
  from: string;
  to: string;
}

function pagePath(value: unknown, field: string): string {
  const path = normalizeWikiPagePath(value, field);
  if (!path.endsWith('.md')) throw new Error(`${field} must end with .md: ${path}`);
  // The wiki listing and the daily check skip dot entries, so a page moved there disappears.
  if (path.split('/').some((segment) => segment.startsWith('.'))) {
    throw new Error(`${field} is in a hidden folder the wiki does not list: ${path}`);
  }
  return path;
}

/** One name on a case-insensitive, normalising disk (the default on macOS). */
const sameName = (path: string): string => path.normalize('NFC').toLowerCase();

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Check every move before the first rename: each from is a page, each to is free, and no
 * path is used twice. A rename that still fails puts the earlier ones back.
 */
export function moveWikiPages(root: string, moves: readonly WikiMove[]): WikiMove[] {
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > WIKI_MOVE_MAX) {
    throw new Error(`moves must list 1 to ${WIKI_MOVE_MAX} moves`);
  }
  const rootReal = realpathSync(resolve(root));
  const planned = moves.map((move, index) => {
    const from = pagePath(move?.from, `moves[${index}].from`);
    const to = pagePath(move?.to, `moves[${index}].to`);
    if (from === to) throw new Error(`moves[${index}] has the same path as from and to: ${from}`);
    return { from, to, index };
  });
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to, index } of planned) {
    if (froms.has(sameName(from))) throw new Error(`moves[${index}].from is moved twice: ${from}`);
    if (tos.has(sameName(to))) throw new Error(`moves[${index}].to is a target twice: ${to}`);
    froms.add(sameName(from));
    tos.add(sameName(to));
  }
  const sources = planned.map(({ from, to, index }) => {
    if (froms.has(sameName(to))) {
      throw new Error(`moves[${index}].to is another move's from: ${to}`);
    }
    const source = resolveInsideRoot(rootReal, from);
    if (source === null) throw new Error(`moves[${index}].from does not exist: ${from}`);
    if (resolveInsideRoot(rootReal, to) !== null) {
      throw new Error(`moves[${index}].to already exists: ${to}`);
    }
    return { from, to, source, target: join(rootReal, ...to.split('/')) };
  });

  const done: typeof sources = [];
  try {
    for (const move of sources) {
      // renameSync replaces an existing file silently; a name the disk aliases must not.
      if (existsSync(move.target)) throw new Error(`${move.to} already exists`);
      mkdirSync(dirname(move.target), { recursive: true });
      renameSync(move.source, move.target);
      done.push(move);
    }
  } catch (error) {
    const failed = sources[done.length]!;
    const stuck: string[] = [];
    for (const move of done.reverse()) {
      try {
        renameSync(move.target, move.source);
      } catch (undo) {
        stuck.push(`${move.from} is still at ${move.to} (${message(undo)})`);
      }
    }
    throw new Error(
      stuck.length === 0
        ? `moving ${failed.from} to ${failed.to} failed, so no page was moved: ${message(error)}`
        : `moving ${failed.from} to ${failed.to} failed (${message(error)}), and putting earlier moves back failed: ${stuck.join('; ')}`
    );
  }
  return sources.map(({ from, to }) => ({ from, to }));
}

/** Moves pages inside the configured wiki root, all or none. */
import { mkdirSync, realpathSync, renameSync } from 'fs';
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
  return path;
}

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
    if (froms.has(from)) throw new Error(`moves[${index}].from is moved twice: ${from}`);
    if (tos.has(to)) throw new Error(`moves[${index}].to is a target twice: ${to}`);
    froms.add(from);
    tos.add(to);
  }
  const sources = planned.map(({ from, to, index }) => {
    if (froms.has(to)) throw new Error(`moves[${index}].to is another move's from: ${to}`);
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
      mkdirSync(dirname(move.target), { recursive: true });
      renameSync(move.source, move.target);
      done.push(move);
    }
  } catch (error) {
    const failed = sources[done.length]!;
    for (const move of done.reverse()) renameSync(move.target, move.source);
    throw new Error(
      `moving ${failed.from} to ${failed.to} failed, so no page was moved: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return sources.map(({ from, to }) => ({ from, to }));
}

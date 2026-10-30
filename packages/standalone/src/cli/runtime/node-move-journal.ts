import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJournalFile, removeUpdateJournal } from './update-journal.js';

/**
 * The journal of `mama update --node` (docs/development/work/install.md, "Moving the managed
 * Node"): its own file, since the update journal's fields describe a package. Under runtime/,
 * beside update.json, which the agents' native reads deny and a backup does not archive.
 *
 * install/install.sh reads it in plain sh before anything else, since ~/.mama/npm may be missing
 * then: it greps `"phase": "committed"`, so the file is written by JSON.stringify with two-space
 * indents (writeJournalFile), one field per line.
 */

/** prepare: steps 1-4, undone on a failure; committed: the new Node runs, only cleanup is left. */
export type NodeMovePhase = 'prepare' | 'committed';

export interface NodeMoveJournal {
  readonly format: 'mama-node-move';
  phase: NodeMovePhase;
  /** The step last begun: 1 lock and journal, 2 copy and rebuild, 3 stop and renames, 4 boot. */
  step: number;
  /** The managed Node's versions, without the `v`. */
  readonly from: string;
  readonly to: string;
  /** A major change, which moves a rebuilt copy of the npm prefix as well. */
  readonly major: boolean;
  readonly startedAt: string;
}

export interface NodeMovePlaces {
  readonly journal: string;
  /** `~/.mama/node`, the folder start.sh's Node lives in, and the two beside it. */
  readonly node: string;
  readonly staged: string;
  readonly aside: string;
  /** `~/.mama/npm`, the managed prefix, and its rebuilt copy and the previous one. */
  readonly prefix: string;
  readonly prefixCopy: string;
  readonly prefixAside: string;
}

export function nodeMovePlaces(mamaRoot: string): NodeMovePlaces {
  return {
    journal: join(mamaRoot, 'runtime', 'node-move.json'),
    node: join(mamaRoot, 'node'),
    staged: join(mamaRoot, 'node.new'),
    aside: join(mamaRoot, 'node.old'),
    prefix: join(mamaRoot, 'npm'),
    prefixCopy: join(mamaRoot, 'npm.new'),
    prefixAside: join(mamaRoot, 'npm.old'),
  };
}

/** start.sh's Node on an install the install command made. */
export function managedNodePath(mamaRoot: string): string {
  return join(nodeMovePlaces(mamaRoot).node, 'bin', 'node');
}

/** The documented install command; running it again moves the managed Node to its pin. */
export const INSTALL_COMMAND =
  'curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | sh';

export function readNodeMoveJournal(path: string): NodeMoveJournal | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<NodeMoveJournal> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    value.format !== 'mama-node-move' ||
    (value.phase !== 'prepare' && value.phase !== 'committed') ||
    typeof value.step !== 'number' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.major !== 'boolean'
  ) {
    throw new Error(`${path} is not a journal mama update --node wrote`);
  }
  return value as NodeMoveJournal;
}

export function writeNodeMoveJournal(path: string, journal: NodeMoveJournal): void {
  writeJournalFile(path, journal);
}

export const removeNodeMoveJournal = removeUpdateJournal;

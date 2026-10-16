import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliInputError } from '../prompt.js';

/** The steps `mama init` takes after its questions, in order; each runs once. */
export const INIT_STEPS = ['config', 'owner', 'toolkit', 'service'] as const;
export type InitStep = (typeof INIT_STEPS)[number];

export interface InitState {
  version: 1;
  done: InitStep[];
  /**
   * The viewer's tunnel settings, kept until the service step writes them into start.sh, so an
   * init that resumes after a failure still has them. Not credentials.
   */
  viewer?: Record<string, string>;
  /** The first owner's Telegram user ID, kept until the owner step registers it. */
  pendingOwner?: string;
}

export function initStatePath(mamaRoot: string): string {
  return join(mamaRoot, 'runtime', 'init-state.json');
}

/** The steps an earlier `mama init` finished, or null when none has run here. */
export function readInitState(mamaRoot: string): InitState | null {
  const path = initStatePath(mamaRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliInputError(`${path} cannot be read; remove it and the MAMA home to start over`);
  }
  const state = parsed as Partial<InitState>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.done) ||
    state.done.some((step) => !(INIT_STEPS as readonly string[]).includes(step))
  ) {
    throw new CliInputError(`${path} is not one this version wrote; remove it to start over`);
  }
  return {
    version: 1,
    done: state.done,
    ...(state.viewer === undefined ? {} : { viewer: state.viewer }),
    ...(state.pendingOwner === undefined ? {} : { pendingOwner: state.pendingOwner }),
  };
}

export function writeInitState(mamaRoot: string, state: InitState): void {
  const path = initStatePath(mamaRoot);
  mkdirSync(join(mamaRoot, 'runtime'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function initComplete(state: InitState | null): boolean {
  return state !== null && INIT_STEPS.every((step) => state.done.includes(step));
}

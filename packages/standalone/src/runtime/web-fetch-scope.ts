/**
 * WebFetch is a judgment call, so a turn with no person in it does not browse (owner, 2026-10-15):
 * deltas, record orders, reports, notices and personal jobs fetch only hosts listed in
 * `agent.autonomous_web_fetch`, and keep WebSearch, which sends a query to the search provider
 * only. A turn where a person speaks keeps WebFetch. A page fetch can carry text in its URL to any
 * host it names, which is why the scope is fixed in advance rather than left to the turn.
 *
 * The session writes the running turn's mode to a file in its runtime directory, outside the
 * workspace, before the turn's access is prepared; the Claude PreToolUse hook reads it. Turns of
 * one workspace run one at a time. Between turns, and when the file cannot be read, the mode is
 * autonomous: the hook refuses rather than guesses.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WebFetchTurnMode {
  /** No person speaks in this turn. */
  autonomous: boolean;
  /** Hosts an autonomous turn may fetch; `*` is every host. */
  hosts: readonly string[];
}

export type WebFetchDecision = { allow: true } | { allow: false; reason: string };

const REFUSAL =
  'WebFetch is off in turns with no person in them, except for the hosts the owner configured ' +
  '(agent.autonomous_web_fetch). Use WebSearch, or leave the link in your result for the person ' +
  'to ask about.';

/** Whether this turn may fetch the URL. A missing or unreadable mode refuses. */
export function webFetchDecision(mode: WebFetchTurnMode | null, url: unknown): WebFetchDecision {
  if (mode !== null && !mode.autonomous) return { allow: true };
  if (mode === null)
    return { allow: false, reason: `${REFUSAL} The turn's mode could not be read.` };
  if (mode.hosts.includes('*')) return { allow: true };
  let host: string;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return { allow: false, reason: `${REFUSAL} The URL could not be read.` };
  }
  // A listed host covers its subdomains: stat.go.jp also allows www.stat.go.jp.
  return mode.hosts.some((listed) => host === listed || host.endsWith(`.${listed}`))
    ? { allow: true }
    : { allow: false, reason: `${REFUSAL} ${host} is not configured.` };
}

export function readWebFetchTurnMode(path: string): WebFetchTurnMode | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebFetchTurnMode>;
    return typeof value.autonomous === 'boolean' &&
      Array.isArray(value.hosts) &&
      value.hosts.every((host) => typeof host === 'string')
      ? { autonomous: value.autonomous, hosts: value.hosts }
      : null;
  } catch {
    return null;
  }
}

/** Replace the file whole, so the hook never reads half a mode. */
export function writeWebFetchTurnMode(path: string, mode: WebFetchTurnMode): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(mode)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

/** A person speaks only in a message turn; every other stimulus kind is autonomous. */
export function webFetchTurnMode(
  source: string | undefined,
  hosts: readonly string[]
): WebFetchTurnMode {
  return { autonomous: source !== 'owner_message', hosts };
}

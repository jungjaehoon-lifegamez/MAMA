/**
 * The one durable reasoning subject that serves the authenticated owner.
 *
 * Connector names, channel ids, report modes, and maintenance kinds are turn
 * metadata. They must never select another model session.
 */
export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

/** Stable owner policy, loaded with the session rather than replayed as turn history. */
export const OWNER_SUBAGENT_INSTRUCTIONS =
  'For native subagents, send one bounded task, its needed evidence and a clear completion condition. ' +
  'Prefer no history fork (fork_turns: "none" where supported); copy the full conversation only when ' +
  'the task requires that context. Avoid delegating simple work. Review returned evidence and ' +
  'integrate your own judgment; you retain the owner conversation and responsibility for completion.';

const LEGACY_HOST_AGENT_TOOLS = new Set(['report_request', 'delegate']);

/** Remove host-created judgment handoffs from the standing owner's catalog. */
export function projectOwnerRuntimeRole(role: RoleConfig): RoleConfig {
  return {
    ...role,
    allowedTools: [
      ...new Set([
        ...role.allowedTools.filter((tool) => !LEGACY_HOST_AGENT_TOOLS.has(tool)),
        'native_subagent',
      ]),
    ],
    blockedTools: [
      ...new Set([
        ...(role.blockedTools ?? []).filter((tool) => tool !== 'delegate'),
        'report_request',
      ]),
    ],
  };
}

export interface OwnerRuntimeReadScope {
  projectRefs: Array<{ kind: 'project'; id: string }>;
  memoryScopes: Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>;
  rawConnectors: string[];
}

/** Host adapters submit stimuli here without selecting another model subject. */
export interface OwnerRuntimeRunner {
  (
    prompt: string,
    channelId: string
  ): Promise<{
    response: string;
    totalUsage: { input_tokens: number; output_tokens: number };
  }>;
}
import type { RoleConfig } from '../cli/config/types.js';

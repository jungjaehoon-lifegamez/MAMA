/**
 * The one durable reasoning subject that serves the authenticated owner.
 *
 * Connector names, channel ids, report modes, and maintenance kinds are turn
 * metadata. They must never select another model session.
 */
export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

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

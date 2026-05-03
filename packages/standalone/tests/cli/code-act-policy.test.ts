import { describe, expect, it } from 'vitest';

import {
  deriveCodeActToolPolicy,
  resolveCodeActAgentPolicy,
} from '../../src/cli/commands/start.js';

describe('STORY-B6: Code-Act runtime policy hardening', () => {
  it('does not let request allowed_tools widen configured agent permissions', () => {
    const policy = deriveCodeActToolPolicy(
      {
        agentId: 'dashboard',
        allowedTools: ['*'],
        blockedTools: ['mama_update'],
      },
      {
        name: 'dashboard',
        display_name: 'Dashboard',
        trigger_prefix: '!dashboard',
        tier: 2,
        useCodeAct: true,
        gateway_tool_permissions: {
          allowed: ['mama_search', 'report_publish'],
          blocked: ['mama_save'],
        },
      }
    );

    expect(policy).toEqual({
      allowedTools: ['mama_search', 'report_publish'],
      blockedTools: ['mama_save', 'mama_update'],
    });
  });

  it('allows request allowed_tools to narrow wildcard-configured agents', () => {
    const policy = deriveCodeActToolPolicy(
      {
        agentId: 'developer',
        allowedTools: ['mama_search'],
      },
      {
        name: 'developer',
        display_name: 'Developer',
        trigger_prefix: '!developer',
        tier: 1,
        useCodeAct: true,
        gateway_tool_permissions: {
          allowed: ['*'],
        },
      }
    );

    expect(policy.allowedTools).toEqual(['mama_search']);
  });

  it('rejects request-specified unknown Code-Act agents', () => {
    const resolved = resolveCodeActAgentPolicy(
      {
        agentId: 'unknown',
        allowedTools: ['*'],
      },
      {
        dashboard: {
          name: 'dashboard',
          display_name: 'Dashboard',
          trigger_prefix: '!dashboard',
          tier: 2,
        },
      },
      'dashboard'
    );

    expect(resolved).toMatchObject({
      error: 'Unknown Code-Act agent: unknown',
    });
  });
});

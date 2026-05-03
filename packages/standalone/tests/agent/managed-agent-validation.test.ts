import { describe, expect, it } from 'vitest';

import {
  validateManagedAgentChanges,
  validateManagedAgentCreateInput,
} from '../../src/agent/managed-agent-validation.js';

describe('STORY-MANAGED-AGENTS: managed agent validation - AC1', () => {
  it('accepts gateway tool permission allowlists and blocklists', () => {
    expect(
      validateManagedAgentChanges({
        gateway_tool_permissions: {
          allowed: ['mama_search'],
          blocked: ['mama_save'],
        },
      })
    ).toBeNull();
  });

  it('rejects malformed gateway tool permission lists', () => {
    expect(
      validateManagedAgentChanges({
        gateway_tool_permissions: {
          allowed: ['mama_search', 42],
        },
      })
    ).toBe('Invalid value for gateway_tool_permissions');
  });

  it('rejects unsupported Gemini backend values', () => {
    expect(
      validateManagedAgentCreateInput({
        id: 'qa',
        name: 'QA',
        model: 'gemini-2.5-pro',
        tier: 1,
        backend: 'gemini',
      })
    ).toBe('Invalid backend.');
  });
});

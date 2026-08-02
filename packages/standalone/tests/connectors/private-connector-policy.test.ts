import { describe, expect, it } from 'vitest';

import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import {
  PRIVATE_CONNECTOR_TOOL_DEFINITIONS,
  projectPrivateToolPolicy,
  resolvePrivateConnectorPolicy,
  resolvePrivatePrincipalSurface,
  visibleConnectorNames,
} from '../../src/connectors/private-connector-policy.js';
import {
  AVAILABLE_CONNECTORS,
  LOADABLE_CONNECTORS,
  PRIVATE_CONNECTORS,
} from '../../src/connectors/index.js';

const PRIVATE_TOOL_NAMES = [
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
];

function connectorResult(enabled: boolean): ConnectorConfigLoadResult {
  return {
    ok: true,
    config: {
      kagemusha: {
        enabled,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: enabled ? ['kagemusha'] : [],
  };
}

function trustedContext(
  roleName: string,
  source = 'telegram'
): Pick<GatewayToolExecutionContext, 'agentContext'> {
  return {
    agentContext: {
      source,
      platform: 'claude',
      roleName,
      role: { allowedTools: [] },
      session: { sessionId: 'test-session', startedAt: new Date() },
      capabilities: [],
      limitations: [],
    },
  };
}

describe('Story private connector isolation: immutable Kagemusha policy boundary', () => {
  it('TG-01/TG-05/TG-06: keeps a fresh install free of private discovery and grants', () => {
    const policy = resolvePrivateConnectorPolicy({
      ok: true,
      config: Object.freeze(Object.create(null)),
      enabledNames: Object.freeze([]),
    });

    expect(AVAILABLE_CONNECTORS).not.toContain('kagemusha');
    expect(PRIVATE_CONNECTORS).toEqual(['kagemusha']);
    expect(LOADABLE_CONNECTORS).toContain('kagemusha');
    expect(visibleConnectorNames([])).not.toContain('kagemusha');
    expect(policy.toolsFor('owner_console')).toEqual([]);
    expect(policy.toolDefinitionsFor('owner_console')).toEqual([]);
    expect(policy.promptOverlayFor('owner_console')).toBe('');
  });

  it('projects the configured private bundle and blocks stale wildcard grants when disabled', () => {
    const enabled = resolvePrivateConnectorPolicy(connectorResult(true));
    expect(enabled.toolsFor('owner_console')).toEqual(PRIVATE_TOOL_NAMES);

    const disabled = resolvePrivateConnectorPolicy(connectorResult(false));
    const role = disabled.projectRole('owner_console', {
      ...DEFAULT_ROLES.definitions.owner_console!,
      allowedTools: ['*'],
    });

    expect(role.blockedTools).toEqual(expect.arrayContaining(PRIVATE_TOOL_NAMES));
  });

  it.each(['os_agent', 'legacy-unbound', 'multi-agent-generic'] as const)(
    'TG-05/TG-06: blocks all private tools from the ineligible %s wildcard surface',
    (surface) => {
      const enabled = resolvePrivateConnectorPolicy(connectorResult(true));
      const projected = projectPrivateToolPolicy(surface, { allowedTools: ['*'] }, enabled);

      expect(projected.blockedTools).toEqual(expect.arrayContaining(PRIVATE_TOOL_NAMES));
    }
  );

  it('TG-01: makes the configured private connector visible only from the supplied config names', () => {
    expect(visibleConnectorNames(['telegram', 'kagemusha'])).toEqual(
      expect.arrayContaining(['telegram', 'kagemusha'])
    );
    expect(visibleConnectorNames(['telegram'])).not.toContain('kagemusha');
  });

  it('derives an eligible private surface only from trusted agent context', () => {
    expect(resolvePrivatePrincipalSurface({})).toBe('legacy-unbound');
    expect(resolvePrivatePrincipalSurface(trustedContext('owner_console'))).toBe('owner_console');
    expect(resolvePrivatePrincipalSurface(trustedContext('workorder-board'))).toBe(
      'workorder-board'
    );
    expect(resolvePrivatePrincipalSurface(trustedContext('workorder-memory-curation'))).toBe(
      'workorder-memory-curation'
    );
    expect(resolvePrivatePrincipalSurface(trustedContext('workorder-temporal'))).toBe(
      'workorder-temporal'
    );
    expect(resolvePrivatePrincipalSurface(trustedContext('operator-report'))).toBe(
      'operator-report'
    );
    expect(resolvePrivatePrincipalSurface(trustedContext('os_agent', 'viewer'))).toBe('os_agent');
    expect(resolvePrivatePrincipalSurface(trustedContext('chat_bot'))).toBe('multi-agent-generic');
  });

  it('TG-05/TG-06 keeps direct and Code-Act private metadata coherent with policy', () => {
    const codeActByName = new Map(HostBridge.getToolRegistry().map((tool) => [tool.name, tool]));

    for (const definition of PRIVATE_CONNECTOR_TOOL_DEFINITIONS) {
      expect(ToolRegistry.getTool(definition.name)).toMatchObject({
        name: definition.name,
        description: definition.description,
        category: definition.category,
        params: definition.params,
      });
      expect(codeActByName.get(definition.name)).toEqual({
        name: definition.name,
        description: definition.description,
        params: definition.codeAct.params,
        returnType: definition.codeAct.returnType,
        category: definition.codeAct.category,
      });
    }

    expect(codeActByName.get('kagemusha_tasks')?.description).toContain(
      'pending|in_progress|review|done|completed|cancelled|dismissed|active'
    );
  });

  it('returns immutable snapshots that cannot mutate a later role projection', () => {
    const policy = resolvePrivateConnectorPolicy(connectorResult(true));
    const tools = policy.toolsFor('owner_console');

    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(policy.configuredPrivateConnectors)).toBe(true);
    expect(Object.isFrozen(policy.enabledPrivateConnectors)).toBe(true);

    const projected = policy.projectRole('owner_console', { allowedTools: ['mama_search'] });
    expect(projected.allowedTools).toEqual(['mama_search', ...PRIVATE_TOOL_NAMES]);
    expect(projected.allowedTools).not.toBe(tools);
  });
});

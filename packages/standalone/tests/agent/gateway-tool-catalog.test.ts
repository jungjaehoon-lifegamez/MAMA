import { describe, expect, it } from 'vitest';

import { buildGatewayToolCatalog } from '../../src/agent/gateway-tool-catalog.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';

function enabledPolicy() {
  const result: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: ['kagemusha'],
  };
  return resolvePrivateConnectorPolicy(result);
}

describe('Gateway tool catalog private isolation', () => {
  it('TG-03/TG-04 expands patterns and filters from the final projected exact names', () => {
    const catalog = buildGatewayToolCatalog({
      surface: 'owner_console',
      allowedTools: ['mama_*'],
      blockedTools: ['mama_save'],
      privateConnectorPolicy: enabledPolicy(),
    });

    expect(catalog.toolNames).toContain('mama_search');
    expect(catalog.toolNames).not.toContain('mama_save');
    expect(catalog.toolNames).toContain('kagemusha_tasks');
    expect(catalog.prompt).toContain('kagemusha_tasks');
  });

  it('TG-05 keys cached prompts by private policy and never reuses a disabled prompt', () => {
    const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
    const enabled = enabledPolicy();
    const input = { surface: 'owner_console' as const, allowedTools: ['*'] as const };

    const disabledCatalog = buildGatewayToolCatalog({
      ...input,
      privateConnectorPolicy: disabled,
    });
    const repeatedDisabled = buildGatewayToolCatalog({
      ...input,
      privateConnectorPolicy: disabled,
    });
    const enabledCatalog = buildGatewayToolCatalog({
      ...input,
      privateConnectorPolicy: enabled,
    });

    expect(repeatedDisabled).toBe(disabledCatalog);
    expect(enabledCatalog.cacheKey).not.toBe(disabledCatalog.cacheKey);
    expect(disabledCatalog.prompt.toLowerCase()).not.toContain('kagemusha');
    expect(enabledCatalog.prompt).toContain('kagemusha_tasks');
  });

  it('TG-04 keeps an enabled connector off ineligible wildcard surfaces', () => {
    const catalog = buildGatewayToolCatalog({
      surface: 'multi-agent-generic',
      allowedTools: ['*'],
      privateConnectorPolicy: enabledPolicy(),
    });

    expect(catalog.toolNames).not.toContain('kagemusha_tasks');
    expect(catalog.prompt.toLowerCase()).not.toContain('kagemusha');
  });

  it('TG-04 keeps an empty final projection empty instead of reopening every tool', () => {
    const disabled = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
    const catalog = buildGatewayToolCatalog({
      surface: 'multi-agent-generic',
      allowedTools: ['not_a_registered_tool'],
      privateConnectorPolicy: disabled,
    });

    expect(catalog.toolNames).toEqual([]);
    expect(catalog.prompt).not.toContain('mama_search');
  });
});

import { describe, expect, it } from 'vitest';

import type { ConnectorConfigLoadResult } from '../../../src/connectors/config-loader.js';
import { resolveRuntimeConnectorBootstrap } from '../../../src/cli/runtime/connector-bootstrap.js';

describe('Story private connector isolation: startup-owned connector bootstrap', () => {
  it('TG-01/TG-05/TG-06: logs one redacted malformed snapshot failure and resolves a fail-closed policy', () => {
    const lines: string[] = [];
    const malformed: ConnectorConfigLoadResult = {
      ok: false,
      error: {
        code: 'parse_error',
        path: '/private/connectors.json',
        message: 'keep-this-private-value-redacted',
      },
      config: {},
      enabledNames: [],
    };

    const bootstrap = resolveRuntimeConnectorBootstrap(malformed, (line) => lines.push(line));

    expect(lines).toEqual(['[connector] failed to load connector configuration (parse_error)']);
    expect(lines.join('\n')).not.toContain('keep-this-private-value-redacted');
    expect(bootstrap.connectorConfigLoadResult).toBe(malformed);
    expect(bootstrap.privateConnectorPolicy.isConfigured('kagemusha')).toBe(false);
    expect(bootstrap.privateConnectorPolicy.isEnabled('kagemusha')).toBe(false);
  });
});

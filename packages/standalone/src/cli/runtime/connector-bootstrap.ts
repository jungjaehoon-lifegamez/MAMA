import type { ConnectorConfigLoadResult } from '../../connectors/config-loader.js';
import {
  resolvePrivateConnectorPolicy,
  type PrivateConnectorPolicy,
} from '../../connectors/private-connector-policy.js';

export interface RuntimeConnectorBootstrap {
  connectorConfigLoadResult: ConnectorConfigLoadResult;
  privateConnectorPolicy: PrivateConnectorPolicy;
}

export function resolveRuntimeConnectorBootstrap(
  connectorConfigLoadResult: ConnectorConfigLoadResult,
  writeError: (line: string) => void = (line) => console.error(line)
): RuntimeConnectorBootstrap {
  if (!connectorConfigLoadResult.ok) {
    writeError(
      `[connector] failed to load connector configuration (${connectorConfigLoadResult.error.code})`
    );
  }

  return {
    connectorConfigLoadResult,
    privateConnectorPolicy: resolvePrivateConnectorPolicy(connectorConfigLoadResult),
  };
}

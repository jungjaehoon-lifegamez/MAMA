/**
 * ConnectorRegistry — in-memory registry for all active connectors.
 */

import type { ConnectorHealth, IConnector } from './types.js';

export class ConnectorRegistry {
  private connectors = new Map<string, IConnector>();

  register(name: string, connector: IConnector): void {
    this.connectors.set(name, connector);
  }

  get(name: string): IConnector | undefined {
    return this.connectors.get(name);
  }

  getActive(): Map<string, IConnector> {
    return new Map(this.connectors);
  }

  async disposeAll(): Promise<void> {
    const disposePromises = Array.from(this.connectors.values()).map((c) => c.dispose());
    await Promise.all(disposePromises);
    this.connectors.clear();
  }

  async healthCheckAll(): Promise<Record<string, ConnectorHealth>> {
    const results: Record<string, ConnectorHealth> = {};
    await Promise.all(
      Array.from(this.connectors.entries()).map(async ([name, connector]) => {
        try {
          results[name] = await connector.healthCheck();
        } catch (err) {
          results[name] = {
            healthy: false,
            lastPollTime: null,
            lastPollCount: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    return results;
  }
}

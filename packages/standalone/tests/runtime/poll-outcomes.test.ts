import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { reportSourceActionRegistrations } from '../../src/api/report-source-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { recordConnectorPollOutcome } from '../../src/connectors/framework/event-index.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import type { IConnector } from '../../src/connectors/framework/types.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector poll outcome visibility', () => {
  it('shows a failed connector poll in source.recent and clears it after a successful poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-outcome-'));
    roots.push(root);
    const database = await openCoreDatabase({ path: join(root, 'state.db') });
    const raw = new RawStore(join(root, 'raw'));
    let polls = 0;
    const connector: IConnector = {
      name: 'connector-test',
      type: 'api',
      init: async () => {},
      dispose: async () => {},
      healthCheck: async () => ({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
      getAuthRequirements: () => [],
      authenticate: async () => true,
      poll: async () => {
        polls += 1;
        if (polls === 1) throw new Error('room collection failed');
        return [];
      },
    };
    const registry = new ConnectorRegistry();
    registry.register('connector-test', connector);
    const scheduler = new PollingScheduler(raw, root, {
      rawIndexSink: () => [],
      recordPollOutcome: (name, outcome) =>
        recordConnectorPollOutcome(database.adapter, name, outcome),
    });
    const dispatch = createDispatcher(
      createCatalog(
        reportSourceActionRegistrations({
          adapter: database.adapter,
          timeZone: createTimeZoneSetting('Asia/Seoul'),
        })
      )
    );
    const access: ActionContext['access'] = {
      principalId: 'owner-test',
      agentId: 'agent-test',
      actions: ['source.recent'],
      connectors: ['connector-test'],
      connectorWideRead: ['connector-test'],
      scopes: [],
    };
    const read = () => dispatch({ action: 'source.recent', input: {} }, { access });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await scheduler.pollConnector('connector-test', registry, {}, async () => {});
      expect(await read()).toMatchObject({
        status: 'completed',
        data: {
          failedConnectors: [{ connector: 'connector-test', error: 'room collection failed' }],
        },
      });
      await scheduler.pollConnector('connector-test', registry, {}, async () => {});
      expect(await read()).toMatchObject({
        status: 'completed',
        data: { failedConnectors: [] },
      });
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      raw.close();
      await database.close();
    }
  });
});

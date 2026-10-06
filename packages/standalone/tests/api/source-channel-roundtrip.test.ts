import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { reportSourceActionRegistrations } from '../../src/api/report-source-actions.js';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('source channel values', () => {
  it('passes a channel listed by source.recent straight to source.search', async () => {
    const home = mkdtempSync(join(tmpdir(), 'source-channel-'));
    homes.push(home);
    const db = await openCoreDatabase({ path: join(home, 'state.db') });
    try {
      const now = Date.now();
      for (const [index, channel] of ['room-a', 'room-a', 'room-b'].entries()) {
        upsertConnectorEventIndex(db.adapter, {
          source_connector: 'slack',
          source_type: 'message',
          source_id: `message-${index}`,
          channel,
          content: `release note ${index}`,
          source_timestamp_ms: now - index * 1_000,
          metadata_json: JSON.stringify({
            channelName: channel === 'room-a' ? 'Room A' : 'Room B',
          }),
        });
      }
      const timeZone = createTimeZoneSetting('UTC');
      const dispatch = createDispatcher(
        createCatalog([
          ...reportSourceActionRegistrations({
            adapter: db.adapter,
            ownerPrincipalId: 'owner',
            timeZone,
          }),
          ...sourceActionRegistrations({
            stored: createStoredSourceReader({
              adapter: db.adapter,
              ownerPrincipalId: () => 'owner',
            }),
            timeZone,
          }),
        ])
      );
      const access: ActionContext['access'] = {
        principalId: 'owner',
        agentId: 'agent',
        actions: ['source.recent', 'source.search'],
        connectors: ['slack'],
        scopes: [],
      };

      const recent = (await dispatch(
        { action: 'source.recent', input: { since: now - 60_000 } },
        { access }
      )) as { data: { channels: Array<{ channel: string; channelName?: string; key: string }> } };
      const listed = recent.data.channels.find((entry) => entry.channelName === 'Room A')!;
      expect(listed).toMatchObject({ channel: 'room-a', key: 'slack:room-a' });

      const found = (await dispatch(
        {
          action: 'source.search',
          input: { source: 'slack', view: 'stored', query: 'release', channel: listed.channel },
        },
        { access }
      )) as { status: string; data: { hits: Array<Record<string, unknown>> } };
      expect(found.status).toBe('completed');
      expect(found.data.hits).toHaveLength(2);
      expect(found.data.hits[0]).toMatchObject({ channel: 'room-a', channelName: 'Room A' });
    } finally {
      await db.close();
    }
  });
});

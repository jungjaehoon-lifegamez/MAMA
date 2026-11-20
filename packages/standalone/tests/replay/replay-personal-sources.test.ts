import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readReplaySourceEvents } from '../../src/replay/replay-source-catalog.js';
import { coreIndexSink } from '../../src/runtime/connectors.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { personalConnectorName } from '../../src/runtime/personal-source-store.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('replay leaves personal sources out (#final review I4)', () => {
  it('never feeds a personal source to the common session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-personal-'));
    roots.push(root);
    const db = await openCoreDatabase({ path: join(root, 'state.db') });
    const at = Date.UTC(2026, 10, 20, 9);
    const sink = coreIndexSink(db.adapter);
    const item = (source: string, sourceId: string) => ({
      source,
      sourceId,
      channel: 'channel-a',
      author: 'someone',
      content: `content ${sourceId}`,
      timestamp: new Date(at),
      type: 'message' as const,
      observedAt: at,
    });
    const personal = personalConnectorName('person-a', 'slack');
    await sink('slack', [item('slack', 'common-1')]);
    await sink(personal, [
      { ...item(personal, 'mine-1'), memoryScopeKind: 'user', memoryScopeId: 'person-a' },
    ]);
    const events = readReplaySourceEvents(db.adapter, at - 1000, at + 1000, {
      timeZone: createTimeZoneSetting('UTC'),
    });
    expect(events.map((event) => event.connector)).toEqual(['slack']);
    await db.close();
  });
});

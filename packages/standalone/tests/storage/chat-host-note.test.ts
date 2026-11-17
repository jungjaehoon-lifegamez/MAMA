import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('host notes in the chat record', () => {
  it('keeps a host note as the host, never as an owner message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-host-note-'));
    homes.push(home);
    const db = await openCoreDatabase({ path: join(home, 'state.db') });
    const raw = new RawStore(join(home, 'raw'));
    const chat = new ChatSources(raw, db.adapter, 'owner', 'owner-agent');
    chat.saveHostNote({
      ref: 'host:approval:p1',
      occurredAt: 1_000,
      text: 'Approval p1 google.calendar.write — the client asked (proposed). Done: approved by owner-a.',
      metadata: { proposalId: 'p1' },
    });
    const rows = db.adapter
      .prepare(
        "SELECT author, channel, json_extract(metadata_json, '$.kind') AS kind FROM connector_event_index WHERE source_connector = 'chat' AND source_id = ?"
      )
      .all('host:approval:p1') as Array<{ author: string; channel: string; kind: string }>;
    // Each record's notes sit on a channel of its own, so one person's never reach another's reads.
    expect(rows).toEqual([{ author: 'host', channel: 'host:owner', kind: 'host_note' }]);
    expect(chat.hasOwnerMessage('host:approval:p1')).toBe(false);
    raw.close();
    await db.close();
  });
});

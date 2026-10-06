import { vi } from 'vitest';
import { join } from 'node:path';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createStimulusIntake } from '../../src/runtime/stimulus-delivery.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';

export async function chatFixture(root: string) {
  const database = await openCoreDatabase({ path: join(root, 'chat-state.db') });
  const raw = new RawStore(join(root, 'raw'));
  const mailbox = new Mailbox(database.adapter);
  const intake = createStimulusIntake(
    { mailbox, accept: (input) => ({ inputId: mailbox.enqueue(input)!, state: 'accepted' }) },
    'owner-test',
    new ChatSources(raw, database.adapter, 'owner-test', 'agent-test')
  );
  return {
    intake,
    mailbox,
    replies: () =>
      database.adapter
        .prepare(
          "SELECT author, content FROM connector_event_index WHERE source_connector = 'chat' AND json_extract(metadata_json, '$.kind') = 'reply' ORDER BY source_timestamp_ms, source_id"
        )
        .all(),
    failSave: () =>
      vi.spyOn(raw, 'save').mockImplementationOnce(() => {
        throw new Error('synthetic raw failure');
      }),
    failProjectionAck: () =>
      vi.spyOn(raw, 'acknowledgeProjection').mockImplementationOnce(() => {
        throw new Error('synthetic projection acknowledgement failure');
      }),
    close: async () => {
      raw.close();
      await database.close();
    },
  };
}

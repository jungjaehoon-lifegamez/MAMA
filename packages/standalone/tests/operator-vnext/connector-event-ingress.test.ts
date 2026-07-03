import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';

import {
  buildConnectorEventIngressPreview,
  buildConnectorOperatorCursorName,
  createConnectorEventIngressPreviewProvider,
  resolveConnectorEventIngressConfig,
} from '../../src/operator-vnext/connector-event-ingress.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

function insertRawEvent(
  db: SQLiteDatabase,
  overrides: {
    connector?: string;
    sourceId: string;
    channel?: string;
    content?: string;
    timestampMs: number;
  }
) {
  const connector = overrides.connector ?? 'slack';
  const channel = overrides.channel ?? 'C-ROLL';
  const eventIndexId = connectorEventIndexId(connector, overrides.sourceId);
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    connector,
    'message',
    overrides.sourceId,
    `${connector}:${channel}:${overrides.sourceId}`,
    channel,
    'synthetic-user',
    null,
    overrides.content ?? `synthetic public rollout event ${overrides.sourceId}`,
    overrides.timestampMs,
    new Date(overrides.timestampMs).toISOString().slice(0, 10),
    overrides.timestampMs,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 1),
    '2026-07-02T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  );
  return { event_index_id: eventIndexId };
}

describe('STORY-VNEXT-PR6-CONNECTOR-INGRESS: connector event dry-run ingress', () => {
  it('previews one connector/channel as source-linked primary operator events without commits', () => {
    const db = makeOperatorVNextDb();
    const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    insertRawEvent(db, {
      sourceId: 'msg-other-channel',
      channel: 'C-OTHER',
      timestampMs: 1710000000500,
    });
    const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
    insertRawEvent(db, {
      connector: 'discord',
      sourceId: 'discord-1',
      channel: 'D-ROLL',
      timestampMs: 1710000001500,
    });

    const preview = buildConnectorEventIngressPreview({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
      limit: 10,
    });

    expect(preview).toEqual({
      cursorName: 'connector:slack:channel:C-ROLL',
      connector: 'slack',
      channel: 'C-ROLL',
      advancedThroughSeq: 0,
      events: [
        {
          seq: 1,
          sourceRef: {
            kind: 'raw',
            connector: 'slack',
            id: first.event_index_id,
            source_id: 'msg-1',
            channel_id: 'C-ROLL',
          },
          eventIndexId: first.event_index_id,
          sourceTimestampMs: 1710000001000,
          sourceId: 'msg-1',
          channel: 'C-ROLL',
        },
        {
          seq: 2,
          sourceRef: {
            kind: 'raw',
            connector: 'slack',
            id: second.event_index_id,
            source_id: 'msg-2',
            channel_id: 'C-ROLL',
          },
          eventIndexId: second.event_index_id,
          sourceTimestampMs: 1710000002000,
          sourceId: 'msg-2',
          channel: 'C-ROLL',
        },
      ],
    });
    expect(countRows(db, 'vnext_operator_cursors')).toBe(0);
    expect(countRows(db, 'vnext_operator_commits')).toBe(0);
    expect(countRows(db, 'operator_no_updates')).toBe(0);

    db.close();
  });

  it('skips deterministic event seqs already advanced by the matching operator cursor', () => {
    const db = makeOperatorVNextDb();
    insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
    const third = insertRawEvent(db, { sourceId: 'msg-3', timestampMs: 1710000003000 });
    db.prepare(
      `INSERT INTO vnext_operator_cursors (
        cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
      ) VALUES (?, ?, ?, ?)`
    ).run(buildConnectorOperatorCursorName({ connector: 'slack', channel: 'C-ROLL' }), 1, null, 1);

    const preview = buildConnectorEventIngressPreview({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
    });

    expect(preview.advancedThroughSeq).toBe(1);
    expect(preview.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(preview.events.map((event) => event.eventIndexId)).toEqual([
      second.event_index_id,
      third.event_index_id,
    ]);

    db.close();
  });

  it('keeps late backfilled connector events behind the current cursor instead of renumbering them away', () => {
    const db = makeOperatorVNextDb();
    insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    db.prepare(
      `INSERT INTO vnext_operator_cursors (
        cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
      ) VALUES (?, ?, ?, ?)`
    ).run(buildConnectorOperatorCursorName({ connector: 'slack', channel: 'C-ROLL' }), 1, null, 1);
    const lateBackfill = insertRawEvent(db, {
      sourceId: 'msg-late-backfill',
      timestampMs: 1710000000000,
    });

    const preview = buildConnectorEventIngressPreview({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
    });

    expect(preview.advancedThroughSeq).toBe(1);
    expect(
      preview.events.map((event) => ({
        seq: event.seq,
        eventIndexId: event.eventIndexId,
        sourceTimestampMs: event.sourceTimestampMs,
      }))
    ).toEqual([
      {
        seq: 2,
        eventIndexId: lateBackfill.event_index_id,
        sourceTimestampMs: 1710000000000,
      },
    ]);

    db.close();
  });

  it('rejects broad connector previews unless a single explicit channel is supplied', () => {
    const db = makeOperatorVNextDb();

    expect(() =>
      buildConnectorEventIngressPreview({
        rawAdapter: db,
        operatorDb: db,
        connector: 'slack',
      })
    ).toThrow(/channel/i);

    db.close();
  });

  it('resolves explicit rollout config only when connector and channel are both supplied', () => {
    expect(resolveConnectorEventIngressConfig({})).toEqual({ enabled: false });
    expect(
      resolveConnectorEventIngressConfig({
        MAMA_VNEXT_INGRESS_CONNECTOR: ' slack ',
        MAMA_VNEXT_INGRESS_CHANNEL: ' C-ROLL ',
      })
    ).toEqual({
      enabled: true,
      connector: 'slack',
      channel: 'C-ROLL',
    });
    expect(() =>
      resolveConnectorEventIngressConfig({
        MAMA_VNEXT_INGRESS_CONNECTOR: 'slack',
      })
    ).toThrow(/channel/i);
  });

  it('creates a provider locked to the configured connector/channel', () => {
    const db = makeOperatorVNextDb();
    const event = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    const provider = createConnectorEventIngressPreviewProvider({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
    });

    expect(provider({ connector: 'slack', channel: 'C-ROLL' }).events[0]?.eventIndexId).toBe(
      event.event_index_id
    );
    expect(() => provider({ connector: 'slack', channel: 'C-OTHER' })).toThrow(
      /configured connector\/channel/i
    );

    db.close();
  });
});

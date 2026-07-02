import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';

import {
  buildConnectorIngressMigrationDryRun,
  createConnectorIngressMigrationDryRunProvider,
} from '../../src/operator-vnext/connector-ingress-migration-dry-run.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

function insertRawEvent(
  db: SQLiteDatabase,
  overrides: {
    sourceId: string;
    channel?: string;
    timestampMs: number;
  }
) {
  const channel = overrides.channel ?? 'C-ROLL';
  const eventIndexId = connectorEventIndexId('slack', overrides.sourceId);
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    'slack',
    'message',
    overrides.sourceId,
    `slack:${channel}:${overrides.sourceId}`,
    channel,
    'synthetic-user',
    null,
    `synthetic public migration dry-run event ${overrides.sourceId}`,
    overrides.timestampMs,
    new Date(overrides.timestampMs).toISOString().slice(0, 10),
    overrides.timestampMs,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 3),
    '2026-07-02T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  );
  return eventIndexId;
}

describe('STORY-VNEXT-PR7-INGRESS-MIGRATION-DRY-RUN: connector ingress migration dry-run', () => {
  it('reports source-linked migration candidates without durable writes', () => {
    const db = makeOperatorVNextDb();
    const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });

    const dryRun = buildConnectorIngressMigrationDryRun({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
      limit: 10,
    });

    expect(dryRun).toEqual({
      mode: 'dry_run',
      status: 'ready',
      cursorName: 'connector:slack:channel:C-ROLL',
      connector: 'slack',
      channel: 'C-ROLL',
      advancedThroughSeq: 0,
      candidateCount: 2,
      highestCandidateSeq: 2,
      requiresOperatorDecision: true,
      durableWrites: {
        commits: 0,
        cursors: 0,
        noUpdates: 0,
      },
      candidates: [
        {
          seq: 1,
          eventIndexId: first,
          sourceRef: {
            kind: 'raw',
            connector: 'slack',
            id: first,
            source_id: 'msg-1',
            channel_id: 'C-ROLL',
          },
          readiness: 'requires_decision',
        },
        {
          seq: 2,
          eventIndexId: second,
          sourceRef: {
            kind: 'raw',
            connector: 'slack',
            id: second,
            source_id: 'msg-2',
            channel_id: 'C-ROLL',
          },
          readiness: 'requires_decision',
        },
      ],
    });
    expect(countRows(db, 'vnext_operator_commits')).toBe(0);
    expect(countRows(db, 'vnext_operator_cursors')).toBe(0);
    expect(countRows(db, 'operator_no_updates')).toBe(0);

    db.close();
  });

  it('reports idle when no preview candidates exist', () => {
    const db = makeOperatorVNextDb();

    const dryRun = buildConnectorIngressMigrationDryRun({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
    });

    expect(dryRun).toMatchObject({
      mode: 'dry_run',
      status: 'idle',
      candidateCount: 0,
      highestCandidateSeq: null,
      requiresOperatorDecision: false,
      candidates: [],
    });

    db.close();
  });

  it('rejects non-positive and fractional dry-run limits', () => {
    const db = makeOperatorVNextDb();

    for (const limit of [0, -1, 0.5]) {
      expect(() =>
        buildConnectorIngressMigrationDryRun({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C-ROLL',
          limit,
        })
      ).toThrow(/limit must be a positive integer/);
    }

    db.close();
  });

  it('creates a provider locked to the configured connector/channel', () => {
    const db = makeOperatorVNextDb();
    insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
    const provider = createConnectorIngressMigrationDryRunProvider({
      rawAdapter: db,
      operatorDb: db,
      connector: 'slack',
      channel: 'C-ROLL',
    });

    expect(provider({ connector: 'slack', channel: 'C-ROLL' }).status).toBe('ready');
    expect(() => provider({ connector: 'slack', channel: 'C-OTHER' })).toThrow(
      /configured connector\/channel/i
    );

    db.close();
  });
});

/**
 * Resolving a cited event.
 *
 * `task_update` had no cause field, which is why 375 of 381 unattributed changes on the
 * live ledger are updates. Adding the field alone would not have helped: the agent sees
 * messages through tools that return the upstream's id, not the index's. Measured on live
 * data before building this - 266 of 300 recent bridge messages resolve exactly against
 * `(connector, source_id)`, and no suffix maps to more than one event - so the citation is
 * resolvable through a join rather than by equality with `event_index_id`.
 *
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolveCitation } from '../../src/evidence/cite.js';

let db: Database.Database;
const adapter = () => ({ prepare: (sql: string) => db.prepare(sql) }) as never;

const GRANT = { chat: ['C001'], board: ['b-1'] };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE connector_event_index (
    event_index_id TEXT PRIMARY KEY, source_connector TEXT NOT NULL,
    source_id TEXT NOT NULL, channel TEXT)`);
  const insert = db.prepare('INSERT INTO connector_event_index VALUES (?, ?, ?, ?)');
  insert.run('evt_granted', 'chat', 'C001:508638', 'C001');
  insert.run('evt_ungranted', 'chat', 'C999:1', 'C999');
  insert.run('evt_board', 'board', 'card-7', 'b-1');
  // A source id containing colons of its own - the shape the live bridge actually uses.
  insert.run('evt_colons', 'kagemusha', 'kakao:room-1:508640', 'kakao:room-1');
});

afterEach(() => db.close());

describe('resolveCitation', () => {
  it('resolves the index id a context packet carries', () => {
    expect(resolveCitation(adapter(), 'evt_granted', GRANT)).toEqual({
      status: 'resolved',
      eventIndexId: 'evt_granted',
      connector: 'chat',
      channel: 'C001',
    });
  });

  // The shape the message tools give: the upstream id, not the index's.
  it('resolves an upstream id through the connector join', () => {
    expect(resolveCitation(adapter(), 'chat:C001:508638', GRANT)).toMatchObject({
      status: 'resolved',
      eventIndexId: 'evt_granted',
    });
  });

  // Source ids contain colons; splitting anywhere but the first silently addresses a
  // different event, or nothing.
  it('splits on the first colon only', () => {
    expect(
      resolveCitation(adapter(), 'kagemusha:kakao:room-1:508640', {
        kagemusha: ['kakao:room-1'],
      })
    ).toMatchObject({ status: 'resolved', eventIndexId: 'evt_colons' });
  });

  // A citation must not out-read reading: naming an id must not attach a channel the
  // caller cannot read to a record it can.
  it('refuses an event outside the caller grant', () => {
    expect(resolveCitation(adapter(), 'evt_ungranted', GRANT)).toEqual({
      status: 'outside_grant',
    });
    expect(resolveCitation(adapter(), 'chat:C999:1', GRANT)).toEqual({ status: 'outside_grant' });
  });

  // Deliberately distinct from outside_grant: one says the agent invented an id, the other
  // says it named something real it may not see. Collapsing them hides which mistake it made.
  it('separates naming nothing from naming something forbidden', () => {
    expect(resolveCitation(adapter(), 'evt_does_not_exist', GRANT)).toEqual({
      status: 'unresolved',
    });
    expect(resolveCitation(adapter(), 'chat:no-such-source', GRANT)).toEqual({
      status: 'unresolved',
    });
  });

  it('treats an empty or shapeless citation as naming nothing', () => {
    for (const value of ['', '   ', 'no-colon-and-no-evt', ':leading', 'trailing:']) {
      expect(resolveCitation(adapter(), value, GRANT), value).toEqual({ status: 'unresolved' });
    }
  });

  // An empty grant reads nothing, so it can cite nothing.
  it('resolves nothing under an empty grant', () => {
    expect(resolveCitation(adapter(), 'evt_granted', {})).toEqual({ status: 'outside_grant' });
  });
});

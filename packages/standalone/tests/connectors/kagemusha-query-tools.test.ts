import { describe, expect, it } from 'vitest';
import { queryMessages } from '../../src/connectors/kagemusha/query-tools.js';

describe('Story R2: kagemusha query tools fail loud on bad arguments', () => {
  describe('AC #1: an unparseable since value throws instead of matching zero rows', () => {
    it('rejects a human phrase like "24h ago" before touching the database', () => {
      // Historic bug: new Date("24h ago") -> NaN, better-sqlite3 binds NaN and
      // created_at > NaN silently matches nothing -> {"success":true,messages:[]}.
      expect(() => queryMessages({ channelId: 'c1', since: '24h ago' })).toThrow(
        /since.*ISO-8601/i
      );
    });

    it('treats a JSON null since as absent (default window), not epoch 0', () => {
      // new Date(null) parses to epoch 0, which would silently match ALL history.
      // A null since must fall through to the default window - so validation must
      // not throw for it (the DB open failing later on CI is a different error).
      expect(() => queryMessages({ channelId: 'c1', since: null as unknown as string })).not.toThrow(
        /since.*ISO-8601/i
      );
    });
  });
});

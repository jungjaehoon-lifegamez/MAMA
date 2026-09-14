import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `initDB` must open the database once however many callers race for it. A
 * second open would create a second adapter and run migrations again on the
 * same file.
 *
 * The guard is two values read together - the stored handle and the in-flight
 * promise. An earlier version assigned the handle after awaiting, which left
 * one microtask where both read null. This counts opens instead of trying to
 * land inside that window: the invariant is what matters, and it is stable.
 */

const opens: string[] = [];

vi.mock('../../src/storage/database.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openDatabase: vi.fn(async () => {
      opens.push('open');
      // Yield twice so a racing caller has somewhere to land.
      await Promise.resolve();
      await Promise.resolve();
      return {
        adapter: { constructor: { name: 'FakeAdapter' } },
        connection: { id: opens.length },
        dbPath: '/tmp/fake.db',
        close: async () => {},
      };
    }),
  };
});

const { initDB, getAdapter, closeDB, resetDBState } = await import('../../src/db-manager.js');

describe('Story PR4C: initDB opens one database however many callers race', () => {
  beforeEach(() => {
    opens.length = 0;
    resetDBState({ disconnect: false });
  });

  afterEach(async () => {
    await closeDB();
  });

  describe('AC #1: concurrent callers share one open', () => {
    it('opens once for ten simultaneous callers', async () => {
      const connections = await Promise.all(Array.from({ length: 10 }, () => initDB()));

      expect(opens).toHaveLength(1);
      for (const connection of connections) {
        expect(connection).toBe(connections[0]);
      }
    });
  });

  describe('AC #2: a caller arriving as the first open settles does not open again', () => {
    // The window is a specific number of microtask turns after the first call:
    // late enough that the in-flight promise has been cleared, early enough
    // that the handle has not been stored yet. Storing the handle after the
    // await put that gap at depths 2 through 4, so the range is swept rather
    // than one lucky depth.
    for (let depth = 0; depth <= 6; depth++) {
      it(`opens once when a second caller arrives ${depth} microtasks in`, async () => {
        opens.length = 0;
        resetDBState({ disconnect: false });

        const first = initDB();
        let turn: Promise<unknown> = Promise.resolve();
        for (let i = 0; i < depth; i++) {
          turn = turn.then(() => {});
        }
        const second = turn.then(() => initDB());

        await Promise.all([first, second]);

        expect(opens).toHaveLength(1);
        expect(getAdapter().constructor.name).toBe('FakeAdapter');
      });
    }
  });

  describe('AC #3: the handle survives the promise being cleared', () => {
    it('answers getAdapter after the open settles', async () => {
      await initDB();
      expect(() => getAdapter()).not.toThrow();
    });
  });
});

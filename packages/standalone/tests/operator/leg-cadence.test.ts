/**
 * A silent leg pages the owner - after sunrise. On-time legs never page,
 * a page fires once per silence (across restarts), recovery reports once,
 * and quiet hours defer without dropping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { LegCadence } from '../../src/operator/leg-cadence.js';

describe('LegCadence', () => {
  let db: SQLiteDatabase;
  let t: number;
  let hour: number;

  const make = () =>
    new LegCadence(db, {
      now: () => t,
      hourOfDay: () => hour,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    t = 1_000_000;
    hour = 12; // daytime by default
  });

  it('an on-time leg never pages', () => {
    const legs = make();
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 1_500; // within 2x
    expect(legs.check()).toEqual({ pages: [], recoveries: [] });
  });

  it('a silent leg pages once, with how long it has been silent', () => {
    const legs = make();
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 2_501;
    const first = legs.check();
    expect(first.pages).toEqual([{ name: 'report', declaredCadenceMs: 1_000, silentForMs: 2_501 }]);
    // Still silent - no duplicate page.
    t += 5_000;
    expect(legs.check().pages).toEqual([]);
  });

  it('page suppression survives a restart (persisted, not in-memory)', () => {
    const legs = make();
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 3_000;
    expect(legs.check().pages).toHaveLength(1);
    // New instance over the same DB = daemon restart.
    const reborn = make();
    reborn.declare('report', 1_000);
    t += 1_000;
    expect(reborn.check().pages).toEqual([]);
  });

  it('recovery clears the page and reports exactly once', () => {
    const legs = make();
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 3_000;
    legs.check(); // paged
    legs.beat('report'); // the leg came back
    const recovered = legs.check();
    expect(recovered.recoveries).toEqual(['report']);
    expect(legs.check().recoveries).toEqual([]); // once
  });

  it('quiet hours defer the page - it fires after sunrise, not never', () => {
    const legs = make();
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 3_000;
    hour = 0; // midnight
    expect(legs.check().pages).toEqual([]); // deferred, not dropped
    hour = 9; // after sunrise
    expect(legs.check().pages).toHaveLength(1);
  });

  it('a non-wrapping quiet window defers inside and pages outside', () => {
    const legs = new LegCadence(db, {
      now: () => t,
      hourOfDay: () => hour,
      quietStartHour: 1,
      quietEndHour: 5,
    });
    legs.declare('report', 1_000);
    legs.beat('report');
    t += 3_000;
    hour = 3; // inside 01-05
    expect(legs.check().pages).toEqual([]);
    hour = 5; // boundary: end hour is exclusive - quiet is over
    expect(legs.check().pages).toHaveLength(1);
  });

  it('boot seeds the clock - a leg that never beats still pages eventually', () => {
    const legs = make();
    legs.declare('never-runs', 1_000);
    t += 2_001;
    expect(legs.check().pages).toHaveLength(1);
  });
});

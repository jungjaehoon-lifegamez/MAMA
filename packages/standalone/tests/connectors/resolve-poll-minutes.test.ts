import { describe, it, expect } from 'vitest';
import { resolvePollMinutes } from '../../src/cli/runtime/connector-init.js';

describe('resolvePollMinutes (M2.4 unified poll cadence)', () => {
  it('defaults to 60 when unset', () => {
    expect(resolvePollMinutes(undefined)).toBe(60);
  });

  it('defaults to 60 for an empty or whitespace string', () => {
    expect(resolvePollMinutes('')).toBe(60);
    expect(resolvePollMinutes('   ')).toBe(60);
  });

  it('parses a positive integer', () => {
    expect(resolvePollMinutes('30')).toBe(30);
    expect(resolvePollMinutes('1')).toBe(1);
  });

  it('parses a fractional value (short cadence for live verification)', () => {
    expect(resolvePollMinutes('0.25')).toBe(0.25);
  });

  it('throws on zero - no silent default (fail loud)', () => {
    expect(() => resolvePollMinutes('0')).toThrow(/MAMA_CONNECTOR_POLL_MINUTES/);
  });

  it('throws on a negative value', () => {
    expect(() => resolvePollMinutes('-5')).toThrow(/finite number > 0/);
  });

  it('throws on a non-numeric value', () => {
    expect(() => resolvePollMinutes('soon')).toThrow(/MAMA_CONNECTOR_POLL_MINUTES/);
  });

  it('throws on NaN and Infinity spellings', () => {
    expect(() => resolvePollMinutes('NaN')).toThrow();
    expect(() => resolvePollMinutes('Infinity')).toThrow();
  });
});

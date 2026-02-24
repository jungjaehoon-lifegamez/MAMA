import { describe, it, expect, beforeAll } from 'vitest';
import {
  countTokens,
  exceedsLimit,
  isEncoderActive,
  resetTokenEstimator,
  forceFallbackMode,
  initTokenEstimator,
} from '../../src/agent/token-estimator.js';

describe('TokenEstimator', () => {
  beforeAll(async () => {
    resetTokenEstimator();
    await initTokenEstimator();
  });

  it('returns positive count for non-empty text', () => {
    expect(countTokens('Hello world')).toBeGreaterThan(0);
  });

  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('handles Korean text', () => {
    expect(countTokens('안녕하세요 반갑습니다')).toBeGreaterThan(0);
  });

  it('uses real encoder (not fallback)', () => {
    expect(isEncoderActive()).toBe(true);
  });

  it('counts "Hello world" as roughly 2 tokens', () => {
    const count = countTokens('Hello world');
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('exceedsLimit works', () => {
    expect(exceedsLimit('Hello', 100)).toBe(false);
    expect(exceedsLimit('word '.repeat(10000), 5)).toBe(true);
  });

  it('counts 10K chars efficiently', () => {
    countTokens('warmup');
    const text = 'Hello world. '.repeat(800); // ~10K chars
    const start = performance.now();
    countTokens(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('fallback uses byte-length heuristic', () => {
    resetTokenEstimator();
    forceFallbackMode();
    expect(isEncoderActive()).toBe(false);
    expect(countTokens('Hello world')).toBe(5);
    expect(countTokens('안녕')).toBe(3);
  });
});

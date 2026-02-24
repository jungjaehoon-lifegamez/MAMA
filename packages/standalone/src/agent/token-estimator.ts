/**
 * TokenEstimator — singleton wrapper around js-tiktoken (cl100k_base).
 *
 * Provides accurate token counting for Korean + English text.
 * Falls back to byte-length heuristic if WASM init fails or during loading.
 *
 * Uses dynamic import to avoid blocking vitest fork initialization.
 */

interface TiktokenEncoder {
  encode(text: string): number[];
}

let _encoder: TiktokenEncoder | null = null;
let _initFailed = false;
let _initPromise: Promise<void> | null = null;

/**
 * Initialize the encoder asynchronously. Safe to call multiple times.
 */
export async function initTokenEstimator(): Promise<void> {
  if (_encoder || _initFailed) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { encodingForModel } = await import('js-tiktoken');
      _encoder = encodingForModel('gpt-4o');
    } catch {
      _initFailed = true;
    }
  })();

  return _initPromise;
}

function getEncoder(): TiktokenEncoder | null {
  if (!_encoder && !_initFailed && !_initPromise) {
    // Fire-and-forget init on first sync access
    initTokenEstimator().catch(() => {});
  }
  return _encoder;
}

/**
 * Byte-length fallback: ~0.4 tokens per byte (empirical for mixed CJK+Latin).
 */
function fallbackCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') * 0.4);
}

/**
 * Count tokens in text. Uses js-tiktoken if available, else byte fallback.
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    return enc.encode(text).length;
  }
  return fallbackCount(text);
}

/**
 * Check if text exceeds a token limit.
 */
export function exceedsLimit(text: string, limit: number): boolean {
  return countTokens(text) > limit;
}

/**
 * Check whether the real encoder is active (vs fallback).
 */
export function isEncoderActive(): boolean {
  return getEncoder() !== null;
}

/**
 * Reset singleton state (for testing).
 */
export function resetTokenEstimator(): void {
  _encoder = null;
  _initFailed = false;
}

/**
 * Force fallback mode (for testing).
 */
export function forceFallbackMode(): void {
  _encoder = null;
  _initFailed = true;
}

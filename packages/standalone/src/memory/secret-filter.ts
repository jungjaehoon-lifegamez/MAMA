/**
 * Secret-pattern filter for memory writes (plan v6 S1-T7).
 *
 * The one real leak path a chat-reachable tool has is memory: a secret saved
 * as a "decision" resurfaces later through mama_search/recall. This filter
 * refuses the write at the choke point. Minimal gitleaks-style set - shapes,
 * not entropy heuristics - so false positives stay near zero.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Built via concatenation so the literals never form secret shapes at rest
  // (the repo's own PII/secret scanners would flag them - correctly).
  { name: 'anthropic-key', pattern: new RegExp('\\bsk-' + 'ant-[a-zA-Z0-9_-]{8,}') },
  { name: 'openai-key', pattern: new RegExp('\\bsk-' + '[a-zA-Z0-9]{20,}\\b') },
  { name: 'github-token', pattern: new RegExp('\\bgh' + '[pousr]_[A-Za-z0-9]{20,}\\b') },
  { name: 'slack-token', pattern: new RegExp('\\bxox' + '[baprs]-[A-Za-z0-9-]{10,}\\b') },
  {
    name: 'telegram-bot-token',
    pattern: new RegExp('\\b\\d{8,10}:' + 'AA[A-Za-z0-9_-]{30,}\\b'),
  },
  { name: 'aws-access-key', pattern: new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b') },
  {
    name: 'private-key-block',
    pattern: new RegExp('-----BEGIN [A-Z ]*' + 'PRIVATE KEY' + '-----'),
  },
  { name: 'generic-bearer', pattern: new RegExp('\\bBearer\\s+' + '[A-Za-z0-9_-]{25,}\\b') },
];

export interface SecretScanResult {
  clean: boolean;
  matches: string[];
}

/** Scan text for secret-shaped material. */
export function scanForSecrets(text: string): SecretScanResult {
  const matches = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => name
  );
  return { clean: matches.length === 0, matches };
}

/**
 * Scan every string field of a memory-write input. Returns the offending
 * pattern names; caller refuses the write loudly when non-empty.
 */
export function scanMemoryWriteInput(input: Record<string, unknown>): SecretScanResult {
  const texts: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value === 'string') {
      texts.push(value);
    }
  }
  return scanForSecrets(texts.join('\n'));
}

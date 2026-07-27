/**
 * Source-guard: the self-healing session-reset allowlist keeps its error
 * classes. Each class is a live-incident scar; losing one silently turns a
 * recoverable failure back into a permanently broken chat session.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('session reset error classes (self-healing allowlist)', () => {
  const source = readFileSync(join(__dirname, '../../src/agent/agent-loop.ts'), 'utf-8');

  it('keeps every recoverable class, including the corrupt-transcript API 400', () => {
    // 2026-07-27: sonnet emitted an empty thinking block, the claude CLI
    // persisted it, and every replay of that session died with this API 400 -
    // the owner chat was bricked until a manual daemon restart. A fresh
    // session is the only cure, so the class must stay reset-eligible.
    expect(source).toContain("'text content blocks must be non-empty'");
    expect(source).toContain('No conversation found with session ID');
    expect(source).toContain('is already in use');
    expect(source).toContain('context_length_exceeded');
    expect(source).toMatch(/isCorruptTranscript/);
    // The class participates in the claude-side reset condition.
    expect(source).toMatch(
      /isSessionNotFound \|\| isSessionInUse \|\| isPromptTooLong \|\| isCorruptTranscript/
    );
  });
});

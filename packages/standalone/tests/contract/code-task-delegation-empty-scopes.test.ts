import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

describe('code-task delegation envelope', () => {
  const p5WiringMarker = join(TEST_DIR, '..', '..', 'src', 'multi-agent', 'delegate-envelope.ts');

  it('keeps code-task delegation envelope wiring outside M1R', () => {
    expect(existsSync(p5WiringMarker)).toBe(false);
  });
});

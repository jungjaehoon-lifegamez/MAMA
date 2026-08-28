import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const postinstallPath = join(here, '../../scripts/postinstall.js');

describe('Story ONB-8: postinstall points at the self-teaching CLI', () => {
  it('never sends a new install to the retired setup wizard', () => {
    const source = readFileSync(postinstallPath, 'utf8');

    expect(source).toContain('mama --help');
    expect(source).toContain('mama status');
    expect(source).not.toMatch(/mama setup|setup wizard/i);
  });
});

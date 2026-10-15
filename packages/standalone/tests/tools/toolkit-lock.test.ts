import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const toolkit = join(__dirname, '../../toolkit');
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

describe('document toolkit lock', () => {
  it('pins every requested package with hashes and records the command that made it', () => {
    const lock = readFileSync(join(toolkit, 'requirements.lock'), 'utf8');
    const requested = readFileSync(join(toolkit, 'requirements.in'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(normalize);
    const pins = new Map<string, string>();
    for (const block of lock.split(/\n(?=[a-z0-9])/i)) {
      const match = /^([A-Za-z0-9_.-]+)==(\S+)/.exec(block);
      if (match) pins.set(normalize(match[1]!), block);
    }
    expect(requested).toEqual(expect.arrayContaining(['numpy', 'pandas', 'matplotlib']));
    for (const name of requested) {
      expect(pins.has(name), name).toBe(true);
      expect(pins.get(name)).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    }
    for (const [name, block] of pins) expect(block, name).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(lock).toMatch(/^#\s+uv pip compile requirements\.in --generate-hashes/m);
  });
});

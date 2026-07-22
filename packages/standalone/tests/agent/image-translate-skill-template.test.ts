import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('image translation skill template', () => {
  const templatePath = join(process.cwd(), 'templates', 'skills', 'image-translate.md');

  it('allows the agent to compose tools when the requested outcome includes side effects', () => {
    const template = readFileSync(templatePath, 'utf8');

    expect(template).toContain('\uC694\uCCAD\uD55C \uCD5C\uC885 \uACB0\uACFC');
    expect(template).toContain('\uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uB3C4\uAD6C\uB97C \uC870\uD569');
    expect(template).toContain('\uC131\uACF5 \uC751\uB2F5\uC744 \uD655\uC778');
    expect(template).toContain('[\uD310\uB3C5 \uBD88\uAC00]');
    expect(template).toContain('\uBD80\uBD84 \uC2E4\uD328');
    expect(template).not.toContain('\uB3C4\uAD6C \uC0AC\uC6A9 \uAE08\uC9C0');
  });
});

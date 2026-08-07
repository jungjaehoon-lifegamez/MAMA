import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeReportHtml } from '../../ui/src/api/sanitize';

/**
 * Layer 1 of the slot-HTML XSS defence (layer 2 is the script-src 'self' CSP
 * on the /ui document). DOMPurify needs a real DOM, and this suite runs in the
 * node environment the vitest config pins - no jsdom is available, and adding
 * one is out of scope. So this file pins the two things that ARE testable here:
 *
 *  1. the fail-closed contract: with no DOM, sanitizeReportHtml returns an
 *     empty string and never the raw input (DOMPurify's own fallback returns
 *     the input unchanged, which is exactly the hole the wrapper closes);
 *  2. the sanitizer configuration the browser build runs with.
 *
 * The stripping behaviour itself (script tags, on* handlers, javascript: URLs)
 * is DOMPurify's own, exercised by its test suite under a DOM.
 */
const HOSTILE = [
  '<script>alert(1)</script>',
  '<b onclick="steal()">click</b>',
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">go</a>',
  '<iframe src="https://evil.example"></iframe>',
];

describe('sanitizeReportHtml: fail-closed without a DOM', () => {
  it('confirms this environment has no DOM for DOMPurify', () => {
    expect(typeof globalThis.window).toBe('undefined');
  });

  it('returns an empty string rather than raw markup', () => {
    for (const html of HOSTILE) {
      expect(sanitizeReportHtml(html), html).toBe('');
    }
    expect(sanitizeReportHtml('<p>benign</p>')).toBe('');
  });

  it('never echoes attacker-influenceable input back to the caller', () => {
    for (const html of HOSTILE) {
      expect(sanitizeReportHtml(html), html).not.toContain('<script');
      expect(sanitizeReportHtml(html), html).not.toContain('onerror');
      expect(sanitizeReportHtml(html), html).not.toContain('javascript:');
    }
  });
});

describe('sanitizeReportHtml: browser configuration', () => {
  const source = readFileSync(join(process.cwd(), 'ui', 'src', 'api', 'sanitize.ts'), 'utf8');

  it('forbids script-bearing and document-scope tags', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base']) {
      expect(source, tag).toContain(`'${tag}'`);
    }
    expect(source).toContain('ALLOW_DATA_ATTR: false');
    expect(source).toContain('USE_PROFILES: { html: true }');
  });

  it('guards the unsupported path before calling into DOMPurify', () => {
    expect(source).toContain('DOMPurify.isSupported');
    expect(source).toMatch(/return '';/);
  });
});

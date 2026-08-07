import DOMPurify from 'dompurify';

/**
 * Slot HTML is attacker-influenceable (a prompt-injected agent can emit hostile
 * markup), so sanitize with DOMPurify at render. Second, independent layer:
 * the script-src 'self' CSP set on the /ui document by graph-api.
 */
export function sanitizeReportHtml(html: string): string {
  // DOMPurify needs a real DOM. Where there is none (node, SSR, a stripped
  // environment) it is not merely inert - its own fallback returns the input
  // unchanged. Refuse instead: an unsanitizable slot renders as nothing, never
  // as raw attacker-influenceable markup.
  if (!DOMPurify.isSupported || typeof DOMPurify.sanitize !== 'function') {
    return '';
  }
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
  });
}

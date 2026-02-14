/**
 * Safe markdown rendering utilities.
 */

/* eslint-env browser */

import { escapeHtml } from './dom.js';

const MARKDOWN_PARSE_OPTIONS = {} as const;

/**
 * Render markdown string to HTML and sanitize.
 *
 * - Uses `marked.parse` when available.
 * - Falls back to plain text rendering when markdown parser is unavailable.
 * - Applies DOMPurify when available; otherwise returns parser output as-is.
 */
export function renderSafeMarkdown(markdown: string): string {
  if (!markdown) {
    return '';
  }

  const markdownText = String(markdown);

  let html: string;
  try {
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
      html = marked.parse(markdownText, MARKDOWN_PARSE_OPTIONS);
    } else {
      throw new Error('marked not available');
    }
  } catch {
    const fallback = escapeHtml(markdownText);
    html = fallback.replace(/\n/g, '<br/>');
  }

  if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
    return DOMPurify.sanitize(html);
  }

  if (typeof console !== 'undefined') {
    console.warn('[SafeMarkdown] DOMPurify is unavailable. Rendering escaped content as fallback.');
  }
  const safeFallback = escapeHtml(markdownText).replace(/\\n/g, '<br/>');
  return safeFallback;
}

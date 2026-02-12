// DOM utility functions
/* eslint-env browser */

/**
 * Escape HTML entities for content insertion
 * @param {string} text - Text to escape
 * @returns {string} HTML-escaped text
 */
export function escapeHtml(text) {
  if (!text) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape text for safe use in HTML attributes
 * Escapes quotes in addition to HTML entities
 * @param {string} text - Text to escape
 * @returns {string} Attribute-safe escaped text
 */
export function escapeAttr(text) {
  if (!text) {
    return '';
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create element with safe attributes
 * @param {string} tagName - HTML tag name
 * @param {Object} attributes - Attributes to set
 * @param {string} textContent - Text content
 * @returns {HTMLElement} Created element
 */
export function createElement(tagName, attributes = {}, textContent = '') {
  const element = document.createElement(tagName);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
}

/**
 * Add event listener with cleanup
 * @param {Element} element - Target element
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {Function} Cleanup function
 */
export function addListener(element, event, handler) {
  element.addEventListener(event, handler);
  return () => element.removeEventListener(event, handler);
}

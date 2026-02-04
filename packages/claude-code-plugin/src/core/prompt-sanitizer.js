/**
 * Prompt Sanitizer
 *
 * Source of truth: packages/claude-code-plugin/src/core/prompt-sanitizer.js
 * Sanitizes untrusted data before injection into LLM prompts.
 * Prevents prompt injection attacks by escaping special characters.
 *
 * @module prompt-sanitizer
 */

/**
 * Sanitize untrusted data for prompt injection
 * Escapes special characters that could break prompt structure
 *
 * Use cases:
 * - User input (topics, decisions, reasoning)
 * - Database-retrieved content (decision history)
 * - File paths, git author names
 * - Any external data used in template literals
 *
 * Security note: This prevents:
 * - Template literal injection: ${malicious.code}
 * - Code block escaping: `dangerous` code `
 * - Markdown injection: **Bold** or [links](javascript:alert())
 *
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text safe for LLM prompts
 *
 * @example
 * const { sanitizeForPrompt } = require('./prompt-sanitizer');
 *
 * // Sanitize user input
 * const safeTopic = sanitizeForPrompt(userInput.topic);
 * const message = `Topic: ${safeTopic}`;
 *
 * // Sanitize database content
 * const safeDecision = sanitizeForPrompt(decision.decision);
 * const output = `Decision: ${safeDecision}`;
 */
function sanitizeForPrompt(text) {
  if (text === null || text === undefined) {
    return '';
  }

  // Convert to string if needed
  const str = typeof text === 'string' ? text : String(text);

  return str
    .replace(/\\/g, '\\\\') // Escape backslashes first (order matters!)
    .replace(/`/g, '\\`') // Escape backticks (code blocks)
    .replace(/\$/g, '\\$') // Escape dollar signs (template literals)
    .replace(/\{/g, '\\{') // Escape opening braces (template literals)
    .replace(/\}/g, '\\}'); // Escape closing braces (template literals)
}

/**
 * Sanitize multiple fields in an object
 * Useful for batch sanitization of decision objects
 *
 * @param {Object} obj - Object with fields to sanitize
 * @param {Array<string>} fields - Field names to sanitize
 * @returns {Object} New object with sanitized fields
 *
 * @example
 * const safeDecision = sanitizeFields(decision, ['topic', 'decision', 'reasoning']);
 * const message = `Topic: ${safeDecision.topic}\nDecision: ${safeDecision.decision}`;
 */
function sanitizeFields(obj, fields) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const sanitized = { ...obj };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
      if (sanitized[field] === null || sanitized[field] === undefined) {
        continue;
      }
      sanitized[field] = sanitizeForPrompt(sanitized[field]);
    }
  }
  return sanitized;
}

module.exports = {
  sanitizeForPrompt,
  sanitizeFields,
};

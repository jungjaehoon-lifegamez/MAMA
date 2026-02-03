/**
 * Formatting Utility Functions
 * @module utils/format
 * @version 1.0.0
 */

/* eslint-env browser */

/**
 * Format message timestamp
 * @param {Date} date - Date object
 * @returns {string} Formatted time (HH:MM)
 */
export function formatMessageTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format checkpoint timestamp
 * @param {string|Date} timestamp - Timestamp
 * @returns {string} Formatted relative time
 */
export function formatCheckpointTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }

  return (
    date.toLocaleDateString() +
    ' ' +
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

/**
 * Format relative time
 * @param {string|Date} timestamp - Timestamp
 * @returns {string} Relative time string
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return '';
  }

  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) {
    return 'Just now';
  }
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }

  return date.toLocaleDateString();
}

/**
 * Truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
export function truncateText(text, maxLength) {
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

/**
 * Extract first meaningful line from text
 * @param {string} text - Text to extract from
 * @returns {string} First meaningful line
 */
export function extractFirstLine(text) {
  if (!text) {
    return 'No summary';
  }
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('**'));
  return lines[0] || text.substring(0, 100);
}

/**
 * Format assistant message with markdown support
 * @param {string} text - Text to format
 * @returns {string} Formatted HTML
 */
export function formatAssistantMessage(text) {
  if (!text) {
    return '';
  }

  // First escape HTML to prevent XSS
  let formatted = escapeHtmlForMarkdown(text);

  // Detect and wrap checkpoint/context sections in collapsible
  formatted = wrapCheckpointSections(formatted);

  // Code blocks with optional language (```js ... ```)
  formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre class="code-block"><code${langClass}>${code.trim()}</code></pre>`;
  });

  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (avoiding conflicts with bold)
  formatted = formatted.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Links: [text](url)
  formatted = formatted.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Auto-detect URLs (not already in anchor tags)
  formatted = formatted.replace(
    /(?<!href="|>)(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Headers (## and ###)
  formatted = formatted.replace(
    /^### (.+)$/gm,
    '<h4 class="text-sm font-semibold mt-2 mb-1">$1</h4>'
  );
  formatted = formatted.replace(
    /^## (.+)$/gm,
    '<h3 class="text-base font-semibold mt-3 mb-1">$1</h3>'
  );

  // Bullet lists (- item)
  formatted = formatted.replace(/^- (.+)$/gm, '<li class="ml-4">• $1</li>');

  // Quiz choices as buttons - patterns like **A)** text or A) text
  // Also handles blockquote prefix (> or &gt;)
  // Match patterns: A) text, **A)** text, > A) text, etc.
  formatted = formatted.replace(
    /^(?:&gt;\s*)?(?:<strong>)?([A-D])\)(?:<\/strong>)?\s*(.+)$/gim,
    (match, letter, text) => {
      const upperLetter = letter.toUpperCase();
      return `<button class="quiz-choice-btn" data-choice="${upperLetter}" onclick="window.sendQuizChoice('${upperLetter}')">${upperLetter}) ${text.trim()}</button>`;
    }
  );

  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');

  // Clean up multiple <br> in lists
  formatted = formatted.replace(/<\/li><br><li/g, '</li><li');

  // Clean up <br> before/after quiz buttons
  formatted = formatted.replace(/<br>(<button class="quiz-choice-btn")/g, '$1');
  formatted = formatted.replace(/(<\/button>)<br>/g, '$1');

  return formatted;
}

/**
 * Escape HTML for markdown processing
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtmlForMarkdown(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Wrap checkpoint/context sections in collapsible elements
 * Detects patterns like "📍 Summary", "🎯 Goal", "Recent decisions", etc.
 * @param {string} text - Text to process
 * @returns {string} Text with collapsible sections
 */
function wrapCheckpointSections(text) {
  // Pattern to detect checkpoint section start
  // Matches: "📍 Summary", "🎯 Goal", "📍 **Last Checkpoint**", etc.
  const checkpointStartPatterns = [
    /^(📍\s*\*?\*?Summary of past work|📍\s*\*?\*?Last Checkpoint)/m,
    /^(🎯\s*Goal)/m,
  ];

  // Check if this message contains a checkpoint section
  const hasCheckpoint = checkpointStartPatterns.some((p) => p.test(text));
  if (!hasCheckpoint) {
    return text;
  }

  // Find the checkpoint section boundaries
  // It typically starts with "📍" and ends before "---" or end of message
  const checkpointMatch = text.match(/(📍[\s\S]*?)(?=\n---\n🚀|\n---\n\n🚀|---\n\n🚀|$)/);

  if (!checkpointMatch) {
    return text;
  }

  const checkpointContent = checkpointMatch[1];
  const uniqueId = 'cp-' + Math.random().toString(36).substr(2, 9);

  // Create collapsible wrapper - summary must be first child (no newlines before it)
  const collapsibleHtml =
    `<details class="checkpoint-collapse" id="${uniqueId}">` +
    `<summary class="checkpoint-summary">📍 Session Context <span class="collapse-hint">(tap to expand)</span></summary>` +
    `<div class="checkpoint-content">${checkpointContent}</div>` +
    `</details>`;

  // Replace the checkpoint content with collapsible version
  return text.replace(checkpointContent, collapsibleHtml);
}

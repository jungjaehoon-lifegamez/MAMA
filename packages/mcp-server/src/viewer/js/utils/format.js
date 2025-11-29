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

  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');

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

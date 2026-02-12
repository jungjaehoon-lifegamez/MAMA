/**
 * Formatting Utility Functions
 * @module utils/format
 * @version 1.1.0
 */

/* eslint-env browser */

/**
 * Known Claude model name mappings
 */
const MODEL_NAMES = {
  'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
  'claude-opus-4-20250514': 'Claude 4 Opus',
  'claude-opus-4-5-20251101': 'Claude 4.5 Opus',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-opus-20240229': 'Claude 3 Opus',
  'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
  'claude-3-haiku-20240307': 'Claude 3 Haiku',
};

/**
 * Get human-friendly model name from model ID
 * @param {string} model - Model ID (e.g., 'claude-sonnet-4-20250514')
 * @returns {string} Human-friendly name (e.g., 'Claude 4 Sonnet')
 */
export function formatModelName(model) {
  if (!model || model === 'default') {
    return 'Default';
  }

  // Check known model mappings
  if (MODEL_NAMES[model]) {
    return MODEL_NAMES[model];
  }

  // Try to extract friendly name from model string
  if (model.includes('opus')) {
    return 'Claude Opus';
  }
  if (model.includes('sonnet')) {
    return 'Claude Sonnet';
  }
  if (model.includes('haiku')) {
    return 'Claude Haiku';
  }

  return model;
}

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

  // Detect outbound media file paths (e.g. ~/.mama/workspace/media/outbound/file.png)
  // Helper: build safe media HTML from captured filename
  const buildMediaHtml = (filename) => {
    const safeName = encodeURIComponent(filename);
    const safeAlt = escapeHtmlForMarkdown(filename);
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    if (imgExts.includes(ext)) {
      return `<div class="media-inline"><img src="/api/media/${safeName}" class="max-w-[300px] rounded-lg my-1 cursor-pointer" onclick="openLightbox('/api/media/${safeName}')" alt="${safeAlt}"/><a href="/api/media/download/${safeName}" class="text-xs text-blue-500 hover:underline block">Download ${safeAlt}</a></div>`;
    }
    return `<a href="/api/media/download/${safeName}" class="text-blue-500 hover:underline">Download ${safeAlt}</a>`;
  };

  // First: strip any <a> wrappers around media paths (from markdown link handler)
  formatted = formatted.replace(
    /<a\s+href="(?:~\/\.mama\/workspace\/media\/(?:outbound|inbound)\/|\/home\/[^/]+\/\.mama\/workspace\/media\/(?:outbound|inbound)\/)([^"]+)"[^>]*>[^<]*<\/a>/gi,
    (match, filename) => buildMediaHtml(filename)
  );
  // Then: handle bare media paths not already inside HTML tags
  formatted = formatted.replace(
    /(?<!href="|src=")(?:~\/\.mama\/workspace\/media\/(?:outbound|inbound)\/|\/home\/[^/]+\/\.mama\/workspace\/media\/(?:outbound|inbound)\/)([^\s<"']+\.(png|jpg|jpeg|gif|webp|svg|pdf))/gi,
    (match, filename) => buildMediaHtml(filename)
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

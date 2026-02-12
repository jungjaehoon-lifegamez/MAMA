/**
 * DOM Utility Functions
 * @module utils/dom
 * @version 1.0.0
 */

/* eslint-env browser */

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
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
 * Debounce function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Show toast notification
 * @param {string} message - Message to display
 * @param {number} duration - Duration in milliseconds
 */
export function showToast(message, duration = 3000) {
  // Remove existing toast
  const existingToast = document.querySelector('.toast-notification');
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  // Auto-remove
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Scroll element to bottom
 * @param {HTMLElement} container - Container to scroll
 */
export function scrollToBottom(container) {
  // Use setTimeout to ensure DOM has updated before scrolling
  const doScroll = () => {
    container.scrollTop = container.scrollHeight;
    if (container.scrollTo) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    }
  };
  setTimeout(doScroll, 50);
  requestAnimationFrame(doScroll);
}

/**
 * Auto-resize textarea to fit content
 * @param {HTMLTextAreaElement} textarea - Textarea element
 * @param {number} maxRows - Maximum number of rows (default: 5)
 */
export function autoResizeTextarea(textarea, maxRows = 5) {
  textarea.style.height = 'auto';
  const lineHeight = parseInt(getComputedStyle(textarea).lineHeight);
  const maxHeight = lineHeight * maxRows;
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = newHeight + 'px';
}

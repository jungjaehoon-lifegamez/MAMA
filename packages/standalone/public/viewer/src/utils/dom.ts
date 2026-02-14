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
export function escapeHtml(text: string | null | undefined): string {
  if (!text) {
    return '';
  }
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape HTML for use in attribute values (also escapes quotes)
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for HTML attributes
 */
export function escapeAttr(text: string | null | undefined): string {
  if (!text) {
    return '';
  }
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Get DOM element by id with typed generic casting
 * @param {string} id - Element id
 * @returns {T | null} Matched element or null
 */
export function getElementByIdOrNull<T extends Element>(id: string): T | null {
  const element = document.getElementById(id);
  return element ? (element as unknown as T) : null;
}

/**
 * Normalize error values to a safe message string
 * @param error - Unknown thrown value
 * @returns {string} Error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Debounce function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return function executedFunction(...args) {
    const later = () => {
      timeout = undefined;
      func(...args);
    };
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

/**
 * Show toast notification
 * @param {string} message - Message to display
 * @param {number} duration - Duration in milliseconds
 */
export function showToast(message: string, duration = 3000): void {
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
export function scrollToBottom(container: HTMLElement): void {
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
export function autoResizeTextarea(textarea: HTMLTextAreaElement, maxRows = 5): void {
  textarea.style.height = 'auto';
  const computedLineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
  const lineHeight =
    Number.isFinite(computedLineHeight) && computedLineHeight > 0 ? computedLineHeight : 20;
  const maxHeight = lineHeight * maxRows;
  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = newHeight + 'px';
}

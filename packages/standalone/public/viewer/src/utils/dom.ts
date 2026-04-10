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
  // Use requestAnimationFrame to batch layout read/write and avoid forced reflow
  requestAnimationFrame(() => {
    const scrollHeight = container.scrollHeight; // Single read
    container.scrollTop = scrollHeight; // Single write
  });
}

/**
 * Auto-resize textarea to fit content
 * @param {HTMLTextAreaElement} textarea - Textarea element
 * @param {number} maxRows - Maximum number of rows (default: 5)
 */
export function autoResizeTextarea(textarea: HTMLTextAreaElement, maxRows = 5): void {
  // Use requestAnimationFrame to defer resize to the next frame, avoiding layout thrash from rapid input events
  requestAnimationFrame(() => {
    textarea.style.height = 'auto'; // Reset height before measuring
    const computedLineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight); // Forces reflow (unavoidable)
    const scrollHeight = textarea.scrollHeight;
    const lineHeight =
      Number.isFinite(computedLineHeight) && computedLineHeight > 0 ? computedLineHeight : 20;
    const maxHeight = lineHeight * maxRows;
    const newHeight = Math.min(scrollHeight, maxHeight);
    textarea.style.height = newHeight + 'px';
  });
}

// ── Collapsible Section Helper ─────────────────────────────────────────────

/**
 * Create a collapsible section with toggle heading.
 * The heading shows a triangle indicator that rotates on expand/collapse.
 * State is persisted to localStorage using the provided storageKey.
 *
 * @param heading - Text for the section heading
 * @param contentHtml - Inner HTML for the collapsible body
 * @param options - Configuration options
 * @returns The root container element
 */
export function createCollapsible(
  heading: string,
  contentHtml: string,
  options: {
    storageKey: string;
    defaultOpen?: boolean;
    headingStyle?: string;
    containerStyle?: string;
  }
): HTMLElement {
  const { storageKey, defaultOpen = true, headingStyle = '', containerStyle = '' } = options;

  const stored = localStorage.getItem(storageKey);
  let isOpen = stored !== null ? stored === 'true' : defaultOpen;

  const wrapper = document.createElement('div');
  if (containerStyle) wrapper.setAttribute('style', containerStyle);

  const headerEl = document.createElement('div');
  headerEl.setAttribute(
    'style',
    'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;' + headingStyle
  );

  const arrow = document.createElement('span');
  arrow.setAttribute(
    'style',
    'display:inline-block;font-size:10px;width:12px;transition:transform 0.15s;color:#9E9891'
  );
  arrow.textContent = isOpen ? '\u25BC' : '\u25B6';

  const label = document.createElement('span');
  label.textContent = heading;

  headerEl.appendChild(arrow);
  headerEl.appendChild(label);

  const body = document.createElement('div');
  body.innerHTML = contentHtml;
  body.style.display = isOpen ? '' : 'none';

  headerEl.addEventListener('click', () => {
    isOpen = !isOpen;
    arrow.textContent = isOpen ? '\u25BC' : '\u25B6';
    body.style.display = isOpen ? '' : 'none';
    localStorage.setItem(storageKey, String(isOpen));
  });

  wrapper.appendChild(headerEl);
  wrapper.appendChild(body);
  return wrapper;
}

// ── Resizable Panel Helper ─────────────────────────────────────────────────

/**
 * Create a draggable resize handle on the right edge of a panel.
 * The handle is 4px wide with cursor:col-resize.
 * Width is persisted to localStorage using the provided storageKey.
 *
 * @param panel - The panel element to make resizable
 * @param options - Configuration options
 * @returns The handle element (already appended to the panel)
 */
export function createResizeHandle(
  panel: HTMLElement,
  options: {
    storageKey: string;
    minWidth?: number;
    maxWidth?: number;
  }
): HTMLElement {
  const { storageKey, minWidth = 100, maxWidth = 600 } = options;

  // Restore saved width
  const savedWidth = localStorage.getItem(storageKey);
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= minWidth && w <= maxWidth) {
      panel.style.width = w + 'px';
      panel.style.minWidth = w + 'px';
    }
  }

  // Ensure panel has relative positioning for the handle
  panel.style.position = 'relative';

  const handle = document.createElement('div');
  handle.setAttribute(
    'style',
    'position:absolute;top:0;right:0;width:4px;height:100%;cursor:col-resize;background:transparent;z-index:10'
  );

  handle.addEventListener('mouseenter', () => {
    handle.style.background = '#EDE9E1';
  });
  handle.addEventListener('mouseleave', () => {
    if (!isDragging) handle.style.background = 'transparent';
  });

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
    panel.style.width = newWidth + 'px';
    panel.style.minWidth = newWidth + 'px';
    e.preventDefault();
  };

  const onMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    handle.style.background = 'transparent';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(storageKey, String(parseInt(panel.style.width, 10)));
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.style.background = '#EDE9E1';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  panel.appendChild(handle);
  return handle;
}

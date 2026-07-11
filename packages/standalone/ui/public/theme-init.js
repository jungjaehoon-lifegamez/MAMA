/* global localStorage, window, document */
(function () {
  let theme = null;
  try {
    // Keep in sync with THEME_STORAGE_KEY in src/lib/theme.ts.
    const stored = localStorage.getItem('mama-ui-theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    }
  } catch (_error) {
    theme = null;
  }
  if (!theme) {
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();

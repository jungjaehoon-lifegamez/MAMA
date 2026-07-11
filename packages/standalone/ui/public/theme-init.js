/* global localStorage, window, document */
(function () {
  let theme = null;
  try {
    const stored = localStorage.getItem('mama-ui-theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    }
  } catch (_error) {
    theme = null;
  }
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();

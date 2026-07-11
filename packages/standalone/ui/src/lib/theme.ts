export const THEME_STORAGE_KEY = 'mama-ui-theme';

export type Theme = 'light' | 'dark';

export interface ThemeStorageReader {
  getItem(key: string): string | null;
}

export interface ThemeTarget {
  dataset: Record<string, string> | DOMStringMap;
}

export function getStoredTheme(storage: ThemeStorageReader): Theme | null {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function resolveTheme(storedTheme: Theme | null, prefersDark: boolean): Theme {
  return storedTheme ?? (prefersDark ? 'dark' : 'light');
}

export function applyTheme(theme: Theme, target: ThemeTarget): void {
  target.dataset.theme = theme;
}

export function toggleTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light';
}

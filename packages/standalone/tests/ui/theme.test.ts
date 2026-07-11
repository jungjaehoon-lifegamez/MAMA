import { describe, expect, it } from 'vitest';
import { applyTheme, getStoredTheme, resolveTheme, toggleTheme } from '../../ui/src/lib/theme';

describe('getStoredTheme', () => {
  it('returns a supported stored theme', () => {
    expect(getStoredTheme({ getItem: () => 'dark' })).toBe('dark');
  });

  it('ignores unsupported stored values', () => {
    expect(getStoredTheme({ getItem: () => 'system' })).toBeNull();
  });

  it('returns null when storage access throws', () => {
    expect(
      getStoredTheme({
        getItem: () => {
          throw new Error('storage blocked');
        },
      })
    ).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('prefers the stored theme over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('uses the system preference when no theme is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('sets the theme on a supplied root target', () => {
    const target = { dataset: {} as Record<string, string> };

    applyTheme('dark', target);

    expect(target.dataset.theme).toBe('dark');
  });
});

describe('toggleTheme', () => {
  it('switches between light and dark', () => {
    expect(toggleTheme('light')).toBe('dark');
    expect(toggleTheme('dark')).toBe('light');
  });
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../ui/public/theme-init.js', import.meta.url), 'utf8');

function runThemeInit(options: {
  stored?: string | null;
  prefersDark?: boolean;
  storageThrows?: boolean;
  supportsMatchMedia?: boolean;
}): string | null {
  let theme: string | null = null;
  const matchMedia = () => ({ matches: options.prefersDark ?? false });
  const context = {
    localStorage: {
      getItem: () => {
        if (options.storageThrows) {
          throw new Error('storage blocked');
        }
        return options.stored ?? null;
      },
    },
    window: options.supportsMatchMedia === false ? {} : { matchMedia },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          if (name === 'data-theme') {
            theme = value;
          }
        },
      },
    },
  };

  runInNewContext(source, context);
  return theme;
}

describe('theme-init.js', () => {
  it('uses a valid stored theme before the system preference', () => {
    expect(runThemeInit({ stored: 'light', prefersDark: true })).toBe('light');
  });

  it('uses the system preference when no valid theme is stored', () => {
    expect(runThemeInit({ stored: null, prefersDark: true })).toBe('dark');
    expect(runThemeInit({ stored: 'system', prefersDark: false })).toBe('light');
  });

  it('uses the system preference when storage access throws', () => {
    expect(runThemeInit({ storageThrows: true, prefersDark: true })).toBe('dark');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    expect(runThemeInit({ stored: null, supportsMatchMedia: false })).toBe('light');
  });
});

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  applyTheme,
  getStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
  type Theme,
} from '../lib/theme';

interface NavItem {
  to: string;
  label: string;
  d: string;
}

// Stock outline icon paths (heroicons-style), no branding.
const navItems: NavItem[] = [
  {
    to: '/',
    label: 'Board',
    d: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  },
  {
    to: '/triggers',
    label: 'Triggers',
    d: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    to: '/tasks',
    label: 'Tasks',
    d: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  },
];

const legacyLinks = [{ href: '/viewer', label: 'Legacy viewer' }];

export default function Sidebar() {
  const [theme, setTheme] = useState<Theme>(() => {
    const documentTheme = document.documentElement.dataset.theme;
    if (documentTheme === 'light' || documentTheme === 'dark') {
      return documentTheme;
    }
    let storedTheme: Theme | null = null;
    try {
      storedTheme = getStoredTheme(window.localStorage);
    } catch {
      storedTheme = null;
    }
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return resolveTheme(storedTheme, prefersDark);
  });

  const handleThemeToggle = () => {
    const nextTheme = toggleTheme(theme);
    applyTheme(nextTheme, document.documentElement);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The applied theme still works when storage is unavailable.
    }
    setTheme(nextTheme);
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-lg transition-all duration-150 ${
      isActive
        ? 'bg-sidebar-active text-text font-medium shadow-[var(--shadow-xs)]'
        : 'text-text-secondary hover:text-text hover:bg-sidebar-hover'
    }`;

  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors ${
      isActive ? 'text-agent font-medium' : 'text-text-tertiary'
    }`;

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 bg-sidebar flex-col flex-shrink-0 border-r border-sidebar-border">
        <div className="px-3 pt-3 pb-1">
          <div className="flex items-center gap-2.5 px-2 mb-3">
            <div className="w-7 h-7 rounded-lg bg-agent flex items-center justify-center">
              <span className="text-on-agent text-xs font-bold">M</span>
            </div>
            <span className="text-[14px] font-semibold text-text tracking-tight">
              MAMA Operator
            </span>
          </div>
        </div>
        <nav className="flex-1 py-2 px-2 overflow-y-auto">
          <div className="space-y-0.5">
            {navItems.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.to === '/'} className={linkClass}>
                {({ isActive }: { isActive: boolean }) => (
                  <>
                    <svg
                      className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-text' : 'text-text-tertiary'}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d={link.d} />
                    </svg>
                    <span className="flex-1">{link.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t border-sidebar-border space-y-0.5">
            {legacyLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-lg text-text-tertiary hover:text-text hover:bg-sidebar-hover transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        </nav>
        <div className="px-3 py-3 border-t border-sidebar-border">
          <button
            type="button"
            onClick={handleThemeToggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[13px] rounded-lg text-text-secondary hover:text-text hover:bg-sidebar-hover transition-colors"
          >
            <svg
              className="w-5 h-5 text-text-tertiary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={
                  theme === 'dark'
                    ? 'M12 3v1.5m0 15V21m9-9h-1.5M4.5 12H3m15.364 6.364-1.06-1.06M6.696 6.696l-1.06-1.06m12.728 0-1.06 1.06M6.696 17.304l-1.06 1.06M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z'
                    : 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z'
                }
              />
            </svg>
            <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
          <div className="px-2 pt-2 text-[10px] text-text-tertiary">MAMA Operator (beta)</div>
        </div>
      </aside>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-surface border-t border-border z-50 flex justify-around">
        {navItems.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.to === '/'} className={mobileLinkClass}>
            {({ isActive }: { isActive: boolean }) => (
              <>
                <svg
                  className={`w-5 h-5 ${isActive ? 'text-agent' : 'text-text-tertiary'}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={link.d} />
                </svg>
                <span>{link.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={handleThemeToggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="flex flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] text-text-tertiary"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={
                theme === 'dark'
                  ? 'M12 3v1.5m0 15V21m9-9h-1.5M4.5 12H3m15.364 6.364-1.06-1.06M6.696 6.696l-1.06-1.06m12.728 0-1.06 1.06M6.696 17.304l-1.06 1.06M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z'
                  : 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z'
              }
            />
          </svg>
          <span>Theme</span>
        </button>
      </nav>
    </>
  );
}

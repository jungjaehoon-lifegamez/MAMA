import { NavLink } from 'react-router-dom';

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
];

const legacyLinks = [{ href: '/viewer', label: 'Legacy viewer' }];

export default function Sidebar() {
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
              <span className="text-white text-xs font-bold">M</span>
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
        <div className="px-4 py-3">
          <div className="text-[10px] text-text-tertiary">MAMA Operator (beta)</div>
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
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={link.d} />
                </svg>
                <span>{link.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const viewerPath = join(process.cwd(), 'public', 'viewer', 'viewer.html');

describe('Story M9.4: Legacy viewer navigation retirement', () => {
  const source = readFileSync(viewerPath, 'utf8');

  function createClassList(initial: string[] = []) {
    const classes = new Set(initial);
    return {
      contains: (className: string) => classes.has(className),
      toggle: (className: string, force: boolean) => {
        if (force) {
          classes.add(className);
        } else {
          classes.delete(className);
        }
      },
    };
  }

  it('removes desktop Dashboard and mobile Home navigation entries', () => {
    expect(source).not.toContain('data-tab="dashboard"');
    expect(source).not.toContain('<span>Home</span>');
  });

  it('opens Feed and uses it as the help fallback', () => {
    expect(source).toContain("currentTab: 'feed'");
    expect(source).toContain("switchTab('feed');");
    expect(source).toContain("STATE.currentTab || 'feed'");
    expect(source).toMatch(/id="chat-tab-indicator"[\s\S]*?>Feed<\/span>/);
  });

  it('keeps More active when an overflow tab is selected', async () => {
    const navigationBody = source.match(
      /async function switchTab\(tabName, params\) \{([\s\S]*?)\n\s*\/\/ Legacy: update/
    )?.[1];
    expect(navigationBody).toBeDefined();

    const moreButton = {
      dataset: { tab: 'more' },
      classList: createClassList(['mama-nav-active']),
    };
    const chatButton = {
      dataset: { tab: 'chat' },
      classList: createClassList(),
    };
    const document = {
      getElementById: (id: string) =>
        id === 'mama-mobile-more'
          ? { style: { display: 'block' } }
          : id === 'chat-tab-indicator'
            ? { textContent: '' }
            : null,
      querySelector: () => moreButton,
      querySelectorAll: (selector: string) => {
        if (selector === '#mama-mobile-tabs .mama-mobile-tab') {
          return [chatButton, moreButton];
        }
        return [];
      },
    };
    const buildSwitchTab = new Function(
      'document',
      'STATE',
      `return async function switchTab(tabName, params) {${navigationBody}};`
    ) as (
      documentValue: typeof document,
      state: { currentTab: string }
    ) => (tabName: string) => Promise<void>;

    await buildSwitchTab(document, { currentTab: 'feed' })('feed');

    expect(moreButton.classList.contains('mama-nav-active')).toBe(true);
    expect(chatButton.classList.contains('mama-nav-active')).toBe(false);
  });

  it('keeps internal Dashboard compatibility code', () => {
    expect(source).toContain('id="tab-dashboard"');
    expect(source).toContain("import { DashboardModule } from '/viewer/js/modules/dashboard.js'");
    expect(source).toContain('window.dashboardModule = dashboard');
    expect(source).toContain('dashboard: `The user clicked the help button');
    expect(source).toContain('window.dashboardModule?.cleanup');
  });
});

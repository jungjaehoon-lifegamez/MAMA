import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const viewerPath = join(process.cwd(), 'public', 'viewer', 'viewer.html');
const viewerCssPath = join(process.cwd(), 'public', 'viewer', 'viewer.css');

const VALID_ROUTES = [
  'operator/board',
  'operator/tasks',
  'operator/triggers',
  'knowledge/memory',
  'knowledge/wiki',
  'system/runtime',
  'system/connectors',
  'system/logs',
];

describe('Viewer unified operator navigation', () => {
  const source = readFileSync(viewerPath, 'utf8');
  const css = readFileSync(viewerCssPath, 'utf8');

  /**
   * Lift the route table and the hash parser straight out of the shipped
   * document and run them. Pinning the strings alone would let the table and
   * the parser drift apart.
   */
  function parseHash(hash: string): { path: string; group: string; view: string; params: string } {
    const routes = source.match(/const ROUTES = \{[\s\S]*?\n {6}\};/)?.[0];
    const defaultRoute = source.match(/const DEFAULT_ROUTE = '[^']+';/)?.[0];
    const parser = source.match(/function parseViewerHash\(\) \{[\s\S]*?\n {6}\}/)?.[0];
    expect(routes).toBeDefined();
    expect(defaultRoute).toBeDefined();
    expect(parser).toBeDefined();

    const run = new Function(
      'window',
      `${routes}\n${defaultRoute}\n${parser}\nreturn parseViewerHash();`
    ) as (windowValue: { location: { hash: string } }) => {
      path: string;
      group: string;
      view: string;
      params: URLSearchParams;
    };
    const route = run({ location: { hash } });
    return {
      path: route.path,
      group: route.group,
      view: route.view,
      params: route.params.toString(),
    };
  }

  it('defaults to the operator board and reacts to hash changes', () => {
    expect(source).toContain("const DEFAULT_ROUTE = 'operator/board'");
    expect(source).toContain("window.addEventListener('hashchange'");
    expect(source).toContain('function parseViewerHash()');
    expect(source).toContain('function writeViewerHash(');
  });

  it('accepts exactly the eight grouped routes', () => {
    const table = source.match(/const ROUTES = \{[\s\S]*?\n {6}\};/)?.[0] ?? '';
    const declared = [...table.matchAll(/'([a-z]+\/[a-z]+)':/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual([...VALID_ROUTES].sort());
  });

  it('parses a known route, its params, and falls back on an unknown one', () => {
    expect(parseHash('#knowledge/wiki')).toEqual({
      path: 'knowledge/wiki',
      group: 'knowledge',
      view: 'wiki',
      params: '',
    });
    expect(parseHash('#operator/tasks?taskId=42')).toEqual({
      path: 'operator/tasks',
      group: 'operator',
      view: 'tasks',
      params: 'taskId=42',
    });
    expect(parseHash('#feed').path).toBe('operator/board');
    expect(parseHash('').path).toBe('operator/board');
  });

  it('mounts the operator bundle lazily and never tears it down while routing', () => {
    expect(source).toContain("import('/viewer/operator/operator.js')");
    expect(source).toContain('mountOperator(operatorRoot');
    expect(source).toContain('operatorHandle.update(');
    // Unmounting would drop the report SSE stream and the query cache.
    expect(source).not.toContain('operatorHandle.unmount(');
    expect(source).toContain('/viewer/operator/operator.css');
  });

  it('shows a reload affordance instead of a blank region when the bundle fails', () => {
    expect(source).toContain('operator-load-error');
    expect(source).toContain('window.location.reload()');
  });

  it('keeps every non-operator route region in the document', () => {
    for (const id of [
      'tab-operator',
      'tab-memory',
      'tab-wiki',
      'tab-runtime',
      'tab-connectors',
      'tab-logs',
    ]) {
      expect(source).toContain(`id="${id}"`);
    }
  });

  it('links every route from the desktop rail and the mobile chip row', () => {
    expect(source).toContain('mama-nav-item');
    expect(source).toContain('mama-subview-chip');
    for (const route of VALID_ROUTES) {
      // Once in the rail, once in the chip row.
      const links = source.split(`data-route="${route}"`).length - 1;
      expect(links, `route ${route}`).toBe(2);
      expect(source).toContain(`href="#${route}"`);
    }
    expect(source).toContain('>Operator</');
    expect(source).toContain('>Knowledge</');
    expect(source).toContain('>System</');
  });

  it('gives mobile chips a 44px touch target and the brand active state', () => {
    const chipRules = css.slice(css.indexOf('.mama-subview-chip'));
    expect(chipRules).toContain('min-height: 44px');
    expect(chipRules).toContain('#ffce00');
    expect(chipRules).toContain('#131313');
    expect(css).toContain('overflow-x: auto');
  });

  it('reports the grouped route shape to the page-context endpoint', () => {
    expect(source).toContain("pageType: 'route'");
    expect(source).toMatch(/reportPageContext\(\s*route\.path,/);
  });

  it('drops the retired chat, feed, agents, dashboard and settings surfaces', () => {
    expect(source).not.toContain('new ChatModule');
    expect(source).not.toContain('new ConnectorFeedModule');
    expect(source).not.toContain('new AgentsModule');
    expect(source).not.toContain('new DashboardModule');
    expect(source).not.toContain('new SettingsModule');
    expect(source).not.toContain('/viewer/js/modules/chat.js');
    expect(source).not.toContain('/viewer/js/modules/connector-feed.js');
    expect(source).not.toContain('/viewer/js/modules/agents.js');
    expect(source).not.toContain('/viewer/js/modules/dashboard.js');
    expect(source).not.toContain('/viewer/js/modules/settings.js');
    expect(source).not.toContain('id="tab-settings"');
    expect(source).not.toContain('id="tab-dashboard"');
    expect(source).not.toContain('id="tab-feed"');
    expect(source).not.toContain('id="tab-agents"');
    expect(source).not.toContain('chat-panel-wrapper');
    expect(source).not.toContain('viewer:sendToChat');
    expect(source).not.toContain('mama-chat-width');
  });

  it('leaves no credential input behind with the settings tab', () => {
    expect(source).not.toMatch(/id="settings-[a-z-]*(token|secret|key|password)/i);
    expect(source).not.toContain('id="settings-');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd();
const uiRoot = join(packageRoot, 'ui');
const uiSrc = join(uiRoot, 'src');
const bundleDir = join(packageRoot, 'public', 'viewer', 'operator');

function read(...segments: string[]): string {
  return readFileSync(join(...segments), 'utf8');
}

describe('operator viewer content bundle: source contract', () => {
  it('exposes a content-only mount boundary', () => {
    const entry = read(uiSrc, 'operator-entry.tsx');
    expect(entry).toContain('export function mountOperator');
    expect(entry).toContain('createRoot');
    expect(entry).toContain('unmount()');
  });

  it('builds a single-file library named operator', () => {
    const vite = read(uiRoot, 'vite.config.ts');
    expect(vite).toContain("fileName: 'operator'");
    expect(vite).toContain("assetFileNames: 'operator.css'");
    expect(vite).toContain("outDir: '../public/viewer/operator'");
    expect(vite).toContain("base: '/viewer/operator/'");
  });

  it('has no standalone document shell left', () => {
    expect(existsSync(join(uiSrc, 'main.tsx'))).toBe(false);
    expect(existsSync(join(uiSrc, 'App.tsx'))).toBe(false);
    expect(existsSync(join(uiSrc, 'components', 'Layout.tsx'))).toBe(false);
    expect(existsSync(join(uiSrc, 'components', 'Sidebar.tsx'))).toBe(false);
    expect(existsSync(join(uiRoot, 'index.html'))).toBe(false);
    expect(existsSync(join(uiSrc, 'lib', 'theme.ts'))).toBe(false);
  });

  it('routes board task clicks through the host instead of react-router', () => {
    const board = read(uiSrc, 'pages', 'Board.tsx');
    expect(board).not.toContain('useNavigate');
    expect(board).toContain('onOpenTask');

    const app = read(uiSrc, 'operator-app.tsx');
    expect(app).toContain("changeView('tasks', { taskId })");
    expect(app).toContain('onViewChange(nextView, nextSelection)');
  });

  it('does not depend on react-router anywhere in the app', () => {
    const pkg = read(uiRoot, 'package.json');
    expect(pkg).not.toContain('react-router');
  });

  it('scopes the bundle reset under #operator-root instead of shipping preflight', () => {
    const css = read(uiSrc, 'styles', 'global.css');
    expect(css).not.toContain("@import 'tailwindcss';");
    expect(css).toContain('#operator-root');
    expect(css).toContain('--color-agent: #ffce00');
    expect(css).toContain('--color-on-agent: #131313');
    expect(css).toContain('--color-agent-light: #eddbf7');
  });
});

// The bundle output is gitignored build product. These assertions run only when
// the bundle has been built (`pnpm --dir packages/standalone run build:ui`), so
// a clean checkout that tests without building still reports honestly.
const bundleBuilt = existsSync(join(bundleDir, 'operator.js'));

describe.skipIf(!bundleBuilt)('operator viewer content bundle: build output', () => {
  it('emits exactly operator.js and operator.css', () => {
    expect(existsSync(join(bundleDir, 'operator.js'))).toBe(true);
    expect(existsSync(join(bundleDir, 'operator.css'))).toBe(true);
  });

  it('ships no global document reset that would fight the viewer stylesheet', () => {
    const css = read(bundleDir, 'operator.css');
    // Strip at-rule preludes and declaration blocks so only selectors remain.
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((chunk) => chunk.split('{')[0])
      .filter((chunk) => chunk && !chunk.trimStart().startsWith('@'))
      .flatMap((chunk) => chunk.split(','))
      .map((selector) => selector.trim())
      .filter(Boolean);

    const bareDocumentSelectors = selectors.filter((selector) =>
      /^(html|body)([:.[][^\s>+~]*)?$/.test(selector)
    );
    expect(bareDocumentSelectors).toEqual([]);
  });
});

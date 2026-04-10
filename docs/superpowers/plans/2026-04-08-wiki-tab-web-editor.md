# Wiki Tab — Web Viewer + Editor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Wiki tab to the MAMA OS dashboard that renders Obsidian wiki pages in-browser with wikilink navigation and inline markdown editing, accessible from any device.

**Architecture:** A new Express router (`wiki-handler.ts`) serves CRUD API endpoints for wiki `.md` files. A viewer module (`wiki.ts`) renders pages with `marked` + DOMPurify (already loaded) plus a wikilink extension. Edit mode provides a split-pane textarea + live preview. The file path is `config.wiki.vaultPath + config.wiki.wikiDir`.

**Tech Stack:** Express router, `marked` (already in CDN), DOMPurify (already in CDN), existing viewer tab pattern.

---

## File Structure

| File                                                    | Responsibility                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/standalone/src/api/wiki-handler.ts`           | Express router: GET tree, GET/PUT/POST/DELETE page                 |
| `packages/standalone/public/viewer/src/modules/wiki.ts` | Viewer module: page list, markdown render, wikilink nav, edit mode |
| `packages/standalone/public/viewer/viewer.html`         | Add Wiki tab nav + content area                                    |
| `packages/standalone/src/api/index.ts`                  | Mount wiki router                                                  |
| `tests/api/wiki-handler.test.ts`                        | API tests                                                          |
| `tests/wiki/viewer-wiki.test.ts`                        | Wikilink parsing tests                                             |

---

### Task 1: Wiki API router

**Files:**

- Create: `packages/standalone/src/api/wiki-handler.ts`
- Test: `packages/standalone/tests/api/wiki-handler.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// packages/standalone/tests/api/wiki-handler.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getWikiTree,
  readWikiPage,
  writeWikiPage,
  deleteWikiPage,
} from '../../src/api/wiki-handler.js';

let wikiPath: string;

describe('Wiki handler', () => {
  beforeEach(() => {
    wikiPath = mkdtempSync(join(tmpdir(), 'wiki-handler-'));
    mkdirSync(join(wikiPath, 'projects'), { recursive: true });
    mkdirSync(join(wikiPath, 'lessons'), { recursive: true });
    writeFileSync(join(wikiPath, 'index.md'), '---\ntitle: Index\n---\n# Wiki Index\n', 'utf8');
    writeFileSync(
      join(wikiPath, 'projects', 'ProjectAlpha.md'),
      '---\ntitle: ProjectAlpha\ntype: entity\n---\n# ProjectAlpha\n\n## Status\n\nIn progress.',
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(wikiPath, { recursive: true, force: true });
  });

  describe('getWikiTree', () => {
    it('returns directory tree with files', () => {
      const tree = getWikiTree(wikiPath);
      expect(tree).toContainEqual(expect.objectContaining({ name: 'index.md', type: 'file' }));
      const projects = tree.find((n) => n.name === 'projects');
      expect(projects?.type).toBe('directory');
      expect(projects?.children).toContainEqual(
        expect.objectContaining({ name: 'ProjectAlpha.md', type: 'file' })
      );
    });

    it('skips hidden directories', () => {
      mkdirSync(join(wikiPath, '.obsidian'));
      writeFileSync(join(wikiPath, '.obsidian', 'config.json'), '{}');
      const tree = getWikiTree(wikiPath);
      expect(tree.find((n) => n.name === '.obsidian')).toBeUndefined();
    });
  });

  describe('readWikiPage', () => {
    it('reads page content and parses frontmatter', () => {
      const result = readWikiPage(wikiPath, 'projects/ProjectAlpha.md');
      expect(result.frontmatter.title).toBe('ProjectAlpha');
      expect(result.frontmatter.type).toBe('entity');
      expect(result.content).toContain('# ProjectAlpha');
      expect(result.raw).toContain('---');
    });

    it('returns null for non-existent page', () => {
      const result = readWikiPage(wikiPath, 'nonexistent.md');
      expect(result).toBeNull();
    });

    it('rejects path traversal', () => {
      expect(() => readWikiPage(wikiPath, '../../../etc/passwd')).toThrow();
    });
  });

  describe('writeWikiPage', () => {
    it('writes new page', () => {
      writeWikiPage(wikiPath, 'projects/NewProject.md', '# New\n\nContent.');
      const content = readFileSync(join(wikiPath, 'projects', 'NewProject.md'), 'utf8');
      expect(content).toContain('# New');
    });

    it('overwrites existing page', () => {
      writeWikiPage(wikiPath, 'projects/ProjectAlpha.md', '# ProjectAlpha Updated');
      const content = readFileSync(join(wikiPath, 'projects', 'ProjectAlpha.md'), 'utf8');
      expect(content).toContain('Updated');
    });

    it('creates intermediate directories', () => {
      writeWikiPage(wikiPath, 'knowledge/processes/deploy.md', '# Deploy');
      const content = readFileSync(join(wikiPath, 'knowledge', 'processes', 'deploy.md'), 'utf8');
      expect(content).toContain('# Deploy');
    });

    it('rejects path traversal', () => {
      expect(() => writeWikiPage(wikiPath, '../escape.md', 'bad')).toThrow();
    });
  });

  describe('deleteWikiPage', () => {
    it('deletes existing page', () => {
      deleteWikiPage(wikiPath, 'projects/ProjectAlpha.md');
      expect(readWikiPage(wikiPath, 'projects/ProjectAlpha.md')).toBeNull();
    });

    it('is no-op for non-existent page', () => {
      expect(() => deleteWikiPage(wikiPath, 'ghost.md')).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/api/wiki-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement wiki-handler.ts**

```typescript
// packages/standalone/src/api/wiki-handler.ts
import { Router } from 'express';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, dirname, normalize, relative } from 'path';
import { asyncHandler } from './error-handler.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface WikiTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WikiTreeNode[];
}

export interface WikiPageResult {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  raw: string;
}

// ── Pure functions (testable without Express) ───────────────────────────────

function validatePath(wikiPath: string, filePath: string): string {
  const resolved = normalize(join(wikiPath, filePath));
  if (!resolved.startsWith(wikiPath)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      fm[key] = val;
    }
  }
  return { frontmatter: fm, content: match[2] };
}

export function getWikiTree(wikiPath: string): WikiTreeNode[] {
  if (!existsSync(wikiPath)) return [];
  const entries = readdirSync(wikiPath).filter((n) => !n.startsWith('.'));
  return entries
    .map((name): WikiTreeNode | null => {
      const full = join(wikiPath, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        return {
          name,
          path: name,
          type: 'directory',
          children: getWikiTree(full).map((c) => ({
            ...c,
            path: `${name}/${c.path}`,
          })),
        };
      }
      if (name.endsWith('.md')) {
        return { name, path: name, type: 'file' };
      }
      return null;
    })
    .filter((n): n is WikiTreeNode => n !== null);
}

export function readWikiPage(wikiPath: string, filePath: string): WikiPageResult | null {
  const resolved = validatePath(wikiPath, filePath);
  if (!existsSync(resolved)) return null;
  const raw = readFileSync(resolved, 'utf8');
  const { frontmatter, content } = parseFrontmatter(raw);
  return { path: filePath, frontmatter, content, raw };
}

export function writeWikiPage(wikiPath: string, filePath: string, content: string): void {
  const resolved = validatePath(wikiPath, filePath);
  const dir = dirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolved, content, 'utf8');
}

export function deleteWikiPage(wikiPath: string, filePath: string): void {
  const resolved = validatePath(wikiPath, filePath);
  if (existsSync(resolved)) unlinkSync(resolved);
}

// ── Express Router ──────────────────────────────────────────────────────────

export function createWikiRouter(wikiPath: string): Router {
  const router = Router();

  // GET /api/wiki/tree
  router.get(
    '/tree',
    asyncHandler(async (_req, res) => {
      res.json({ tree: getWikiTree(wikiPath) });
    })
  );

  // GET /api/wiki/page/:path(*)
  router.get(
    '/page/*',
    asyncHandler(async (req, res) => {
      const filePath = (req.params as Record<string, string>)[0];
      const result = readWikiPage(wikiPath, filePath);
      if (!result) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      res.json(result);
    })
  );

  // PUT /api/wiki/page/:path(*) — update existing or create
  router.put(
    '/page/*',
    asyncHandler(async (req, res) => {
      const filePath = (req.params as Record<string, string>)[0];
      const { content } = req.body as { content: string };
      if (!content && content !== '') {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      writeWikiPage(wikiPath, filePath, content);
      res.json({ ok: true, path: filePath });
    })
  );

  // POST /api/wiki/page — create new page
  router.post(
    '/page',
    asyncHandler(async (req, res) => {
      const { path: filePath, content } = req.body as { path: string; content: string };
      if (!filePath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      if (readWikiPage(wikiPath, filePath)) {
        res.status(409).json({ error: 'Page already exists' });
        return;
      }
      writeWikiPage(
        wikiPath,
        filePath,
        content || `# ${filePath.replace(/\.md$/, '').split('/').pop()}\n`
      );
      res.json({ ok: true, path: filePath });
    })
  );

  // DELETE /api/wiki/page/:path(*)
  router.delete(
    '/page/*',
    asyncHandler(async (req, res) => {
      const filePath = (req.params as Record<string, string>)[0];
      deleteWikiPage(wikiPath, filePath);
      res.json({ ok: true });
    })
  );

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/standalone && npx vitest run tests/api/wiki-handler.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/wiki-handler.ts packages/standalone/tests/api/wiki-handler.test.ts
git commit -m "feat(wiki): Wiki API router — CRUD for wiki pages with path traversal protection"
```

---

### Task 2: Mount wiki router in API server

**Files:**

- Modify: `packages/standalone/src/api/index.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`

- [ ] **Step 1: Add wikiPath to ApiServerOptions**

In `packages/standalone/src/api/index.ts`, add to `ApiServerOptions` interface (after `memoryDb`):

```typescript
  /** Wiki directory path (for wiki API) */
  wikiPath?: string;
```

- [ ] **Step 2: Mount wiki router**

In `createApiServer`, after the report router mount (~line 190), add:

```typescript
// Mount wiki router if wiki path is configured
if (options.wikiPath) {
  const { createWikiRouter } = await import('./wiki-handler.js');
  const wikiRouter = createWikiRouter(options.wikiPath);
  app.use('/api/wiki', wikiRouter);
}
```

Note: `createApiServer` is not async currently. Change it to use dynamic import that's lazy-evaluated within route handlers, OR mount synchronously by importing at top of file. Since other routers are imported at the top, import at top:

```typescript
// At top of file, add:
import { createWikiRouter } from './wiki-handler.js';
```

Then mount synchronously:

```typescript
// Mount wiki router if wiki path is configured
const wikiPath = options.wikiPath;
if (wikiPath) {
  const wikiRouter = createWikiRouter(wikiPath);
  app.use('/api/wiki', wikiRouter);
}
```

- [ ] **Step 3: Pass wikiPath from start.ts**

In `start.ts`, where `createApiServer` is called (~line 2505), add `wikiPath`:

```typescript
const wikiConfig = config.wiki as
  | { enabled?: boolean; vaultPath?: string; wikiDir?: string }
  | undefined;
const wikiPath =
  wikiConfig?.enabled && wikiConfig.vaultPath
    ? join(wikiConfig.vaultPath, wikiConfig.wikiDir || 'wiki')
    : undefined;
```

Then pass it:

```typescript
  const apiServer = createApiServer({
    scheduler,
    port: API_PORT,
    db,
    memoryDb: memoryDb as unknown as import('../../sqlite.js').SQLiteDatabase,
    skillRegistry,
    wikiPath,  // ← add this
    ...
  });
```

Note: The `join` import is likely already available in start.ts. Check before adding.

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/index.ts packages/standalone/src/api/wiki-handler.ts packages/standalone/src/cli/commands/start.ts
git commit -m "feat(wiki): mount wiki API router in server — /api/wiki/tree, /api/wiki/page/*"
```

---

### Task 3: Frontend API methods for wiki

**Files:**

- Modify: `packages/standalone/public/viewer/src/utils/api.ts`

- [ ] **Step 1: Add wiki types and API methods**

Add interfaces after `ConnectorStatusResponse`:

```typescript
export interface WikiTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WikiTreeNode[];
}

export interface WikiTreeResponse {
  tree: WikiTreeNode[];
}

export interface WikiPageResponse {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  raw: string;
}
```

Add methods to the `API` class (before closing brace):

```typescript
  // =============================================
  // Wiki API
  // =============================================

  static async getWikiTree(): Promise<WikiTreeResponse> {
    return this.get<WikiTreeResponse>('/api/wiki/tree');
  }

  static async getWikiPage(pagePath: string): Promise<WikiPageResponse> {
    return this.get<WikiPageResponse>(`/api/wiki/page/${encodeURIComponent(pagePath)}`);
  }

  static async saveWikiPage(pagePath: string, content: string): Promise<JsonRecord> {
    return this.put<JsonRecord, { content: string }>(
      `/api/wiki/page/${encodeURIComponent(pagePath)}`,
      { content }
    );
  }

  static async createWikiPage(pagePath: string, content?: string): Promise<JsonRecord> {
    return this.post<JsonRecord, { path: string; content?: string }>('/api/wiki/page', {
      path: pagePath,
      content,
    });
  }

  static async deleteWikiPage(pagePath: string): Promise<JsonRecord> {
    return this.del<JsonRecord>(`/api/wiki/page/${encodeURIComponent(pagePath)}`);
  }
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/utils/api.ts
git commit -m "feat(wiki): frontend API methods — getWikiTree, getWikiPage, saveWikiPage"
```

---

### Task 4: Wiki viewer module

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/wiki.ts`

- [ ] **Step 1: Create the wiki module**

```typescript
// packages/standalone/public/viewer/src/modules/wiki.ts
import { API, type WikiTreeNode, type WikiPageResponse } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';

declare const marked: { parse(md: string): string };
declare const DOMPurify: { sanitize(html: string): string };

const logger = new DebugLogger('Wiki');

function wikilinkToHtml(md: string): string {
  // [[path|display]] → clickable link
  // [[path]] → clickable link with path as display
  return md.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, path: string, display?: string) => {
      const label = display || path.split('/').pop() || path;
      const href = path.replace(/\.md$/, '');
      return `<a class="wiki-link" data-wiki-path="${href}.md" href="#">${label}</a>`;
    }
  );
}

function renderMarkdown(raw: string): string {
  // Strip frontmatter
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // Convert wikilinks before markdown parsing
  const withLinks = wikilinkToHtml(stripped);
  try {
    const html = marked.parse(withLinks);
    return DOMPurify.sanitize(html);
  } catch {
    return DOMPurify.sanitize(withLinks.replace(/\n/g, '<br>'));
  }
}

function renderTreeNode(node: WikiTreeNode, depth: number = 0): string {
  const indent = depth * 12;
  if (node.type === 'directory') {
    const children = (node.children || []).map((c) => renderTreeNode(c, depth + 1)).join('');
    return (
      `<div style="padding-left:${indent}px">` +
      `<div class="wiki-tree-dir" style="padding:3px 0;font-size:12px;font-weight:600;color:#6B6560;cursor:default">` +
      `<span style="margin-right:4px">📁</span>${node.name}</div>` +
      `${children}</div>`
    );
  }
  return (
    `<div class="wiki-tree-file" data-path="${node.path}" ` +
    `style="padding:3px 0 3px ${indent}px;font-size:12px;color:#1A1A1A;cursor:pointer;border-radius:3px" ` +
    `onmouseover="this.style.background='#F5F3EF'" onmouseout="this.style.background='transparent'">` +
    `${node.name.replace(/\.md$/, '')}</div>`
  );
}

export class WikiModule {
  private container: HTMLElement | null = null;
  private currentPath: string | null = null;
  private editMode = false;

  init(): void {
    this.container = document.getElementById('wiki-content');
    if (!this.container) return;
    this.loadTree();
  }

  private async loadTree(): Promise<void> {
    if (!this.container) return;
    try {
      const { tree } = await API.getWikiTree();
      this.renderLayout(tree);
    } catch (err) {
      logger.error('Failed to load wiki tree', err);
      this.container.innerHTML =
        '<div style="padding:40px;text-align:center;color:#9E9891;font-size:14px">' +
        'Wiki not configured. Enable wiki in config.yaml.</div>';
    }
  }

  private renderLayout(tree: WikiTreeNode[]): void {
    if (!this.container) return;

    const treeHtml = tree.map((n) => renderTreeNode(n)).join('');

    this.container.innerHTML =
      '<div style="display:flex;gap:16px;height:100%">' +
      // Sidebar: file tree
      `<div id="wiki-tree" style="width:200px;min-width:200px;overflow-y:auto;border-right:1px solid #EDE9E1;padding-right:12px">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">` +
      `<h2 style="font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:#1A1A1A;margin:0">Wiki</h2>` +
      `<button id="wiki-new-btn" style="font-size:11px;padding:2px 8px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#6B6560">+ New</button>` +
      `</div>` +
      treeHtml +
      `</div>` +
      // Main: page view/edit
      `<div id="wiki-page" style="flex:1;overflow-y:auto">` +
      `<div style="padding:40px;text-align:center;color:#9E9891;font-size:13px">Select a page to view.</div>` +
      `</div>` +
      '</div>';

    // Bind file click events
    this.container.querySelectorAll('.wiki-tree-file').forEach((el) => {
      el.addEventListener('click', () => {
        const path = (el as HTMLElement).dataset.path;
        if (path) this.openPage(path);
      });
    });

    // Bind new page button
    document.getElementById('wiki-new-btn')?.addEventListener('click', () => this.promptNewPage());

    // Auto-open index.md if exists
    const indexNode = tree.find((n) => n.name === 'index.md');
    if (indexNode) this.openPage(indexNode.path);
  }

  private async openPage(path: string): Promise<void> {
    this.currentPath = path;
    this.editMode = false;
    const pageEl = document.getElementById('wiki-page');
    if (!pageEl) return;

    try {
      const page = await API.getWikiPage(path);
      this.renderPageView(pageEl, page);
    } catch {
      pageEl.innerHTML = `<div style="color:#D94F4F;padding:20px">Failed to load ${path}</div>`;
    }

    // Highlight active tree item
    this.container?.querySelectorAll('.wiki-tree-file').forEach((el) => {
      const isActive = (el as HTMLElement).dataset.path === path;
      (el as HTMLElement).style.background = isActive ? '#F5F3EF' : 'transparent';
      (el as HTMLElement).style.fontWeight = isActive ? '600' : '400';
    });
  }

  private renderPageView(el: HTMLElement, page: WikiPageResponse): void {
    const title = (page.frontmatter.title as string) || page.path.replace(/\.md$/, '');
    const type = (page.frontmatter.type as string) || '';
    const confidence = (page.frontmatter.confidence as string) || '';

    const meta = [type, confidence].filter(Boolean).join(' · ');
    const html = renderMarkdown(page.raw);

    el.innerHTML =
      `<div style="max-width:720px">` +
      // Header bar
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #EDE9E1">` +
      `<div>` +
      `<span style="font-size:10px;color:#9E9891">${meta}</span>` +
      `</div>` +
      `<button id="wiki-edit-btn" style="font-size:11px;padding:3px 12px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#1A1A1A">Edit</button>` +
      `</div>` +
      // Rendered content
      `<div id="wiki-rendered" class="wiki-page-content" style="font-size:13px;color:#1A1A1A;line-height:1.7">${html}</div>` +
      `</div>`;

    // Bind edit button
    document.getElementById('wiki-edit-btn')?.addEventListener('click', () => {
      this.renderPageEdit(el, page);
    });

    // Bind wikilink clicks
    el.querySelectorAll('.wiki-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const wikiPath = (link as HTMLElement).dataset.wikiPath;
        if (wikiPath) this.openPage(wikiPath);
      });
    });
  }

  private renderPageEdit(el: HTMLElement, page: WikiPageResponse): void {
    this.editMode = true;

    el.innerHTML =
      `<div style="display:flex;flex-direction:column;height:100%">` +
      // Toolbar
      `<div style="display:flex;gap:8px;margin-bottom:8px">` +
      `<button id="wiki-save-btn" style="font-size:11px;padding:3px 12px;border:none;border-radius:3px;background:#1A1A1A;color:#fff;cursor:pointer">Save</button>` +
      `<button id="wiki-cancel-btn" style="font-size:11px;padding:3px 12px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#6B6560">Cancel</button>` +
      `<span style="font-size:10px;color:#9E9891;margin-left:auto;align-self:center">${page.path}</span>` +
      `</div>` +
      // Split pane: editor + preview
      `<div style="display:flex;gap:12px;flex:1;min-height:0">` +
      `<textarea id="wiki-editor" style="flex:1;font-family:monospace;font-size:12px;padding:12px;border:1px solid #EDE9E1;border-radius:4px;resize:none;line-height:1.6;color:#1A1A1A;background:#FAFAF8">${this.escapeHtml(page.raw)}</textarea>` +
      `<div id="wiki-preview" style="flex:1;overflow-y:auto;padding:12px;border:1px solid #EDE9E1;border-radius:4px;font-size:13px;color:#1A1A1A;line-height:1.7;background:#fff"></div>` +
      `</div>` +
      `</div>`;

    const editor = document.getElementById('wiki-editor') as HTMLTextAreaElement;
    const preview = document.getElementById('wiki-preview') as HTMLElement;

    // Initial preview
    if (preview) preview.innerHTML = renderMarkdown(page.raw);

    // Live preview on input
    editor?.addEventListener('input', () => {
      if (preview) preview.innerHTML = renderMarkdown(editor.value);
    });

    // Save
    document.getElementById('wiki-save-btn')?.addEventListener('click', async () => {
      if (!this.currentPath) return;
      try {
        await API.saveWikiPage(this.currentPath, editor.value);
        const updated = await API.getWikiPage(this.currentPath);
        this.renderPageView(el, updated);
      } catch (err) {
        logger.error('Save failed', err);
      }
    });

    // Cancel
    document.getElementById('wiki-cancel-btn')?.addEventListener('click', () => {
      this.renderPageView(el, page);
    });
  }

  private async promptNewPage(): Promise<void> {
    const path = prompt('Page path (e.g. projects/NewProject.md):');
    if (!path) return;
    const normalized = path.endsWith('.md') ? path : `${path}.md`;
    try {
      await API.createWikiPage(normalized);
      await this.loadTree();
      this.openPage(normalized);
    } catch (err) {
      logger.error('Create page failed', err);
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy(): void {
    this.currentPath = null;
    this.editMode = false;
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/public/viewer/src/modules/wiki.ts
git commit -m "feat(wiki): Wiki viewer module — markdown render, wikilinks, split-pane editor"
```

---

### Task 5: Add Wiki tab to viewer.html

**Files:**

- Modify: `packages/standalone/public/viewer/viewer.html`

- [ ] **Step 1: Add Wiki nav button in sidebar** (after Projects, before Memory)

```html
<button
  class="mama-nav-item"
  data-tab="wiki"
  onclick="window.switchTab && window.switchTab('wiki')"
>
  <i data-lucide="book-open"></i>
  <span>Wiki</span>
</button>
```

- [ ] **Step 2: Add Wiki tab content** (after Projects tab, before Settings tab)

```html
<!-- Wiki Tab -->
<div class="tab-content" id="tab-wiki">
  <div class="flex-1 flex flex-col min-h-0 overflow-y-auto p-4 md:p-6">
    <div id="wiki-content">
      <div style="padding:40px;text-align:center;color:#9E9891;font-size:14px">Loading wiki...</div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add mobile tab** (after Projects mobile tab, before Memory mobile tab)

```html
<button
  class="mama-mobile-tab"
  data-tab="wiki"
  onclick="window.switchTab && window.switchTab('wiki')"
>
  <i data-lucide="book-open"></i>
  <span>Wiki</span>
</button>
```

- [ ] **Step 4: Import WikiModule and wire switchTab**

In the `<script type="module">` section, add:

```javascript
import { WikiModule } from '/viewer/js/modules/wiki.js';
```

After `const projects = new ProjectsModule();`, add:

```javascript
const wiki = new WikiModule();
```

In the `switchTab` function, add the wiki case (after `projects` case):

```javascript
        } else if (tabName === 'wiki') {
          wiki.init();
```

- [ ] **Step 5: Build and verify**

Run: `pnpm build`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/public/viewer/viewer.html
git commit -m "feat(wiki): add Wiki tab to viewer — sidebar nav, content area, module init"
```

---

### Task 6: Wiki Agent debug fix

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`

- [ ] **Step 1: Investigate wiki agent issue**

The Wiki Agent runs but doesn't call `wiki_publish`. Check that the `toolsConfig.gateway` list is wired correctly. The issue is likely that the `wiki_publish` tool needs to be in the gateway tools that the agent's `toolExecutor` recognizes for this specific agent session.

Read the dashboard agent pattern to compare — it uses `mama_search` + `report_publish` and works. The wiki agent uses `mama_search` + `wiki_publish`. Verify that `wiki_publish` is listed in the `toolsConfig.gateway` array AND that `setWikiPublisher` was called before the agent runs.

- [ ] **Step 2: Verify order of operations in start.ts**

The `setWikiPublisher()` call must happen BEFORE `runWikiAgent()`. Read the current code to confirm the `toolExecutor.setWikiPublisher(...)` call is placed before the event listener and manual trigger registration.

- [ ] **Step 3: Add a startup test run**

After the event listeners, add a delayed first run (like dashboard agent has):

```typescript
// First run after 15s (let connectors and dashboard agent go first)
setTimeout(runWikiAgent, 15_000);
```

- [ ] **Step 4: Build and restart**

```bash
pnpm build
mama stop && mama start
sleep 20
curl -s http://localhost:3847/api/wiki/tree | python3 -m json.tool
```

Expected: Tree should show generated pages after wiki agent runs.

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/cli/commands/start.ts
git commit -m "fix(wiki): add startup run for Wiki Agent (15s delay after boot)"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build` — 0 errors
- [ ] `pnpm test` — all pass
- [ ] `mama stop && mama start` — starts without errors
- [ ] `curl -s http://localhost:3847/api/wiki/tree` — returns directory tree
- [ ] `curl -s http://localhost:3847/api/wiki/page/projects/ProjectAlpha.md` — returns page with frontmatter
- [ ] Dashboard Wiki tab shows file tree on left, rendered page on right
- [ ] Click `[[wikilink]]` navigates to linked page
- [ ] Edit button opens split-pane editor with live preview
- [ ] Save writes to disk, re-renders page
- [ ] "+ New" creates new page and opens it
- [ ] Wiki Agent auto-generates pages on startup (15s delay)

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
import { join, dirname, normalize } from 'path';
import { asyncHandler } from './error-handler.js';

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
          children: getWikiTree(full).map((c) => ({ ...c, path: `${name}/${c.path}` })),
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

export function createWikiRouter(wikiPath: string): Router {
  const router = Router();

  router.get(
    '/tree',
    asyncHandler(async (_req, res) => {
      res.json({ tree: getWikiTree(wikiPath) });
    })
  );

  // GET /api/wiki/page?path=projects/MyProject.md
  router.get(
    '/page',
    asyncHandler(async (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'path query param is required' });
        return;
      }
      const result = readWikiPage(wikiPath, filePath);
      if (!result) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      res.json(result);
    })
  );

  // PUT /api/wiki/page — update page
  router.put(
    '/page',
    asyncHandler(async (req, res) => {
      const { path: filePath, content } = req.body as { path: string; content: string };
      if (!filePath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
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

  // DELETE /api/wiki/page?path=projects/MyProject.md
  router.delete(
    '/page',
    asyncHandler(async (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'path query param is required' });
        return;
      }
      deleteWikiPage(wikiPath, filePath);
      res.json({ ok: true });
    })
  );

  return router;
}

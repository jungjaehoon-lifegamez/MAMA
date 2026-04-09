import { API, type WikiTreeNode, type WikiPageResponse } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { createResizeHandle } from '../utils/dom.js';

declare const marked: { parse(md: string): string };
declare const DOMPurify: { sanitize(html: string): string };

const logger = new DebugLogger('Wiki');

function wikilinkToHtml(md: string): string {
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
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
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
    const storageKey = `wiki-dir-${node.name}-d${depth}`;
    const storedState = localStorage.getItem(storageKey);
    const isOpen = storedState !== null ? storedState === 'true' : true;
    const children = (node.children || []).map((c) => renderTreeNode(c, depth + 1)).join('');
    const arrow = isOpen ? '\u25BC' : '\u25B6';
    const childDisplay = isOpen ? '' : 'display:none;';
    return (
      `<div style="padding-left:${indent}px">` +
      `<div class="wiki-tree-dir" data-storage-key="${storageKey}" ` +
      `style="padding:3px 0;font-size:12px;font-weight:600;color:#6B6560;cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px">` +
      `<span class="wiki-dir-arrow" style="display:inline-block;font-size:9px;width:10px;color:#9E9891">${arrow}</span>` +
      `<span>\u{1F4C1}</span><span>${node.name}</span></div>` +
      `<div class="wiki-dir-children" style="${childDisplay}">${children}</div></div>`
    );
  }
  return (
    `<div class="wiki-tree-file" data-path="${node.path}" ` +
    `style="padding:3px 0 3px ${indent}px;font-size:12px;color:#1A1A1A;cursor:pointer;border-radius:3px" ` +
    `onmouseover="this.style.background='#F5F3EF'" onmouseout="this.style.background='transparent'">` +
    `${node.name.replace(/\.md$/, '')}</div>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class WikiModule {
  private container: HTMLElement | null = null;
  private currentPath: string | null = null;

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
      `<div id="wiki-tree" style="width:200px;min-width:200px;overflow-y:auto;border-right:1px solid #EDE9E1;padding-right:12px">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">` +
      `<h2 style="font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:#1A1A1A;margin:0">Wiki</h2>` +
      `<button id="wiki-new-btn" style="font-size:11px;padding:2px 8px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#6B6560">+ New</button>` +
      `</div>` +
      treeHtml +
      `</div>` +
      `<div id="wiki-page" style="flex:1;overflow-y:auto">` +
      `<div style="padding:40px;text-align:center;color:#9E9891;font-size:13px">Select a page to view.</div>` +
      `</div>` +
      '</div>';

    // Attach resize handle to wiki tree panel
    const treePanel = document.getElementById('wiki-tree');
    if (treePanel) {
      createResizeHandle(treePanel, {
        storageKey: 'wiki-tree-width',
        minWidth: 120,
        maxWidth: 500,
      });
    }

    // Bind collapsible directory toggles
    this.container.querySelectorAll('.wiki-tree-dir').forEach((el) => {
      el.addEventListener('click', () => {
        const dirEl = el as HTMLElement;
        const key = dirEl.dataset.storageKey;
        const arrow = dirEl.querySelector('.wiki-dir-arrow') as HTMLElement;
        const children = dirEl.parentElement?.querySelector('.wiki-dir-children') as HTMLElement;
        if (!arrow || !children) return;

        const isOpen = children.style.display !== 'none';
        children.style.display = isOpen ? 'none' : '';
        arrow.textContent = isOpen ? '\u25B6' : '\u25BC';
        if (key) localStorage.setItem(key, String(!isOpen));
      });
    });

    this.container.querySelectorAll('.wiki-tree-file').forEach((el) => {
      el.addEventListener('click', () => {
        const path = (el as HTMLElement).dataset.path;
        if (path) this.openPage(path);
      });
    });

    document.getElementById('wiki-new-btn')?.addEventListener('click', () => this.promptNewPage());

    const indexNode = tree.find((n) => n.name === 'index.md');
    if (indexNode) this.openPage(indexNode.path);
  }

  private async openPage(path: string): Promise<void> {
    this.currentPath = path;
    const pageEl = document.getElementById('wiki-page');
    if (!pageEl) return;

    try {
      const page = await API.getWikiPage(path);
      this.renderPageView(pageEl, page);
    } catch {
      pageEl.innerHTML = `<div style="color:#D94F4F;padding:20px">Failed to load ${path}</div>`;
    }

    this.container?.querySelectorAll('.wiki-tree-file').forEach((el) => {
      const isActive = (el as HTMLElement).dataset.path === path;
      (el as HTMLElement).style.background = isActive ? '#F5F3EF' : 'transparent';
      (el as HTMLElement).style.fontWeight = isActive ? '600' : '400';
    });
  }

  private renderPageView(el: HTMLElement, page: WikiPageResponse): void {
    const type = (page.frontmatter.type as string) || '';
    const confidence = (page.frontmatter.confidence as string) || '';
    const meta = [type, confidence].filter(Boolean).join(' · ');
    const html = renderMarkdown(page.raw);

    el.innerHTML =
      `<div style="max-width:720px">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #EDE9E1">` +
      `<span style="font-size:10px;color:#9E9891">${meta}</span>` +
      `<button id="wiki-edit-btn" style="font-size:11px;padding:3px 12px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#1A1A1A">Edit</button>` +
      `</div>` +
      `<div id="wiki-rendered" style="font-size:13px;color:#1A1A1A;line-height:1.7">` +
      `<style>.wiki-page h1{font-family:Fredoka,sans-serif;font-size:22px;font-weight:700;color:#1A1A1A;margin:0 0 16px 0;border-bottom:2px solid #EDE9E1;padding-bottom:8px}` +
      `.wiki-page h2{font-family:Fredoka,sans-serif;font-size:16px;font-weight:600;color:#1A1A1A;margin:20px 0 8px 0}` +
      `.wiki-page h3{font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:#6B6560;margin:16px 0 6px 0}` +
      `.wiki-page p{margin:0 0 10px 0}` +
      `.wiki-page ul,.wiki-page ol{margin:0 0 10px 0;padding-left:20px}` +
      `.wiki-page li{margin:2px 0}` +
      `.wiki-page strong{color:#1A1A1A}` +
      `.wiki-page a.wiki-link{color:#5B8DEF;text-decoration:none;border-bottom:1px dashed #5B8DEF}` +
      `.wiki-page a.wiki-link:hover{color:#3A6FD8;border-bottom-style:solid}` +
      `.wiki-page code{background:#F5F3EF;padding:1px 4px;border-radius:2px;font-size:12px}` +
      `.wiki-page pre{background:#F5F3EF;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px}` +
      `.wiki-page hr{border:none;border-top:1px solid #EDE9E1;margin:16px 0}` +
      `.wiki-page table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12px}` +
      `.wiki-page th,.wiki-page td{border:1px solid #EDE9E1;padding:6px 10px;text-align:left}` +
      `.wiki-page th{background:#FAFAF8;font-weight:600}</style>` +
      `<div class="wiki-page">${html}</div></div>` +
      `</div>`;

    document.getElementById('wiki-edit-btn')?.addEventListener('click', () => {
      this.renderPageEdit(el, page);
    });

    el.querySelectorAll('.wiki-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const wikiPath = (link as HTMLElement).dataset.wikiPath;
        if (wikiPath) this.openPage(wikiPath);
      });
    });
  }

  private renderPageEdit(el: HTMLElement, page: WikiPageResponse): void {
    el.innerHTML =
      `<div style="display:flex;flex-direction:column;height:100%">` +
      `<div style="display:flex;gap:8px;margin-bottom:8px">` +
      `<button id="wiki-save-btn" style="font-size:11px;padding:3px 12px;border:none;border-radius:3px;background:#1A1A1A;color:#fff;cursor:pointer">Save</button>` +
      `<button id="wiki-cancel-btn" style="font-size:11px;padding:3px 12px;border:1px solid #EDE9E1;border-radius:3px;background:#fff;cursor:pointer;color:#6B6560">Cancel</button>` +
      `<span style="font-size:10px;color:#9E9891;margin-left:auto;align-self:center">${page.path}</span>` +
      `</div>` +
      `<div style="display:flex;gap:12px;flex:1;min-height:0">` +
      `<textarea id="wiki-editor" style="flex:1;font-family:monospace;font-size:12px;padding:12px;border:1px solid #EDE9E1;border-radius:4px;resize:none;line-height:1.6;color:#1A1A1A;background:#FAFAF8">${escapeHtml(page.raw)}</textarea>` +
      `<div id="wiki-preview" style="flex:1;overflow-y:auto;padding:12px;border:1px solid #EDE9E1;border-radius:4px;font-size:13px;color:#1A1A1A;line-height:1.7;background:#fff"></div>` +
      `</div>` +
      `</div>`;

    const editor = document.getElementById('wiki-editor') as HTMLTextAreaElement;
    const preview = document.getElementById('wiki-preview') as HTMLElement;

    if (preview) preview.innerHTML = renderMarkdown(page.raw);

    editor?.addEventListener('input', () => {
      if (preview) preview.innerHTML = renderMarkdown(editor.value);
    });

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

  destroy(): void {
    this.currentPath = null;
  }
}

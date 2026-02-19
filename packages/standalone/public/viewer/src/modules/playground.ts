/**
 * Playground Module
 * @module modules/playground
 *
 * Lists, views, and manages interactive HTML playgrounds
 * created by agents via playground_create gateway tool.
 */

/* eslint-env browser */

interface PlaygroundEntry {
  name: string;
  slug: string;
  description?: string;
  created_at: string;
}

export const PlaygroundModule = {
  initialized: false,

  async init(): Promise<void> {
    await this.loadList();
    this.bindEvents();
    this.initialized = true;
  },

  bindEvents(): void {
    const refreshBtn = document.getElementById('playground-refresh-btn');
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.addEventListener('click', () => this.loadList());
      refreshBtn.dataset.bound = '1';
    }

    const backBtn = document.getElementById('playground-back-btn');
    if (backBtn && !backBtn.dataset.bound) {
      backBtn.addEventListener('click', () => this.showList());
      backBtn.dataset.bound = '1';
    }
  },

  async loadList(): Promise<void> {
    const listEl = document.getElementById('playground-list');
    if (!listEl) return;

    try {
      const res = await fetch('/api/playgrounds');
      const items: PlaygroundEntry[] = await res.json();

      if (!items.length) {
        listEl.innerHTML =
          '<div class="text-gray-500 text-sm col-span-full text-center py-8">No playgrounds yet. Ask an agent to create one!</div>';
        return;
      }

      listEl.innerHTML = items
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map(
          (item) => `
        <div class="playground-card bg-white border border-mama-lavender-dark rounded-xl p-4 hover:shadow-md transition-shadow cursor-pointer flex flex-col gap-2" data-slug="${item.slug}">
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-mama-black text-sm truncate">${this.escapeHtml(item.name)}</h3>
            <button class="playground-delete p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-500 transition-colors" data-slug="${item.slug}" title="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
          ${item.description ? `<p class="text-xs text-gray-500 line-clamp-2">${this.escapeHtml(item.description)}</p>` : ''}
          <span class="text-[10px] text-gray-400 mt-auto">${new Date(item.created_at).toLocaleString()}</span>
        </div>
      `
        )
        .join('');

      // Bind card clicks
      listEl.querySelectorAll('.playground-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;
          if (target.closest('.playground-delete')) return;
          const slug = (card as HTMLElement).dataset.slug;
          if (slug) this.openPlayground(slug, items.find((i) => i.slug === slug)?.name || slug);
        });
      });

      // Bind delete buttons
      listEl.querySelectorAll('.playground-delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const slug = (btn as HTMLElement).dataset.slug;
          if (slug && confirm(`Delete playground "${slug}"?`)) {
            await this.deletePlayground(slug);
          }
        });
      });
    } catch (err) {
      listEl.innerHTML =
        '<div class="text-red-500 text-sm col-span-full text-center py-8">Failed to load playgrounds</div>';
      console.error('[Playground] Failed to load:', err);
    }
  },

  openPlayground(slug: string, name: string): void {
    const listEl = document.getElementById('playground-list');
    const viewerEl = document.getElementById('playground-viewer');
    const iframe = document.getElementById('playground-iframe') as HTMLIFrameElement | null;
    const titleEl = document.getElementById('playground-viewer-title');
    const openNewEl = document.getElementById('playground-open-new') as HTMLAnchorElement | null;

    if (!listEl || !viewerEl || !iframe) return;

    const url = `/playgrounds/${slug}.html`;
    listEl.classList.add('hidden');
    viewerEl.classList.remove('hidden');
    iframe.src = url;
    if (titleEl) titleEl.textContent = name;
    if (openNewEl) openNewEl.href = url;
  },

  showList(): void {
    const listEl = document.getElementById('playground-list');
    const viewerEl = document.getElementById('playground-viewer');
    const iframe = document.getElementById('playground-iframe') as HTMLIFrameElement | null;

    if (listEl) listEl.classList.remove('hidden');
    if (viewerEl) viewerEl.classList.add('hidden');
    if (iframe) iframe.src = 'about:blank';
  },

  async deletePlayground(slug: string): Promise<void> {
    try {
      await fetch(`/api/playgrounds/${slug}`, { method: 'DELETE' });
      this.showList();
      await this.loadList();
    } catch (err) {
      console.error('[Playground] Failed to delete:', err);
    }
  },

  escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};

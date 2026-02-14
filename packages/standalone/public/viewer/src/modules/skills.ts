/**
 * Skills Marketplace Module
 * @module modules/skills
 * @version 1.0.0
 *
 * Manages skill browsing, installation, and configuration
 * across MAMA, Cowork, and OpenClaw sources.
 */

/* eslint-env browser */

import { API, type SkillItem } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { getElementByIdOrNull } from '../utils/dom.js';
import { renderSafeMarkdown } from '../utils/markdown.js';

const logger = new DebugLogger('Skills');

/**
 * Skills marketplace module
 */
export const SkillsModule = {
  /** All skills (installed + catalog) */
  installed: [] as SkillItem[],
  catalog: [] as SkillItem[],
  /** Current filter */
  currentFilter: 'all',
  /** Search query */
  searchQuery: '',
  /** Whether initialized */
  _initialized: false,
  /** Debounce timer */
  _searchTimer: null as ReturnType<typeof setTimeout> | null,

  /**
   * Initialize the skills tab
   */
  async init(): Promise<void> {
    if (!this._initialized) {
      this._bindEvents();
      this._initialized = true;
    }
    await this.loadSkills();
    this.render();
  },

  /**
   * Load installed + catalog skills
   */
  async loadSkills(): Promise<void> {
    try {
      const [installedResponse, catalogResponse] = await Promise.all([
        API.getSkills(),
        API.getSkillCatalog('all'),
      ]);

      this.installed = installedResponse.skills || [];
      const catalogItems = catalogResponse.skills || [];
      const installedMap = new Set(
        this.installed.map((item: SkillItem) => `${item.source}::${item.id}`)
      );
      this.catalog = catalogItems.filter(
        (s: SkillItem) => !installedMap.has(`${s.source}::${s.id}`)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Unexpected error while loading skills:', message);
      // Initialize with empty arrays on failure
      this.installed = [];
      this.catalog = [];
    }
  },

  /**
   * Bind UI events
   */
  _bindEvents(): void {
    // Search input
    const searchInput = getElementByIdOrNull<HTMLInputElement>('skills-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e: Event) => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          this.searchQuery = target.value.trim();
          this.render();
        }, 300);
      });
    }

    // URL install
    const urlBtn = getElementByIdOrNull<HTMLButtonElement>('skills-url-install-btn');
    if (urlBtn) {
      urlBtn.addEventListener('click', () => {
        const input = getElementByIdOrNull<HTMLInputElement>('skills-url-input');
        const url = input?.value?.trim();
        if (url) {
          this.installFromUrl(url);
        }
      });
    }
    const urlInput = getElementByIdOrNull<HTMLInputElement>('skills-url-input');
    if (urlInput) {
      urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          const target = e.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          const url = target.value.trim();
          if (url) {
            this.installFromUrl(url);
          }
        }
      });
    }

    // Filter buttons
    const filterBar = getElementByIdOrNull<HTMLElement>('skills-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', (e: MouseEvent) => {
        const target = e.target;
        const btn =
          target instanceof HTMLElement ? target.closest<HTMLElement>('[data-filter]') : null;
        if (!btn) {
          return;
        }
        const filter = btn.dataset.filter;
        if (!filter) {
          return;
        }
        this.currentFilter = filter;
        // Update active state
        filterBar.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) => {
          b.classList.toggle('bg-yellow-400', b.dataset.filter === this.currentFilter);
          b.classList.toggle('text-gray-900', b.dataset.filter === this.currentFilter);
          b.classList.toggle('bg-gray-700', b.dataset.filter !== this.currentFilter);
          b.classList.toggle('text-gray-300', b.dataset.filter !== this.currentFilter);
        });
        this.render();
      });
    }
  },

  /**
   * Render the full skills view
   */
  render(): void {
    const container = getElementByIdOrNull<HTMLElement>('skills-content');
    if (!container) {
      return;
    }

    const installed = this._filterSkills(this.installed);
    const available = this._filterSkills(this.catalog);

    container.innerHTML = `
      ${
        installed.length > 0
          ? `
        <div class="mb-6">
          <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Installed (${installed.length})
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            ${installed.map((s) => this._renderCard(s, true)).join('')}
          </div>
        </div>
      `
          : ''
      }

      <div class="mb-6">
        <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Available (${available.length})
        </h3>
        ${
          available.length > 0
            ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            ${available.map((s) => this._renderCard(s, false)).join('')}
          </div>
        `
            : `
          <p class="text-gray-500 text-sm">
            ${this.searchQuery ? 'No skills match your search.' : 'Loading catalog...'}
          </p>
        `
        }
      </div>
    `;

    // Bind card actions
    container.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const source = btn.dataset.source;
        if (!action || !id || !source) {
          return;
        }
        if (action === 'install') {
          this.install(source, id);
        } else if (action === 'uninstall') {
          this.uninstall(source, id);
        } else if (action === 'toggle') {
          this.toggle(source, id, btn.dataset.enabled !== 'true');
        }
      });
    });

    // Bind card click for detail
    container.querySelectorAll<HTMLElement>('[data-skill-card]').forEach((card) => {
      card.addEventListener('click', () => {
        const source = card.dataset.source;
        const id = card.dataset.id;
        if (!source || !id) {
          return;
        }
        this.showDetail(source, id);
      });
    });
  },

  /**
   * Filter skills by current filter + search query
   */
  _filterSkills(skills: SkillItem[]): SkillItem[] {
    let filtered = skills;

    // Source filter
    if (this.currentFilter !== 'all' && this.currentFilter !== 'installed') {
      filtered = filtered.filter((s) => s.source === this.currentFilter);
    }

    // Search filter
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q)
      );
    }

    return filtered;
  },

  /**
   * Render a single skill card
   */
  _renderCard(skill: SkillItem, isInstalled: boolean): string {
    const sourceColors = {
      mama: 'bg-yellow-900/30 text-yellow-400',
      cowork: 'bg-blue-900/30 text-blue-400',
      external: 'bg-purple-900/30 text-purple-400',
    };
    const badgeClass = sourceColors[skill.source] || 'bg-gray-700 text-gray-400';
    const enabledClass = skill.enabled !== false ? 'border-green-500/30' : 'border-gray-700';

    return `
      <div class="bg-gray-800 rounded-lg border ${enabledClass} p-3 cursor-pointer
        hover:border-yellow-500/50 transition-colors"
        data-skill-card data-id="${this._escapeHtml(skill.id)}" data-source="${this._escapeHtml(skill.source)}">
        <div class="flex items-start justify-between mb-2">
          <h4 class="font-medium text-sm text-white truncate flex-1">${this._escapeHtml(skill.name)}</h4>
          <span class="text-xs px-1.5 py-0.5 rounded ${badgeClass} ml-2 whitespace-nowrap">
            ${this._escapeHtml(skill.source)}
          </span>
        </div>
        <p class="text-xs text-gray-400 line-clamp-2 mb-3">${this._escapeHtml(skill.description || '')}</p>
        <div class="flex items-center justify-between">
          ${
            isInstalled
              ? `
            <button data-action="toggle" data-id="${this._escapeHtml(skill.id)}" data-source="${this._escapeHtml(skill.source)}"
              data-enabled="${skill.enabled !== false}"
              class="text-xs px-2 py-1 rounded ${skill.enabled !== false ? 'bg-green-900/30 text-green-400' : 'bg-gray-700 text-gray-400'}">
              ${skill.enabled !== false ? 'Enabled' : 'Disabled'}
            </button>
            <button data-action="uninstall" data-id="${this._escapeHtml(skill.id)}" data-source="${this._escapeHtml(skill.source)}"
              class="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50">
              Remove
            </button>
          `
              : `
            <span></span>
            <button data-action="install" data-id="${this._escapeHtml(skill.id)}" data-source="${this._escapeHtml(skill.source)}"
              class="text-xs px-2 py-1 rounded bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/50">
              Install
            </button>
          `
          }
        </div>
      </div>
    `;
  },

  /**
   * Install a skill
   */
  async install(source: string, name: string): Promise<void> {
    try {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-action="install"][data-id="${CSS.escape(name)}"][data-source="${CSS.escape(source)}"]`
      );
      if (btn) {
        btn.textContent = 'Installing...';
        btn.disabled = true;
      }
      await API.installSkill(source, name);
      await this.loadSkills();
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Install failed:', message);
      alert(`Failed to install ${name}: ${message}`);
      this.render();
    }
  },

  /**
   * Install from GitHub URL
   */
  async installFromUrl(url: string): Promise<void> {
    const btn = getElementByIdOrNull<HTMLButtonElement>('skills-url-install-btn');
    const input = getElementByIdOrNull<HTMLInputElement>('skills-url-input');
    try {
      if (btn) {
        btn.textContent = 'Installing...';
        btn.disabled = true;
      }
      await API.installSkillFromUrl(url);
      if (input) {
        input.value = '';
      }
      await this.loadSkills();
      this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('URL install failed:', message);
      alert(`Failed to install from URL: ${message}`);
    } finally {
      if (btn) {
        btn.textContent = 'Install URL';
        btn.disabled = false;
      }
    }
  },

  /**
   * Uninstall a skill
   */
  async uninstall(source: string, name: string): Promise<void> {
    if (!confirm(`Remove skill "${name}"?`)) {
      return;
    }

    try {
      await API.uninstallSkill(name, source);
      await this.loadSkills();
      this.render();
    } catch (error) {
      logger.error('Uninstall failed:', error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Toggle skill enabled/disabled
   */
  async toggle(source: string, name: string, enabled: boolean): Promise<void> {
    try {
      await API.toggleSkill(name, enabled, source);
      // Update local state
      const skill = this.installed.find((s) => s.id === name && s.source === source);
      if (skill) {
        skill.enabled = enabled;
      }
      this.render();
    } catch (error) {
      logger.error('Toggle failed:', error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Show skill detail modal
   */
  async showDetail(source: string, name: string): Promise<void> {
    const modal = getElementByIdOrNull<HTMLElement>('skill-detail-modal');
    const modalContent = getElementByIdOrNull<HTMLElement>('skill-detail-content');
    if (!modal || !modalContent) {
      return;
    }

    modalContent.innerHTML = '<p class="text-gray-400">Loading...</p>';
    modal.classList.remove('hidden');

    try {
      const { content } = await API.getSkillContent(name, source);
      modalContent.innerHTML = `
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold text-white">${this._escapeHtml(name)}</h2>
          <span class="text-xs px-2 py-1 rounded bg-gray-700 text-gray-400">${this._escapeHtml(source)}</span>
        </div>
        <div class="prose prose-invert prose-sm max-w-none">
          ${this._renderMarkdown(content)}
        </div>
      `;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      modalContent.innerHTML = `<p class="text-red-400">Failed to load: ${this._escapeHtml(message)}</p>`;
    }
  },

  /**
   * Close detail modal
   */
  closeDetail(): void {
    const modal = getElementByIdOrNull<HTMLElement>('skill-detail-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  },

  /**
   * Escape HTML special characters
   */
  _escapeHtml(unsafe: unknown): string {
    if (!unsafe) {
      return '';
    }
    return unsafe
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  /**
   * Render markdown to HTML using marked.js, with sanitization
   */
  _renderMarkdown(md: string): string {
    if (!md) {
      return '';
    }
    // Remove frontmatter
    md = md.replace(/^---\n[\s\S]*?\n---\n/, '');
    return renderSafeMarkdown(md);
  },
};

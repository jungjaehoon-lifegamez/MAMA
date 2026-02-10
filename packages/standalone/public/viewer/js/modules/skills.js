/**
 * Skills Marketplace Module
 * @module modules/skills
 * @version 1.0.0
 *
 * Manages skill browsing, installation, and configuration
 * across MAMA, Cowork, and OpenClaw sources.
 */

/* eslint-env browser */

import { API } from '../utils/api.js';

/**
 * Skills marketplace module
 */
export const SkillsModule = {
  /** All skills (installed + catalog) */
  installed: [],
  catalog: [],
  /** Current filter */
  currentFilter: 'all',
  /** Search query */
  searchQuery: '',
  /** Whether initialized */
  _initialized: false,
  /** Debounce timer */
  _searchTimer: null,

  /**
   * Initialize the skills tab
   */
  async init() {
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
  async loadSkills() {
    try {
      const [installedRes, catalogRes] = await Promise.all([
        API.getSkills().catch(() => ({ skills: [] })),
        API.getSkillCatalog('all').catch(() => ({ skills: [] })),
      ]);

      this.installed = installedRes.skills || [];
      this.catalog = (catalogRes.skills || []).filter(
        (s) => !this.installed.some((i) => i.id === s.id && i.source === s.source)
      );
    } catch (error) {
      console.error('[Skills] Failed to load:', error);
    }
  },

  /**
   * Bind UI events
   */
  _bindEvents() {
    // Search input
    const searchInput = document.getElementById('skills-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
          this.searchQuery = e.target.value.trim();
          this.render();
        }, 300);
      });
    }

    // Filter buttons
    const filterBar = document.getElementById('skills-filter-bar');
    if (filterBar) {
      filterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-filter]');
        if (!btn) {
          return;
        }
        this.currentFilter = btn.dataset.filter;
        // Update active state
        filterBar.querySelectorAll('[data-filter]').forEach((b) => {
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
  render() {
    const container = document.getElementById('skills-content');
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
    container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const source = btn.dataset.source;
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
    container.querySelectorAll('[data-skill-card]').forEach((card) => {
      card.addEventListener('click', () => {
        this.showDetail(card.dataset.source, card.dataset.id);
      });
    });
  },

  /**
   * Filter skills by current filter + search query
   */
  _filterSkills(skills) {
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
          s.description.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q)
      );
    }

    return filtered;
  },

  /**
   * Render a single skill card
   */
  _renderCard(skill, isInstalled) {
    const sourceColors = {
      mama: 'bg-yellow-900/30 text-yellow-400',
      cowork: 'bg-blue-900/30 text-blue-400',
      openclaw: 'bg-green-900/30 text-green-400',
    };
    const badgeClass = sourceColors[skill.source] || 'bg-gray-700 text-gray-400';
    const enabledClass = skill.enabled !== false ? 'border-green-500/30' : 'border-gray-700';

    return `
      <div class="bg-gray-800 rounded-lg border ${enabledClass} p-3 cursor-pointer
        hover:border-yellow-500/50 transition-colors"
        data-skill-card data-id="${skill.id}" data-source="${skill.source}">
        <div class="flex items-start justify-between mb-2">
          <h4 class="font-medium text-sm text-white truncate flex-1">${this._escapeHtml(skill.name)}</h4>
          <span class="text-xs px-1.5 py-0.5 rounded ${badgeClass} ml-2 whitespace-nowrap">
            ${skill.source}
          </span>
        </div>
        <p class="text-xs text-gray-400 line-clamp-2 mb-3">${this._escapeHtml(skill.description)}</p>
        <div class="flex items-center justify-between">
          ${
            isInstalled
              ? `
            <button data-action="toggle" data-id="${skill.id}" data-source="${skill.source}"
              data-enabled="${skill.enabled !== false}"
              class="text-xs px-2 py-1 rounded ${skill.enabled !== false ? 'bg-green-900/30 text-green-400' : 'bg-gray-700 text-gray-400'}">
              ${skill.enabled !== false ? 'Enabled' : 'Disabled'}
            </button>
            <button data-action="uninstall" data-id="${skill.id}" data-source="${skill.source}"
              class="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50">
              Remove
            </button>
          `
              : `
            <span></span>
            <button data-action="install" data-id="${skill.id}" data-source="${skill.source}"
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
  async install(source, name) {
    try {
      const btn = document.querySelector(
        `[data-action="install"][data-id="${name}"][data-source="${source}"]`
      );
      if (btn) {
        btn.textContent = 'Installing...';
        btn.disabled = true;
      }
      await API.installSkill(source, name);
      await this.loadSkills();
      this.render();
    } catch (error) {
      console.error('[Skills] Install failed:', error);
      alert(`Failed to install ${name}: ${error.message}`);
      this.render();
    }
  },

  /**
   * Uninstall a skill
   */
  async uninstall(source, name) {
    if (!confirm(`Remove skill "${name}"?`)) {
      return;
    }

    try {
      await API.uninstallSkill(name, source);
      await this.loadSkills();
      this.render();
    } catch (error) {
      console.error('[Skills] Uninstall failed:', error);
    }
  },

  /**
   * Toggle skill enabled/disabled
   */
  async toggle(source, name, enabled) {
    try {
      await API.toggleSkill(name, enabled, source);
      // Update local state
      const skill = this.installed.find((s) => s.id === name && s.source === source);
      if (skill) {
        skill.enabled = enabled;
      }
      this.render();
    } catch (error) {
      console.error('[Skills] Toggle failed:', error);
    }
  },

  /**
   * Show skill detail modal
   */
  async showDetail(source, name) {
    const modal = document.getElementById('skill-detail-modal');
    const modalContent = document.getElementById('skill-detail-content');
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
          <span class="text-xs px-2 py-1 rounded bg-gray-700 text-gray-400">${source}</span>
        </div>
        <div class="prose prose-invert prose-sm max-w-none">
          ${this._renderMarkdown(content)}
        </div>
      `;
    } catch (error) {
      modalContent.innerHTML = `<p class="text-red-400">Failed to load: ${error.message}</p>`;
    }
  },

  /**
   * Close detail modal
   */
  closeDetail() {
    const modal = document.getElementById('skill-detail-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  },

  /**
   * Simple markdown to HTML renderer
   */
  _renderMarkdown(md) {
    if (!md) {
      return '';
    }
    // Remove frontmatter
    md = md.replace(/^---\n[\s\S]*?\n---\n/, '');

    let html = this._escapeHtml(md);

    // Code blocks
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      '<pre class="bg-gray-900 rounded p-3 my-2 overflow-x-auto"><code>$2</code></pre>'
    );
    // Inline code
    html = html.replace(
      /`([^`]+)`/g,
      '<code class="bg-gray-900 px-1 rounded text-yellow-400">$1</code>'
    );
    // Headers
    html = html.replace(
      /^### (.+)$/gm,
      '<h3 class="text-base font-semibold text-white mt-4 mb-2">$1</h3>'
    );
    html = html.replace(
      /^## (.+)$/gm,
      '<h2 class="text-lg font-bold text-white mt-4 mb-2">$1</h2>'
    );
    html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-white mt-4 mb-2">$1</h1>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Lists
    html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');
    html = html.replace(/(<li.*<\/li>\n?)+/g, '<ul class="my-2">$&</ul>');
    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p class="my-2">');
    html = '<p class="my-2">' + html + '</p>';

    return html;
  },

  /**
   * Escape HTML
   */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};

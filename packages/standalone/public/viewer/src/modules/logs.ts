/**
 * Logs Module — native log viewer replacing playground iframe.
 * Polls /api/logs/daemon with incremental fetching (since/tail).
 */

const POLL_INTERVAL = 2000;
const DEFAULT_TAIL = 500;

interface LogLine {
  raw: string;
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

export class LogsModule {
  private lines: LogLine[] = [];
  private filteredLines: LogLine[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastModified = '';
  private paused = false;
  private searchQuery = '';
  private levelFilter: Set<string> = new Set(['ERROR', 'WARN', 'INFO', 'DEBUG']);
  private autoScroll = true;
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
    this.startPolling();
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.initialized = false;
  }

  private bindEvents(): void {
    const searchInput = document.getElementById('logs-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.toLowerCase();
        this.applyFilters();
      });
    }

    const pauseBtn = document.getElementById('logs-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        this.paused = !this.paused;
        pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
      });
    }

    document.querySelectorAll<HTMLElement>('[data-log-level]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.logLevel!;
        if (this.levelFilter.has(level)) {
          this.levelFilter.delete(level);
          btn.classList.remove('active');
        } else {
          this.levelFilter.add(level);
          btn.classList.add('active');
        }
        this.applyFilters();
      });
    });

    const container = document.getElementById('logs-container');
    if (container) {
      container.addEventListener('scroll', () => {
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
        this.autoScroll = atBottom;
      });
    }
  }

  private async startPolling(): Promise<void> {
    await this.fetchLogs();
    this.pollTimer = setInterval(() => {
      if (!this.paused) this.fetchLogs();
    }, POLL_INTERVAL);
  }

  private async fetchLogs(): Promise<void> {
    try {
      const params = new URLSearchParams({ tail: String(DEFAULT_TAIL) });
      if (this.lastModified) params.set('since', this.lastModified);

      const res = await fetch(`/api/logs/daemon?${params}`);
      if (res.status === 304) return;
      if (!res.ok) return;

      this.lastModified = res.headers.get('x-last-modified') || '';
      const text = await res.text();
      const newLines = text
        .split('\n')
        .filter(Boolean)
        .map((raw) => this.parseLine(raw));

      if (this.lastModified) {
        this.lines.push(...newLines);
        if (this.lines.length > 5000) {
          this.lines = this.lines.slice(-5000);
        }
      } else {
        this.lines = newLines;
      }

      this.applyFilters();
    } catch {
      // Polling errors are silent
    }
  }

  private parseLine(raw: string): LogLine {
    const match = raw.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(ERROR|WARN|INFO|DEBUG)\s*(.*)/);
    if (match) {
      return { raw, timestamp: match[1], source: match[2], level: match[3], message: match[4] };
    }
    return { raw, timestamp: '', source: '', level: 'INFO', message: raw };
  }

  private applyFilters(): void {
    this.filteredLines = this.lines.filter((line) => {
      if (!this.levelFilter.has(line.level)) return false;
      if (this.searchQuery && !line.raw.toLowerCase().includes(this.searchQuery)) return false;
      return true;
    });
    this.render();
  }

  private render(): void {
    const container = document.getElementById('logs-container');
    if (!container) return;

    const countEl = document.getElementById('logs-count');
    if (countEl) countEl.textContent = `${this.filteredLines.length} lines`;

    const fragment = document.createDocumentFragment();
    for (const line of this.filteredLines) {
      const div = document.createElement('div');
      div.className = `logs-line logs-level-${line.level.toLowerCase()}`;
      div.innerHTML = `<span class="logs-ts">${this.escapeHtml(line.timestamp)}</span> <span class="logs-src">${this.escapeHtml(line.source)}</span> <span class="logs-lvl">${line.level}</span> <span class="logs-msg">${this.escapeHtml(line.message)}</span>`;
      fragment.appendChild(div);
    }

    container.innerHTML = '';
    container.appendChild(fragment);

    if (this.autoScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

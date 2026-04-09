import { API, type ConnectorActivitySummary, type ConnectorFeedChannel } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { createCollapsible, createResizeHandle } from '../utils/dom.js';

const logger = new DebugLogger('ConnectorFeed');

// ── Style constants ─────────────────────────────────────────────────────────

const COLOR = {
  primary: '#1A1A1A',
  secondary: '#6B6560',
  tertiary: '#9E9891',
  border: '#EDE9E1',
  bg: '#FAFAF8',
  red: '#D94F4F',
  green: '#3A9E7E',
  yellow: '#F5C518',
} as const;

const CONNECTOR_ICON: Record<string, string> = {
  calendar: '\u{1F4C5}',
  slack: '\u{1F4AC}',
  discord: '\u{1F4AC}',
  telegram: '\u{1F4AC}',
  trello: '\u{1F4CB}',
  kagemusha: '\u{1F977}',
  'claude-code': '\u{1F916}',
  gmail: '\u{1F4E7}',
  notion: '\u{1F4DD}',
  obsidian: '\u{1F4D3}',
  sheets: '\u{1F4CA}',
  drive: '\u{1F4C1}',
  chatwork: '\u{1F4AC}',
  imessage: '\u{1F4AC}',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ts: string | number): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

// ── Connector Feed Module ───────────────────────────────────────────────────

export class ConnectorFeedModule {
  private container: HTMLElement | null = null;
  private selectedConnector: string | null = null;

  init(): void {
    this.container = document.getElementById('feed-content');
    if (!this.container) return;
    this.loadConnectors();
  }

  private async loadConnectors(): Promise<void> {
    if (!this.container) return;
    try {
      const res = await API.getConnectorActivity();
      this.renderConnectorList(res.connectors);
    } catch (err) {
      logger.error('Failed to load connectors', err);
      this.container.innerHTML =
        '<div style="padding:40px;text-align:center;color:#9E9891;font-size:14px">Failed to load connectors.</div>';
    }
  }

  private renderConnectorList(connectors: ConnectorActivitySummary[]): void {
    if (!this.container) return;

    if (connectors.length === 0) {
      this.container.innerHTML =
        '<div style="padding:40px;text-align:center;color:#9E9891;font-size:14px">' +
        'No connectors configured. Add connectors in Settings to see their feeds here.</div>';
      return;
    }

    let html = '<div style="display:flex;gap:16px;height:100%">';

    // Left: Connector list
    html += `<div id="connector-list" style="width:280px;min-width:280px;overflow-y:auto;border-right:1px solid ${COLOR.border};padding-right:16px">`;
    html += `<h2 style="font-family:Fredoka,sans-serif;font-size:16px;font-weight:600;color:${COLOR.primary};margin:0 0 12px 0">Connectors</h2>`;

    for (const c of connectors) {
      const isActive = this.selectedConnector === c.connector;
      const bgColor = isActive ? '#F5F3EF' : 'transparent';
      const borderLeft = isActive ? `3px solid ${COLOR.primary}` : '3px solid transparent';
      const icon = CONNECTOR_ICON[c.connector] || '\u{1F517}';

      let statusHtml = '';
      if (c.status === 'active') {
        const rel = relativeTime(c.timestamp);
        statusHtml = `<span style="font-size:11px;color:${COLOR.green}">\u25CF active</span> <span style="font-size:10px;color:${COLOR.tertiary}">${esc(rel)}</span>`;
      } else if (c.status === 'idle') {
        statusHtml = `<span style="font-size:11px;color:${COLOR.tertiary}">\u25CB idle</span>`;
      } else {
        statusHtml = `<span style="font-size:11px;color:${COLOR.red}">\u26A0\uFE0F \uBBF8\uC5F0\uACB0</span>`;
      }

      html +=
        `<div class="connector-item" data-connector="${esc(c.connector)}" ` +
        `style="padding:10px 12px;margin-bottom:4px;border-radius:4px;cursor:pointer;` +
        `background:${bgColor};border-left:${borderLeft};transition:background 0.15s">` +
        `<div style="display:flex;align-items:center;gap:8px">` +
        `<span style="font-size:16px">${icon}</span>` +
        `<span style="font-size:13px;font-weight:600;color:${COLOR.primary}">${esc(c.connector)}</span>` +
        `</div>` +
        `<div style="margin-top:4px;padding-left:24px">${statusHtml}</div>` +
        `</div>`;
    }
    html += '</div>';

    // Right: Detail panel
    html += '<div id="connector-detail" style="flex:1;overflow-y:auto;padding-left:16px">';
    if (this.selectedConnector) {
      html += `<div style="color:${COLOR.tertiary};font-size:13px">Loading...</div>`;
    } else {
      html +=
        `<div style="padding:40px;text-align:center;color:${COLOR.tertiary};font-size:13px">` +
        'Select a connector to view its feed.</div>';
    }
    html += '</div></div>';

    this.container.innerHTML = html;

    // Attach resize handle to connector list panel
    const listPanel = document.getElementById('connector-list');
    if (listPanel) {
      createResizeHandle(listPanel, {
        storageKey: 'feed-connector-list-width',
        minWidth: 180,
        maxWidth: 500,
      });
    }

    // Bind click events
    this.container.querySelectorAll('.connector-item').forEach((el) => {
      el.addEventListener('click', () => {
        const name = (el as HTMLElement).dataset.connector;
        if (name) this.selectConnector(name, connectors);
      });
    });

    // Auto-select first connector if none selected
    if (!this.selectedConnector && connectors.length > 0) {
      this.selectConnector(connectors[0].connector, connectors);
    }
  }

  private async selectConnector(
    name: string,
    _connectors: ConnectorActivitySummary[]
  ): Promise<void> {
    this.selectedConnector = name;

    // Update list selection highlight
    this.container?.querySelectorAll('.connector-item').forEach((el) => {
      const id = (el as HTMLElement).dataset.connector;
      const isActive = id === name;
      (el as HTMLElement).style.background = isActive ? '#F5F3EF' : 'transparent';
      (el as HTMLElement).style.borderLeft = isActive
        ? `3px solid ${COLOR.primary}`
        : '3px solid transparent';
    });

    const detail = document.getElementById('connector-detail');
    if (!detail) return;
    detail.innerHTML = `<div style="color:${COLOR.tertiary};font-size:13px">Loading feed...</div>`;

    try {
      const res = await API.getConnectorFeed(name);
      this.renderFeedDetail(detail, name, res.feed);
    } catch (err) {
      logger.error('Failed to load connector feed', err);
      detail.innerHTML = `<div style="color:${COLOR.red};font-size:13px">Failed to load feed.</div>`;
    }
  }

  private renderFeedDetail(
    container: HTMLElement,
    name: string,
    feed: ConnectorFeedChannel[]
  ): void {
    const icon = CONNECTOR_ICON[name] || '\u{1F517}';

    // Clear and build header
    container.innerHTML = '';

    const header = document.createElement('div');
    header.setAttribute('style', 'margin-bottom:16px');
    header.innerHTML =
      `<h2 style="font-family:Fredoka,sans-serif;font-size:16px;font-weight:600;color:${COLOR.primary};margin:0">${icon} ${esc(name)}</h2>` +
      `<div style="font-size:11px;color:${COLOR.tertiary};margin-top:4px">${feed.length} channel${feed.length !== 1 ? 's' : ''}</div>`;
    container.appendChild(header);

    if (feed.length === 0) {
      const empty = document.createElement('div');
      empty.setAttribute(
        'style',
        `padding:20px;text-align:center;color:${COLOR.tertiary};font-size:13px`
      );
      empty.textContent = 'No feed data available for this connector.';
      container.appendChild(empty);
      return;
    }

    // Channel-grouped items with collapsible headers and newest-first sort
    for (const ch of feed) {
      // Sort items newest first by timestamp
      const sorted = [...ch.items].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      let itemsHtml = '';
      for (const item of sorted) {
        const rel = relativeTime(item.timestamp);
        const preview = item.content.replace(/\n/g, ' ').slice(0, 120);
        itemsHtml += `<div style="padding:8px 12px;border-bottom:1px solid ${COLOR.border}">`;
        itemsHtml += `<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">`;
        itemsHtml += `<span style="font-size:11px;font-weight:600;color:${COLOR.primary}">${esc(item.author)}</span>`;
        itemsHtml += `<span style="font-size:10px;color:${COLOR.tertiary};padding:0 4px;background:${COLOR.bg};border-radius:2px">${esc(item.type)}</span>`;
        itemsHtml += `<span style="font-size:10px;color:${COLOR.tertiary};margin-left:auto;white-space:nowrap">${esc(rel)}</span>`;
        itemsHtml += `</div>`;
        itemsHtml += `<div style="font-size:11px;color:${COLOR.secondary};line-height:1.5">${esc(preview)}</div>`;
        itemsHtml += `</div>`;
      }

      const channelHeading = `#${esc(ch.channel)} (${ch.items.length} items)`;
      const channelGroup = createCollapsible(channelHeading, itemsHtml, {
        storageKey: `feed-channel-${name}-${ch.channel}`,
        defaultOpen: true,
        headingStyle: `font-size:12px;font-weight:600;color:${COLOR.primary};padding:10px 12px;background:${COLOR.bg};`,
        containerStyle: `margin-bottom:16px;border:1px solid ${COLOR.border};border-radius:4px;background:#fff;overflow:hidden;`,
      });
      container.appendChild(channelGroup);
    }
  }

  destroy(): void {
    this.selectedConnector = null;
  }
}

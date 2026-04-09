import {
  API,
  type ReportSlot,
  type IntelligenceSummaryResponse,
  type NoticesResponse,
  type PipelineResponse,
  type ConnectorActivityResponse,
  type IntelligenceProjectsResponse,
  type AgentNotice,
  type PipelineProject,
  type ConnectorActivitySummary,
} from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';

declare const DOMPurify: { sanitize(html: string): string };

const logger = new DebugLogger('Dashboard');

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

const S = {
  heading: `font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:${COLOR.primary};margin:0 0 10px 0;`,
  body: `font-size:12px;color:${COLOR.secondary};line-height:1.6;margin:0;`,
  pill: `display:inline-block;font-size:10px;padding:1px 6px;border-radius:2px;font-weight:600;`,
  row: `display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid ${COLOR.border};`,
  time: `font-size:10px;color:${COLOR.tertiary};min-width:48px;white-space:nowrap;font-variant-numeric:tabular-nums;`,
  section: `background:#fff;border:1px solid ${COLOR.border};border-radius:4px;padding:16px 20px;margin-bottom:12px;`,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Dashboard Module ────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class DashboardModule {
  private container: HTMLElement | null = null;
  private eventSource: EventSource | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  init(): void {
    this.container = document.getElementById('dashboard-slots');
    if (!this.container) return;
    this.loadDashboard();
    this.connectSse();
    this.refreshTimer = setInterval(() => this.loadDashboard(), REFRESH_INTERVAL);
  }

  private async loadDashboard(): Promise<void> {
    if (!this.container) return;
    try {
      const [summaryRes, noticesRes, pipelineRes, connectorRes, projectsRes, slotsRes] =
        await Promise.all([
          API.getIntelligenceSummary().catch(
            (): IntelligenceSummaryResponse => ({ text: '', generatedAt: null })
          ),
          API.getNotices(10).catch((): NoticesResponse => ({ notices: [] })),
          API.getPipeline().catch((): PipelineResponse => ({ projects: [] })),
          API.getConnectorActivity().catch((): ConnectorActivityResponse => ({ connectors: [] })),
          API.getProjects().catch((): IntelligenceProjectsResponse => ({ projects: [] })),
          API.getReportSlots().catch((): { slots: ReportSlot[] } => ({ slots: [] })),
        ]);

      this.render({
        summary: summaryRes,
        notices: noticesRes.notices,
        pipeline: pipelineRes.projects,
        connectors: connectorRes.connectors,
        totalDecisions: projectsRes.projects.reduce((sum, p) => sum + p.activeDecisions, 0),
        agentCount: new Set(noticesRes.notices.map((n) => n.agent)).size,
        briefingSlot: slotsRes.slots.find((s) => s.slotId === 'briefing') ?? null,
      });
    } catch (err) {
      logger.error('Failed to load dashboard data', err);
    }
  }

  private connectSse(): void {
    try {
      this.eventSource = new EventSource('/api/report/events');
      this.eventSource.addEventListener('report-update', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          if (data.slots && Array.isArray(data.slots)) {
            const briefing = data.slots.find((s: ReportSlot) => s.slotId === 'briefing');
            if (briefing) this.updateBriefingSection(briefing.html);
          } else if (data.slot === 'briefing' && typeof data.html === 'string') {
            this.updateBriefingSection(data.html);
          }
        } catch (err) {
          logger.error('SSE parse error', err);
        }
      });
      this.eventSource.onerror = () => {
        logger.warn('SSE connection lost, will auto-reconnect');
      };
    } catch (err) {
      logger.error('Failed to connect SSE', err);
    }
  }

  private updateBriefingSection(html: string): void {
    const el = this.container?.querySelector('#dash-briefing-content') as HTMLElement | null;
    if (!el) return;
    const clean = DOMPurify.sanitize(html);
    if (el.innerHTML !== clean) el.innerHTML = clean;
  }

  private render(data: {
    summary: IntelligenceSummaryResponse;
    notices: AgentNotice[];
    pipeline: PipelineProject[];
    connectors: ConnectorActivitySummary[];
    totalDecisions: number;
    agentCount: number;
    briefingSlot: ReportSlot | null;
  }): void {
    if (!this.container) return;

    const emptyEl = document.getElementById('slots-empty');
    const hasData =
      data.summary.text ||
      data.notices.length > 0 ||
      data.pipeline.length > 0 ||
      data.connectors.length > 0 ||
      data.briefingSlot?.html;
    if (!hasData) {
      if (emptyEl) emptyEl.style.display = '';
      this.container.querySelectorAll('.dash-section').forEach((el) => el.remove());
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const sections: string[] = [];

    // ── Section 1: Summary + Notices ──────────────────────────────────────
    {
      let summaryHtml = '';

      // Agent-generated summary
      if (data.briefingSlot?.html) {
        summaryHtml += `<div id="dash-briefing-content" style="margin-bottom:12px">${DOMPurify.sanitize(data.briefingSlot.html)}</div>`;
      } else if (data.summary.text) {
        summaryHtml += `<p style="${S.body}margin-bottom:12px">${esc(data.summary.text)}</p>`;
        if (data.summary.generatedAt) {
          summaryHtml += `<div style="font-size:10px;color:${COLOR.tertiary};margin-bottom:12px">${esc(relativeTime(data.summary.generatedAt))}</div>`;
        }
      } else {
        summaryHtml += `<p style="font-size:12px;color:${COLOR.tertiary};margin-bottom:12px">Waiting for agent briefing...</p>`;
      }

      // Agent notices
      if (data.notices.length > 0) {
        summaryHtml += `<div style="margin-top:8px">`;
        for (const n of data.notices) {
          const time = relativeTime(n.timestamp);
          summaryHtml +=
            `<div style="${S.row}">` +
            `<span style="${S.time}">${esc(time)}</span>` +
            `<span style="${S.pill}background:${COLOR.green}20;color:${COLOR.green}">${esc(n.agent)}</span>` +
            `<span style="font-size:11px;color:${COLOR.primary};flex:1">${esc(n.action)}</span>` +
            `<span style="font-size:10px;color:${COLOR.tertiary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(n.target)}</span>` +
            `</div>`;
        }
        summaryHtml += `</div>`;
      } else {
        summaryHtml += `<div style="font-size:11px;color:${COLOR.tertiary};margin-top:8px">No agent activity yet</div>`;
      }

      sections.push(
        `<div class="dash-section" style="${S.section}">` +
          `<h3 style="${S.heading}">Summary</h3>${summaryHtml}</div>`
      );
    }

    // ── Section 2: Pipeline ──────────────────────────────────────────────
    if (data.pipeline.length > 0) {
      const sorted = [...data.pipeline].sort(
        (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );

      let pipelineHtml = '';
      for (const p of sorted) {
        const rel = relativeTime(p.lastActivity);
        const isRecent = Date.now() - new Date(p.lastActivity).getTime() < 3600000;
        const newBadge = isRecent
          ? ' <span style="color:#D94F4F;font-size:10px">\u{1F534}</span>'
          : '';
        const dotColor = isRecent ? COLOR.green : COLOR.tertiary;

        pipelineHtml +=
          `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid ${COLOR.border}">` +
          `<span style="display:inline-block;width:6px;height:6px;background:${dotColor};flex-shrink:0"></span>` +
          `<span style="font-size:12px;font-weight:600;color:${COLOR.primary};flex:1">${esc(p.project.slice(0, 20))}${newBadge}</span>` +
          `<span style="font-size:10px;color:${COLOR.tertiary}">${p.activeDecisions} decisions</span>` +
          `<span style="${S.time}">${esc(rel)}</span>` +
          `</div>`;
      }

      sections.push(
        `<div class="dash-section" style="${S.section}">` +
          `<h3 style="${S.heading}">Pipeline</h3>${pipelineHtml}</div>`
      );
    }

    // ── Section 3: Connector Activity ────────────────────────────────────
    if (data.connectors.length > 0) {
      let connHtml = '';
      for (const c of data.connectors) {
        const icon = CONNECTOR_ICON[c.connector] || '\u{1F517}';
        if (c.status === 'active') {
          const rel = relativeTime(c.timestamp);
          const snippet = c.content.replace(/\n/g, ' ').slice(0, 60);
          connHtml +=
            `<div style="${S.row}">` +
            `<span style="font-size:14px;min-width:20px">${icon}</span>` +
            `<span style="font-size:12px;font-weight:600;color:${COLOR.primary};min-width:80px">${esc(c.connector)}</span>` +
            `<span style="font-size:11px;color:${COLOR.secondary};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
            `<span style="color:${COLOR.tertiary}">${esc(c.channel)}</span> ${esc(snippet)}</span>` +
            `<span style="${S.time}">${esc(rel)}</span>` +
            `</div>`;
        } else if (c.status === 'idle') {
          connHtml +=
            `<div style="${S.row}">` +
            `<span style="font-size:14px;min-width:20px">${icon}</span>` +
            `<span style="font-size:12px;color:${COLOR.tertiary};flex:1">${esc(c.connector)} <span style="font-size:10px">idle</span></span>` +
            `</div>`;
        } else {
          connHtml +=
            `<div style="${S.row}">` +
            `<span style="font-size:14px;min-width:20px">${icon}</span>` +
            `<span style="font-size:12px;color:${COLOR.red};flex:1">${esc(c.connector)} <span style="font-size:10px">\u26A0\uFE0F \uBBF8\uC5F0\uACB0</span></span>` +
            `</div>`;
        }
      }

      sections.push(
        `<div class="dash-section" style="${S.section}">` +
          `<h3 style="${S.heading}">Connectors</h3>${connHtml}</div>`
      );
    }

    // ── Section 4: System ────────────────────────────────────────────────
    {
      const statsItems: string[] = [];
      statsItems.push(
        `<span style="font-size:11px;color:${COLOR.secondary}">Agents: <strong style="color:${COLOR.primary}">${data.agentCount || '-'}</strong></span>`
      );
      statsItems.push(
        `<span style="font-size:11px;color:${COLOR.secondary}">Decisions: <strong style="color:${COLOR.primary}">${data.totalDecisions}</strong></span>`
      );

      sections.push(
        `<div class="dash-section" style="${S.section}padding:10px 20px;">` +
          `<div style="display:flex;gap:24px;align-items:center">${statsItems.join('')}</div></div>`
      );
    }

    this.container.innerHTML = sections.join('');
  }

  destroy(): void {
    this.eventSource?.close();
    this.eventSource = null;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

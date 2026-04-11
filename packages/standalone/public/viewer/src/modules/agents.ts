/**
 * Agents Module - Interactive Agent Management
 * @module modules/agents
 *
 * Managed Agents pattern: card grid list → detail view with 5 tabs
 * (Config, Persona, Tools, Metrics, History).
 * SmartStore pattern: reportPageContext for agent awareness.
 */

/* eslint-env browser */

import { API, type MultiAgentAgent } from '../utils/api.js';
import { DebugLogger } from '../utils/debug-logger.js';
import { showToast, escapeHtml } from '../utils/dom.js';
import { reportPageContext } from '../utils/ui-commands.js';

const logger = new DebugLogger('Agents');

const C = {
  pri: '#1A1A1A',
  sec: '#6B6560',
  ter: '#9E9891',
  bdr: '#EDE9E1',
  bg: '#FAFAF8',
  agent: '#8b5cf6',
  green: '#3A9E7E',
  red: '#D94F4F',
  yellow: '#FFCE00',
} as const;

type AgentWithVersion = MultiAgentAgent & { system?: string; version?: number };
type DetailTab = 'config' | 'persona' | 'tools' | 'metrics' | 'history';

export class AgentsModule {
  private container: HTMLElement | null = null;
  private initialized = false;
  private agents: AgentWithVersion[] = [];
  private selectedAgent: AgentWithVersion | null = null;
  private activeTab: DetailTab = 'config';

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.container = document.getElementById('agents-content');
    if (!this.container) return;
    this.loadAgents();
  }

  // ── List View ───────────────────────────────────────────────────────────

  private async loadAgents(): Promise<void> {
    if (!this.container) return;
    try {
      const { agents } = await API.getAgents();
      this.agents = agents;
      this.renderList();
      reportPageContext('agents', {
        pageType: 'agent-list',
        summary: `${agents.length} agents`,
        total: agents.length,
      });
    } catch (err) {
      logger.error('Failed to load agents', err);
      showToast('Failed to load agents');
    }
  }

  private renderList(): void {
    if (!this.container) return;
    const cards = this.agents
      .map((a) => {
        const statusColor = a.enabled ? C.green : C.ter;
        const statusText = a.enabled ? 'Active' : 'Disabled';
        return `
        <div class="agent-card" data-agent-id="${escapeHtml(a.id ?? '')}"
             style="background:#fff;border:1px solid ${C.bdr};border-radius:12px;padding:16px;cursor:pointer;transition:box-shadow 0.15s,transform 0.15s;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:15px;font-weight:600;color:${C.pri}">${escapeHtml(a.display_name || a.name || a.id || '')}</span>
            <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:${C.agent}15;color:${C.agent}">T${a.tier ?? 1}</span>
          </div>
          <div style="font-size:12px;color:${C.sec};margin-bottom:6px;">${escapeHtml(a.model || 'No model')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;color:${statusColor};font-weight:500;">\u25CF ${statusText}</span>
            <span style="font-size:11px;color:${C.ter};">v${a.version ?? 0}</span>
          </div>
        </div>`;
      })
      .join('');

    this.container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-size:18px;font-weight:600;color:${C.pri};margin:0;">Agents</h2>
        <button id="btn-create-agent"
                style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:${C.agent};color:#fff;cursor:pointer;font-weight:500;">
          + New Agent
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">
        ${cards}
      </div>`;

    this.container.querySelectorAll('.agent-card').forEach((card) => {
      card.addEventListener('click', () => {
        const agentId = (card as HTMLElement).dataset.agentId;
        if (agentId) this.showDetail(agentId);
      });
    });
    this.container
      .querySelector('#btn-create-agent')
      ?.addEventListener('click', () => this.showCreateModal());
  }

  // ── Detail View ─────────────────────────────────────────────────────────

  private async showDetail(agentId: string): Promise<void> {
    try {
      const agent = await API.getAgent(agentId);
      this.selectedAgent = agent;
      this.activeTab = 'config';
      this.renderDetail();
      reportPageContext('agents', {
        pageType: 'agent-detail',
        selectedAgent: agentId,
        agentVersion: agent.version,
        tab: this.activeTab,
        summary: `${agent.display_name || agent.name} v${agent.version}`,
      });
    } catch (err) {
      logger.error(`Failed to load agent ${agentId}`, err);
      showToast('Failed to load agent details');
    }
  }

  private renderDetail(): void {
    if (!this.container || !this.selectedAgent) return;
    const a = this.selectedAgent;
    const tabs: DetailTab[] = ['config', 'persona', 'tools', 'metrics', 'history'];

    const tabBar = tabs
      .map(
        (t) =>
          `<button class="detail-tab" data-dtab="${t}" style="padding:6px 14px;border:none;border-bottom:2px solid ${this.activeTab === t ? C.agent : 'transparent'};background:none;cursor:pointer;font-size:12px;font-weight:${this.activeTab === t ? '600' : '400'};color:${this.activeTab === t ? C.agent : C.sec};transition:all 0.15s;">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`
      )
      .join('');

    this.container.innerHTML = `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:8px;">
        <button id="btn-back" style="background:none;border:none;cursor:pointer;color:${C.sec};font-size:13px;">\u2190 Agents</button>
        <span style="font-size:16px;font-weight:600;color:${C.pri}">${escapeHtml(a.display_name || a.name || a.id || '')}</span>
        <span style="font-size:11px;color:${C.ter};background:${C.bg};padding:2px 8px;border-radius:4px;">v${a.version ?? 0}</span>
      </div>
      <div style="border-bottom:1px solid ${C.bdr};margin-bottom:16px;display:flex;gap:0;">
        ${tabBar}
      </div>
      <div id="detail-content"></div>`;

    this.container.querySelector('#btn-back')?.addEventListener('click', () => this.showList());
    this.container.querySelectorAll('.detail-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.dtab as DetailTab;
        this.renderDetail();
      });
    });

    const content = this.container.querySelector('#detail-content') as HTMLElement;
    if (!content) return;

    switch (this.activeTab) {
      case 'config':
        this.renderConfigTab(content, a);
        break;
      case 'persona':
        this.renderPersonaTab(content, a);
        break;
      case 'tools':
        this.renderToolsTab(content, a);
        break;
      case 'metrics':
        this.renderMetricsTab(content, a);
        break;
      case 'history':
        this.renderHistoryTab(content, a);
        break;
    }
  }

  private renderConfigTab(el: HTMLElement, a: AgentWithVersion): void {
    const field = (label: string, value: string) =>
      `<div style="margin-bottom:12px;"><label style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">${label}</label><div style="font-size:13px;color:${C.pri};padding:6px 10px;border:1px solid ${C.bdr};border-radius:6px;background:#fff;">${escapeHtml(value)}</div></div>`;

    el.innerHTML = `
      ${field('ID', a.id ?? '')}
      ${field('Name', a.display_name || a.name || '')}
      ${field('Backend', a.backend || 'claude')}
      ${field('Model', a.model || 'Not set')}
      ${field('Tier', String(a.tier ?? 1))}
      ${field('Effort', a.effort || 'Not set')}
      ${field('Can Delegate', String(a.can_delegate ?? false))}
      ${field('Trigger', a.trigger_prefix || 'None')}
      ${field('Cooldown', `${a.cooldown_ms ?? 5000}ms`)}
    `;
  }

  private renderPersonaTab(el: HTMLElement, a: AgentWithVersion): void {
    const text = (a as { system?: string }).system || '(No persona loaded)';
    el.innerHTML = `
      <textarea id="persona-editor" style="width:100%;min-height:300px;font-family:monospace;font-size:12px;padding:10px;border:1px solid ${C.bdr};border-radius:6px;resize:vertical;line-height:1.5;color:${C.pri};background:#fff;">${escapeHtml(text)}</textarea>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="btn-save-persona" style="padding:6px 14px;border:none;border-radius:6px;background:${C.agent};color:#fff;cursor:pointer;font-size:12px;font-weight:500;">Save \u2014 creates v${(a.version ?? 0) + 1}</button>
      </div>`;

    el.querySelector('#btn-save-persona')?.addEventListener('click', async () => {
      const textarea = el.querySelector('#persona-editor') as HTMLTextAreaElement;
      if (!textarea || !a.id) return;
      try {
        const res = await API.updateAgent(a.id, {
          version: a.version ?? 0,
          changes: { system: textarea.value },
          change_note: 'Persona updated via viewer',
        });
        if ((res as { new_version?: number }).new_version) {
          showToast(`v${(res as { new_version: number }).new_version} saved`);
          this.showDetail(a.id);
        }
      } catch (err) {
        showToast('Save failed');
        logger.error('Persona save failed', err);
      }
    });
  }

  private renderToolsTab(el: HTMLElement, a: AgentWithVersion): void {
    const allTools = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'NotebookEdit',
    ];
    const allowed = a.tool_permissions?.allowed ?? [];
    const isAll = allowed.includes('*');

    const rows = allTools
      .map((t) => {
        const checked = isAll || allowed.includes(t);
        return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid ${C.bdr};font-size:13px;color:${C.pri};"><input type="checkbox" ${checked ? 'checked' : ''} data-tool="${t}" style="accent-color:${C.agent}"> ${t}</label>`;
      })
      .join('');

    el.innerHTML = `
      <div style="font-size:11px;color:${C.ter};margin-bottom:8px;">Tier ${a.tier ?? 1} preset applied. Toggle individual tools below.</div>
      <div>${rows}</div>`;
  }

  private async renderMetricsTab(el: HTMLElement, a: AgentWithVersion): Promise<void> {
    el.innerHTML = `<div style="color:${C.ter};font-size:12px;">Loading metrics...</div>`;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const { metrics } = await API.getAgentMetrics(a.id ?? '', weekAgo, today);
      if (!metrics.length) {
        el.innerHTML = `<div style="color:${C.ter};font-size:12px;">No metrics recorded yet for this agent.</div>`;
        return;
      }
      const rows = (metrics as Array<Record<string, unknown>>)
        .map(
          (m) =>
            `<tr style="border-bottom:1px solid ${C.bdr};">
            <td style="padding:4px 8px;font-size:12px;">${m.period_start}</td>
            <td style="padding:4px 8px;font-size:12px;text-align:right;">${m.input_tokens}</td>
            <td style="padding:4px 8px;font-size:12px;text-align:right;">${m.output_tokens}</td>
            <td style="padding:4px 8px;font-size:12px;text-align:right;">${m.tool_calls}</td>
            <td style="padding:4px 8px;font-size:12px;text-align:right;">${m.errors}</td>
          </tr>`
        )
        .join('');
      el.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="border-bottom:2px solid ${C.bdr};font-size:11px;color:${C.ter};">
            <th style="text-align:left;padding:4px 8px;">Date</th>
            <th style="text-align:right;padding:4px 8px;">In Tokens</th>
            <th style="text-align:right;padding:4px 8px;">Out Tokens</th>
            <th style="text-align:right;padding:4px 8px;">Tool Calls</th>
            <th style="text-align:right;padding:4px 8px;">Errors</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch {
      el.innerHTML = `<div style="color:${C.red};font-size:12px;">Failed to load metrics.</div>`;
    }
  }

  private async renderHistoryTab(el: HTMLElement, a: AgentWithVersion): Promise<void> {
    el.innerHTML = `<div style="color:${C.ter};font-size:12px;">Loading versions...</div>`;
    try {
      const { versions } = await API.getAgentVersions(a.id ?? '');
      if (!versions.length) {
        el.innerHTML = `<div style="color:${C.ter};font-size:12px;">No version history.</div>`;
        return;
      }
      const rows = (versions as Array<Record<string, unknown>>)
        .map(
          (v) =>
            `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid ${C.bdr};">
            <span style="font-size:13px;font-weight:600;color:${C.pri};min-width:32px;">v${v.version}</span>
            <span style="font-size:11px;color:${C.ter};">${v.created_at}</span>
            <span style="font-size:12px;color:${C.sec};flex:1;">${escapeHtml(String(v.change_note || ''))}</span>
            ${v.version === a.version ? `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${C.agent}15;color:${C.agent};font-weight:600;">current</span>` : ''}
          </div>`
        )
        .join('');
      el.innerHTML = `<div>${rows}</div>`;
    } catch {
      el.innerHTML = `<div style="color:${C.red};font-size:12px;">Failed to load versions.</div>`;
    }
  }

  // ── Create Modal ────────────────────────────────────────────────────────

  private showCreateModal(): void {
    if (!this.container) return;
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:100;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.15);">
        <h3 style="font-size:16px;font-weight:600;color:${C.pri};margin:0 0 16px 0;">New Agent</h3>
        <div style="margin-bottom:10px;"><label style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">ID (slug)</label><input id="new-id" style="width:100%;padding:6px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" placeholder="qa-specialist" /></div>
        <div style="margin-bottom:10px;"><label style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Name</label><input id="new-name" style="width:100%;padding:6px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" placeholder="QA Specialist" /></div>
        <div style="margin-bottom:10px;"><label style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Model</label><input id="new-model" style="width:100%;padding:6px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" value="claude-sonnet-4-6" /></div>
        <div style="margin-bottom:16px;"><label style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Tier</label><select id="new-tier" style="width:100%;padding:6px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;"><option value="1">T1 (Full)</option><option value="2" selected>T2 (Read/Search)</option><option value="3">T3 (Read only)</option></select></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="btn-cancel" style="padding:6px 14px;border:1px solid ${C.bdr};border-radius:6px;background:#fff;cursor:pointer;font-size:12px;">Cancel</button>
          <button id="btn-create" style="padding:6px 14px;border:none;border-radius:6px;background:${C.agent};color:#fff;cursor:pointer;font-size:12px;font-weight:500;">Create</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.querySelector('#btn-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#btn-create')?.addEventListener('click', async () => {
      const id = (overlay.querySelector('#new-id') as HTMLInputElement).value.trim();
      const name = (overlay.querySelector('#new-name') as HTMLInputElement).value.trim();
      const model = (overlay.querySelector('#new-model') as HTMLInputElement).value.trim();
      const tier = parseInt((overlay.querySelector('#new-tier') as HTMLSelectElement).value, 10);
      if (!id || !name) {
        showToast('ID and Name are required');
        return;
      }
      try {
        await API.createAgent({ id, name, model, tier });
        overlay.remove();
        showToast(`Agent '${name}' created`);
        await this.showDetail(id);
      } catch (err) {
        showToast('Create failed');
        logger.error('Create agent failed', err);
      }
    });
  }

  // ── Navigation ──────────────────────────────────────────────────────────

  showList(): void {
    this.selectedAgent = null;
    this.loadAgents();
  }
}

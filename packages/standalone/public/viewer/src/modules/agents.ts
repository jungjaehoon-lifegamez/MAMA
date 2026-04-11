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
type DetailTab = 'config' | 'persona' | 'tools' | 'activity' | 'history';

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

  private alerts: string[] = [];

  private async loadAgents(): Promise<void> {
    if (!this.container) return;
    try {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const [{ agents }, summaryRes] = await Promise.all([
        API.getAgents(),
        API.getActivitySummary(yesterday).catch(() => ({ summary: [], alerts: [] })),
      ]);
      this.agents = agents;
      this.alerts = summaryRes.alerts;
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

  private static relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  private renderList(): void {
    if (!this.container) return;
    const cards = this.agents
      .map((a) => {
        const lastAct = (a as unknown as Record<string, unknown>).last_activity as
          | Record<string, unknown>
          | null
          | undefined;
        // Status badge: disabled > error > active > idle
        let badgeColor: string;
        let badgeText: string;
        if (a.enabled === false) {
          badgeColor = C.ter;
          badgeText = 'Disabled';
        } else if (lastAct?.type === 'task_error') {
          badgeColor = C.red;
          badgeText = 'Error';
        } else if (
          lastAct?.created_at &&
          Date.now() - new Date(String(lastAct.created_at)).getTime() < 300000
        ) {
          badgeColor = C.green;
          badgeText = 'Active';
        } else {
          badgeColor = '#EAB308';
          badgeText = 'Idle';
        }
        const lastRunStr = lastAct?.created_at
          ? AgentsModule.relativeTime(String(lastAct.created_at))
          : '';
        return `
        <div class="agent-card" data-agent-id="${escapeHtml(a.id ?? '')}"
             style="background:#fff;border:1px solid ${C.bdr};border-radius:12px;padding:16px;cursor:pointer;transition:box-shadow 0.15s,transform 0.15s;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:15px;font-weight:600;color:${C.pri}">${escapeHtml(a.display_name || a.name || a.id || '')}</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:${C.agent}15;color:${C.agent}">T${a.tier ?? 1}</span>
              <label class="agent-toggle-label" style="position:relative;display:inline-flex;align-items:center;cursor:pointer;" title="${a.enabled !== false ? 'Disable' : 'Enable'} agent">
                <input type="checkbox" data-toggle-id="${escapeHtml(a.id ?? '')}" ${a.enabled !== false ? 'checked' : ''} style="position:absolute;opacity:0;width:0;height:0;" />
                <div style="width:28px;height:16px;background:${a.enabled !== false ? C.green : '#D1D5DB'};border-radius:8px;position:relative;transition:background 0.2s;">
                  <div style="position:absolute;top:2px;left:${a.enabled !== false ? '14px' : '2px'};width:12px;height:12px;background:#fff;border-radius:50%;transition:left 0.2s;"></div>
                </div>
              </label>
            </div>
          </div>
          <div style="font-size:12px;color:${C.sec};margin-bottom:6px;">${escapeHtml(a.model || 'No model')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:11px;color:${badgeColor};font-weight:500;">\u25CF ${badgeText}${lastRunStr ? ` \u00B7 ${lastRunStr}` : ''}</span>
          </div>
        </div>`;
      })
      .join('');

    const alertBanner =
      this.alerts.length > 0
        ? `<div class="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700">\u26A0 ${this.alerts.length} agent(s) need attention: ${escapeHtml(this.alerts.slice(0, 3).join(', '))}</div>`
        : '';

    this.container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-size:18px;font-weight:600;color:${C.pri};margin:0;">Agents</h2>
        <button id="btn-create-agent"
                style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:${C.agent};color:#fff;cursor:pointer;font-weight:500;">
          + New Agent
        </button>
      </div>
      ${alertBanner}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">
        ${cards}
      </div>`;

    // Enable toggle — stop propagation so card click doesn't fire
    this.container.querySelectorAll<HTMLInputElement>('[data-toggle-id]').forEach((toggle) => {
      toggle.addEventListener('click', (e) => e.stopPropagation());
      toggle.addEventListener('change', async () => {
        const agentId = toggle.dataset.toggleId;
        if (!agentId) return;
        try {
          await API.put(`/api/multi-agent/agents/${agentId}`, { enabled: toggle.checked });
          showToast(`${agentId} ${toggle.checked ? 'enabled' : 'disabled'}`);
          this.loadAgents();
        } catch {
          showToast('Toggle failed');
          toggle.checked = !toggle.checked;
        }
      });
    });

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
    const tabs: DetailTab[] = ['config', 'persona', 'tools', 'activity', 'history'];

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
      <div style="border-bottom:1px solid ${C.bdr};margin-bottom:16px;display:flex;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch;">
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
      case 'activity':
        void this.renderActivityTab(content, a);
        break;
      case 'history':
        this.renderHistoryTab(content, a);
        break;
    }
  }

  private renderConfigTab(el: HTMLElement, a: AgentWithVersion): void {
    const backend = a.backend || 'claude';
    const modelOptions = (
      backend === 'codex-mcp'
        ? ['gpt-5.3-codex', 'gpt-5.4-mini']
        : ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']
    )
      .map((m) => `<option value="${m}" ${a.model === m ? 'selected' : ''}>${m}</option>`)
      .join('');

    const tierOptions = [1, 2, 3]
      .map((t) => `<option value="${t}" ${(a.tier ?? 1) === t ? 'selected' : ''}>T${t}</option>`)
      .join('');

    const backendOptions = ['claude', 'codex-mcp']
      .map((b) => `<option value="${b}" ${backend === b ? 'selected' : ''}>${b}</option>`)
      .join('');

    el.innerHTML = `
      <div class="space-y-3">
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">ID</label>
          <div class="text-[13px] text-gray-800 px-2.5 py-1.5 border border-gray-200 rounded-md bg-gray-50">${escapeHtml(a.id ?? '')}</div>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Name</label>
          <input id="cfg-name" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]" value="${escapeHtml(a.display_name || a.name || '')}" />
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Backend</label>
          <select id="cfg-backend" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${backendOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Model</label>
          <select id="cfg-model" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${modelOptions}</select>
        </div>
        <div>
          <label class="block text-[11px] text-gray-400 mb-1">Tier</label>
          <select id="cfg-tier" class="agent-input w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-[13px]">${tierOptions}</select>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cfg-enabled" ${a.enabled !== false ? 'checked' : ''} class="accent-[#FFCE00] w-4 h-4" />
            <span class="text-[13px]">Enabled</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cfg-delegate" ${a.can_delegate ? 'checked' : ''} class="accent-[#8b5cf6] w-4 h-4" />
            <span class="text-[13px]">Can Delegate</span>
          </label>
        </div>
        <div class="pt-2">
          <button id="btn-save-config" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save</button>
        </div>
      </div>`;

    // Backend change → update model options
    el.querySelector('#cfg-backend')?.addEventListener('change', () => {
      const newBackend = (el.querySelector('#cfg-backend') as HTMLSelectElement).value;
      const models =
        newBackend === 'codex-mcp'
          ? ['gpt-5.3-codex', 'gpt-5.4-mini']
          : ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
      const modelSelect = el.querySelector('#cfg-model') as HTMLSelectElement;
      modelSelect.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join('');
    });

    // Save uses existing PUT /api/multi-agent/agents/:id (same as Settings)
    el.querySelector('#btn-save-config')?.addEventListener('click', async () => {
      if (!a.id) return;
      try {
        await API.put(`/api/multi-agent/agents/${a.id}`, {
          model: (el.querySelector('#cfg-model') as HTMLSelectElement).value,
          backend: (el.querySelector('#cfg-backend') as HTMLSelectElement).value,
          tier: parseInt((el.querySelector('#cfg-tier') as HTMLSelectElement).value, 10),
          enabled: (el.querySelector('#cfg-enabled') as HTMLInputElement).checked,
          can_delegate: (el.querySelector('#cfg-delegate') as HTMLInputElement).checked,
        });
        showToast('Saved — hot reloaded');

        // Also record in agent_versions for audit trail
        if (a.version !== null && a.version !== undefined) {
          await API.updateAgent(a.id, {
            version: a.version,
            changes: {
              model: (el.querySelector('#cfg-model') as HTMLSelectElement).value,
              tier: parseInt((el.querySelector('#cfg-tier') as HTMLSelectElement).value, 10),
            },
            change_note: 'Config updated via Agents tab',
          }).catch(() => {
            /* audit trail is best-effort */
          });
        }

        this.showDetail(a.id);
      } catch {
        showToast('Save failed');
      }
    });
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
        return `<label class="flex items-center gap-2 py-1.5 border-b border-gray-100 text-[13px] cursor-pointer">
          <input type="checkbox" ${checked ? 'checked' : ''} data-tool="${t}" class="accent-[#8b5cf6] w-4 h-4" /> ${t}
        </label>`;
      })
      .join('');

    el.innerHTML = `
      <div class="text-[11px] text-gray-400 mb-2">Tier ${a.tier ?? 1} preset. Toggle tools and save.</div>
      <div>${rows}</div>
      <div class="pt-3">
        <button id="btn-save-tools" class="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[#8b5cf6] hover:bg-[#7c3aed] transition-colors">Save Tools</button>
      </div>`;

    el.querySelector('#btn-save-tools')?.addEventListener('click', async () => {
      const checked: string[] = [];
      el.querySelectorAll<HTMLInputElement>('input[data-tool]').forEach((cb) => {
        if (cb.checked) checked.push(cb.dataset.tool!);
      });
      if (!a.id) return;
      try {
        await API.put(`/api/multi-agent/agents/${a.id}`, {
          tool_permissions: { allowed: checked },
        });
        showToast('Tools saved ��� hot reloaded');

        // Audit trail (best-effort)
        if (a.version !== null && a.version !== undefined) {
          await API.updateAgent(a.id, {
            version: a.version,
            changes: { tool_permissions: { allowed: checked } },
            change_note: `Tools: ${checked.join(', ')}`,
          }).catch(() => {});
        }

        this.showDetail(a.id);
      } catch {
        showToast('Save failed');
      }
    });
  }

  private async renderActivityTab(el: HTMLElement, a: AgentWithVersion): Promise<void> {
    el.innerHTML = '<div class="text-[12px] text-gray-400">Loading...</div>';
    try {
      const { activity } = await API.getAgentActivity(a.id ?? '', 20);
      if (!activity.length) {
        el.innerHTML =
          '<div class="text-[12px] text-gray-400 py-4 text-center">No activity yet. Delegate a task to this agent to see logs here.</div>';
        return;
      }
      const rows = activity
        .map((ev: Record<string, unknown>) => {
          const typeIcons: Record<string, string> = {
            test_run: '&#x1F9EA;',
            task_error: '&#x274C;',
            config_change: '&#x2699;&#xFE0F;',
            task_start: '&#x25B6;&#xFE0F;',
          };
          const icon = typeIcons[String(ev.type)] || '&#x2705;';
          const scoreStr =
            ev.score !== null && ev.score !== undefined ? ` &mdash; ${ev.score}/100` : '';
          const summary = escapeHtml(String(ev.output_summary || ev.input_summary || ev.type));
          const errorHtml = ev.error_message
            ? `<div class="text-[11px] text-red-500 mt-0.5">${escapeHtml(String(ev.error_message))}</div>`
            : '';
          const meta = `<div class="text-[10px] text-gray-400 mt-0.5">v${ev.agent_version} &middot; ${ev.duration_ms || 0}ms &middot; ${ev.created_at}</div>`;

          // Expandable card for test_run with per-item pass/fail
          if (ev.type === 'test_run' && ev.details) {
            let details: Record<string, unknown> | null = null;
            try {
              details =
                typeof ev.details === 'string'
                  ? (JSON.parse(ev.details) as Record<string, unknown>)
                  : (ev.details as Record<string, unknown>);
            } catch {
              /* ignore parse errors */
            }
            const items = (details?.items as Array<Record<string, unknown>>) ?? [];
            const itemsHtml = items
              .map((item) => {
                const badge =
                  item.result === 'pass'
                    ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">PASS</span>'
                    : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">FAIL</span>';
                return `<div class="flex items-center gap-2 py-1 text-[11px]">${badge}<span class="text-gray-600 truncate">${escapeHtml(String(item.input || ''))}</span></div>`;
              })
              .join('');

            return `<div class="py-2 border-b border-gray-100">
              <div role="button" aria-expanded="false" aria-controls="expand-${ev.id}" data-expand="${ev.id}" class="flex items-center gap-2 cursor-pointer">
                <span class="text-[14px] flex-shrink-0">${icon}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-[12px] font-medium text-gray-800">${summary}${scoreStr}</div>
                  ${meta}
                </div>
                <span class="text-[10px] text-gray-400">&#x25BC;</span>
              </div>
              <div id="expand-${ev.id}" class="hidden mt-2 ml-6 pl-2 border-l-2 border-gray-200">${itemsHtml}</div>
            </div>`;
          }

          return `<div class="flex items-start gap-2 py-2 border-b border-gray-100">
            <span class="text-[14px] flex-shrink-0">${icon}</span>
            <div class="flex-1 min-w-0">
              <div class="text-[12px] font-medium text-gray-800">${summary}${scoreStr}</div>
              ${errorHtml}
              ${meta}
            </div>
          </div>`;
        })
        .join('');
      el.innerHTML = `<div>${rows}</div>`;

      // Expand/collapse toggle with ARIA
      el.querySelectorAll<HTMLElement>('[data-expand]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
          const id = toggle.dataset.expand;
          const content = el.querySelector(`#expand-${id}`);
          if (content) {
            const isHidden = content.classList.toggle('hidden');
            toggle.setAttribute('aria-expanded', String(!isHidden));
          }
        });
      });
    } catch {
      el.innerHTML = '<div class="text-[12px] text-red-500">Failed to load activity.</div>';
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
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Create new agent');
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;width:380px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.15);">
        <h3 style="font-size:16px;font-weight:600;color:${C.pri};margin:0 0 16px 0;">New Agent</h3>
        <div style="margin-bottom:10px;"><label for="new-id" style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">ID (slug)</label><input id="new-id" class="agent-input" style="width:100%;padding:8px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" placeholder="qa-specialist" /></div>
        <div style="margin-bottom:10px;"><label for="new-name" style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Name</label><input id="new-name" class="agent-input" style="width:100%;padding:8px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" placeholder="QA Specialist" /></div>
        <div style="margin-bottom:10px;"><label for="new-model" style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Model</label><input id="new-model" class="agent-input" style="width:100%;padding:8px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;" value="claude-sonnet-4-6" /></div>
        <div style="margin-bottom:16px;"><label for="new-tier" style="font-size:11px;color:${C.ter};display:block;margin-bottom:4px;">Tier</label><select id="new-tier" class="agent-input" style="width:100%;padding:8px 10px;border:1px solid ${C.bdr};border-radius:6px;font-size:13px;"><option value="1">T1 (Full)</option><option value="2" selected>T2 (Read/Search)</option><option value="3">T3 (Read only)</option></select></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="btn-cancel" style="padding:8px 14px;border:1px solid ${C.bdr};border-radius:6px;background:#fff;cursor:pointer;font-size:12px;">Cancel</button>
          <button id="btn-create" style="padding:8px 14px;border:none;border-radius:6px;background:${C.agent};color:#fff;cursor:pointer;font-size:12px;font-weight:500;">Create</button>
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

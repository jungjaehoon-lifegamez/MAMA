/**
 * System views: Runtime (with the backend limit and each person's usage) and Connectors.
 * @module modules/system
 *
 * Read-only truth, one source. Both views render `GET /api/runtime/status` and
 * nothing else: no config read, no client-side model registry, no credential
 * ever reaching the DOM. Editing daemon configuration from the browser is not a
 * capability of this surface; setup is a CLI action.
 */

/* eslint-env browser */

const RUNTIME_STATUS_ENDPOINT = '/api/runtime/status';

export interface RuntimeConnectorStatus {
  name: string;
  healthy: boolean;
  /** ISO time of the last poll, or null before the first. */
  lastPoll: string | null;
  error: string | null;
}

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface PersonUsage {
  agentId: string;
  principalId: string | null;
  name: string;
  today: UsageTotals;
  week: UsageTotals;
  sessions: Array<UsageTotals & { session: string }>;
  actions: Array<{ tool: string; count: number }>;
}

export interface BackendLimitWindow {
  window: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface BackendLimits {
  backend: string;
  windows: BackendLimitWindow[];
  observedAt: number;
}

/** `GET /api/runtime/status`: the daemon's status report, what `mama status` prints. */
export interface RuntimeStatusSnapshot {
  running: boolean;
  version: string;
  backend: string;
  model: string;
  startedAt: number;
  stage: string;
  service: string | null;
  lastError: { at: number; line: string } | null;
  connectors: RuntimeConnectorStatus[];
  usage: { dayStart: number; weekStart: number; people: PersonUsage[] } | null;
  limits: BackendLimits[];
}

export interface SystemViewOptions {
  /** Test seam; defaults to fetching the authoritative endpoint. */
  fetchStatus?: () => Promise<RuntimeStatusSnapshot>;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function defaultFetchStatus(): Promise<RuntimeStatusSnapshot> {
  const response = await fetch(RUNTIME_STATUS_ENDPOINT);
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return (await response.json()) as RuntimeStatusSnapshot;
}

function skeleton(rows: number): string {
  let html = '<div class="mama-system-skeleton" aria-busy="true" aria-live="polite">';
  for (let i = 0; i < rows; i++) {
    html += '<div class="mama-system-skeleton-row"></div>';
  }
  html += '</div>';
  return html;
}

/**
 * Failure names the endpoint that failed and offers a retry. A System view that
 * silently shows nothing is indistinguishable from a healthy empty runtime.
 */
function errorCard(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return (
    '<div class="mama-system-error" role="alert">' +
    '<p class="mama-system-error-title">Could not read ' +
    escapeHtml(RUNTIME_STATUS_ENDPOINT) +
    '</p>' +
    '<p class="mama-system-error-detail">' +
    escapeHtml(detail) +
    '</p>' +
    '<button type="button" class="mama-system-retry" data-retry>Retry</button>' +
    '</div>'
  );
}

function formatUptime(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function statTile(label: string, value: string, tone = 'neutral'): string {
  return (
    '<div class="mama-system-tile" data-tone="' +
    escapeHtml(tone) +
    '">' +
    '<span class="mama-system-tile-label">' +
    escapeHtml(label) +
    '</span>' +
    '<span class="mama-system-tile-value">' +
    escapeHtml(value) +
    '</span>' +
    '</div>'
  );
}

function formatTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 'unknown';
  return new Date(ms).toLocaleString();
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'k';
  return String(value);
}

function totalsText(totals: UsageTotals): string {
  return (
    totals.runs +
    ' runs · ' +
    compactTokens(totals.inputTokens) +
    ' in (' +
    compactTokens(totals.cachedTokens) +
    ' cached) · ' +
    compactTokens(totals.outputTokens) +
    ' out'
  );
}

function row(tone: string, name: string, state: string, detail = ''): string {
  return (
    '<li class="mama-system-row" data-tone="' +
    escapeHtml(tone) +
    '">' +
    '<span class="mama-system-dot"></span>' +
    '<span class="mama-system-row-name">' +
    escapeHtml(name) +
    '</span>' +
    '<span class="mama-system-row-state">' +
    escapeHtml(state) +
    '</span>' +
    (detail ? '<span class="mama-system-row-detail">' + escapeHtml(detail) + '</span>' : '') +
    '</li>'
  );
}

function limitsPanel(limits: BackendLimits[]): string {
  const rows = limits
    .flatMap((limit) =>
      limit.windows.map((window) =>
        row(
          window.usedPercent >= 90 ? 'bad' : window.usedPercent >= 70 ? 'warn' : 'ok',
          limit.backend + ' ' + window.window,
          window.usedPercent + '% used',
          (window.resetsAt === null ? '' : 'resets ' + formatTime(window.resetsAt) + ' · ') +
            'reported ' +
            formatTime(limit.observedAt)
        )
      )
    )
    .join('');
  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Backend limit</h2>' +
    '<p class="mama-system-note">What the login has used, as its CLI last reported it during a turn. Every session shares the login.</p>' +
    (rows
      ? '<ul class="mama-system-list">' + rows + '</ul>'
      : '<p class="mama-system-note">Not reported yet: each CLI reports it during a turn.</p>') +
    '</section>'
  );
}

function usagePanel(usage: RuntimeStatusSnapshot['usage']): string {
  if (!usage) return '';
  let people = '';
  for (const person of usage.people) {
    const sessions = person.sessions
      .slice(0, 5)
      .map((session) => row('neutral', session.session || '(none)', totalsText(session)))
      .join('');
    const actions = person.actions
      .slice(0, 8)
      .map((action) => action.tool + ' ' + action.count)
      .join(' · ');
    people +=
      '<div class="mama-system-person">' +
      '<h3 class="mama-system-subheading">' +
      escapeHtml(person.name) +
      '</h3>' +
      '<div class="mama-system-tiles">' +
      statTile('Today', totalsText(person.today)) +
      statTile('Last 7 days', totalsText(person.week)) +
      '</div>' +
      (sessions
        ? '<p class="mama-system-note">Sessions, last 7 days</p><ul class="mama-system-list">' +
          sessions +
          '</ul>'
        : '') +
      (actions
        ? '<p class="mama-system-note">Actions, last 7 days: ' + escapeHtml(actions) + '</p>'
        : '') +
      '</div>';
  }
  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Usage and actions by person</h2>' +
    '<p class="mama-system-note">Runs and tokens each session recorded, since ' +
    escapeHtml(formatTime(usage.weekStart)) +
    '. Actions are counted by name only.</p>' +
    (people || '<p class="mama-system-note">No runs in the last 7 days.</p>') +
    '</section>'
  );
}

export function renderRuntimeSnapshot(snapshot: RuntimeStatusSnapshot): string {
  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Runtime</h2>' +
    '<p class="mama-system-note">Reported by the running daemon. Configuration is edited via the CLI.</p>' +
    '<div class="mama-system-tiles">' +
    statTile('Daemon', snapshot.running ? 'running' : 'stopped', snapshot.running ? 'ok' : 'bad') +
    statTile('Boot stage', snapshot.stage, snapshot.stage === 'running' ? 'ok' : 'warn') +
    statTile('Service', snapshot.service ?? 'none', snapshot.service ? 'ok' : 'warn') +
    statTile('Version', snapshot.version) +
    statTile('Backend', snapshot.backend) +
    statTile('Model', snapshot.model) +
    statTile('Last boot', formatTime(snapshot.startedAt)) +
    statTile('Uptime', formatUptime(snapshot.startedAt)) +
    statTile(
      'Last error',
      snapshot.lastError
        ? formatTime(snapshot.lastError.at) + ': ' + snapshot.lastError.line
        : 'none since boot',
      snapshot.lastError ? 'bad' : 'ok'
    ) +
    '</div>' +
    '</section>' +
    limitsPanel(snapshot.limits ?? []) +
    usagePanel(snapshot.usage)
  );
}

export function renderConnectorsSnapshot(snapshot: RuntimeStatusSnapshot): string {
  const connectors = snapshot.connectors ?? [];
  if (connectors.length === 0) {
    return (
      '<section class="mama-system-panel">' +
      '<h2 class="mama-system-heading">Connectors</h2>' +
      '<div class="mama-system-empty">' +
      '<p class="mama-system-empty-title">No connectors enabled</p>' +
      '<p class="mama-system-empty-detail">Ask your agent to run:</p>' +
      '<code class="mama-system-code">mama init --section connectors</code>' +
      '</div>' +
      '</section>'
    );
  }
  const rows = connectors
    .map((connector) =>
      row(
        connector.healthy ? 'ok' : 'bad',
        connector.name,
        (connector.healthy ? 'ok' : 'failing') +
          ' · last poll ' +
          (connector.lastPoll ? formatTime(Date.parse(connector.lastPoll)) : 'not yet'),
        connector.error ?? ''
      )
    )
    .join('');
  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Connectors</h2>' +
    '<p class="mama-system-note">Each enabled connector as the running daemon last polled it.</p>' +
    '<ul class="mama-system-list">' +
    rows +
    '</ul>' +
    '</section>'
  );
}

async function renderView(
  container: HTMLElement | null,
  options: SystemViewOptions,
  toHtml: (snapshot: RuntimeStatusSnapshot) => string,
  skeletonRows: number
): Promise<void> {
  if (!container) return;
  const fetchStatus = options.fetchStatus ?? defaultFetchStatus;

  container.innerHTML = skeleton(skeletonRows);
  try {
    const snapshot = await fetchStatus();
    container.innerHTML = toHtml(snapshot);
  } catch (error) {
    container.innerHTML = errorCard(error);
    const retry = container.querySelector('[data-retry]');
    if (retry) {
      retry.addEventListener('click', () => {
        void renderView(container, options, toHtml, skeletonRows);
      });
    }
  }
}

export function renderRuntimeView(
  container: HTMLElement | null,
  options: SystemViewOptions = {}
): Promise<void> {
  return renderView(container, options, renderRuntimeSnapshot, 3);
}

export function renderConnectorsView(
  container: HTMLElement | null,
  options: SystemViewOptions = {}
): Promise<void> {
  return renderView(container, options, renderConnectorsSnapshot, 5);
}

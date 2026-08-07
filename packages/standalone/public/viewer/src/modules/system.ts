/**
 * System views: Runtime and Connectors.
 * @module modules/system
 *
 * Read-only truth, one source. Both views render `GET /api/runtime/status` and
 * nothing else: no config read, no client-side model registry, no credential
 * ever reaching the DOM. Editing daemon configuration from the browser is not a
 * capability of this surface; setup is a CLI action.
 */

/* eslint-env browser */

const RUNTIME_STATUS_ENDPOINT = '/api/runtime/status';

/** Shown when the daemon booted without a health service. Never a fake score. */
const HEALTH_UNAVAILABLE = 'unavailable';

export type RuntimeBackend = 'claude' | 'codex' | 'cline';
export type RuntimeConnectorState = 'connected' | 'disconnected' | 'unknown';

export interface RuntimeConnectorStatus {
  name: string;
  enabled: boolean;
  state: RuntimeConnectorState;
}

export interface RuntimeStatusSnapshot {
  running: boolean;
  backend: RuntimeBackend;
  model: string;
  startedAt: number;
  health: { score: number; status: string } | null;
  connectors: RuntimeConnectorStatus[];
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

function formatStartedAt(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return 'unknown';
  return new Date(startedAt).toLocaleString();
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

export function renderRuntimeSnapshot(snapshot: RuntimeStatusSnapshot): string {
  const health = snapshot.health;
  const healthValue = health ? health.status + ' - ' + health.score : HEALTH_UNAVAILABLE;
  const healthTone = health
    ? health.status === 'healthy'
      ? 'ok'
      : health.status === 'degraded'
        ? 'warn'
        : 'bad'
    : 'muted';

  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Runtime</h2>' +
    '<p class="mama-system-note">Reported by the running daemon; some fields reflect boot-time state. Configuration is edited via the CLI or the config file.</p>' +
    '<div class="mama-system-tiles">' +
    statTile('Daemon', snapshot.running ? 'running' : 'stopped', snapshot.running ? 'ok' : 'bad') +
    statTile('Backend', snapshot.backend) +
    statTile('Model', snapshot.model) +
    statTile('Health', healthValue, healthTone) +
    statTile('Uptime', formatUptime(snapshot.startedAt)) +
    statTile('Started', formatStartedAt(snapshot.startedAt)) +
    '</div>' +
    '</section>'
  );
}

const CONNECTOR_STATE_TONE: Record<RuntimeConnectorState, string> = {
  connected: 'ok',
  disconnected: 'muted',
  unknown: 'warn',
};

/**
 * What a connector state actually means. 'connected' is not a live probe: it
 * says the connector registered when the daemon booted, so the chip carries the
 * narrower claim rather than letting the word oversell itself.
 */
const CONNECTOR_STATE_TITLE: Record<RuntimeConnectorState, string> = {
  connected: 'Registered at daemon boot',
  disconnected: 'Disabled in config',
  unknown: 'Enabled in config but not registered at boot',
};

export function renderConnectorsSnapshot(snapshot: RuntimeStatusSnapshot): string {
  const connectors = snapshot.connectors ?? [];
  if (connectors.length === 0) {
    return (
      '<section class="mama-system-panel">' +
      '<h2 class="mama-system-heading">Connectors</h2>' +
      '<div class="mama-system-empty">' +
      '<p class="mama-system-empty-title">No connectors configured</p>' +
      '<p class="mama-system-empty-detail">Add one from a terminal:</p>' +
      '<code class="mama-system-code">mama connector add &lt;name&gt;</code>' +
      '</div>' +
      '</section>'
    );
  }

  let rows = '';
  for (const connector of connectors) {
    rows +=
      '<li class="mama-system-row" data-tone="' +
      escapeHtml(CONNECTOR_STATE_TONE[connector.state] ?? 'muted') +
      '">' +
      '<span class="mama-system-dot"></span>' +
      '<span class="mama-system-row-name">' +
      escapeHtml(connector.name) +
      '</span>' +
      '<span class="mama-system-row-state" title="' +
      escapeHtml(CONNECTOR_STATE_TITLE[connector.state] ?? 'State reported at daemon boot') +
      '">' +
      escapeHtml(connector.state) +
      '</span>' +
      (connector.enabled ? '' : '<span class="mama-system-badge">off</span>') +
      '</li>';
  }

  return (
    '<section class="mama-system-panel">' +
    '<h2 class="mama-system-heading">Connectors</h2>' +
    '<p class="mama-system-note">Read-only. Add or remove connectors with <code>mama connector add</code>.</p>' +
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

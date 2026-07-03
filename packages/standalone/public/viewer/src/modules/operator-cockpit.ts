/**
 * vNext Operator Cockpit
 *
 * Thin viewer/client layer over primary-operator ingress endpoints.
 * Keep this module projection-only: no canonical state, no raw connector payloads.
 */

/* eslint-env browser */

import { API } from '../utils/api.js';

export interface OperatorCockpitScope {
  connector: string;
  channel: string;
  limit?: number;
}

export interface OperatorAdminAuth {
  adminToken: string;
}

export interface OperatorSourceRef {
  kind?: string;
  connector?: string;
  id?: string;
  source_id?: string;
  channel_id?: string | null;
}

export interface OperatorPreviewEvent {
  seq: number;
  eventIndexId: string;
  sourceTimestampMs: number;
  sourceId: string;
  channel: string | null;
  sourceRef: OperatorSourceRef;
  [key: string]: unknown;
}

export interface OperatorPreviewPayload {
  cursorName: string;
  connector: string;
  channel: string;
  advancedThroughSeq: number;
  events: OperatorPreviewEvent[];
}

export interface OperatorPreviewResponse {
  ok: boolean;
  mode: 'dry_run';
  preview: OperatorPreviewPayload;
}

export interface OperatorDryRunCandidate {
  seq: number;
  eventIndexId: string;
  sourceRef: OperatorSourceRef;
  readiness: 'requires_decision';
}

export interface OperatorDryRunPayload {
  mode?: 'dry_run';
  status: 'idle' | 'ready';
  cursorName?: string;
  connector?: string;
  channel?: string;
  advancedThroughSeq: number;
  candidateCount: number;
  highestCandidateSeq?: number | null;
  requiresOperatorDecision?: boolean;
  durableWrites?: {
    commits: 0;
    cursors: 0;
    noUpdates: 0;
  };
  candidates: OperatorDryRunCandidate[];
}

export interface OperatorDryRunResponse {
  ok: boolean;
  mode: 'dry_run';
  dry_run: OperatorDryRunPayload;
}

export interface OperatorReviewBatch {
  preview: OperatorPreviewResponse;
  dryRun: OperatorDryRunResponse;
}

export interface OperatorReviewState {
  cursor: {
    cursorName: string;
    connector: string;
    channel: string;
    advancedThroughSeq: number;
    status: OperatorDryRunPayload['status'];
    candidateCount: number;
  };
  events: Array<{
    seq: number;
    eventIndexId: string;
    sourceRefText: string;
    sourceId: string;
    channel: string | null;
    sourceTimestampMs: number;
    readiness: OperatorDryRunCandidate['readiness'];
  }>;
}

export interface NoUpdateCommitRequest {
  connector: string;
  channel: string;
  expected_advanced_through_seq: number;
  event_index_ids: string[];
}

export interface WikiCommitRequest {
  connector: string;
  channel: string;
  expected_advanced_through_seq: number;
  event_pages: Array<{
    event_index_id: string;
    pages: Array<{
      path: string;
      title: string;
      type: string;
      content: string;
    }>;
  }>;
}

export interface MemoryCommitRequest {
  connector: string;
  channel: string;
  expected_advanced_through_seq: number;
  event_memories: Array<{
    event_index_id: string;
    memories: Array<Record<string, unknown>>;
  }>;
}

export interface CommitResultCommit {
  seq: number;
  status: string;
  outcome: string;
  cursorAdvanced: boolean;
}

export interface CommitResultInput {
  ok?: boolean;
  mode?: string;
  status?: string;
  cursorName?: string;
  connector?: string;
  channel?: string;
  requestedCount?: number;
  processed?: number;
  advancedThroughSeq?: number;
  firstSeq?: number;
  lastSeq?: number;
  pagesStored?: number;
  memoriesSaved?: number;
  commits?: CommitResultCommit[];
  [key: string]: unknown;
}

export interface OperatorMemoryScope {
  kind: 'channel';
  id: string;
}

export interface CommitResultState {
  ok: boolean;
  mode: string;
  status: string;
  cursorName: string;
  connector: string;
  channel: string;
  requestedCount: number;
  processed: number;
  advancedThroughSeq: number;
  firstSeq: number | null;
  lastSeq: number | null;
  pagesStored: number | null;
  memoriesSaved: number | null;
  commits: CommitResultCommit[];
}

const DEFAULT_CONNECTOR = 'slack';
const DEFAULT_CHANNEL = 'C_PUBLIC_SYNTHETIC';
const DEFAULT_LIMIT = 25;

function queryForScope(scope: OperatorCockpitScope): Record<string, string | number> {
  const query: Record<string, string | number> = {
    connector: scope.connector,
    channel: scope.channel,
  };
  if (typeof scope.limit === 'number') {
    query.limit = scope.limit;
  }
  return query;
}

function sourceRefText(ref: OperatorSourceRef): string {
  const kind = ref.kind ?? 'raw';
  const connector = ref.connector ?? 'unknown';
  const id = ref.id ?? 'unknown';
  if (kind === 'raw') {
    return `raw:${connector}:${id}`;
  }
  return `${kind}:${id}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boolOrFalse(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeCommits(value: unknown): CommitResultCommit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((commit) => {
    const row = commit && typeof commit === 'object' ? (commit as Record<string, unknown>) : {};
    return {
      seq: numberOrZero(row.seq),
      status: stringOrEmpty(row.status),
      outcome: stringOrEmpty(row.outcome),
      cursorAdvanced: boolOrFalse(row.cursorAdvanced),
    };
  });
}

function adminRequestOptions(auth: OperatorAdminAuth): { headers: Record<string, string> } {
  const token = auth.adminToken.trim();
  if (token.length === 0) {
    throw new Error('Admin token is required for operator commits.');
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

export function buildOperatorMemoryScopes(
  connector: string,
  channel: string
): OperatorMemoryScope[] {
  const connectorPart = connector.trim() || DEFAULT_CONNECTOR;
  const channelPart = channel.trim() || DEFAULT_CHANNEL;
  return [{ kind: 'channel', id: `${connectorPart}:${channelPart}` }];
}

export class OperatorCockpitController {
  async fetchReviewBatch(scope: OperatorCockpitScope): Promise<OperatorReviewBatch> {
    const query = queryForScope(scope);
    const [preview, dryRun] = await Promise.all([
      API.get<OperatorPreviewResponse>('/api/vnext/ingress/preview', query),
      API.get<OperatorDryRunResponse>('/api/vnext/ingress/migration-dry-run', query),
    ]);
    return { preview, dryRun };
  }

  async commitNoUpdate(
    body: NoUpdateCommitRequest,
    auth: OperatorAdminAuth
  ): Promise<CommitResultInput> {
    return API.post<CommitResultInput>(
      '/api/vnext/ingress/manual-no-update-commit',
      body,
      adminRequestOptions(auth)
    );
  }

  async commitWiki(body: WikiCommitRequest, auth: OperatorAdminAuth): Promise<CommitResultInput> {
    return API.post<CommitResultInput>(
      '/api/vnext/ingress/manual-wiki-commit',
      body,
      adminRequestOptions(auth)
    );
  }

  async commitMemory(
    body: MemoryCommitRequest,
    auth: OperatorAdminAuth
  ): Promise<CommitResultInput> {
    return API.post<CommitResultInput>(
      '/api/vnext/ingress/manual-memory-commit',
      body,
      adminRequestOptions(auth)
    );
  }
}

export function renderOperatorCockpitShell(): string {
  return `
    <div class="operator-cockpit-shell">
      <form id="operator-cockpit-form" class="operator-cockpit-form">
        <label>
          <span>Connector</span>
          <input name="connector" value="${DEFAULT_CONNECTOR}" autocomplete="off" />
        </label>
        <label>
          <span>Channel</span>
          <input name="channel" value="${DEFAULT_CHANNEL}" autocomplete="off" />
        </label>
        <label>
          <span>Limit</span>
          <input name="limit" type="number" min="1" max="100" value="${DEFAULT_LIMIT}" />
        </label>
        <label>
          <span>Admin token</span>
          <input
            name="admin-token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="MAMA_ADMIN_TOKEN"
          />
        </label>
        <button type="submit" class="operator-cockpit-refresh">Refresh</button>
      </form>
      <div id="operator-cockpit-batch" class="operator-cockpit-batch"></div>
      <div id="operator-cockpit-result" class="operator-cockpit-result-slot"></div>
    </div>
  `;
}

export function renderOperatorError(message: string, _error?: unknown): string {
  return `<div class="operator-cockpit-error">${esc(message)}</div>`;
}

function readTextInput(root: ParentNode, selector: string): string {
  const input = root.querySelector(selector);
  return input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
    ? input.value.trim()
    : '';
}

function readNumberInput(root: ParentNode, selector: string, fallback: number): number {
  const input = root.querySelector(selector);
  if (!(input instanceof HTMLInputElement)) {
    return fallback;
  }
  const value = Number(input.value);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class OperatorCockpitModule {
  private readonly controller: OperatorCockpitController;
  private container: HTMLElement | null = null;
  private currentState: OperatorReviewState | null = null;

  constructor(controller = new OperatorCockpitController()) {
    this.controller = controller;
  }

  init(): void {
    this.container = document.getElementById('operator-cockpit-content');
    if (!this.container) {
      return;
    }
    this.container.innerHTML = renderOperatorCockpitShell();
    this.bindForm();
  }

  private bindForm(): void {
    const form = this.container?.querySelector('#operator-cockpit-form');
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.loadBatch();
    });
  }

  private readScope(): OperatorCockpitScope {
    const root = this.container ?? document;
    return {
      connector: readTextInput(root, 'input[name="connector"]') || DEFAULT_CONNECTOR,
      channel: readTextInput(root, 'input[name="channel"]') || DEFAULT_CHANNEL,
      limit: readNumberInput(root, 'input[name="limit"]', DEFAULT_LIMIT),
    };
  }

  private readAdminAuth(): OperatorAdminAuth {
    const root = this.container ?? document;
    return { adminToken: readTextInput(root, 'input[name="admin-token"]') };
  }

  private async loadBatch(options: { clearResult?: boolean } = {}): Promise<void> {
    const clearResult = options.clearResult ?? true;
    const batchSlot = this.container?.querySelector('#operator-cockpit-batch');
    const resultSlot = this.container?.querySelector('#operator-cockpit-result');
    if (!(batchSlot instanceof HTMLElement)) {
      return;
    }
    if (clearResult && resultSlot instanceof HTMLElement) {
      resultSlot.innerHTML = '';
    }
    batchSlot.innerHTML = '<div class="operator-cockpit-empty">Loading...</div>';

    try {
      const batch = await this.controller.fetchReviewBatch(this.readScope());
      this.currentState = buildOperatorReviewState(batch);
      batchSlot.innerHTML = renderOperatorReviewState(this.currentState);
      this.bindCommitActions();
    } catch (error) {
      batchSlot.innerHTML = renderOperatorError('Operator review failed.', error);
    }
  }

  private bindCommitActions(): void {
    this.container?.querySelectorAll('[data-action][data-event-index-id]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!(button instanceof HTMLElement)) {
          return;
        }
        const eventIndexId = button.dataset.eventIndexId;
        const action = button.dataset.action;
        if (!eventIndexId || !action) {
          return;
        }
        void this.commitEvent(action, eventIndexId, button.closest('.operator-cockpit-row'));
      });
    });
  }

  private async commitEvent(
    action: string,
    eventIndexId: string,
    row: Element | null
  ): Promise<void> {
    const state = this.currentState;
    const resultSlot = this.container?.querySelector('#operator-cockpit-result');
    if (!state || !(resultSlot instanceof HTMLElement)) {
      return;
    }
    resultSlot.innerHTML = '<div class="operator-cockpit-empty">Committing...</div>';
    const base = {
      connector: state.cursor.connector,
      channel: state.cursor.channel,
      expected_advanced_through_seq: state.cursor.advancedThroughSeq,
    };

    try {
      let result: CommitResultInput;
      const auth = this.readAdminAuth();
      if (action === 'no_update') {
        result = await this.controller.commitNoUpdate(
          {
            ...base,
            event_index_ids: [eventIndexId],
          },
          auth
        );
      } else if (action === 'wiki') {
        result = await this.controller.commitWiki(
          {
            ...base,
            event_pages: [
              {
                event_index_id: eventIndexId,
                pages: [
                  {
                    path: readTextInput(row ?? document, '[data-field="wiki-path"]'),
                    title: readTextInput(row ?? document, '[data-field="wiki-title"]'),
                    type: 'entity',
                    content: readTextInput(row ?? document, '[data-field="wiki-content"]'),
                  },
                ],
              },
            ],
          },
          auth
        );
      } else if (action === 'memory') {
        result = await this.controller.commitMemory(
          {
            ...base,
            event_memories: [
              {
                event_index_id: eventIndexId,
                memories: [
                  {
                    topic: readTextInput(row ?? document, '[data-field="memory-topic"]'),
                    kind: 'decision',
                    summary: readTextInput(row ?? document, '[data-field="memory-summary"]'),
                    details: readTextInput(row ?? document, '[data-field="memory-details"]'),
                    confidence: 0.8,
                    scopes: buildOperatorMemoryScopes(state.cursor.connector, state.cursor.channel),
                  },
                ],
              },
            ],
          },
          auth
        );
      } else {
        throw new Error(`Unknown operator action: ${action}`);
      }

      const resultState = buildCommitResultState(result);
      await this.loadBatch({ clearResult: false });
      resultSlot.innerHTML = renderCommitResultState(resultState);
    } catch (error) {
      resultSlot.innerHTML = renderOperatorError('Operator commit failed.', error);
    }
  }
}

export function buildOperatorReviewState(batch: OperatorReviewBatch): OperatorReviewState {
  const readinessByEventIndexId = new Map(
    batch.dryRun.dry_run.candidates.map((candidate) => [
      candidate.eventIndexId,
      candidate.readiness,
    ])
  );
  const preview = batch.preview.preview;

  return {
    cursor: {
      cursorName: preview.cursorName,
      connector: preview.connector,
      channel: preview.channel,
      advancedThroughSeq: preview.advancedThroughSeq,
      status: batch.dryRun.dry_run.status,
      candidateCount: batch.dryRun.dry_run.candidateCount,
    },
    events: preview.events.map((event) => ({
      seq: event.seq,
      eventIndexId: event.eventIndexId,
      sourceRefText: sourceRefText(event.sourceRef),
      sourceId: event.sourceId,
      channel: event.channel,
      sourceTimestampMs: event.sourceTimestampMs,
      readiness: readinessByEventIndexId.get(event.eventIndexId) ?? 'requires_decision',
    })),
  };
}

export function buildCommitResultState(input: CommitResultInput): CommitResultState {
  return {
    ok: boolOrFalse(input.ok),
    mode: stringOrEmpty(input.mode),
    status: stringOrEmpty(input.status),
    cursorName: stringOrEmpty(input.cursorName),
    connector: stringOrEmpty(input.connector),
    channel: stringOrEmpty(input.channel),
    requestedCount: numberOrZero(input.requestedCount),
    processed: numberOrZero(input.processed),
    advancedThroughSeq: numberOrZero(input.advancedThroughSeq),
    firstSeq: numberOrNull(input.firstSeq),
    lastSeq: numberOrNull(input.lastSeq),
    pagesStored: numberOrNull(input.pagesStored),
    memoriesSaved: numberOrNull(input.memoriesSaved),
    commits: sanitizeCommits(input.commits),
  };
}

export function renderOperatorReviewState(state: OperatorReviewState): string {
  const eventRows =
    state.events.length === 0
      ? '<div class="operator-cockpit-empty">No reviewed events.</div>'
      : state.events
          .map(
            (event) => `
              <article class="operator-cockpit-row" data-event-index-id="${esc(event.eventIndexId)}">
                <div class="operator-cockpit-row-main">
                  <div class="operator-cockpit-seq">Seq ${esc(event.seq)}</div>
                  <div class="operator-cockpit-source">${esc(event.sourceRefText)}</div>
                  <div class="operator-cockpit-meta">
                    <span>${esc(event.readiness)}</span>
                    <span>${esc(event.channel ?? 'no-channel')}</span>
                    <span>${esc(event.sourceId)}</span>
                  </div>
                </div>
                <div class="operator-cockpit-actions">
                  <button type="button" data-action="no_update" data-event-index-id="${esc(
                    event.eventIndexId
                  )}">No update</button>
                  <button type="button" data-action="wiki" data-event-index-id="${esc(
                    event.eventIndexId
                  )}">Wiki</button>
                  <button type="button" data-action="memory" data-event-index-id="${esc(
                    event.eventIndexId
                  )}">Memory</button>
                </div>
                <div class="operator-cockpit-editors">
                  <div>
                    <input data-field="wiki-path" value="projects/operator-${esc(event.seq)}.md" />
                    <input data-field="wiki-title" value="Operator ${esc(event.seq)}" />
                    <textarea data-field="wiki-content">Reviewed event ${esc(event.seq)}</textarea>
                  </div>
                  <div>
                    <input data-field="memory-topic" value="operator/event-${esc(event.seq)}" />
                    <input data-field="memory-summary" value="Reviewed event ${esc(event.seq)}" />
                    <textarea data-field="memory-details">Operator reviewed ${esc(
                      event.sourceRefText
                    )}</textarea>
                  </div>
                </div>
              </article>
            `
          )
          .join('');

  return `
    <section class="operator-cockpit-panel">
      <header class="operator-cockpit-header">
        <div>
          <h2>Operator</h2>
          <p>${esc(state.cursor.connector)} / ${esc(state.cursor.channel)}</p>
        </div>
        <div class="operator-cockpit-cursor">
          <span>${esc(state.cursor.cursorName)}</span>
          <strong>${esc(state.cursor.advancedThroughSeq)}</strong>
        </div>
      </header>
      <div class="operator-cockpit-summary">
        <span>${esc(state.cursor.status)}</span>
        <span>${esc(state.cursor.candidateCount)} candidates</span>
      </div>
      <div class="operator-cockpit-list">${eventRows}</div>
    </section>
  `;
}

export function renderCommitResultState(state: CommitResultState): string {
  const commits = state.commits
    .map(
      (commit) => `
        <li>
          <span>Seq ${esc(commit.seq)}</span>
          <span>${esc(commit.status)}</span>
          <span>${esc(commit.outcome)}</span>
          <span>${commit.cursorAdvanced ? 'advanced' : 'held'}</span>
        </li>
      `
    )
    .join('');

  return `
    <section class="operator-cockpit-result" data-ok="${state.ok ? 'true' : 'false'}">
      <header>
        <strong>${esc(state.mode)}</strong>
        <span>${esc(state.status)}</span>
      </header>
      <dl>
        <dt>Cursor</dt><dd>${esc(state.cursorName)}</dd>
        <dt>Connector</dt><dd>${esc(state.connector)}</dd>
        <dt>Channel</dt><dd>${esc(state.channel)}</dd>
        <dt>Processed</dt><dd>${esc(state.processed)} / ${esc(state.requestedCount)}</dd>
        <dt>Advanced</dt><dd>${esc(state.advancedThroughSeq)}</dd>
        <dt>Pages</dt><dd>${esc(state.pagesStored ?? 'n/a')}</dd>
        <dt>Memories</dt><dd>${esc(state.memoriesSaved ?? 'n/a')}</dd>
      </dl>
      <ul>${commits}</ul>
    </section>
  `;
}

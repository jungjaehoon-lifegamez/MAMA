import type { ReportSlot } from './report';

export interface OperatorSummary {
  report: {
    actionRequired: number;
    updatedAt: number | null;
  };
  work: {
    open: number;
    review: number;
    overdue: number;
    unassigned: number;
  };
}

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

export type TaskPriority = 'high' | 'normal' | 'low';

export type TaskTemporalState =
  | 'closed'
  | 'exact_upcoming'
  | 'exact_overdue'
  | 'date_upcoming'
  | 'date_due'
  | 'date_overdue'
  | 'unscheduled';

export interface OperatorTask {
  id: number;
  commitment_id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  due_date: string | null;
  due_at: string | null;
  deadline_offset_minutes: number | null;
  revision: number;
  temporal_epoch: number;
  temporal_reconciled_occurrence_key: string | null;
  last_temporal_checked_at: number | null;
  next_temporal_check_at: number | null;
  last_temporal_attempt_id: number | null;
  temporal_state: TaskTemporalState;
  source_channel: string | null;
  latest_event: string | null;
  auto_created: boolean;
  confirmed: boolean;
  created_at: number;
  updated_at: number;
}

export interface OperatorTaskEvidence {
  observationRef: string;
  source: string;
  channel?: string | null;
  sourceAt?: number | null;
  observedAt?: number | null;
  content: string;
}

export interface OperatorTaskRevision {
  revision: number;
  operation: 'create' | 'revise' | 'withdraw';
  eventTime: number;
  eventTimeSource: 'event' | 'recorded';
  recordedAt: number;
  summary: string | null;
  reasoning: string | null;
  change: Record<string, unknown>;
  clear: string[];
  feedback: string | null;
  roles: unknown[] | null;
  files: unknown[] | null;
  evidence: OperatorTaskEvidence[];
}

export interface OperatorTaskDetail {
  commitmentId: string;
  rowId: number;
  revision: number;
  title: string | null;
  project: string | null;
  stage: string | null;
  assignee: string | null;
  lastEventTime: string | number | null;
  updatedAt: number;
  createdAt: number;
  withdrawn: boolean;
  revisions: OperatorTaskRevision[];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getReport: () => request<{ slots: ReportSlot[] }>('/api/report'),
  getOperatorSummary: () => request<OperatorSummary>('/api/operator/summary'),
  listTasks: (filters: { status?: TaskStatus; source_channel?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.source_channel) params.set('source_channel', filters.source_channel);
    params.set('limit', String(filters.limit ?? 50));
    return request<{ tasks: OperatorTask[] }>(`/api/operator/tasks?${params.toString()}`);
  },
  getTaskDetail: (commitmentId: string) =>
    request<OperatorTaskDetail>(`/api/viewer/tasks/${encodeURIComponent(commitmentId)}`),
};

/**
 * Native EventSource on the report SSE stream. Auto-reconnects; onOpen fires on
 * every (re)connect so callers can refetch state missed while disconnected.
 */
export function connectReportSse(handlers: {
  onUpdate: (data: unknown) => void;
  onOpen?: () => void;
  onDown?: () => void;
}): () => void {
  const es = new EventSource('/api/report/events');
  es.addEventListener('report-update', (ev) => {
    try {
      handlers.onUpdate(JSON.parse((ev as MessageEvent).data));
    } catch {
      // malformed frame: ignore; the next full update self-heals
    }
  });
  if (handlers.onOpen) {
    es.addEventListener('open', handlers.onOpen);
  }
  if (handlers.onDown) {
    es.addEventListener('error', handlers.onDown);
  }
  return () => es.close();
}

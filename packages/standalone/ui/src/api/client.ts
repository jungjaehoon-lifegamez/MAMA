import type { ReportSlot } from './report';

export interface OperatorSummary {
  triggers: {
    active: number;
    disabled: number;
    fired: number;
    succeeded: number;
    failed: number;
  };
}

export interface TriggerRow {
  id: string;
  kind: string;
  memoryQuery: string;
  status: string;
  authoredBy: string;
  createdAt: number;
  fired: number;
  succeeded: number;
  failed: number;
  disabledReason: string | null;
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
  listTriggers: () => request<{ triggers: TriggerRow[] }>('/api/operator/triggers'),
  disableTrigger: async (id: string, reason: string): Promise<void> => {
    await request<{ ok: boolean }>(`/api/operator/triggers/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
};

/**
 * Native EventSource on the report SSE stream. Auto-reconnects; onOpen fires on
 * every (re)connect so callers can refetch state missed while disconnected.
 */
export function connectReportSse(handlers: {
  onUpdate: (data: unknown) => void;
  onOpen?: () => void;
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
  return () => es.close();
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { mergeReportEvent, orderSlots, type ReportSlot, type SlotRecord } from '../api/report';
import { sanitizeReportHtml } from '../api/sanitize';
import { connectReportSse } from '../api/client';
import StatCard from '../components/StatCard';
import { formatRelativeTime, getFreshnessClass } from '../lib/time';
import { linkifyTaskReferences } from '../lib/task-links';

type SseStatus = 'live' | 'reconnecting';

function SlotRenderer({ slot, now }: { slot: ReportSlot; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = sanitizeReportHtml(slot.html);
    if (slot.slotId !== 'pipeline') return;
    linkifyTaskReferences(ref.current);
    const handleClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target =
        event.target instanceof Element ? event.target.closest('[data-task-id]') : null;
      const taskId = target instanceof HTMLElement ? target.dataset.taskId : undefined;
      if (!taskId || !/^\d+$/.test(taskId)) return;
      event.preventDefault();
      navigate(`/tasks#task-${taskId}`);
    };
    ref.current.addEventListener('click', handleClick);
    return () => ref.current?.removeEventListener('click', handleClick);
  }, [navigate, slot.html, slot.slotId]);

  return (
    <section
      className="min-w-0 bg-surface rounded-xl border border-border shadow-[var(--shadow-xs)] p-4"
      data-slot={slot.slotId}
    >
      <div className="flex justify-end mb-2">
        <span
          className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${getFreshnessClass(now, slot.updatedAt)}`}
        >
          {formatRelativeTime(now, slot.updatedAt)}
        </span>
      </div>
      <div ref={ref} className="report-slot-content" />
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 py-16">
      <h2 className="text-lg font-semibold text-text mb-2">No reports published yet</h2>
      <p className="text-sm text-text-secondary max-w-md">
        Slots appear here once an agent publishes them via report_publish. The heartbeat briefing or
        the dashboard agent fills the first slot.
      </p>
    </div>
  );
}

export default function Board() {
  const [slots, setSlots] = useState<SlotRecord>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [sseStatus, setSseStatus] = useState<SseStatus>('reconnecting');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await api.getReport();
      const record: SlotRecord = {};
      for (const slot of data.slots ?? []) {
        record[slot.slotId] = slot;
      }
      setSlots(record);
      const latest = Math.max(0, ...(data.slots ?? []).map((s) => s.updatedAt));
      if (latest > 0) setLastUpdate(latest);
    } catch {
      // board stays on previous state; SSE reconnect will refetch
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // SSE hot-reload; onOpen refetches state missed while disconnected.
  useEffect(() => {
    const disconnect = connectReportSse({
      onUpdate: (data) => {
        setSlots((prev) => mergeReportEvent(prev, data));
        setLastUpdate(Date.now());
      },
      onOpen: () => {
        setSseStatus('live');
        void load();
      },
      onDown: () => setSseStatus('reconnecting'),
    });
    return disconnect;
  }, [load]);

  const { data: summary } = useQuery({
    queryKey: ['operatorSummary'],
    queryFn: api.getOperatorSummary,
    refetchInterval: 60_000,
  });

  const ordered = orderSlots(slots);

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border flex-shrink-0 bg-surface">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-text">Operator Board</h1>
          <span
            role="status"
            aria-live="polite"
            className={`text-[10px] font-semibold tracking-wide rounded-full px-2 py-0.5 ${
              sseStatus === 'live'
                ? 'bg-success-soft text-success-text'
                : 'bg-warning-soft text-warning-text'
            }`}
          >
            {sseStatus === 'live' ? 'LIVE' : 'RECONNECTING'}
          </span>
          {lastUpdate && (
            <span className="text-[10px] text-text-tertiary whitespace-nowrap">
              updated {formatRelativeTime(now, lastUpdate)}
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          className="text-xs px-3 py-1.5 rounded bg-surface-hover hover:bg-surface-selected text-text-secondary transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 max-w-4xl min-w-0 mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard label="Active triggers" value={summary?.triggers.active ?? '-'} />
            <StatCard label="Total fires" value={summary?.triggers.fired ?? '-'} />
            <StatCard label="Succeeded" value={summary?.triggers.succeeded ?? '-'} tone="success" />
            <StatCard
              label="Failed"
              value={summary?.triggers.failed ?? '-'}
              tone={summary && summary.triggers.failed > 0 ? 'danger' : 'default'}
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-text-tertiary">
              Loading report...
            </div>
          ) : ordered.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-3">
              {ordered.map((slot) => (
                <SlotRenderer key={slot.slotId} slot={slot} now={now} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

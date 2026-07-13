import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { mergeReportEvent, orderSlots, type ReportSlot, type SlotRecord } from '../api/report';
import { sanitizeReportHtml } from '../api/sanitize';
import { connectReportSse } from '../api/client';
import StatCard from '../components/StatCard';
import { formatRelativeTime, getFreshnessClass } from '../lib/time';
import { linkifyTaskReferences } from '../lib/task-links';
import {
  COLLAPSED_SLOTS_STORAGE_KEY,
  formatSlotLabel,
  parseCollapsedSlots,
  pruneCollapsedSlots,
  serializeCollapsedSlots,
  toggleCollapsedSlot,
} from '../lib/slot-collapse';

type SseStatus = 'live' | 'reconnecting';

function SlotRenderer({
  slot,
  now,
  collapsed,
  onToggle,
}: {
  slot: ReportSlot;
  now: number;
  collapsed: boolean;
  onToggle: (slotId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const panelId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    element.innerHTML = sanitizeReportHtml(slot.html);
    if (slot.slotId !== 'pipeline') {
      return;
    }
    linkifyTaskReferences(element);
    const handleClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target =
        event.target instanceof Element ? event.target.closest('[data-task-id]') : null;
      const taskId = target instanceof HTMLElement ? target.dataset.taskId : undefined;
      if (!taskId || !/^\d+$/.test(taskId)) {
        return;
      }
      event.preventDefault();
      navigate(`/tasks#task-${taskId}`);
    };
    element.addEventListener('click', handleClick);
    return () => element.removeEventListener('click', handleClick);
  }, [navigate, slot.html, slot.slotId]);

  return (
    <section
      className="min-w-0 bg-surface rounded-xl border border-border shadow-[var(--shadow-xs)] p-4"
      data-slot={slot.slotId}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-lg mb-2 text-left"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        onClick={() => onToggle(slot.slotId)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <svg
            className={`h-4 w-4 flex-shrink-0 text-text-tertiary transition-transform ${collapsed ? '' : 'rotate-90'}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate text-sm font-semibold text-text">
            {formatSlotLabel(slot.slotId)}
          </span>
        </span>
        <span
          className={`flex-shrink-0 text-[10px] font-medium rounded-full px-2 py-0.5 ${getFreshnessClass(now, slot.updatedAt)}`}
        >
          {formatRelativeTime(now, slot.updatedAt)}
        </span>
      </button>
      <div id={panelId} ref={ref} className="report-slot-content" hidden={collapsed} />
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
  const [collapsedSlots, setCollapsedSlots] = useState<Set<string>>(() => {
    try {
      return parseCollapsedSlots(window.localStorage.getItem(COLLAPSED_SLOTS_STORAGE_KEY));
    } catch {
      return new Set();
    }
  });
  const queryClient = useQueryClient();

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_SLOTS_STORAGE_KEY,
        serializeCollapsedSlots(collapsedSlots)
      );
    } catch {
      // Session state remains usable when storage is unavailable.
    }
  }, [collapsedSlots]);

  const load = useCallback(async () => {
    try {
      const data = await api.getReport();
      const record: SlotRecord = {};
      for (const slot of data.slots ?? []) {
        record[slot.slotId] = slot;
      }
      setSlots(record);
      setCollapsedSlots((current) => pruneCollapsedSlots(current, new Set(Object.keys(record))));
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
        void queryClient.invalidateQueries({ queryKey: ['operatorSummary'] });
      },
      onOpen: () => {
        setSseStatus('live');
        void load();
        void queryClient.invalidateQueries({ queryKey: ['operatorSummary'] });
      },
      onDown: () => setSseStatus('reconnecting'),
    });
    return disconnect;
  }, [load, queryClient]);

  const { data: summary } = useQuery({
    queryKey: ['operatorSummary'],
    queryFn: api.getOperatorSummary,
    refetchInterval: 60_000,
  });

  const ordered = orderSlots(slots);
  const handleToggleSlot = useCallback((slotId: string) => {
    setCollapsedSlots((current) => toggleCollapsedSlot(current, slotId));
  }, []);

  const handleRefresh = useCallback(() => {
    void load();
    void queryClient.invalidateQueries({ queryKey: ['operatorSummary'] });
  }, [load, queryClient]);

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
          type="button"
          onClick={handleRefresh}
          className="text-xs px-3 py-1.5 rounded bg-surface-hover hover:bg-surface-selected text-text-secondary transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 max-w-4xl min-w-0 mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard
              label="Action required"
              value={summary?.report.actionRequired ?? '-'}
              tone={summary && summary.report.actionRequired > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Unconfirmed tasks"
              value={summary?.tasks.unconfirmed ?? '-'}
              tone={summary && summary.tasks.unconfirmed > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Failed trigger runs"
              value={summary?.triggers.failed ?? '-'}
              tone={summary && summary.triggers.failed > 0 ? 'danger' : 'default'}
            />
            <StatCard label="Active triggers" value={summary?.triggers.active ?? '-'} />
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
                <SlotRenderer
                  key={slot.slotId}
                  slot={slot}
                  now={now}
                  collapsed={collapsedSlots.has(slot.slotId)}
                  onToggle={handleToggleSlot}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  mergeReportEvent,
  orderSlots,
  type ReportSlot,
  type SlotRecord,
} from '../api/report';
import { sanitizeReportHtml } from '../api/sanitize';
import { connectReportSse } from '../api/client';
import StatCard from '../components/StatCard';

function SlotRenderer({ slot }: { slot: ReportSlot }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = sanitizeReportHtml(slot.html);
  }, [slot.html]);

  return (
    <section
      className="bg-surface rounded-xl border border-border shadow-[var(--shadow-xs)] p-4"
      data-slot={slot.slotId}
    >
      <div ref={ref} />
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 py-16">
      <h2 className="text-lg font-semibold text-text mb-2">No reports published yet</h2>
      <p className="text-sm text-text-secondary max-w-md">
        Slots appear here once an agent publishes them via report_publish. The heartbeat
        briefing or the dashboard agent fills the first slot.
      </p>
    </div>
  );
}

export default function Board() {
  const [slots, setSlots] = useState<SlotRecord>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

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

  // SSE hot-reload; onOpen refetches state missed while disconnected.
  useEffect(() => {
    const disconnect = connectReportSse({
      onUpdate: (data) => {
        setSlots((prev) => mergeReportEvent(prev, data));
        setLastUpdate(Date.now());
      },
      onOpen: () => {
        void load();
      },
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0 bg-surface">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-text">Operator Board</h1>
          {lastUpdate && (
            <span className="text-[10px] text-text-tertiary">
              {new Date(lastUpdate).toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              updated
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
        <div className="p-4 max-w-4xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard label="Active triggers" value={summary?.triggers.active ?? '-'} />
            <StatCard label="Total fires" value={summary?.triggers.fired ?? '-'} />
            <StatCard
              label="Succeeded"
              value={summary?.triggers.succeeded ?? '-'}
              tone="success"
            />
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
                <SlotRenderer key={slot.slotId} slot={slot} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

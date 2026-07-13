import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OperatorTrigger } from '../api/client';
import TriggerDrawer from '../components/TriggerDrawer';
import TriggerRow from '../components/TriggerRow';
import { filterTriggers, type TriggerStatusFilter } from '../lib/trigger-filter';

const STATUS_FILTERS: Array<{ value: TriggerStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'superseded', label: 'Superseded' },
];

type TriggerCache = { triggers: OperatorTrigger[] };

export default function Triggers() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TriggerStatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpener, setDrawerOpener] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['operatorTriggers'],
    queryFn: api.listTriggers,
    refetchInterval: 30_000,
  });

  const disable = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.disableTrigger(id, reason),
    onSuccess: (updated) => {
      queryClient.setQueryData<TriggerCache>(['operatorTriggers'], (current) => {
        if (!current) {
          return current;
        }
        return {
          triggers: current.triggers.map((trigger) =>
            trigger.id === updated.id ? updated : trigger
          ),
        };
      });
      void queryClient.invalidateQueries({ queryKey: ['operatorTriggers'] });
      void queryClient.invalidateQueries({ queryKey: ['operatorSummary'] });
    },
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const triggers = query.data?.triggers ?? [];
  const filteredTriggers = useMemo(
    () => filterTriggers(triggers, searchQuery, statusFilter),
    [triggers, searchQuery, statusFilter]
  );
  const selectedTrigger = selectedId
    ? (triggers.find((trigger) => trigger.id === selectedId) ?? null)
    : null;

  useEffect(() => {
    if (!query.data || !selectedId || selectedTrigger) {
      return;
    }
    setSelectedId(null);
    window.queueMicrotask(() => {
      if (drawerOpener?.isConnected) {
        drawerOpener.focus();
      } else {
        searchInputRef.current?.focus();
      }
    });
  }, [drawerOpener, query.data, selectedId, selectedTrigger]);

  const openDrawer = (id: string, opener: HTMLElement) => {
    disable.reset();
    setDrawerOpener(opener);
    setSelectedId(id);
  };

  const closeDrawer = () => {
    disable.reset();
    setSelectedId(null);
    setDrawerOpener(null);
  };

  const disableError = disable.error
    ? disable.error instanceof Error
      ? disable.error.message
      : 'Unable to disable trigger'
    : null;

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <header className="border-b border-border bg-surface px-4 py-4">
        <h1 className="text-base font-semibold text-text">Triggers</h1>
        <p className="mt-1 text-xs text-text-secondary">
          Search persisted trigger configuration and aggregate outcomes.
        </p>
      </header>

      <div className="flex-1 p-4">
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full sm:max-w-sm">
              <label htmlFor="trigger-search" className="text-xs font-medium text-text-secondary">
                Search triggers
              </label>
              <input
                ref={searchInputRef}
                id="trigger-search"
                type="search"
                aria-label="Search triggers"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search kind or keyword"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-agent"
              />
            </div>

            <div className="flex flex-wrap gap-2" aria-label="Filter triggers by status">
              {STATUS_FILTERS.map((filter) => {
                const active = statusFilter === filter.value;
                return (
                  <button
                    key={filter.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setStatusFilter(filter.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? 'bg-agent-hover text-on-agent dark:bg-agent'
                        : 'bg-surface text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-xs)]">
            {query.isPending ? (
              <div className="px-4 py-16 text-center text-sm text-text-secondary">
                Loading triggers...
              </div>
            ) : query.isError ? (
              <div role="alert" className="px-4 py-16 text-center text-sm text-warning-text">
                {query.error instanceof Error ? query.error.message : 'Unable to load triggers'}
              </div>
            ) : triggers.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <div className="text-sm font-medium text-text">No triggers yet</div>
                <div className="mt-1 text-xs text-text-secondary">
                  The registry will populate when the agent authors a trigger.
                </div>
              </div>
            ) : filteredTriggers.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <div className="text-sm font-medium text-text">No matching triggers</div>
                <div className="mt-1 text-xs text-text-secondary">
                  Clear the search or select All to see more triggers.
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="task-table">
                  <thead>
                    <tr>
                      <th>Trigger</th>
                      <th>Status</th>
                      <th>Fires</th>
                      <th>Success / Fail</th>
                      <th>Updated</th>
                      <th>Author</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTriggers.map((trigger) => (
                      <TriggerRow
                        key={trigger.id}
                        trigger={trigger}
                        now={now}
                        onOpen={openDrawer}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedTrigger && (
        <TriggerDrawer
          trigger={selectedTrigger}
          now={now}
          opener={drawerOpener}
          fallbackFocusRef={searchInputRef}
          disabling={disable.isPending}
          disableError={disableError}
          onDisable={(id, reason) => disable.mutateAsync({ id, reason })}
          onDismiss={closeDrawer}
        />
      )}
    </div>
  );
}

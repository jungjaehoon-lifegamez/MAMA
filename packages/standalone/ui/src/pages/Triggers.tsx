import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import TriggerRow from '../components/TriggerRow';

export default function Triggers() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['operatorTriggers'],
    queryFn: api.listTriggers,
    refetchInterval: 30_000,
  });

  const disable = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.disableTrigger(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['operatorTriggers'] });
      void queryClient.invalidateQueries({ queryKey: ['operatorSummary'] });
    },
  });

  const triggers = data?.triggers ?? [];
  const active = triggers.filter((t) => t.status === 'active');
  const inactive = triggers.filter((t) => t.status !== 'active');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0 bg-surface">
        <h1 className="text-base font-semibold text-text">Triggers</h1>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-success/10 text-success font-medium">
          active {active.length}
        </span>
        {inactive.length > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-secondary text-text-tertiary font-medium">
            inactive {inactive.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 max-w-4xl mx-auto space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-sm text-text-tertiary">
              Loading triggers...
            </div>
          ) : triggers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                      <p className="text-sm text-text-secondary">
                No triggers yet. The agent authors them itself once the trigger
                loop observes events.
              </p>
            </div>
          ) : (
            <>
              <div className="bg-surface rounded-xl border border-border shadow-[var(--shadow-xs)]">
                {active.map((t) => (
                  <TriggerRow
                    key={t.id}
                    trigger={t}
                    onDisable={(id, reason) => disable.mutate({ id, reason })}
                  />
                ))}
                {active.length === 0 && (
                  <p className="px-4 py-6 text-sm text-text-tertiary text-center">
                    No active triggers.
                  </p>
                )}
              </div>
              {inactive.length > 0 && (
                <details className="bg-surface rounded-xl border border-border shadow-[var(--shadow-xs)]">
                  <summary className="px-4 py-3 text-sm text-text-secondary cursor-pointer select-none">
                    Inactive triggers: {inactive.length}
                  </summary>
                  {inactive.map((t) => (
                    <TriggerRow
                      key={t.id}
                      trigger={t}
                      onDisable={(id, reason) => disable.mutate({ id, reason })}
                    />
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { TriggerRow as TriggerRowData } from '../api/client';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export default function TriggerRow({
  trigger,
  onDisable,
}: {
  trigger: TriggerRowData;
  onDisable: (id: string, reason: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const disabled = trigger.status !== 'active';

  return (
    <div
      className={`px-4 py-3 border-b border-border last:border-b-0 ${disabled ? 'opacity-90' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span
          className="text-[11px] px-2 py-0.5 rounded-full bg-agent-light text-agent font-medium max-w-[40%] truncate"
          title={trigger.kind}
        >
          {trigger.kind}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text truncate">{truncate(trigger.memoryQuery, 80)}</p>
          <p className="text-[11px] text-text-tertiary">
            fired {trigger.fired} / ok {trigger.succeeded} / fail {trigger.failed} /{' '}
            {trigger.authoredBy} /{' '}
            {new Date(trigger.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </p>
          {disabled && trigger.disabledReason && (
            <p className="text-[11px] text-danger mt-0.5">
              {trigger.status}: {trigger.disabledReason}
            </p>
          )}
        </div>
        {!disabled && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="shrink-0 px-3 py-1 text-xs font-medium rounded-full bg-surface-secondary text-text-tertiary hover:bg-danger/10 hover:text-danger transition-colors"
          >
            Disable
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2 mt-2">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            className="flex-1 px-2 py-1 text-xs bg-surface-selected rounded border border-border focus:outline-none focus:ring-1 focus:ring-agent"
          />
          <button
            onClick={() => {
              if (reason.trim()) onDisable(trigger.id, reason.trim());
            }}
            disabled={!reason.trim()}
            className="px-3 py-1 text-xs font-medium rounded-full bg-danger/10 text-danger disabled:opacity-40 hover:opacity-80 transition-opacity"
          >
            Confirm
          </button>
          <button
            onClick={() => {
              setConfirming(false);
              setReason('');
            }}
            className="px-3 py-1 text-xs font-medium rounded-full bg-surface-secondary text-text-tertiary hover:opacity-80"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

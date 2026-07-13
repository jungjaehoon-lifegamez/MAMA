import { useRef } from 'react';
import type { OperatorTrigger, TriggerStatus } from '../api/client';
import { formatRelativeTime } from '../lib/time';

const STATUS_CLASSES: Record<TriggerStatus, string> = {
  active: 'bg-success-soft text-success-text',
  disabled: 'bg-surface-secondary text-text-secondary dark:text-text-tertiary',
  superseded: 'bg-warning-soft text-warning-text',
};

interface TriggerRowProps {
  trigger: OperatorTrigger;
  now: number;
  onOpen: (id: string, opener: HTMLElement) => void;
}

export default function TriggerRow({ trigger, now, onOpen }: TriggerRowProps) {
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const keywords = trigger.match.keywords.join(', ');

  return (
    <tr
      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-hover"
      onClick={() => {
        if (openButtonRef.current) {
          onOpen(trigger.id, openButtonRef.current);
        }
      }}
    >
      <td className="min-w-64 px-3 py-3">
        <button
          ref={openButtonRef}
          type="button"
          aria-haspopup="dialog"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(trigger.id, event.currentTarget);
          }}
          className="block max-w-80 text-left text-sm font-medium text-agent-hover underline-offset-2 hover:underline dark:text-agent"
        >
          {trigger.kind}
        </button>
        <div className="mt-1 max-w-80 truncate text-[11px] text-text-secondary dark:text-text-tertiary">
          {keywords || 'No keywords'}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <span
          className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[trigger.status]}`}
        >
          {trigger.status}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-text-secondary">{trigger.fired}</td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-text-secondary">
        {trigger.succeeded} / {trigger.failed}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-text-secondary dark:text-text-tertiary">
        {formatRelativeTime(now, trigger.updatedAt)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-text-secondary">
        {trigger.authoredBy}
      </td>
    </tr>
  );
}

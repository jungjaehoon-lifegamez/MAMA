import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { OperatorTrigger, TriggerStatus } from '../api/client';
import {
  acquireSubmissionLock,
  releaseSubmissionLock,
  shouldShowModal,
} from '../lib/trigger-drawer-state';
import { formatRelativeTime } from '../lib/time';

const STATUS_CLASSES: Record<TriggerStatus, string> = {
  active: 'bg-success-soft text-success-text',
  disabled: 'bg-surface-secondary text-text-secondary dark:text-text-tertiary',
  superseded: 'bg-warning-soft text-warning-text',
};

interface TriggerDrawerProps {
  trigger: OperatorTrigger;
  now: number;
  opener: HTMLElement | null;
  fallbackFocusRef: RefObject<HTMLInputElement | null>;
  disabling: boolean;
  disableError: string | null;
  onDisable: (id: string, reason: string) => Promise<OperatorTrigger>;
  onDismiss: () => void;
}

function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-text">{children}</dd>
    </div>
  );
}

export default function TriggerDrawer({
  trigger,
  now,
  opener,
  fallbackFocusRef,
  disabling,
  disableError,
  onDisable,
  onDismiss,
}: TriggerDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const submissionLockRef = useRef(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (shouldShowModal(dialog.open)) {
      dialog.showModal();
      closeButtonRef.current?.focus();
    }

    const scrollContainer = document.getElementById('app-scroll-container');
    const previousOverflowY = scrollContainer?.style.overflowY ?? '';
    if (scrollContainer) {
      scrollContainer.style.overflowY = 'hidden';
    }

    return () => {
      if (scrollContainer) {
        scrollContainer.style.overflowY = previousOverflowY;
      }
    };
  }, [trigger.id]);

  const requestClose = () => {
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  };

  const handleClose = () => {
    onDismiss();
    window.queueMicrotask(() => {
      if (opener?.isConnected) {
        opener.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    });
  };

  const handleDisable = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedReason = reason.trim();
    if (!trimmedReason || disabling || !acquireSubmissionLock(submissionLockRef)) {
      return;
    }
    try {
      await onDisable(trigger.id, trimmedReason);
      setReason('');
    } catch {
      return;
    } finally {
      releaseSubmissionLock(submissionLockRef);
    }
  };

  const neutral = Math.max(0, trigger.fired - trigger.succeeded - trigger.failed);
  const scopeChannels = trigger.match.scopeChannelIds ?? [];

  return (
    <dialog
      ref={dialogRef}
      className="trigger-drawer"
      aria-labelledby="trigger-drawer-title"
      aria-describedby="trigger-drawer-description"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={handleClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface text-text">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="trigger-drawer-title" className="break-words text-lg font-semibold text-text">
              {trigger.kind}
            </h2>
            <p id="trigger-drawer-description" className="mt-1 text-xs text-text-secondary">
              Persisted trigger configuration and aggregate activity.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            autoFocus
            onClick={requestClose}
            className="shrink-0 rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section aria-labelledby="trigger-identity-heading">
            <h3 id="trigger-identity-heading" className="text-sm font-semibold text-text">
              Identity
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <Detail label="Kind">{trigger.kind}</Detail>
              <Detail label="ID">
                <span className="break-all">{trigger.id}</span>
              </Detail>
              <Detail label="Status">
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[trigger.status]}`}
                >
                  {trigger.status}
                </span>
              </Detail>
              <Detail label="Author">{trigger.authoredBy}</Detail>
            </dl>
          </section>

          <section aria-labelledby="trigger-timing-heading">
            <h3 id="trigger-timing-heading" className="text-sm font-semibold text-text">
              Timing
            </h3>
            <dl className="mt-3 space-y-3">
              <Detail label="Created">{absoluteTime(trigger.createdAt)}</Detail>
              <Detail label="Updated">
                {absoluteTime(trigger.updatedAt)} ({formatRelativeTime(now, trigger.updatedAt)})
              </Detail>
            </dl>
          </section>

          <section aria-labelledby="trigger-activity-heading">
            <h3 id="trigger-activity-heading" className="text-sm font-semibold text-text">
              Aggregate activity
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <Detail label="Fired">{trigger.fired}</Detail>
              <Detail label="Succeeded">{trigger.succeeded}</Detail>
              <Detail label="Failed">{trigger.failed}</Detail>
              <Detail label="Neutral / unclassified">{neutral}</Detail>
            </dl>
          </section>

          <section aria-labelledby="trigger-memory-heading">
            <h3 id="trigger-memory-heading" className="text-sm font-semibold text-text">
              Memory query
            </h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
              {trigger.memoryQuery}
            </p>
          </section>

          <section aria-labelledby="trigger-match-heading">
            <h3 id="trigger-match-heading" className="text-sm font-semibold text-text">
              Match configuration
            </h3>
            <dl className="mt-3 space-y-3">
              <Detail label="Keywords">
                {trigger.match.keywords.length > 0 ? trigger.match.keywords.join(', ') : 'None'}
              </Detail>
              <Detail label="Keyword mode">{trigger.match.keywordMode}</Detail>
              <Detail label="Minimum confidence">{trigger.match.minConfidence}</Detail>
              <Detail label="Scope channel IDs">
                {scopeChannels.length > 0 ? scopeChannels.join(', ') : 'All channels'}
              </Detail>
            </dl>
          </section>

          <section aria-labelledby="trigger-evidence-heading">
            <h3 id="trigger-evidence-heading" className="text-sm font-semibold text-text">
              Required evidence
            </h3>
            {trigger.requiredEvidence.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {trigger.requiredEvidence.map((evidence) => (
                  <li key={evidence} className="break-words">
                    {evidence}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-text-secondary">None</p>
            )}
          </section>

          <section aria-labelledby="trigger-procedure-heading">
            <h3 id="trigger-procedure-heading" className="text-sm font-semibold text-text">
              Procedure
            </h3>
            {trigger.procedure.length > 0 ? (
              <ol className="mt-2 list-decimal space-y-3 pl-5">
                {trigger.procedure.map((step, index) => (
                  <li key={`${step.action}-${index}`} className="pl-1 text-sm text-text-secondary">
                    <div className="font-medium text-text">{step.action}</div>
                    <div className="mt-0.5 break-words">{step.description}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm text-text-secondary">No procedure steps</p>
            )}
          </section>

          <section aria-labelledby="trigger-provenance-heading">
            <h3 id="trigger-provenance-heading" className="text-sm font-semibold text-text">
              Provenance
            </h3>
            <dl className="mt-3 space-y-3">
              <Detail label="Created from">{trigger.provenance.createdFrom}</Detail>
              <Detail label="Note">{trigger.provenance.note || 'None'}</Detail>
            </dl>
          </section>

          {trigger.disabledReason && (
            <section aria-labelledby="trigger-disabled-heading">
              <h3 id="trigger-disabled-heading" className="text-sm font-semibold text-text">
                Disabled reason
              </h3>
              <p className="mt-2 break-words text-sm text-text-secondary">
                {trigger.disabledReason}
              </p>
            </section>
          )}

          {trigger.status === 'active' && (
            <section
              aria-labelledby="trigger-disable-heading"
              className="border-t border-border pt-5"
            >
              <h3 id="trigger-disable-heading" className="text-sm font-semibold text-text">
                Disable trigger
              </h3>
              <form className="mt-3 space-y-3" onSubmit={handleDisable}>
                <div>
                  <label htmlFor="trigger-disable-reason" className="text-xs text-text-secondary">
                    Reason
                  </label>
                  <input
                    id="trigger-disable-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    className="mt-1 w-full rounded-lg border border-border bg-surface-selected px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-agent"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!reason.trim() || disabling}
                  className="rounded-lg bg-danger px-3 py-2 text-xs font-medium text-on-agent hover:opacity-80 disabled:opacity-40"
                >
                  {disabling ? 'Disabling...' : 'Confirm disable'}
                </button>
                {disabling && (
                  <p aria-live="polite" className="text-xs text-text-secondary">
                    Disabling trigger...
                  </p>
                )}
                {disableError && (
                  <p role="alert" className="text-xs text-danger">
                    {disableError}
                  </p>
                )}
              </form>
            </section>
          )}
        </div>
      </div>
    </dialog>
  );
}

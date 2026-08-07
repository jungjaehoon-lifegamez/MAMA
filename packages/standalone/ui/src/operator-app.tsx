import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Board from './pages/Board';
import Tasks from './pages/Tasks';
import Triggers from './pages/Triggers';

export type OperatorView = 'board' | 'tasks' | 'triggers';

export interface OperatorSelection {
  taskId?: number;
  triggerId?: string;
}

/** Host -> content: change the view in place, without remounting. */
export type OperatorUpdate = (view: OperatorView, selection?: OperatorSelection) => void;

export interface OperatorMountOptions {
  initialView: OperatorView;
  initialSelection?: OperatorSelection;
  onViewChange(view: OperatorView, selection?: OperatorSelection): void;
}

interface OperatorAppProps extends OperatorMountOptions {
  /** Hands the in-place updater back to mountOperator. */
  onReady(update: OperatorUpdate): void;
}

const queryClient = new QueryClient();

/**
 * Content-only operator surface. View state lives here, not in the URL: the
 * host document owns the address bar, drives this surface through `update`
 * (popstate, deep links) and is told about in-content navigation through
 * `onViewChange`. Host-driven updates deliberately do NOT re-notify the host.
 */
export default function OperatorApp({
  initialView,
  initialSelection,
  onViewChange,
  onReady,
}: OperatorAppProps) {
  const [view, setView] = useState<OperatorView>(initialView);
  const [selection, setSelection] = useState<OperatorSelection | undefined>(initialSelection);
  // Bumped on every host update so pages re-apply a selection they already
  // hold: navigating to the same task twice must scroll to it twice.
  const [selectionNonce, setSelectionNonce] = useState(0);

  const applyUpdate = useCallback<OperatorUpdate>((nextView, nextSelection) => {
    setView(nextView);
    setSelection(nextSelection);
    setSelectionNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    onReady(applyUpdate);
  }, [applyUpdate, onReady]);

  const changeView = useCallback(
    (nextView: OperatorView, nextSelection?: OperatorSelection) => {
      applyUpdate(nextView, nextSelection);
      onViewChange(nextView, nextSelection);
    },
    [applyUpdate, onViewChange]
  );

  const handleOpenTask = useCallback(
    (taskId: number) => {
      changeView('tasks', { taskId });
    },
    [changeView]
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* The bundle's reset and tokens are scoped to this id; see styles/global.css. */}
      <div id="operator-root" className="flex h-full min-w-0 flex-col bg-bg text-text">
        {view === 'board' ? <Board onOpenTask={handleOpenTask} /> : null}
        {view === 'tasks' ? (
          <Tasks focusTaskId={selection?.taskId} selectionNonce={selectionNonce} />
        ) : null}
        {view === 'triggers' ? (
          <Triggers selectedTriggerId={selection?.triggerId} selectionNonce={selectionNonce} />
        ) : null}
      </div>
    </QueryClientProvider>
  );
}

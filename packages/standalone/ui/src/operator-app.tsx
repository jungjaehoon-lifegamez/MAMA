import { useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Board from './pages/Board';
import Tasks from './pages/Tasks';
import Triggers from './pages/Triggers';

export type OperatorView = 'board' | 'tasks' | 'triggers';

export interface OperatorSelection {
  taskId?: number;
  triggerId?: string;
}

export interface OperatorMountOptions {
  initialView: OperatorView;
  initialSelection?: OperatorSelection;
  onViewChange(view: OperatorView, selection?: OperatorSelection): void;
}

const queryClient = new QueryClient();

/**
 * Content-only operator surface. View state lives here, not in the URL: the
 * host document owns the address bar and is told what changed via onViewChange.
 */
export default function OperatorApp({
  initialView,
  initialSelection,
  onViewChange,
}: OperatorMountOptions) {
  const [view, setView] = useState<OperatorView>(initialView);
  const [selection, setSelection] = useState<OperatorSelection | undefined>(initialSelection);

  const changeView = useCallback(
    (nextView: OperatorView, nextSelection?: OperatorSelection) => {
      setView(nextView);
      setSelection(nextSelection);
      onViewChange(nextView, nextSelection);
    },
    [onViewChange]
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
        {view === 'tasks' ? <Tasks focusTaskId={selection?.taskId} /> : null}
        {view === 'triggers' ? <Triggers initialTriggerId={selection?.triggerId} /> : null}
      </div>
    </QueryClientProvider>
  );
}

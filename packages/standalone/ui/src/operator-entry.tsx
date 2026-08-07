import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OperatorApp, {
  type OperatorMountOptions,
  type OperatorSelection,
  type OperatorUpdate,
  type OperatorView,
} from './operator-app';
import './styles/global.css';

export type { OperatorMountOptions, OperatorSelection, OperatorUpdate, OperatorView };

export interface OperatorHandle {
  /** Tear the surface down; the host may then reuse the element. */
  unmount(): void;
  /** Drive the view from the host (popstate, deep link) without remounting. */
  update(view: OperatorView, selection?: OperatorSelection): void;
}

/**
 * Mount the operator UI as CONTENT inside a host document (the Viewer).
 *
 * This bundle owns no document chrome: no router, no sidebar, no branding, no
 * global reset. The host owns the URL and the page shell; it steers the mounted
 * surface with `update` and hears about in-content navigation via `onViewChange`.
 */
export function mountOperator(root: HTMLElement, options: OperatorMountOptions): OperatorHandle {
  const reactRoot = createRoot(root);

  // React renders asynchronously, so an update issued right after mount can
  // arrive before the app registers its updater. Hold the latest one and
  // replay it rather than dropping the host's navigation on the floor.
  let apply: OperatorUpdate | null = null;
  let pending: Parameters<OperatorUpdate> | null = null;

  const handleReady = (update: OperatorUpdate) => {
    apply = update;
    if (pending) {
      const replay = pending;
      pending = null;
      update(...replay);
    }
  };

  reactRoot.render(
    <StrictMode>
      <OperatorApp {...options} onReady={handleReady} />
    </StrictMode>
  );

  return {
    unmount: () => {
      apply = null;
      pending = null;
      reactRoot.unmount();
    },
    update: (view, selection) => {
      if (apply) {
        apply(view, selection);
        return;
      }
      pending = [view, selection];
    },
  };
}

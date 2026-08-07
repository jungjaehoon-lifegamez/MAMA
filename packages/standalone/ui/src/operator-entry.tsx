import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OperatorApp, {
  type OperatorMountOptions,
  type OperatorSelection,
  type OperatorView,
} from './operator-app';
import './styles/global.css';

export type { OperatorMountOptions, OperatorSelection, OperatorView };

/**
 * Mount the operator UI as CONTENT inside a host document (the Viewer).
 *
 * This bundle owns no document chrome: no router, no sidebar, no branding, no
 * global reset. The host owns the URL, the navigation and the page shell, and
 * learns about in-content navigation through `onViewChange`.
 *
 * Returns a cleanup closure; call it before the host reuses the element.
 */
export function mountOperator(root: HTMLElement, options: OperatorMountOptions): () => void {
  const reactRoot = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <OperatorApp {...options} />
    </StrictMode>
  );
  return () => reactRoot.unmount();
}

/**
 * Lock whatever actually scrolls behind a modal drawer.
 *
 * The operator bundle is CONTENT inside the Viewer host document, so a drawer
 * cannot name a fixed element id: the host owns the page shell and each
 * operator page scrolls in a different container (Board owns its own scroll
 * region, the host tab region owns the rest). Walking up from the drawer to the
 * first ancestor that really scrolls keeps the lock correct no matter which
 * shell the bundle is mounted in.
 */
export function lockScrollBehind(element: Element | null): () => void {
  const target = findScrollContainer(element);
  if (!target) {
    return () => {};
  }
  const previousOverflowY = target.style.overflowY;
  target.style.overflowY = 'hidden';
  return () => {
    target.style.overflowY = previousOverflowY;
  };
}

function findScrollContainer(element: Element | null): HTMLElement | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return null;
  }
  let node = element?.parentElement ?? null;
  while (node) {
    if (isScrollable(node)) {
      return node;
    }
    node = node.parentElement;
  }
  // Nothing in the mount chain scrolls: the document itself is the scroller.
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.body;
}

function isScrollable(node: HTMLElement): boolean {
  const { overflowY } = window.getComputedStyle(node);
  return (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
}

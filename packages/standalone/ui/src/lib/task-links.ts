export type TaskReferenceSegment =
  | { type: 'text'; value: string }
  | { type: 'task'; value: string; taskId: string };

const TASK_REFERENCE_PATTERN = /#(\d+)(?![A-Za-z0-9_])/g;

export function segmentTaskReferences(text: string): TaskReferenceSegment[] {
  const segments: TaskReferenceSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TASK_REFERENCE_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, index) });
    }
    segments.push({ type: 'task', value: match[0], taskId: match[1] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}

export function linkifyTaskReferences(root: HTMLElement): void {
  const document = root.ownerDocument;
  const textNodes: Text[] = [];

  const collectTextNodes = (node: Node): void => {
    if (node.nodeType === 1) {
      const element = node as Element;
      element.removeAttribute('data-task-id');
      if (['A', 'CODE', 'PRE'].includes(element.tagName.toUpperCase())) return;
    }
    if (node.nodeType === 3) {
      textNodes.push(node as Text);
      return;
    }
    for (const child of Array.from(node.childNodes)) collectTextNodes(child);
  };

  collectTextNodes(root);

  for (const textNode of textNodes) {
    const segments = segmentTaskReferences(textNode.data);
    if (!segments.some((segment) => segment.type === 'task')) continue;
    const fragment = document.createDocumentFragment();
    for (const segment of segments) {
      if (segment.type === 'text') {
        fragment.append(document.createTextNode(segment.value));
        continue;
      }
      const anchor = document.createElement('a');
      anchor.href = `/ui/tasks#task-${segment.taskId}`;
      anchor.setAttribute('data-task-id', segment.taskId);
      anchor.className = 'task-reference-link';
      anchor.textContent = segment.value;
      fragment.append(anchor);
    }
    textNode.replaceWith(fragment);
  }
}

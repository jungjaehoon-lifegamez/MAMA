import { describe, expect, it } from 'vitest';
import { linkifyTaskReferences, segmentTaskReferences } from '../../ui/src/lib/task-links';

abstract class FakeNode {
  abstract readonly nodeType: number;
  parentElement: FakeElement | null = null;
  childNodes: FakeNode[] = [];

  constructor(readonly ownerDocument: FakeDocument) {}

  append(node: FakeNode): void {
    node.parentElement = this instanceof FakeElement ? this : this.parentElement;
    this.childNodes.push(node);
  }

  replaceWith(replacement: FakeNode): void {
    if (!this.parentElement) throw new Error('Cannot replace a detached node');
    const index = this.parentElement.childNodes.indexOf(this);
    const replacements = replacement.nodeType === 11 ? replacement.childNodes : [replacement];
    for (const node of replacements) node.parentElement = this.parentElement;
    this.parentElement.childNodes.splice(index, 1, ...replacements);
  }
}

class FakeText extends FakeNode {
  readonly nodeType = 3;

  constructor(
    ownerDocument: FakeDocument,
    public data: string
  ) {
    super(ownerDocument);
  }
}

class FakeElement extends FakeNode {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();

  constructor(
    ownerDocument: FakeDocument,
    readonly tagName: string
  ) {
    super(ownerDocument);
  }

  set href(value: string) {
    this.setAttribute('href', value);
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.append(this.ownerDocument.createTextNode(value));
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeFragment extends FakeNode {
  readonly nodeType = 11;
}

class FakeDocument {
  createDocumentFragment(): FakeFragment {
    return new FakeFragment(this);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toUpperCase());
  }

  createTextNode(data: string): FakeText {
    return new FakeText(this, data);
  }
}

function element(document: FakeDocument, tagName: string, ...children: FakeNode[]): FakeElement {
  const result = document.createElement(tagName);
  for (const child of children) result.append(child);
  return result;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return escapeText(node.data);
  const children = node.childNodes.map(serialize).join('');
  if (!(node instanceof FakeElement)) return children;
  const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${value}"`).join('');
  return `<${node.tagName.toLowerCase()}${attributes}>${children}</${node.tagName.toLowerCase()}>`;
}

function linkify(root: FakeElement): void {
  linkifyTaskReferences(root as unknown as HTMLElement);
}

describe('segmentTaskReferences', () => {
  it('segments one task reference', () => {
    expect(segmentTaskReferences('Review #12 today')).toEqual([
      { type: 'text', value: 'Review ' },
      { type: 'task', value: '#12', taskId: '12' },
      { type: 'text', value: ' today' },
    ]);
  });

  it('segments multiple task references and adjacent punctuation', () => {
    expect(segmentTaskReferences('#1, then (#23).')).toEqual([
      { type: 'task', value: '#1', taskId: '1' },
      { type: 'text', value: ', then (' },
      { type: 'task', value: '#23', taskId: '23' },
      { type: 'text', value: ').' },
    ]);
  });

  it('preserves text when there are no numeric references', () => {
    expect(segmentTaskReferences('No references here')).toEqual([
      { type: 'text', value: 'No references here' },
    ]);
  });

  it('does not segment non-numeric hashtags', () => {
    expect(segmentTaskReferences('Keep #release and #12x intact')).toEqual([
      { type: 'text', value: 'Keep #release and #12x intact' },
    ]);
  });
});

describe('linkifyTaskReferences', () => {
  it('keeps hostile markup as text while linking task references', () => {
    const document = new FakeDocument();
    const root = element(
      document,
      'div',
      document.createTextNode('<img src=x onerror=alert(1)> Review #7')
    );

    linkify(root);

    expect(serialize(root)).toBe(
      '<div>&lt;img src=x onerror=alert(1)&gt; Review <a href="/ui/tasks#task-7" data-task-id="7" class="task-reference-link">#7</a></div>'
    );
  });

  it('removes attacker-authored task ids and adds only generated link metadata', () => {
    const document = new FakeDocument();
    const hostile = element(document, 'span', document.createTextNode('Open #12'));
    hostile.setAttribute('data-task-id', '999');
    const root = element(document, 'div', hostile);

    linkify(root);

    expect(serialize(root)).toBe(
      '<div><span>Open <a href="/ui/tasks#task-12" data-task-id="12" class="task-reference-link">#12</a></span></div>'
    );
  });

  it('skips existing links, code, and preformatted content', () => {
    const document = new FakeDocument();
    const root = element(
      document,
      'div',
      element(document, 'a', document.createTextNode('#1')),
      element(document, 'code', document.createTextNode('#2')),
      element(document, 'pre', document.createTextNode('#3')),
      document.createTextNode(' #4')
    );

    linkify(root);

    expect(serialize(root)).toBe(
      '<div><a>#1</a><code>#2</code><pre>#3</pre> <a href="/ui/tasks#task-4" data-task-id="4" class="task-reference-link">#4</a></div>'
    );
  });
});

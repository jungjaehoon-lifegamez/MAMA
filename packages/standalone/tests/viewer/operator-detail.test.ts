import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { positiveTaskId } from '../../ui/src/lib/task-selection';

// tests/ui + tests/viewer convention: node environment, no jsdom. Pure modules
// are executed; components are asserted at the source level.
const uiSrc = join(process.cwd(), 'ui', 'src');

function read(...segments: string[]): string {
  return readFileSync(join(uiSrc, ...segments), 'utf8');
}

describe('task detail drawer: bounded evidence', () => {
  const drawer = read('components', 'TaskDrawer.tsx');

  it('shows only the ledger fields the task row already carries', () => {
    expect(drawer).toContain('task.source_channel');
    expect(drawer).toContain('task.latest_event');
    expect(drawer).toContain('task.created_at');
    expect(drawer).toContain('task.updated_at');
    expect(drawer).toContain('task.temporal_state');
    expect(drawer).toContain('task.confirmed');
  });

  it('names the missing-source case instead of rendering an empty slot', () => {
    expect(drawer).toContain("const NO_SOURCE = 'No linked source recorded'");
    expect(drawer).toContain('task.source_channel || NO_SOURCE');
    expect(drawer).toContain('task.latest_event || NO_SOURCE');
  });

  it('reads no raw transcript and issues no new request', () => {
    expect(drawer).not.toMatch(/raw.?transcript|\/api\/(raw|messages)/i);
    expect(drawer).not.toContain('useQuery');
    expect(drawer).not.toContain('fetch(');
    // The drawer may import OperatorTask as a type; it must not import the api
    // client value, nor call it. A type-only import names no `api` binding.
    expect(drawer).not.toMatch(/^import \{[^}]*\bapi\b/m);
    expect(drawer).not.toMatch(/\bapi\.\w+\(/);
  });

  it('carries exactly the four bounded sections', () => {
    const headings = [...drawer.matchAll(/<h3 id="task-[a-z-]+"[^>]*>\s*([^<]+?)\s*<\/h3>/g)].map(
      (match) => match[1]
    );
    expect(headings).toEqual(['Status', 'Schedule', 'Source evidence', 'Recent ledger context']);
  });

  it('mirrors the TriggerDrawer dialog semantics: Escape closes, focus returns', () => {
    // A native <dialog> routes Escape through `cancel`; both cancel and the
    // close button funnel into requestClose -> onClose -> handleClose.
    expect(drawer).toContain('<dialog');
    expect(drawer).toContain('dialog.showModal()');
    expect(drawer).toContain('onCancel={(event) => {');
    expect(drawer).toContain('event.preventDefault();');
    expect(drawer).toContain('requestClose();');
    expect(drawer).toContain('onClose={handleClose}');
    // Focus restoration: the opening row button first, the page fallback if it
    // has since left the document.
    expect(drawer).toContain('opener?.isConnected');
    expect(drawer).toContain('opener.focus()');
    expect(drawer).toContain('fallbackFocusRef.current?.focus()');
  });

  it('uses palette tokens only, with a visible focus ring', () => {
    expect(drawer).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(drawer).toContain('focus:ring-2 focus:ring-agent-strong');
    expect(drawer).not.toContain('outline-none');
  });
});

describe('task row: details are an explicit action', () => {
  const row = read('components', 'TaskRow.tsx');

  it('opens the drawer from a dedicated control, not from the row', () => {
    expect(row).toContain('View details');
    expect(row).toContain('aria-label={`View details for task ${task.id}`}');
    expect(row).toContain('onClick={(event) => onOpenDetails(task, event.currentTarget)}');
    // No owner mutation may ride on a navigation click.
    expect(row).not.toContain('<tr id={`task-${task.id}`} onClick');
    expect(row).toContain('onClick={() => onPatch(task, { confirmed: true })}');
  });
});

describe('tasks page: selection is validated before it becomes a route', () => {
  const tasks = read('pages', 'Tasks.tsx');
  const app = read('operator-app.tsx');

  it('opens the drawer only for a validated positive integer id', () => {
    expect(tasks).toContain("from '../lib/task-selection'");
    expect(tasks).toContain('const requested = positiveTaskId(focusTaskId);');
    expect(tasks).toContain('if (requested !== undefined) {');
    // Same nonce mechanism as the scroll effect: a repeated selection counts.
    expect(tasks).toContain('}, [focusTaskId, selectionNonce]);');
  });

  it('reports in-content open and close to the host', () => {
    expect(tasks).toContain('onSelectTask?.(task.id)');
    expect(tasks).toContain('onSelectTask?.(undefined)');
    expect(app).toContain("changeView('tasks', taskId === undefined ? undefined : { taskId })");
    expect(app).toContain('onSelectTask={handleSelectTask}');
  });

  it('drops a selection the loaded page cannot answer', () => {
    expect(tasks).toContain('setSelectedTaskId(null);');
    expect(tasks).toContain('firstFilterRef.current?.focus()');
  });

  it('says why, instead of closing the drawer silently', () => {
    // Ordinary case, not an edge one: the task is outside the newest 50, or a
    // filter change / 30s refetch moved it out from under an open drawer.
    expect(tasks).toContain('setUnresolvedTaskId(selectedTaskId);');
    expect(tasks).toContain('Task #{unresolvedTaskId} is not in the current view.');
    expect(tasks).toContain('role="status"');
    // Dismissible, and cleared as soon as a selection resolves again.
    expect(tasks).toContain('onClick={() => setUnresolvedTaskId(null)}');
    expect(tasks).toContain('Dismiss');
    expect(tasks).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('positiveTaskId', () => {
  // The shell already refuses `?task=abc`, `?task=-1` and `?task=` (pinned in
  // viewer-navigation.test.ts). This is the second boundary: whatever reaches
  // the component is ignored unless it is a real id - no drawer, no throw.
  it('accepts positive integers', () => {
    expect(positiveTaskId(1)).toBe(1);
    expect(positiveTaskId(42)).toBe(42);
  });

  it('ignores everything that is not a positive integer id', () => {
    for (const bad of [undefined, null, 0, -1, 3.5, NaN, Infinity, '42', '', {}, []]) {
      expect(positiveTaskId(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('trigger drawer: provenance is configuration, not conversation', () => {
  const drawer = read('components', 'TriggerDrawer.tsx');

  it('labels createdFrom and note as configuration provenance', () => {
    expect(drawer).toContain('Configuration provenance');
    expect(drawer).toContain('Not conversation history');
    expect(drawer).toContain('<DrawerDetail label="Configured from">');
    expect(drawer).toContain('<DrawerDetail label="Configuration note">');
  });

  it('adds no connector or raw-message request', () => {
    expect(drawer).not.toMatch(/raw.?transcript|\/api\/(raw|messages)|connectors/i);
  });
});

describe('drawer stylesheet', () => {
  it('gives the task drawer the same panel rules as the trigger drawer', () => {
    const css = read('styles', 'global.css');
    expect(css).toContain('.trigger-drawer,\n.task-drawer {');
    expect(css).toContain('.trigger-drawer::backdrop,\n.task-drawer::backdrop {');
  });
});

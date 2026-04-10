import { describe, it, expect, beforeEach } from 'vitest';
import { UICommandQueue } from '../../src/api/ui-command-handler.js';

describe('UICommandQueue', () => {
  let queue: UICommandQueue;

  beforeEach(() => {
    queue = new UICommandQueue();
  });

  it('enqueue and drain returns commands', () => {
    queue.push({ type: 'navigate', payload: { route: 'agents' } });
    queue.push({ type: 'notify', payload: { message: 'hello', severity: 'info' } });
    const cmds = queue.drain();
    expect(cmds).toHaveLength(2);
    expect(cmds[0].type).toBe('navigate');
  });

  it('drain clears the queue', () => {
    queue.push({ type: 'navigate', payload: { route: 'agents' } });
    queue.drain();
    expect(queue.drain()).toHaveLength(0);
  });

  it('setPageContext stores latest context', () => {
    queue.setPageContext({ currentRoute: 'agents', pageData: { pageType: 'agent-list' } });
    expect(queue.getPageContext()?.currentRoute).toBe('agents');
  });

  it('overwrites previous page context', () => {
    queue.setPageContext({ currentRoute: 'dashboard' });
    queue.setPageContext({ currentRoute: 'agents' });
    expect(queue.getPageContext()?.currentRoute).toBe('agents');
  });

  it('limits queue size to 50', () => {
    for (let i = 0; i < 60; i++) {
      queue.push({ type: 'notify', payload: { message: `msg-${i}`, severity: 'info' } });
    }
    expect(queue.drain().length).toBeLessThanOrEqual(50);
  });
});

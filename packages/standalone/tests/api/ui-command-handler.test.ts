import { describe, it, expect, beforeEach } from 'vitest';
import {
  UICommandQueue,
  handlePostPageContext,
  handlePostUICommand,
} from '../../src/api/ui-command-handler.js';

function mockRes() {
  const res = { _status: 0, _body: '', _headers: {} as Record<string, string> } as {
    _status: number;
    _body: string;
    _headers: Record<string, string>;
    writeHead: (s: number, h: Record<string, string>) => void;
    end: (b: string) => void;
  };
  res.writeHead = (s, h) => {
    res._status = s;
    res._headers = h;
  };
  res.end = (b) => {
    res._body = b;
  };
  return res;
}

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

  it('stores page context per channel when channelId is provided', () => {
    queue.setPageContext({
      currentRoute: 'agents',
      channelId: 'viewer-session-1',
      pageData: { pageType: 'agent-list' },
    });
    queue.setPageContext({
      currentRoute: 'dashboard',
      channelId: 'viewer-session-2',
      pageData: { pageType: 'dashboard' },
    });

    expect(queue.getPageContext('viewer-session-1')?.currentRoute).toBe('agents');
    expect(queue.getPageContext('viewer-session-2')?.currentRoute).toBe('dashboard');
  });

  it('does not fall back to global context for a missing channel', () => {
    queue.setPageContext({ currentRoute: 'agents', pageData: { pageType: 'agent-list' } });
    queue.setPageContext({
      currentRoute: 'dashboard',
      channelId: 'viewer-session-1',
      pageData: { pageType: 'dashboard' },
    });

    expect(queue.getPageContext('viewer-session-2')).toBeNull();
  });

  it('limits queue size to 50', () => {
    for (let i = 0; i < 60; i++) {
      queue.push({ type: 'notify', payload: { message: `msg-${i}`, severity: 'info' } });
    }
    expect(queue.drain().length).toBeLessThanOrEqual(50);
  });

  it('rejects invalid page-context payloads', () => {
    const res = mockRes();
    handlePostPageContext(res as never, { currentRoute: 123 } as never, queue);

    expect(res._status).toBe(400);
    expect(queue.getPageContext()).toBeNull();
  });

  it('rejects invalid ui-command payloads', () => {
    const res = mockRes();
    handlePostUICommand(res as never, { type: 'boom', payload: {} } as never, queue);

    expect(res._status).toBe(400);
    expect(queue.drain()).toHaveLength(0);
  });
});

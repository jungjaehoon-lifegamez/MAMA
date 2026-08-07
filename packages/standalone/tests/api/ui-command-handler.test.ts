import { describe, it, expect, beforeEach } from 'vitest';
import {
  UICommandQueue,
  handlePostPageContext,
  handlePostUICommand,
  handlePostUICommandAck,
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
    queue.push({ type: 'navigate', payload: { route: 'operator/board' } });
    queue.push({ type: 'notify', payload: { message: 'hello', severity: 'info' } });
    const cmds = queue.drain();
    expect(cmds).toHaveLength(2);
    expect(cmds[0].type).toBe('navigate');
  });

  it('drain clears the queue', () => {
    const queued = queue.push({ type: 'navigate', payload: { route: 'operator/board' } });
    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(0);
    queue.ack([queued.id!]);
    expect(queue.drain()).toHaveLength(0);
  });

  it('setPageContext stores latest context', () => {
    queue.setPageContext({ currentRoute: 'operator/board', pageData: { pageType: 'agent-list' } });
    expect(queue.getPageContext()?.currentRoute).toBe('operator/board');
  });

  it('overwrites previous page context', () => {
    queue.setPageContext({ currentRoute: 'operator/tasks' });
    queue.setPageContext({ currentRoute: 'operator/board' });
    expect(queue.getPageContext()?.currentRoute).toBe('operator/board');
  });

  it('stores page context per channel when channelId is provided', () => {
    queue.setPageContext({
      currentRoute: 'operator/board',
      channelId: 'viewer-session-1',
      pageData: { pageType: 'agent-list' },
    });
    queue.setPageContext({
      currentRoute: 'operator/tasks',
      channelId: 'viewer-session-2',
      pageData: { pageType: 'dashboard' },
    });

    expect(queue.getPageContext('viewer-session-1')?.currentRoute).toBe('operator/board');
    expect(queue.getPageContext('viewer-session-2')?.currentRoute).toBe('operator/tasks');
  });

  it('aliases legacy viewer session channel ids to the stable frontdoor channel', () => {
    queue.setPageContext({
      currentRoute: 'operator/board',
      channelId: 'session_legacy_viewer_id',
      pageData: { pageType: 'agent-list' },
    });

    expect(queue.getPageContext('mama_os_main')?.currentRoute).toBe('operator/board');
  });

  it('does not fall back to global context for a missing channel', () => {
    queue.setPageContext({ currentRoute: 'operator/board', pageData: { pageType: 'agent-list' } });
    queue.setPageContext({
      currentRoute: 'operator/tasks',
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

  it('rejects invalid ui-command ack payloads', () => {
    const res = mockRes();
    handlePostUICommandAck(res as never, { command_ids: ['ok', 123] } as never, queue);

    expect(res._status).toBe(400);
  });
});

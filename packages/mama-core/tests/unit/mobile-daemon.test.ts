import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() };
  pid = 4242;
}

describe('Story MCD-1: Mobile Claude daemon spawn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC #1: spawn uses the required stream-json CLI flags for Claude', async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const { ClaudeDaemon } = await import('../../src/embedding-server/mobile/daemon.js');
    const daemon = new ClaudeDaemon('/tmp/mama-mobile', 'session_123');

    const spawnPromise = daemon.spawn();
    await vi.advanceTimersByTimeAsync(120);
    await spawnPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--print',
        '--verbose',
        '--dangerously-skip-permissions',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--session-id',
        '--setting-sources',
        'project,local',
      ]),
      expect.objectContaining({
        cwd: '/tmp/mama-mobile',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    const cliArgs = spawnMock.mock.calls[0][1] as string[];
    const sessionIdIndex = cliArgs.indexOf('--session-id');
    expect(sessionIdIndex).toBeGreaterThan(-1);
    expect(cliArgs[sessionIdIndex + 1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

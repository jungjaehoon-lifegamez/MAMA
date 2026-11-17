import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptCallbacks, ToolUseBlock } from '../../src/runtime/drivers/types.js';
import { NativeEffectReplayBoundary } from '../../src/runtime/native-effect-observer.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import { ClaudeCLIWrapper } from '../../src/runtime/drivers/claude-cli-wrapper.js';
import { CodexAppServerProcess } from '../../src/runtime/drivers/codex-app-server-process.js';
vi.mock('child_process', () => ({ spawn: vi.fn() }));
const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'native-observation-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('native observation is not authorization', () => {
  it('observes reads, web tools and delegation without changing replay eligibility', () => {
    const observer = { started: vi.fn(), settled: vi.fn(), interrupted: vi.fn() };
    const boundary = new NativeEffectReplayBoundary(observer);
    for (const name of [
      'Read',
      'WebFetch',
      'WebSearch',
      'webSearch',
      'web_search',
      'Agent',
      'collabAgentToolCall',
    ]) {
      boundary.started(name, { nativeToolUseId: name });
      boundary.settled(name, name, false);
    }
    expect(observer.started).toHaveBeenCalledTimes(7);
    expect(observer.settled).toHaveBeenCalledTimes(7);
    const failure = new Error('read failed');
    expect(boundary.failure(failure)).toBe(failure);
  });
  it('does not let an observer failure stop a successful native call', () => {
    const fail = () => {
      throw new Error('storage unavailable');
    };
    const boundary = new NativeEffectReplayBoundary({
      started: fail,
      settled: fail,
      interrupted: fail,
      finished: fail,
    });
    expect(() => {
      boundary.started('Bash', { nativeToolUseId: 'call' });
      boundary.settled('Bash', 'call', false);
      boundary.finished();
    }).not.toThrow();
    expect(boundary.failure(new Error('backend failed'))).toMatchObject({
      code: 'MUTATION_OUTCOME_UNKNOWN',
    });
  });
  it('preserves Claude child tool names after the parent callbacks clear', () => {
    const driver = new PersistentClaudeProcess({ workspaceDir: root(), sessionId: 'fixture' });
    const started = vi.fn();
    const settled = vi.fn();
    const internal = driver as unknown as {
      currentCallbacks?: PromptCallbacks;
      recordToolUse(tool: ToolUseBlock): boolean;
      handleStdout(chunk: Buffer): void;
      backgroundAgents: Map<string, unknown>;
      completeBackgroundAgent(state: unknown, wake: boolean, status: 'unknown'): void;
    };
    internal.currentCallbacks = { onToolUse: started, onToolComplete: settled };
    internal.recordToolUse({ id: 'agent-call', name: 'Agent', input: {} });
    internal.currentCallbacks = undefined;
    const send = (event: unknown) =>
      internal.handleStdout(Buffer.from(JSON.stringify(event) + '\n'));
    send({
      type: 'assistant',
      parent_tool_use_id: 'agent-call',
      message: {
        content: [
          { type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'note.md' } },
        ],
      },
    });
    send({
      type: 'user',
      parent_tool_use_id: 'agent-call',
      message: { content: [{ type: 'tool_result', tool_use_id: 'read-call', is_error: false }] },
    });
    expect(started).toHaveBeenCalledWith(
      'Read',
      expect.objectContaining({ nativeToolUseId: 'read-call', subagentItemId: 'agent-call' })
    );
    expect(settled).toHaveBeenCalledWith('Read', 'read-call', false);
    send({
      type: 'assistant',
      parent_tool_use_id: 'agent-call',
      message: { content: [{ type: 'tool_use', id: 'unfinished', name: 'Read', input: {} }] },
    });
    internal.completeBackgroundAgent(internal.backgroundAgents.get('agent-call'), false, 'unknown');
    expect(settled).toHaveBeenCalledWith('Read', 'unfinished', true, 'unknown');
  });
  it('observes Codex child command and web items once with input', () => {
    const home = root();
    const driver = new CodexAppServerProcess({
      hostRootDir: home,
      cwd: home,
      sessionKey: 'fixture',
      model: 'fixture',
      systemPrompt: '',
      sandbox: 'workspace-write',
    });
    const started = vi.fn();
    const settled = vi.fn();
    const internal = driver as unknown as {
      subagents: Map<string, Record<string, unknown>>;
      handleNotification(method: string, params: unknown): void;
      finishSubagent(id: string, status: 'interrupted'): void;
    };
    internal.subagents.set('child', {
      parentThreadId: 'parent',
      agentPath: 'child',
      sessionKey: 'fixture',
      authority: Promise.resolve(null),
      onToolUse: started,
      onToolComplete: settled,
      nativeItems: new Map(),
    });
    for (const item of [
      { id: 'cmd', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0 },
      {
        id: 'web',
        type: 'webSearch',
        action: { type: 'search', query: 'fixture' },
        status: 'completed',
      },
      // A Codex app call, as Codex CLI 0.160.1 reports it; failed, so it settles as an error.
      {
        id: 'app',
        type: 'mcpToolCall',
        server: 'codex_apps',
        tool: 'google_calendar.create_event',
        arguments: { title: 'fixture meeting' },
        status: 'failed',
      },
      // A call to the host's own MCP actions is traced by the host, not here.
      { id: 'host', type: 'mcpToolCall', server: 'mama', tool: 'work.list', status: 'completed' },
    ]) {
      for (const method of ['item/started', 'item/completed', 'item/completed'])
        internal.handleNotification(method, { threadId: 'child', turnId: 'turn', item });
    }
    expect(started).toHaveBeenCalledTimes(3);
    expect(started).toHaveBeenCalledWith(
      'google_calendar.create_event',
      expect.objectContaining({ arguments: { title: 'fixture meeting' } })
    );
    expect(settled).toHaveBeenCalledWith(
      'google_calendar.create_event',
      JSON.stringify(['child', 'app']),
      true
    );
    expect(started).toHaveBeenCalledWith(
      'commandExecution',
      expect.objectContaining({ command: 'pwd', subagentThreadId: 'child' })
    );
    expect(started).toHaveBeenCalledWith(
      'webSearch',
      expect.objectContaining({ action: { type: 'search', query: 'fixture' } })
    );
    expect(settled).toHaveBeenCalledTimes(3);
    internal.handleNotification('item/started', {
      threadId: 'child',
      turnId: 'turn',
      item: { id: 'unfinished', type: 'commandExecution', command: 'pwd' },
    });
    internal.finishSubagent('child', 'interrupted');
    expect(settled).toHaveBeenCalledWith(
      'commandExecution',
      JSON.stringify(['child', 'unfinished']),
      true,
      'unknown'
    );
  });
  it.each(['persistent', 'wrapper'] as const)(
    'redacts configured secrets from %s stderr across chunks',
    async (kind) => {
      const home = root();
      const configured = ['synthetic', 'credential'].join('-');
      const config = join(home, 'mcp.json');
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: { fixture: { command: 'fixture', env: { SERVICE_TOKEN: configured } } },
        })
      );
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
        pid: 12345,
        killed: false,
      });
      vi.mocked(spawn).mockReturnValue(child as never);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      if (kind === 'persistent') {
        const driver = new PersistentClaudeProcess({
          workspaceDir: home,
          sessionId: 'fixture',
          mcpConfigPath: config,
          processEnv: { HOME: home },
        });
        await driver.start();
        child.stderr.write(configured.slice(0, 8));
        driver.stop();
        child.stderr.write(configured.slice(8) + '\n');
        child.stderr.end();
        child.emit('close', 0);
      } else {
        const driver = new ClaudeCLIWrapper({
          workspaceDir: home,
          mcpConfigPath: config,
          processEnv: { HOME: home },
        });
        const result = driver.prompt('fixture').catch((error: Error) => error);
        child.stderr.write(configured.slice(0, 8));
        child.stderr.write(configured.slice(8) + '\n');
        child.emit('close', 1);
        expect(String(await result).includes(configured)).toBe(false);
      }
      const output = logged.mock.calls.flat().join('');
      expect(output.includes(configured)).toBe(false);
      expect(output).toContain('[REDACTED]');
    }
  );
});

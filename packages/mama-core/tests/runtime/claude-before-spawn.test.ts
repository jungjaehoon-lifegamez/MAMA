import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCLIWrapper } from '../../src/runtime/drivers/claude-cli-wrapper.js';
import { PersistentCLIAdapter } from '../../src/runtime/drivers/persistent-cli-adapter.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import { NativeSessionUnavailableError } from '../../src/runtime/drivers/types.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

class Child extends EventEmitter {
  pid = 123;
  killed = false;
  inputs: string[] = [];
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.inputs.push(chunk.toString());
      done();
      queueMicrotask(() => {
        this.stdout.write(chunk);
        this.reply();
      });
    },
  });

  reply(): void {
    this.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', usage: {} }) + '\n'
    );
  }

  kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-before-spawn-'));
  roots.push(root);
  return root;
}

describe('Claude process start hook', () => {
  it.each(['persistent', 'one-shot'] as const)(
    'runs the hook synchronously before every %s spawn',
    async (kind) => {
      let generation = 0;
      const seen: number[] = [];
      const children: Child[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        seen.push(generation);
        const child = new Child();
        children.push(child);
        return child as never;
      });
      const options = {
        workspaceDir: workspace(),
        sessionId: 'fixture-session',
        beforeSpawn: () => {
          generation += 1;
        },
      };
      if (kind === 'persistent') {
        const driver = new PersistentClaudeProcess(options);
        try {
          await driver.start();
          children[0].emit('close', 1);
          await driver.start();
        } finally {
          driver.stop();
        }
      } else {
        const driver = new ClaudeCLIWrapper(options);
        for (let turn = 0; turn < 2; turn += 1) {
          const result = driver.prompt('fixture input');
          children[turn].reply();
          children[turn].emit('close', 0);
          await expect(result).resolves.toMatchObject({ response: 'answer' });
        }
      }
      expect(seen).toEqual([1, 2]);
    }
  );

  it.each(['persistent', 'one-shot'] as const)(
    'fails the %s start without spawning when the hook throws',
    async (kind) => {
      const options = {
        workspaceDir: workspace(),
        sessionId: 'fixture-session',
        beforeSpawn: () => {
          throw new Error('fixture preparation failed');
        },
      };
      // An attempted spawn must fail promptly even in the unmodified implementation.
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error('unexpected spawn');
      });
      const persistent = new PersistentClaudeProcess(options);
      const oneShot = new ClaudeCLIWrapper(options);
      const start = () =>
        kind === 'persistent' ? persistent.start() : oneShot.prompt('fixture input');
      await expect(start()).rejects.toThrow('fixture preparation failed');
      await expect(start()).rejects.toThrow('fixture preparation failed');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  it('carries the hook into the adapter replacement after death before input', async () => {
    let generation = 0;
    const seen: number[] = [];
    const children: Child[] = [];
    vi.mocked(spawn).mockImplementation(() => {
      seen.push(generation);
      const child = new Child();
      children.push(child);
      return child as never;
    });
    const driver = new PersistentCLIAdapter({
      workspaceDir: workspace(),
      beforeSpawn: () => {
        generation += 1;
      },
    });
    try {
      await expect(
        driver.prompt('fixture input', undefined, {
          preparePrompt: async () => {
            children[0].emit('close', 1);
            return 'fixture input';
          },
        })
      ).rejects.toBeInstanceOf(NativeSessionUnavailableError);
      await expect(driver.prompt('fixture input')).resolves.toMatchObject({ response: 'answer' });
      expect(children[0].inputs).toEqual([]);
      expect(children[1].inputs).toHaveLength(1);
      expect(seen).toEqual([1, 2]);
    } finally {
      await driver.stop();
    }
  });
});

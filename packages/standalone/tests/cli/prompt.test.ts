import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { createTerminalPrompt } from '../../src/cli/prompt.js';

beforeEach(() => vi.stubEnv('TERM', 'xterm-256color'));
afterEach(() => vi.unstubAllEnvs());

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const chunks: string[] = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  const prompt = createTerminalPrompt(
    input as unknown as ReadStream,
    output as unknown as WriteStream
  );
  return { input, output, chunks, prompt };
}

describe('terminal secret entry', () => {
  it('turns echo off, suppresses typed characters and redraws, then restores terminal state', async () => {
    const t = terminal();
    try {
      const answer = t.prompt.secret('Secret');
      expect(t.input.isRaw).toBe(true);
      // Separate key events: readline treats one multi-character chunk as a paste.
      for (const key of 'fixture-secrex\x7ft\r') t.input.write(key);
      expect((await answer) === 'fixture-secret').toBe(true);
      expect(t.chunks.join('')).toBe('Secret: \n');
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.input.destroy();
      t.output.destroy();
    }
  });

  it('cancels Ctrl-C without returning or echoing a partial token', async () => {
    const t = terminal();
    try {
      const answer = t.prompt.secret('Secret');
      t.input.write('fixture-partial\x03');
      await expect(answer).rejects.toThrow(/cancelled/);
      expect(t.chunks.join('')).toBe('Secret: \n');
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.input.destroy();
      t.output.destroy();
    }
  });

  it('cancels end of input and restores echo', async () => {
    const t = terminal();
    try {
      const answer = t.prompt.secret('Secret');
      t.input.end();
      await expect(answer).rejects.toThrow(/cancelled/);
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.input.destroy();
      t.output.destroy();
    }
  });
});

describe('terminal text entry', () => {
  it('ends the question as cancelled when its signal aborts, and gives the terminal back', async () => {
    const t = terminal();
    try {
      const stop = new AbortController();
      const answer = t.prompt.text('Code', stop.signal);
      stop.abort();
      await expect(answer).rejects.toThrow(/cancelled/);
      expect(t.input.isRaw).toBe(false);
    } finally {
      t.input.destroy();
      t.output.destroy();
    }
  });
});

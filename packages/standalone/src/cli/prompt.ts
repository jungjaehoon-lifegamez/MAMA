import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';

export class CliInputError extends Error {}

export interface PromptAdapter {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  /** An aborted signal ends the question as cancelled. */
  text(label: string, signal?: AbortSignal): Promise<string>;
  secret(label: string): Promise<string>;
  write(line: string): void;
}

export function requireTTY(prompt: PromptAdapter): void {
  if (!prompt.stdinIsTTY || !prompt.stdoutIsTTY) {
    throw new CliInputError(
      'This command requires a TTY on both stdin and stdout. Run it yourself in a terminal.'
    );
  }
}

/** readline disables terminal echo in raw mode; hidden output is discarded, including redraws. */
export function createTerminalPrompt(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout
): PromptAdapter {
  const question = async (
    label: string,
    hidden: boolean,
    signal?: AbortSignal
  ): Promise<string> => {
    requireTTY(adapter);
    const wasRaw = input.isRaw;
    const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
    const rl = createInterface({
      input,
      output: hidden ? muted : output,
      terminal: true,
      historySize: 0,
    });
    try {
      if (hidden) output.write(`${label}: `);
      return await new Promise<string>((resolve, reject) => {
        rl.once('close', () => reject(new CliInputError('Input cancelled; no value saved.')));
        rl.once('SIGINT', () => rl.close());
        if (signal?.aborted) rl.close();
        signal?.addEventListener('abort', () => rl.close(), { once: true });
        rl.question(hidden ? '' : `${label}: `, resolve);
      });
    } finally {
      rl.close();
      input.setRawMode(wasRaw);
      muted.destroy();
      if (hidden) output.write('\n');
    }
  };
  const adapter: PromptAdapter = {
    stdinIsTTY: input.isTTY === true,
    stdoutIsTTY: output.isTTY === true,
    text: (label, signal) => question(label, false, signal),
    secret: (label) => question(label, true),
    write: (line) => {
      output.write(`${line}\n`);
    },
  };
  return adapter;
}

export function nonblankLine(value: string): string {
  if (
    !value.trim() ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new CliInputError('Input must be nonblank text on a single line.');
  }
  return value;
}

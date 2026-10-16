/**
 * `mama logs [-n N] [--follow]`: the daemon's own log (`logging.file`, daemon.log by default), its
 * last N lines (50), then with --follow each line as the daemon writes it. Following keeps up across
 * a rotation: when the file is replaced or shrinks, the new file is read from its start.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';

const USAGE = 'Usage: mama logs [-n <lines>] [--follow]';
const DEFAULT_LINES = 50;

export interface LogsOptions {
  home?: string;
  write?: (text: string) => void;
  /** Ends --follow; the CLI aborts it on Ctrl-C. */
  signal?: AbortSignal;
  pollMs?: number;
}

function parseArgs(args: readonly string[]): { lines: number; follow: boolean } {
  let lines = DEFAULT_LINES;
  let follow = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--follow' || arg === '-f') {
      follow = true;
    } else if (arg === '-n') {
      const value = args[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) throw new CliInputError(USAGE);
      lines = Number(value);
      i += 1;
    } else {
      throw new CliInputError(USAGE);
    }
  }
  return { lines, follow };
}

/** The last `count` lines of the text, kept with their line ends. */
function lastLines(text: string, count: number): string {
  if (count === 0) return '';
  const lines = text.split(/(?<=\n)/);
  return lines.slice(-count).join('');
}

export async function runLogs(args: readonly string[], options: LogsOptions = {}): Promise<void> {
  const { lines, follow } = parseArgs(args);
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const path = loadConfig({ home: options.home ?? homedir() }).logging.file;
  if (!existsSync(path) && !follow) {
    throw new CliInputError(`${path} does not exist yet; the daemon writes it once it starts`);
  }
  let inode = -1;
  let position = 0;
  if (existsSync(path)) {
    const text = readFileSync(path);
    write(lastLines(text.toString('utf8'), lines));
    inode = statSync(path).ino;
    position = text.length;
  }
  if (!follow) return;

  const pollMs = options.pollMs ?? 500;
  while (!options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    // Between a rotation's removal of the file and the daemon's next write it is briefly absent.
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.ino !== inode || stat.size < position) {
      inode = stat.ino;
      position = 0;
    }
    if (stat.size <= position) continue;
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(stat.size - position);
      const read = readSync(fd, chunk, 0, chunk.length, position);
      position += read;
      write(chunk.subarray(0, read).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  }
}

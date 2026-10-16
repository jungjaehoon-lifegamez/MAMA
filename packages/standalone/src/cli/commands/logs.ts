/**
 * `mama logs [-n N] [--follow]`: the daemon's own log (`logging.file`, daemon.log by default), its
 * last N lines (50), then with --follow each line as the daemon writes it. Following keeps up across
 * a rotation: when the file has been emptied, what was written since the last read is taken from the
 * newest archive, then the file is read from its start.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { gunzipSync } from 'node:zlib';
import { archivePath, DAEMON_LOG_LIMITS, readLastLines } from '../../runtime/rotating-log.js';
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
    // Read where the file stands first: a line written meanwhile is printed twice, never skipped.
    const stat = statSync(path);
    inode = stat.ino;
    position = stat.size;
    // Just after a rotation the file holds only a few lines; the rest come from the archives.
    write(readLastLines(path, DAEMON_LOG_LIMITS.keep, lines).join(''));
  }
  if (!follow) return;

  // A character split across two reads is held until its last byte arrives.
  const decoder = new StringDecoder('utf8');
  // A rotation writes a new newest archive; that, not the file's size, says one happened, since the
  // file can grow past the last read position again before the next poll.
  const archive = archivePath(path, 1);
  const archiveId = (): number | null => (existsSync(archive) ? statSync(archive).ino : null);
  let lastArchive = archiveId();
  const pollMs = options.pollMs ?? 500;
  while (!options.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      // Before the daemon's first write, or while the file is being replaced.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const currentArchive = archiveId();
    if (stat.ino !== inode) {
      inode = stat.ino;
      position = 0;
    } else if (currentArchive !== null && currentArchive !== lastArchive) {
      // Rotated: the lines written after the last read went into the newest archive.
      const archived = gunzipSync(readFileSync(archive));
      if (archived.length > position) write(decoder.write(archived.subarray(position)));
      position = 0;
    } else if (stat.size < position) {
      position = 0;
    }
    lastArchive = currentArchive;
    if (stat.size <= position) continue;
    const fd = openSync(path, 'r');
    try {
      const chunk = Buffer.alloc(stat.size - position);
      const read = readSync(fd, chunk, 0, chunk.length, position);
      position += read;
      write(decoder.write(chunk.subarray(0, read)));
    } finally {
      closeSync(fd);
    }
  }
}

import {
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import { minimatch } from 'minimatch';

import type { HostToolBridge, HostToolCallResult, HostToolDefinition } from './model-runner.js';

export const CODEX_AUXILIARY_TOOL_NAMES = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
] as const;

export type CodexAuxiliaryToolName = (typeof CODEX_AUXILIARY_TOOL_NAMES)[number];

export interface CodexAuxiliaryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexAuxiliaryToolPolicy {
  allowedTools: readonly CodexAuxiliaryToolName[];
  roots: readonly string[];
}

export interface CodexAuxiliaryToolBridgeOptions extends CodexAuxiliaryToolPolicy {
  executeCommand: (
    command: string,
    cwd: string,
    roots: readonly string[],
    signal?: AbortSignal
  ) => Promise<CodexAuxiliaryCommandResult>;
}

const STRING = { type: 'string' } as const;
const DEFINITIONS: Readonly<Record<CodexAuxiliaryToolName, HostToolDefinition>> = {
  Read: definition(
    'Read',
    'Read one UTF-8 file inside the MAMA workspace.',
    {
      path: STRING,
    },
    ['path']
  ),
  Write: definition(
    'Write',
    'Write one UTF-8 file inside the MAMA workspace.',
    {
      path: STRING,
      content: STRING,
    },
    ['path', 'content']
  ),
  Edit: definition(
    'Edit',
    'Replace one exact text occurrence inside a MAMA workspace file.',
    {
      path: STRING,
      old_string: STRING,
      new_string: STRING,
    },
    ['path', 'old_string', 'new_string']
  ),
  Bash: definition(
    'Bash',
    'Run one command in the Codex sandbox inside the MAMA workspace.',
    {
      command: STRING,
      workdir: STRING,
    },
    ['command']
  ),
  Glob: definition(
    'Glob',
    'List workspace files matching a glob pattern.',
    {
      pattern: STRING,
      path: STRING,
    },
    ['pattern']
  ),
  Grep: definition(
    'Grep',
    'Search workspace text files with a regular expression.',
    {
      pattern: STRING,
      path: STRING,
      glob: STRING,
    },
    ['pattern']
  ),
};

const MAX_FILE_BYTES = 200_000;
const MAX_COMMAND_STREAM_BYTES = 50_000;
const MAX_WALK_ENTRIES = 5_000;
const MAX_RESULTS = 500;

function definition(
  name: CodexAuxiliaryToolName,
  description: string,
  properties: HostToolDefinition['inputSchema']['properties'],
  required: readonly string[]
): HostToolDefinition {
  return {
    type: 'function',
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

function requireString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string when provided`);
  }
  return value;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeRoots(roots: readonly string[]): string[] {
  const normalized = [...new Set(roots.map((root) => realpathSync(resolve(root))))];
  if (normalized.length === 0) throw new Error('Codex auxiliary tools require at least one root');
  return normalized;
}

function canonicalizeCandidate(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve path: ${path}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function assertNoSymlinkTraversal(path: string, root: string, allowMissingLeaf: boolean): void {
  const rel = relative(root, path);
  const segments = rel === '' ? [] : rel.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink traversal is not allowed: ${path}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && allowMissingLeaf) return;
      throw error;
    }
  }
}

function resolveScopedPath(
  rawPath: string,
  roots: readonly string[],
  options: { base?: string; allowMissingLeaf?: boolean } = {}
): string {
  const candidate = canonicalizeCandidate(resolve(options.base ?? roots[0], rawPath));
  const root = roots.find((allowedRoot) => within(allowedRoot, candidate));
  if (!root) throw new Error(`Path is outside the MAMA auxiliary roots: ${rawPath}`);
  assertNoSymlinkTraversal(candidate, root, options.allowMissingLeaf ?? false);
  if (!(options.allowMissingLeaf ?? false)) {
    const real = realpathSync(candidate);
    if (!within(root, real)) throw new Error(`Resolved path escaped the MAMA auxiliary root`);
  }
  return candidate;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) throw new Error('Workspace scan exceeded its entry limit');
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function content(result: unknown, isError = false): HostToolCallResult {
  return { content: typeof result === 'string' ? result : JSON.stringify(result), isError };
}

function boundedCommandStream(value: string): {
  text: string;
  bytes: number;
  truncated: boolean;
} {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= MAX_COMMAND_STREAM_BYTES) {
    return { text: value, bytes: encoded.byteLength, truncated: false };
  }
  return {
    text: encoded.subarray(0, MAX_COMMAND_STREAM_BYTES).toString('utf8'),
    bytes: encoded.byteLength,
    truncated: true,
  };
}

function assertReadableFileSize(path: string): void {
  if (statSync(path).size > MAX_FILE_BYTES) {
    throw new Error('File exceeds read limit');
  }
}

export function createCodexAuxiliaryToolBridge(
  options: CodexAuxiliaryToolBridgeOptions
): HostToolBridge {
  const roots = normalizeRoots(options.roots);
  const allowed = [...new Set(options.allowedTools)];
  const tools = allowed.map((name) => DEFINITIONS[name]);
  return {
    tools,
    async execute(call) {
      try {
        if (!allowed.includes(call.name as CodexAuxiliaryToolName)) {
          throw new Error(`Codex auxiliary tool ${call.name} was not allowed`);
        }
        const name = call.name as CodexAuxiliaryToolName;
        if (name === 'Read') {
          const path = resolveScopedPath(requireString(call.input, 'path'), roots);
          assertReadableFileSize(path);
          return content(readFileSync(path, 'utf8'));
        }
        if (name === 'Write') {
          const path = resolveScopedPath(requireString(call.input, 'path'), roots, {
            allowMissingLeaf: true,
          });
          const newContent = requireString(call.input, 'content');
          if (Buffer.byteLength(newContent) > MAX_FILE_BYTES) {
            throw new Error('File exceeds write limit');
          }
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, newContent, 'utf8');
          return content({ path, written: true });
        }
        if (name === 'Edit') {
          const path = resolveScopedPath(requireString(call.input, 'path'), roots);
          const oldText = requireString(call.input, 'old_string');
          const newText = requireString(call.input, 'new_string');
          assertReadableFileSize(path);
          const original = readFileSync(path, 'utf8');
          const first = original.indexOf(oldText);
          if (first < 0) throw new Error('old_string was not found');
          if (original.indexOf(oldText, first + oldText.length) >= 0) {
            throw new Error('old_string matched more than once');
          }
          const edited = `${original.slice(0, first)}${newText}${original.slice(first + oldText.length)}`;
          if (Buffer.byteLength(edited) > MAX_FILE_BYTES) {
            throw new Error('File exceeds write limit');
          }
          writeFileSync(path, edited, 'utf8');
          return content({ path, edited: true });
        }
        if (name === 'Bash') {
          const cwd = resolveScopedPath(optionalString(call.input, 'workdir') ?? roots[0], roots);
          const result = await options.executeCommand(
            requireString(call.input, 'command'),
            cwd,
            roots,
            call.signal
          );
          const stdout = boundedCommandStream(result.stdout);
          const stderr = boundedCommandStream(result.stderr);
          return content(
            {
              exitCode: result.exitCode,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutBytes: stdout.bytes,
              stderrBytes: stderr.bytes,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            },
            result.exitCode !== 0
          );
        }
        const scanRoot = resolveScopedPath(optionalString(call.input, 'path') ?? roots[0], roots);
        const files = walkFiles(scanRoot);
        if (name === 'Glob') {
          const pattern = requireString(call.input, 'pattern');
          const matches = files
            .filter((path) => minimatch(relative(scanRoot, path), pattern, { dot: true }))
            .slice(0, MAX_RESULTS);
          return content(matches);
        }
        const regex = new RegExp(requireString(call.input, 'pattern'), 'g');
        const glob = optionalString(call.input, 'glob');
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const path of files) {
          if (glob && !minimatch(relative(scanRoot, path), glob, { dot: true })) continue;
          const stat = lstatSync(path);
          if (stat.size > MAX_FILE_BYTES) continue;
          const lines = readFileSync(path, 'utf8').split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            regex.lastIndex = 0;
            if (regex.test(lines[index])) {
              matches.push({ path, line: index + 1, text: lines[index] });
              if (matches.length >= MAX_RESULTS) return content(matches);
            }
          }
        }
        return content(matches);
      } catch (error) {
        return content(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}

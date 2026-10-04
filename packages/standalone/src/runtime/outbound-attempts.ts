/**
 * Outbound attempts from native tools are seen, not blocked (W35; owner, 2026-10-03). A shell
 * command that opens a network connection becomes a security event the owner is told about,
 * whether the sandbox refuses it or not. A web fetch is reported with its URL too (owner,
 * 2026-10-05): it stays open, but text placed in a URL reaches whatever host it names. Web search
 * goes to the search provider only and stays in tool_traces. The shell patterns name network
 * clients in command position, not URL literals: a
 * script that reads a sheet full of links is not an attempt. They are a heuristic: a client they do
 * not name, or a script file written first and run after, is missed.
 */
import type { NativeEffectObserver } from '@jungjaehoon/mama-core/runtime/native-effect-observer';
import { traceSummary } from '@jungjaehoon/mama-core/runtime/trace-summary';

import type { OutboundAttemptEvent } from '../api/security-events.js';

const WEB_FETCH_TOOLS = new Set(['webfetch']);

const SHELL_TOOLS = new Set([
  'bash',
  'commandexecution',
  'shell',
  'shell_command',
  'exec_command',
  'execute_command',
]);

// A command word: at the start, after a line break, a separator or an opening quote (Codex sends a shell call as
// `/bin/zsh -c "..."`), behind sudo, env, time, xargs, nohup, exec or command and their flags, with
// an optional directory (`/usr/bin/curl`). `grep curl` or `man ssh` does not put a client there.
const AT_COMMAND = String.raw`(?:^|[\n;&|(\x60'"]|\$\()\s*(?:(?:sudo|env|time|xargs|nohup|exec|command)\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*)*(?:[\w.~-]*\/)*`;
const atCommand = (words: string) => new RegExp(`${AT_COMMAND}(?:${words})(?=\\s|$|['"])`);

const NETWORK = [
  atCommand('curl|wget|nc|ncat|netcat|telnet|ftp|sftp|scp|ssh|rsync|http|https|xh|rclone|gsutil'),
  atCommand(String.raw`(?:pip3?|npm|pnpm|yarn|brew|gem|cargo|apt|apt-get)\s+(?:install|add|i|ci)`),
  atCommand(String.raw`git(?:\s+-C\s+\S+)?\s+(?:push|clone|fetch|pull)`),
  atCommand(String.raw`gh\s+(?:api|gist|release\s+upload)`),
  atCommand(String.raw`aws\s+s3\s+(?:cp|sync|mv)`),
  /\b(?:python3?|node|ruby|perl)\b[\s\S]*(?:\brequests\.|\burllib\.request\b|\burlopen\(|\bhttp\.client\b|\bsocket\.|\bfetch\(|\baxios\b|\bnet\/http\b)/,
];
// Case-sensitive: `curl -D` dumps headers, `-d` sends data.
const SENDS_DATA = [
  /\bcurl\b[\s\S]*?(?:\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|--json)(?:\s|=|@|'|"|$)|\s-X\s*(?:POST|PUT|PATCH)\b|\s--request[\s=](?:POST|PUT|PATCH)\b)/,
  /\bwget\b[\s\S]*--post-(?:data|file)/,
  atCommand('scp|sftp|nc|ncat|netcat'),
  /\brsync\b[\s\S]*\s\S+:\S*/,
  /\bgit\b(?:\s+-C\s+\S+)?\s+push\b/,
  /\b(?:http|https|xh)\s+(?:POST|PUT|PATCH)\b/,
  /\bgh\s+(?:gist\s+create|release\s+upload)\b|\bgh\s+api\b[\s\S]*(?:-X\s*(?:POST|PUT|PATCH)|--method[\s=](?:POST|PUT|PATCH)|\s-[fF]\s)/,
  /\baws\s+s3\s+(?:cp|sync|mv)\b|\bgsutil\s+cp\b|\brclone\s+(?:copy|sync|move)\b/,
  /\brequests\.(?:post|put|patch)\b|\bmethod\s*[:=]\s*['"](?:POST|PUT|PATCH)['"]|\burlopen\([^)]*,\s*data/,
];

function commandText(input: Record<string, unknown>): string | null {
  const command = input.command;
  if (typeof command === 'string') return command;
  // argv elements stay apart, so the script of `bash -lc '...'` starts a command of its own.
  if (Array.isArray(command)) return command.map(String).join('\n');
  return null;
}

/** The command as tool_traces shows it (bounded, secrets masked), as plain text. */
function commandSummary(command: string): string | null {
  const traced = traceSummary(command);
  if (traced === null) return null;
  // A summary cut at its bound ends in "..." outside the JSON string; keep it as cut.
  return traced.endsWith('"') ? (JSON.parse(traced) as string) : traced;
}

/** The outbound attempt a native tool call makes, or null for any other call. */
export function outboundAttempt(
  name: string,
  input: Record<string, unknown>,
  modelRunId: string
): OutboundAttemptEvent | null {
  const callId = typeof input.nativeToolUseId === 'string' ? input.nativeToolUseId : null;
  if (WEB_FETCH_TOOLS.has(name.toLowerCase())) {
    if (typeof input.url !== 'string') return null;
    return {
      time: new Date().toISOString(),
      class: 'web_fetch',
      tool: name,
      summary: commandSummary(input.url),
      // A page read sends no body, but its URL can carry text; which is not knowable here.
      sendsData: null,
      modelRunId,
      callId,
    };
  }
  if (!SHELL_TOOLS.has(name.toLowerCase())) return null;
  const command = commandText(input);
  if (command === null || !NETWORK.some((pattern) => pattern.test(command))) return null;
  const sendsData = SENDS_DATA.some((pattern) => pattern.test(command));
  return {
    time: new Date().toISOString(),
    class: sendsData ? 'outbound_send' : 'outbound_attempt',
    tool: name,
    summary: commandSummary(command),
    sendsData,
    modelRunId,
    callId,
  };
}

/**
 * Wraps a run's trace observer. A runtime can announce one call twice, so the trace observer drops
 * a repeated call id; the owner is told once per call the same way.
 */
export function withOutboundAttempts(
  inner: NativeEffectObserver,
  modelRunId: string,
  sink: (event: OutboundAttemptEvent) => void
): NativeEffectObserver {
  const seen = new Set<string>();
  return {
    started(name, input) {
      inner.started(name, input);
      const event = outboundAttempt(name, input, modelRunId);
      if (event === null) return;
      if (event.callId !== null) {
        if (seen.has(event.callId)) return;
        seen.add(event.callId);
      }
      sink(event);
    },
    settled: (name, toolUseId, isError, outcome) =>
      inner.settled(name, toolUseId, isError, outcome),
    interrupted: () => inner.interrupted(),
    finished: () => inner.finished?.(),
  };
}

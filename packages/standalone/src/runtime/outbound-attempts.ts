/**
 * Outbound attempts from native tools are seen, not blocked (W35; owner, 2026-10-03). A shell
 * command that opens a network connection becomes a security event the owner is told about,
 * whether the sandbox refuses it or not. Web fetch and web search stay open and stay recorded in
 * tool_traces only. The patterns name network clients, not URL literals: a script that reads a
 * sheet full of links is not an attempt. They are a heuristic; a client they do not name is missed.
 */
import type { NativeEffectObserver } from '@jungjaehoon/mama-core/runtime/native-effect-observer';
import { traceSummary } from '@jungjaehoon/mama-core/runtime/trace-summary';

import type { OutboundAttemptEvent } from '../api/security-events.js';

const SHELL_TOOLS = new Set([
  'bash',
  'commandexecution',
  'shell',
  'shell_command',
  'exec_command',
  'execute_command',
]);

const WORD_START = String.raw`(?:^|[\s;&|(\x60$])`;
const NETWORK = [
  new RegExp(`${WORD_START}(?:curl|wget|nc|ncat|netcat|telnet|ftp|sftp|scp|ssh|rsync)(?=\\s|$)`),
  /\b(?:pip3?|npm|pnpm|yarn|brew|gem|cargo)\s+(?:install|add)\b/,
  /\bgit\s+(?:push|clone|fetch|pull)\b/,
  /\b(?:python3?|node|ruby|perl)\b[\s\S]*(?:\brequests\.|\burllib\b|\bhttp\.client\b|\bsocket\.|\bfetch\(|\baxios\b|\bnet\/http\b)/,
];
const SENDS_DATA = [
  /\bcurl\b[\s\S]*(?:\s-d\b|\s--data|\s-F\b|\s--form|\s-T\b|\s--upload-file|\s-X\s*(?:POST|PUT|PATCH)\b|\s--request\s+(?:POST|PUT|PATCH)\b)/i,
  /\bwget\b[\s\S]*--post-(?:data|file)/,
  new RegExp(`${WORD_START}(?:scp|sftp|nc|ncat|netcat)(?=\\s|$)`),
  /\brsync\b[\s\S]*\s\S+:\S*/,
  /\bgit\s+push\b/,
  /\brequests\.(?:post|put|patch)\b|\bmethod\s*[:=]\s*['"](?:POST|PUT|PATCH)['"]/i,
];

function commandText(input: Record<string, unknown>): string | null {
  const command = input.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return null;
}

/** The outbound attempt a native tool call makes, or null for any other call. */
export function outboundAttempt(
  name: string,
  input: Record<string, unknown>,
  modelRunId: string
): OutboundAttemptEvent | null {
  if (!SHELL_TOOLS.has(name.toLowerCase())) return null;
  const command = commandText(input);
  if (command === null || !NETWORK.some((pattern) => pattern.test(command))) return null;
  return {
    time: new Date().toISOString(),
    class: 'outbound_attempt',
    tool: name,
    summary: traceSummary({ command }),
    sendsData: SENDS_DATA.some((pattern) => pattern.test(command)),
    modelRunId,
    callId: typeof input.nativeToolUseId === 'string' ? input.nativeToolUseId : null,
  };
}

/** Wraps a run's trace observer; a call reported twice is reported to the owner once. */
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

import { AgentError } from './drivers/types.js';

/** Notifications are observations, not backend pre-execution authorization hooks. */
export interface NativeEffectObserver {
  started(name: string, input: Record<string, unknown>): void;
  settled(name: string, toolUseId: string, isError: boolean, outcome?: 'unknown'): void;
  interrupted(): void;
  /** Settle the durable admission marker only after a clean run return. */
  finished?(): void;
}

const NATIVE_EFFECT_NAMES = new Set([
  'bash',
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'exec_command',
  'shell',
  'shell_command',
  'commandexecution',
  'filechange',
  'execute_command',
  'write_to_file',
  'replace_in_file',
]);

/**
 * Delegation is an admission, not an effect. Spawning a native subagent (Claude `Agent`/
 * `Task`, Codex `spawn_agent`/`send_input`/`resume_agent`) names nothing the replay gate
 * can re-execute: every effect the child performs carries its own ledger row through the
 * gateway. Measured 2026-09-10: a Claude `Agent` tool_use recorded as `native_tool`
 * under the reused `workorder:board:full:repair` occurrence blocked every later board
 * order ("owner effect requires reconciliation before replay", orders #4805-#4807).
 * Codex spawns already bypass this boundary via `onSubagentStart`; the Claude spawn
 * arrives as an ordinary tool_use, so the name set must not claim it.
 */
const DELEGATION_NAMES = new Set([
  'agent',
  'task',
  'spawn_agent',
  'collabagenttoolcall',
  'send_input',
  'resume_agent',
]);
export function isDelegationToolName(name: string): boolean {
  return DELEGATION_NAMES.has(name.toLowerCase());
}

const NATIVE_READ_NAMES = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch', 'web_search']);

/**
 * A Codex app call (the account's connectors), named `codex_apps:<tool>` by the driver. A write
 * (no `readOnlyHint`) reaches a service outside the host, so its turn is not replayed.
 */
export const CODEX_APP_PREFIX = 'codex_apps:';

function isAppToolName(name: string): boolean {
  return name.startsWith(CODEX_APP_PREFIX);
}

export function isNativeToolName(name: string): boolean {
  return (
    isAppToolName(name) ||
    NATIVE_EFFECT_NAMES.has(name.toLowerCase()) ||
    NATIVE_READ_NAMES.has(name.toLowerCase()) ||
    isDelegationToolName(name)
  );
}

/** TG-03/04/05/06: a completed shell invocation is still unsafe to replay. */
export class NativeEffectReplayBoundary {
  private observed = false;
  constructor(private readonly observer?: NativeEffectObserver) {}

  private observe(callback: () => void): void {
    try {
      callback();
    } catch {
      // A trace sink is not an authorization hook; omit exception text (may contain input).
      console.warn('[NativeEffectObserver] observation failed');
    }
  }

  started(name: string, input: Record<string, unknown>): void {
    if (!isNativeToolName(name)) return;
    if (NATIVE_EFFECT_NAMES.has(name.toLowerCase())) this.observed = true;
    if (isAppToolName(name) && input.readOnlyHint !== true) this.observed = true;
    this.observe(() => this.observer?.started(name, input));
  }

  settled(name: string, toolUseId: string, isError: boolean, outcome?: 'unknown'): void {
    if (!isNativeToolName(name)) return;
    if (NATIVE_EFFECT_NAMES.has(name.toLowerCase())) this.observed = true;
    this.observe(() => this.observer?.settled(name, toolUseId, isError, outcome));
  }

  finished(): void {
    this.observe(() => this.observer?.finished?.());
  }

  failure(error: unknown, allowPreExecutionRecovery = false): unknown {
    // Only AgentLoop's trusted recoverable-session predicate may permit a reset.
    // Once a native effect is observed, even a session error cannot allow replay.
    if (allowPreExecutionRecovery && !this.observed) {
      this.observe(() => this.observer?.interrupted());
      return error;
    }
    if (!this.observed) {
      this.observe(() => this.observer?.interrupted());
      return error;
    }
    try {
      this.observer?.interrupted();
    } catch {
      // The durable started reservation remains unresolved if settlement fails.
    }
    return new AgentError(
      'Native run effect outcome is uncertain; reconcile effects before replaying the occurrence.',
      'MUTATION_OUTCOME_UNKNOWN',
      error instanceof Error ? error : new Error(String(error)),
      false
    );
  }
}

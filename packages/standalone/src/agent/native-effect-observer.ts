import { AgentError } from './types.js';

/** Notifications are observations, not backend pre-execution authorization hooks. */
export interface NativeEffectObserver {
  started(name: string, input: Record<string, unknown>): void;
  settled(name: string, toolUseId: string, isError: boolean): void;
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

/** TG-03/04/05/06: a completed shell invocation is still unsafe to replay. */
export class NativeEffectReplayBoundary {
  private observed = false;
  constructor(private readonly observer?: NativeEffectObserver) {}

  started(name: string, input: Record<string, unknown>): void {
    if (!NATIVE_EFFECT_NAMES.has(name.toLowerCase())) {
      return;
    }
    // Latch before persistence: an observer failure must also prevent retry.
    this.observed = true;
    this.observer?.started(name, input);
  }

  settled(name: string, toolUseId: string, isError: boolean): void {
    if (!NATIVE_EFFECT_NAMES.has(name.toLowerCase())) {
      return;
    }
    this.observed = true;
    this.observer?.settled(name, toolUseId, isError);
  }

  finished(): void {
    this.observer?.finished?.();
  }

  failure(error: unknown, allowPreExecutionRecovery = false): unknown {
    // Only AgentLoop's trusted recoverable-session predicate may permit a reset.
    // Once a native effect is observed, even a session error cannot allow replay.
    if (allowPreExecutionRecovery && !this.observed) {
      return error;
    }
    if (!this.observed && !this.observer) {
      return error;
    }
    try {
      this.observer?.interrupted();
    } catch {
      // The durable started reservation remains unresolved if settlement fails.
    }
    return new AgentError(
      'Native run effect outcome is uncertain; reconcile effects before replaying the occurrence.',
      'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      error instanceof Error ? error : new Error(String(error)),
      false
    );
  }
}

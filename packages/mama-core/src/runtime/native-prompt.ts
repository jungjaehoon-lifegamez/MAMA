/**
 * One native request: prepare its protocol options, forward acknowledgement and
 * events, record observed exchanges, and return the harness result.
 * Tool execution, compaction and continuation belong to the native harness.
 */
import type {
  AgentErrorCode,
  BackendType,
  ClaudeResponse,
  ContentBlock,
  HostExecutionContext,
  HostToolBridge,
  IModelRunner,
  Message,
  ModelRunnerErrorCode,
  PromptFinalResponse,
  PromptResult,
  StopReason,
  StreamCallbacks,
  ToolResultBlock,
  ToolUseBlock,
  TurnInfo,
  Usage,
} from './drivers/types.js';
import {
  AgentError,
  ClaudeToolStreamProtocolError,
  HostToolAbortError,
  HostToolTerminalError,
  ModelRunnerError,
  NativeInputUncertainError,
  NativeSessionUnavailableError,
  type NativeInputReceipt,
  type NativeInputDispatch,
} from './drivers/types.js';
import type { SessionPool } from './session-pool.js';
import type { NativeEffectReplayBoundary } from './native-effect-observer.js';
import { DebugLogger } from '../debug-logger.js';

const logger = new DebugLogger('turn');
import { countBudgetTokens } from './turn-text.js';
import type { ModelRunUsage } from './model-run-types.js';

function accumulateUsage(
  total: Usage,
  measured: ModelRunUsage,
  usage: PromptResult['usage']
): void {
  total.input_tokens += usage.input_tokens ?? 0;
  total.output_tokens += usage.output_tokens ?? 0;
  for (const field of Object.keys(measured) as Array<keyof ModelRunUsage>) {
    const value = usage[field];
    if (value !== undefined) measured[field] = (measured[field] ?? 0) + value;
  }
}

/** Why a run stopped on the host's side, as distinct from the model's own stop reason. */
export interface BudgetStopInfo {
  channelKey: string;
  modelRunId: string | null;
  agentId?: string;
  budgetTokens: number;
  runTokenBudget: number;
  turns: number;
}

/** Run-local observers and tier. Never instance state: two runs can overlap. */
export interface RunScope {
  streamCallbacks?: StreamCallbacks;
  tier: 1 | 2 | 3;
  onTurn?: (turn: TurnInfo) => void;
  onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
}

/** State the loop is handed and hands back. Everything here changes as turns run. */
export interface NativePromptCarry {
  turn: number;
  stopReason: StopReason;
  stoppedBy?: 'budget';
  budgetTokens: number;
  resolvedCliSessionId: string | null;
  sessionIsNew: boolean;
}

/**
 * The fourteen facts about this request the loop actually reads. The caller's own
 * options object is wider and names things the core has no business knowing; this is
 * the part that crosses.
 */
export interface NativePromptRequest {
  nativeInputId?: string;
  source?: string;
  freshSession?: boolean;
  resumeSession?: boolean;
  model?: string;
  requestTimeoutMs?: number;
  onCliSessionReset?: (sessionId: string) => void;
  systemPrompt?: string;
  promptKind?: string;
  promptBrief?: 'sent' | 'omitted';
  agentContext?: { roleName?: string };
  modelRunId?: string;
  stopAfterSuccessfulTools?: string[];
}

/** A model-runner failure, said in the loop's own error vocabulary. */
const MODEL_RUNNER_AGENT_ERROR_CODES: Record<ModelRunnerErrorCode, AgentErrorCode> = {
  timeout: 'NETWORK_ERROR',
  crash: 'CLI_ERROR',
  context_overflow: 'MAX_TOKENS',
  auth_failure: 'AUTH_ERROR',
  rate_limit: 'RATE_LIMIT',
  unknown: 'CLI_ERROR',
};

/** A tool result carries two host-only fields that history must not keep. */
export type InternalToolResultBlock = ToolResultBlock & {
  abort?: boolean;
  terminalCode?: string;
};

/**
 * Everything the loop reads that does not change while it runs. The caller builds it
 * once, before the first turn.
 */
export interface NativePromptContext<TToolContext extends HostExecutionContext> {
  prepareSessionContent?: (
    session: import('./drivers/types.js').NativeSessionState
  ) => Promise<ContentBlock[]>;
  channelKey: string;
  claudeNativeTools: string | undefined;
  effectiveSessionPolicyFingerprint: string | undefined;
  restrictedReadRoots: readonly string[] | undefined;
  nativeCwd: string | undefined;
  history: Message[];
  hostToolBridge: HostToolBridge | undefined;
  isCodex: boolean;
  isDurableRuntime: boolean;
  nativeEffects: NativeEffectReplayBoundary;
  ownedModelRunId: string | null;
  standingPolicy: boolean;
  /** What this call opens with, already composed by the entry. */
  systemPrompt: string | undefined;
  /**
   * The complete current policy, asked for only when the durable thread this run was
   * resuming turned out to be gone. The loop never composes one: it asks.
   */
  reanchor: (() => Promise<string>) | undefined;
  resumeInstructions: (() => Promise<string>) | undefined;
  runScope: RunScope;
  toolExecutionContext: TToolContext | null;
  totalUsage: Usage;
  runUsage: ModelRunUsage;
  tracksSessionPolicy: boolean;
}

/**
 * Native driver, lifecycle bookkeeping and the consumer's input formatting port.
 */
export interface NativePromptHost {
  agent: IModelRunner;
  backend: BackendType;
  model: string;
  runTokenBudget: number;
  sessionPool: SessionPool;
  onBudgetStop?: (info: BudgetStopInfo) => void;
  onTokenUsage?: (record: {
    channel_key: string;
    agent_id?: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cost_usd?: number;
  }) => void;
  onMetric?: (name: string, value: number, labels?: Record<string, string>) => void;
  formatLastMessageOnly(history: Message[]): string;
}

/**
 * Submit one native request and observe its completed exchanges and final result.
 * `carry` is read and written: the caller reads the final state off it.
 */
export async function runNativePrompt<TToolContext extends HostExecutionContext>(
  carry: NativePromptCarry,
  context: NativePromptContext<TToolContext>,
  request: NativePromptRequest,
  host: NativePromptHost
): Promise<void> {
  const {
    channelKey,
    claudeNativeTools,
    effectiveSessionPolicyFingerprint,
    restrictedReadRoots,
    nativeCwd,
    history,
    hostToolBridge,
    isCodex,
    isDurableRuntime,
    nativeEffects,
    ownedModelRunId,
    standingPolicy,
    systemPrompt,
    reanchor,
    resumeInstructions,
    runScope,
    toolExecutionContext,
    totalUsage,
    tracksSessionPolicy,
  } = context;

  // The eight that change are taken out of `carry` and put back in a finally, so the
  // body below is the same text it was inside the class. A throw still reports the
  // turn it reached.
  let { turn, stopReason, stoppedBy, budgetTokens, resolvedCliSessionId, sessionIsNew } = carry;
  try {
    turn++;
    {
      let response: ClaudeResponse;

      const ext = runScope.streamCallbacks;
      let attemptReportedError: Error | undefined;
      let nativeReceipt: NativeInputReceipt | undefined;
      let nativeDispatch: NativeInputDispatch | undefined;
      const callbacks = {
        onInputDispatch: (input: NativeInputDispatch) => {
          ext?.onInputDispatch?.(input);
          nativeDispatch = input;
        },
        onAccepted: (receipt: NativeInputReceipt) => {
          nativeReceipt = receipt;
          ext?.onAccepted?.(receipt);
        },
        onDelta: (text: string) => {
          ext?.onDelta?.(text);
        },
        onToolUse: (name: string, input: Record<string, unknown>) => {
          nativeEffects.started(name, input);
          ext?.onToolUse?.(name, input);
        },
        onToolComplete: (
          name: string,
          toolUseId: string,
          isError: boolean,
          outcome?: 'unknown'
        ) => {
          nativeEffects.settled(name, toolUseId, isError, outcome);
          if (outcome) ext?.onToolComplete?.(name, toolUseId, isError, outcome);
          else ext?.onToolComplete?.(name, toolUseId, isError);
        },
        // A spawn is an admission, not an external effect: forwarded verbatim with NO
        // nativeEffects call, so it never writes a `native_tool` ledger row and never
        // makes the occurrence unsafe to replay.
        onSubagentStart: (info: { agentThreadId: string; agentPath: string; itemId: string }) => {
          ext?.onSubagentStart?.(info);
        },
        onFollowUp: (info: {
          agentThreadId: string;
          agentPath: string;
          itemId: string;
          text: string;
          isError: boolean;
        }) => {
          ext?.onFollowUp?.(info);
        },
        onFinal: (finalResponse: PromptFinalResponse) => {
          ext?.onFinal?.(finalResponse);
        },
        onError: (error: Error) => {
          // A model runner can emit onError before rejecting. Hold it until
          // AgentLoop knows whether the attempt is terminal so a successful
          // one-time session recovery does not leak a false failure event.
          attemptReportedError = error;
        },
      };

      let piResult;
      // Claude: first turn uses --session-id and injects the system prompt; later turns --resume
      // Codex: resumeSession controls durable session reset/continuation.
      let shouldResume = isDurableRuntime
        ? turn > 1 || (request.freshSession === true ? false : (request.resumeSession ?? true))
        : !sessionIsNew || turn > 1 || (standingPolicy && request.resumeSession === true);
      let requestSystemPrompt = systemPrompt;
      let provisionalDurableSessionId: string | undefined;
      // All three backends preserve context and receive only the new user message.
      const basePromptText = host.formatLastMessageOnly(history);
      const preparePrompt = context.prepareSessionContent
        ? async (session: import('./drivers/types.js').NativeSessionState): Promise<string> => {
            const content = await context.prepareSessionContent!(session);
            const input = [...history].reverse().find((message) => message.role === 'user');
            if (!input) throw new Error('Native session content requires an input message');
            input.content = content;
            console.log(
              `[NativeTurn] [${host.backend}] ${channelKey} (${session.isNewSession ? 'NEW' : 'CONTINUE'} native session)`
            );
            return host.formatLastMessageOnly(history);
          }
        : undefined;
      let promptText = basePromptText;
      const promptStart = Date.now();
      const throwFinalCliError = (error: unknown): never => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const modelRunnerErrorCode =
          normalizedError instanceof ModelRunnerError
            ? MODEL_RUNNER_AGENT_ERROR_CODES[normalizedError.code]
            : undefined;
        const errorType =
          normalizedError instanceof ClaudeToolStreamProtocolError
            ? normalizedError.code
            : normalizedError instanceof HostToolTerminalError
              ? normalizedError.terminalCode
              : (modelRunnerErrorCode ?? 'CLI_ERROR');
        host.onMetric?.('prompt_error', 1, {
          backend: host.backend,
          error_type: errorType,
        });
        try {
          ext?.onError?.(attemptReportedError ?? normalizedError);
        } catch (callbackError) {
          logger.warn(
            `External onError callback failed: ${
              callbackError instanceof Error ? callbackError.message : String(callbackError)
            }`
          );
        }
        if (normalizedError instanceof HostToolTerminalError) {
          throw new AgentError(
            normalizedError.message,
            normalizedError.terminalCode,
            normalizedError,
            false
          );
        }
        if (normalizedError instanceof HostToolAbortError) {
          throw new AgentError(normalizedError.message, 'CLI_ERROR', normalizedError, false);
        }
        if (normalizedError instanceof NativeInputUncertainError) {
          throw new AgentError(normalizedError.message, 'CLI_ERROR', normalizedError, false);
        }
        if (normalizedError instanceof ClaudeToolStreamProtocolError) {
          throw new AgentError(
            normalizedError.message,
            normalizedError.code,
            normalizedError,
            false
          );
        }
        throw new AgentError(
          `CLI error: ${normalizedError.message}`,
          modelRunnerErrorCode ?? 'CLI_ERROR',
          normalizedError,
          normalizedError instanceof ModelRunnerError ? normalizedError.retryable : true
        );
      };
      const appendCompletedToolExchanges = (
        exchanges: readonly {
          toolUse: ToolUseBlock;
          toolResult: ToolResultBlock;
        }[]
      ): void => {
        for (const exchange of exchanges) {
          history.push({ role: 'assistant', content: [exchange.toolUse] });
          runScope.onTurn?.({
            turn,
            role: 'assistant',
            content: [exchange.toolUse],
            stopReason: 'tool_use',
          });
          history.push({ role: 'user', content: [exchange.toolResult] });
          runScope.onTurn?.({
            turn,
            role: 'user',
            content: [exchange.toolResult],
          });
        }
      };
      try {
        const durablePolicyStatus =
          tracksSessionPolicy && turn === 1 && (shouldResume || standingPolicy)
            ? host.agent.getSessionPolicyStatus?.({
                model: request.model,
                resumeSession: true,
                systemPrompt: requestSystemPrompt,
                sessionKey: channelKey,
                sessionPolicyFingerprint: effectiveSessionPolicyFingerprint,
                restrictedReadRoots,
                cwd: nativeCwd,
                sessionId: resolvedCliSessionId ?? undefined,
                requestTimeout: request.requestTimeoutMs,
                // Enforced INSIDE the codex turn (usage events), see CodexAppServerProcess.
                runTokenBudget: host.runTokenBudget,
                hostToolBridge,
              })
            : undefined;
        if (durablePolicyStatus === 'mismatch' || durablePolicyStatus === 'missing') {
          console.log(
            `[turn] ${host.backend} durable session ${durablePolicyStatus}; ` +
              'opening the full policy before model request'
          );
          if (host.backend === 'claude' && durablePolicyStatus === 'mismatch') {
            if (!host.agent.resetSession) {
              throw new Error('Claude model runner cannot retire a stale policy session');
            }
            await host.agent.resetSession(resolvedCliSessionId ?? undefined);
          }
          const newSessionId = host.sessionPool.resetSession(channelKey);
          request.onCliSessionReset?.(newSessionId);
          resolvedCliSessionId = newSessionId;
          provisionalDurableSessionId = newSessionId;
          try {
            // Recovery is asked for only after the backend proves replacement is
            // required, never from host pool state.
            const reanchored = await reanchor?.();
            if (reanchored !== undefined) {
              requestSystemPrompt = reanchored;
            }
          } catch (rebuildError) {
            host.sessionPool.invalidateSession(channelKey, newSessionId);
            provisionalDurableSessionId = undefined;
            attemptReportedError =
              rebuildError instanceof Error ? rebuildError : new Error(String(rebuildError));
            throw rebuildError;
          }
          shouldResume = false;
        }
        promptText = basePromptText;
        piResult = await host.agent.prompt(promptText, callbacks, {
          preparePrompt,
          model: request.model,
          nativeInputId: request.nativeInputId,
          resumeSession: shouldResume,
          systemPrompt: requestSystemPrompt,
          resumeInstructions,
          promptTelemetry: {
            kind: request.promptKind ?? (request.source === 'operator' ? 'scheduled' : 'chat'),
            brief: request.promptBrief ?? 'omitted',
          },
          sessionKey: channelKey,
          sessionPolicyFingerprint: effectiveSessionPolicyFingerprint,
          restrictedReadRoots,
          cwd: nativeCwd,
          sessionId: resolvedCliSessionId ?? undefined,
          // Per-run request timeout (operator worker runs); undefined leaves
          // the pool's construction-time default untouched (chat).
          requestTimeout: request.requestTimeoutMs,
          runTokenBudget: host.runTokenBudget,
          hostToolBridge,
          toolExecutionContext,
          ...(host.backend === 'claude' ? { tools: claudeNativeTools } : {}),
        });
        provisionalDurableSessionId = undefined;
      } catch (error) {
        if (provisionalDurableSessionId) {
          host.sessionPool.invalidateSession(channelKey, provisionalDurableSessionId);
          provisionalDurableSessionId = undefined;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[turn] ${host.backend} CLI error:`, errorMessage);

        const errorUsage = (error as { usage?: PromptResult['usage'] }).usage;
        if (errorUsage) {
          accumulateUsage(totalUsage, context.runUsage, errorUsage);
          budgetTokens += countBudgetTokens(errorUsage, host.backend);
        }

        // A codex turn interrupted by the run budget is a host decision, not a failure:
        // stop here with what was collected and let the host record the receipt.
        if (
          (error as { code?: unknown })?.code === 'RUN_BUDGET_STOP' ||
          errorMessage.startsWith('run budget stop:')
        ) {
          stoppedBy = 'budget';
          const stoppedUsage = errorUsage;
          if (stoppedUsage) {
            try {
              host.onTokenUsage?.({
                channel_key: channelKey,
                agent_id: request.agentContext?.roleName || host.model,
                input_tokens: stoppedUsage.input_tokens ?? 0,
                output_tokens: stoppedUsage.output_tokens ?? 0,
                cache_read_tokens: stoppedUsage.cache_read_input_tokens || 0,
                cost_usd: 0,
              });
            } catch {
              // Recording failures must never mask the stop itself.
            }
          }
          budgetTokens = Math.max(budgetTokens, host.runTokenBudget);
          try {
            host.onBudgetStop?.({
              channelKey,
              modelRunId: ownedModelRunId ?? request.modelRunId ?? null,
              agentId: request.agentContext?.roleName,
              budgetTokens,
              runTokenBudget: host.runTokenBudget,
              turns: turn,
            });
          } catch {
            // Receipt failures must never mask the stop itself.
          }
          return;
        }

        if (error instanceof HostToolTerminalError && error.completedToolExchanges?.length) {
          appendCompletedToolExchanges(error.completedToolExchanges);
          throwFinalCliError(error);
        }
        if (error instanceof HostToolAbortError && error.completedToolExchanges.length > 0) {
          appendCompletedToolExchanges(error.completedToolExchanges);
          throwFinalCliError(error);
        }

        if (nativeReceipt || nativeDispatch) {
          throwFinalCliError(
            new NativeInputUncertainError(
              'Native input dispatch began; reconcile its result before replay',
              (nativeReceipt ?? nativeDispatch)!,
              error
            )
          );
        }
        // Check if this is a recoverable session error
        // 1. "No conversation found" - CLI session was lost (daemon restart, timeout)
        // 2. "Session ID already in use" - concurrent request conflict
        // 3. "Prompt is too long" - session context exceeded API limits
        const isSessionNotFound = errorMessage.includes('No conversation found with session ID');
        const isSessionInUse = errorMessage.includes('is already in use');
        const isPromptTooLong =
          (error instanceof ModelRunnerError && error.code === 'context_overflow') ||
          errorMessage.includes('Prompt is too long') ||
          errorMessage.includes('prompt is too long') ||
          errorMessage.includes('request_too_large') ||
          errorMessage.includes('context window') ||
          errorMessage.includes('context_length_exceeded');
        const isCodexPolicyMismatch = errorMessage.includes(
          'Codex app-server thread policy mismatch; reset the session explicitly'
        );
        // 4. API 400 on a resumed session whose stored transcript carries an
        //    empty content block (live incident 2026-07-27: sonnet emitted an
        //    empty thinking block, the CLI persisted it, and every subsequent
        //    replay of that session died with this 400). The transcript is
        //    unrecoverable - only a fresh session heals it.
        const isCorruptTranscript = errorMessage.includes('text content blocks must be non-empty');

        const canRecoverSession =
          error instanceof NativeSessionUnavailableError ||
          (isCodex && isCodexPolicyMismatch) ||
          (!isCodex &&
            (isSessionNotFound || isSessionInUse || isPromptTooLong || isCorruptTranscript));
        const nativeFailure = nativeEffects.failure(error, canRecoverSession);
        if (nativeFailure !== error) {
          throw nativeFailure;
        }

        if (canRecoverSession) {
          const reason = isCodexPolicyMismatch
            ? 'policy mismatch'
            : error instanceof NativeSessionUnavailableError
              ? 'native context missing'
              : isSessionNotFound
                ? 'not found in CLI'
                : isSessionInUse
                  ? 'already in use'
                  : isCorruptTranscript
                    ? 'transcript corrupt (empty content block)'
                    : 'prompt too long (context overflow)';
          console.log(`[turn] Session ${reason}, retrying with new session`);

          // Reset session in pool so it creates a new one
          const newSessionId = host.sessionPool.resetSession(channelKey);
          request.onCliSessionReset?.(newSessionId);
          // Per-call routing: hand the new id to this prompt() and update the
          // resolved id so later turns follow it - no shared-adapter mutation.
          resolvedCliSessionId = newSessionId;

          // A recoverable durable-session error can occur on a resumed
          // native session whose per-call prompt is intentionally minimal.
          // Rebuild the full policy before opening every replacement session.
          let resetSystemPrompt = systemPrompt;
          try {
            // Discard the recoverable first-attempt error before any reset
            // preparation. A prompt rebuild or retry failure must surface
            // its own final error, never the mismatch that triggered it.
            attemptReportedError = undefined;
            const reanchoredAfterReset = await reanchor?.();
            if (reanchoredAfterReset !== undefined) {
              resetSystemPrompt = reanchoredAfterReset;
            }

            promptText = basePromptText;
            piResult = await host.agent.prompt(promptText, callbacks, {
              preparePrompt,
              model: request.model,
              nativeInputId: request.nativeInputId,
              resumeSession: false, // Force new session
              systemPrompt: resetSystemPrompt,
              sessionKey: channelKey,
              sessionPolicyFingerprint: effectiveSessionPolicyFingerprint,
              restrictedReadRoots,
              cwd: nativeCwd,
              sessionId: newSessionId,
              // Carry the per-run timeout onto the reset session too.
              requestTimeout: request.requestTimeoutMs,
              runTokenBudget: host.runTokenBudget,
              hostToolBridge,
              toolExecutionContext,
              ...(host.backend === 'claude' ? { tools: claudeNativeTools } : {}),
            });
          } catch (retryError) {
            const retryUsage = (retryError as { usage?: PromptResult['usage'] }).usage;
            if (retryUsage) {
              accumulateUsage(totalUsage, context.runUsage, retryUsage);
              budgetTokens += countBudgetTokens(retryUsage, host.backend);
            }
            console.error(
              `[turn] ${host.backend} reset retry failed:`,
              retryError instanceof Error ? retryError.message : String(retryError)
            );
            // resetSession() creates and locks a replacement pool entry.
            // A failed rebuild/retry must remove it entirely; otherwise the
            // next native turn sees isNew=false and can persist a
            // minimal resume prompt as the replacement thread's base policy.
            host.sessionPool.invalidateSession(channelKey, newSessionId);
            throwFinalCliError(retryError);
          }
          // Prepend reset notice so user knows context was lost
          if (isPromptTooLong && piResult?.response) {
            piResult.response = `\u26a0\ufe0f Session reset: The previous conversation was too long, starting a new session.\n\n${piResult.response}`;
          }
          console.log(`[turn] Retry successful with new session: ${newSessionId}`);
        } else {
          throwFinalCliError(error);
        }
      }

      if (!piResult) {
        return throwFinalCliError(new Error('Model runner returned no prompt result'));
      }

      // Emit one terminal metric per prompt turn, including recovered calls.
      host.onMetric?.('prompt_latency_ms', Date.now() - promptStart, {
        backend: host.backend,
        turn: String(turn),
      });
      // After first successful call, mark session as not new for subsequent turns
      if (turn === 1) {
        sessionIsNew = false;
      }

      const contentBlocks: ContentBlock[] = [];
      if (piResult.response?.trim()) contentBlocks.push({ type: 'text', text: piResult.response });

      // eslint-disable-next-line prefer-const
      response = {
        id: `msg_${Date.now()}`,
        type: 'message' as const,
        role: 'assistant' as const,
        content: contentBlocks,
        model: host.model,
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: {
          ...piResult.usage,
          input_tokens: piResult.usage.input_tokens ?? 0,
          output_tokens: piResult.usage.output_tokens ?? 0,
        },
      };

      // Update usage
      accumulateUsage(totalUsage, context.runUsage, piResult.usage);
      budgetTokens += countBudgetTokens(response.usage, host.backend);

      // Record token usage
      if (host.onTokenUsage) {
        try {
          host.onTokenUsage({
            channel_key: channelKey,
            agent_id: request.agentContext?.roleName || host.model, // Use roleName if available, else model
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_read_tokens: response.usage.cache_read_input_tokens || 0, // No longer needs 'as any' cast
            cost_usd: piResult.cost_usd || 0,
          });
        } catch {
          // Ignore recording errors - never break the agent loop
        }
      }

      // Preserve the SessionPool usage-status contract. Billing telemetry is
      // recorded above; durable runtimes own model-aware compaction.
      host.sessionPool.updateTokens(channelKey, response.usage.input_tokens, host.backend);

      // Claude's MCP server may already have executed these tool calls while the
      // prompt was streaming. Preserve the observed exchange in conversation
      // order, but never execute the observed tool_use again.
      // Replaying a completed mutation would turn a transport observation into a
      // second host-side effect.
      if (Array.isArray(piResult.completedToolExchanges)) {
        appendCompletedToolExchanges(piResult.completedToolExchanges);
      }

      // The local MCP server can complete a mutation and still report an
      // indeterminate terminal outcome. Preserve the paired exchange above
      // for auditability, then fail this turn without sending it through the
      // ordinary host-tool loop or retrying the prompt.
      if (piResult.terminalError) {
        throwFinalCliError(
          new HostToolTerminalError(piResult.terminalError.code, piResult.terminalError.message)
        );
      }

      if (piResult.toolUseBlocks?.length) {
        throwFinalCliError(
          new ClaudeToolStreamProtocolError(
            'Unresolved native tool calls cannot be executed by a host model loop'
          )
        );
      }

      // Add assistant response to history
      history.push({
        role: 'assistant',
        content: response.content,
      });

      // Notify turn callback
      runScope.onTurn?.({
        turn,
        role: 'assistant',
        content: response.content,
        stopReason: response.stop_reason,
        usage: response.usage,
      });

      stopReason = response.stop_reason;

      // Per-run budget: checked after this turn's usage and before the next dispatch, so
      // the budget is never exceeded by more than one turn. The partial response so far is
      // returned, and the host records the receipt.
      if (host.runTokenBudget > 0 && budgetTokens >= host.runTokenBudget) {
        stoppedBy = 'budget';
        console.warn(
          `[turn] run budget stop: ${budgetTokens} >= ${host.runTokenBudget} tokens after turn ${turn} (${channelKey})`
        );
        try {
          host.onBudgetStop?.({
            channelKey,
            modelRunId: ownedModelRunId ?? request.modelRunId ?? null,
            agentId: request.agentContext?.roleName,
            budgetTokens,
            runTokenBudget: host.runTokenBudget,
            turns: turn,
          });
        } catch {
          // Receipt failures must never mask the stop itself.
        }
        return;
      }
    }
  } finally {
    Object.assign(carry, {
      turn,
      stopReason,
      stoppedBy,
      budgetTokens,
      resolvedCliSessionId,
      sessionIsNew,
    });
  }
}

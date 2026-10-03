/**
 * One run, from the moment a caller hands over content to the moment the answer,
 * the receipts and the session lock are settled.
 *
 * This was a product's agent loop: the entry a consumer called to talk to a model.
 * Everything it does here is the same whichever consumer asks and whatever the words
 * mean - wait for the session's lane, decide NEW vs CONTINUE, open a model run, hold a
 * native-effect boundary open, run the turns, run the tools the model asked for under
 * the loop guards, give a native child its own authority, commit or fail the run,
 * release the session. None of it needs to know the transport.
 *
 * What it cannot know, the caller states: the layers this turn opens with, which
 * channel key it serializes on, what a tool call actually does, and what the consumer
 * wants kept once the answer stands. A port is asked; it is never inferred.
 */
import type {
  BackendType,
  ContentBlock,
  HostExecutionContext,
  HostToolBridge,
  HostToolCall,
  HostToolDefinition,
  HostToolTerminalCode,
  IModelRunner,
  Message,
  NativeInputReceipt,
  StopReason,
  StreamCallbacks,
  ToolUseBlock,
  TurnInfo,
  Usage,
} from './drivers/types.js';
import {
  AgentError,
  NativeSteeringTargetUnavailableError,
  isHostToolTerminalCode,
} from './drivers/types.js';
import { NativeEffectReplayBoundary, type NativeEffectObserver } from './native-effect-observer.js';
import type { PostToolHandler } from './post-tool-handler.js';
import { composeLayers, type PromptLayer } from './prompt-layers.js';
import type { SubagentBridge, SubagentBridgeRequest } from './subagent-bridge.js';
import type { SessionPool } from './session-pool.js';
import type { NativeToolCaller } from '../action-contracts.js';
import { extractTextResponse } from './turn-text.js';
import {
  runNativePrompt,
  type BudgetStopInfo,
  type InternalToolResultBlock,
  type RunScope,
  type NativePromptCarry,
  type NativePromptRequest,
} from './native-prompt.js';
import { DebugLogger } from '../debug-logger.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const logger = new DebugLogger('NativeTurn');

/** Normal coding tasks often need 10+ consecutive Bash calls; 5 was too low. */
const MAX_CONSECUTIVE_SAME_HOST_TOOL = 15;
const COMPLETION_SUMMARY_MAX_CHARS = 2_000;

function completionSummary(response: string): string {
  return response.slice(0, COMPLETION_SUMMARY_MAX_CHARS);
}

function historyToolResult(result: InternalToolResultBlock): InternalToolResultBlock {
  const { abort: _abort, terminalCode: _terminalCode, ...block } = result;
  return block as InternalToolResultBlock;
}

/** Background work a tool started that the run must outlive its own turns to drain. */
export interface BackgroundTaskRegistry {
  register(task: Promise<unknown>): void;
}

/**
 * What the entry reads from the caller's wider options object. The caller's own type
 * is much wider and names things the core has no business knowing; this is the part
 * that crosses.
 */
export interface NativeTurnRequest extends NativePromptRequest {
  /** Assembled only after the native driver has selected a new or retained session. */
  prepareSessionContent?: (
    session: import('./drivers/types.js').NativeSessionState
  ) => Promise<ContentBlock[]>;
  sessionKey?: string;
  channelId?: string;
  lanePriority?: number;
  /** Best-effort notification that an earlier turn already occupies this session lane. */
  onQueued?: () => void;
  /** Trace identity as soon as the run exists, including turns that never return a result. */
  onModelRunStarted?: (modelRunId: string) => void;
  cliSessionId?: string | null;
  procedureRefs?: unknown;
  streamCallbacks?: StreamCallbacks;
  onTurn?: (turn: TurnInfo) => void;
  onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  /** Authority is asked for AFTER both queue waits, never before. */
  prepareAccess?: () => unknown | Promise<unknown>;
  /** Admission may replace the content it was handed. */
  prepareContent?: () =>
    | { content: ContentBlock[]; procedureRefs?: unknown }
    | Promise<{ content: ContentBlock[]; procedureRefs?: unknown }>;
  /** A run the caller already owns; this entry opens none of its own for it. */
  ownerJournalPrompt?: string;
  tier?: 1 | 2 | 3;
}

/** Why a run stopped on the host's side. */
export type NativeRunStoppedBy = 'budget';

/** Whether this run's model-run record can be cited afterwards. */
export type NativeRunProvenance = 'available' | 'backend_no_run' | 'commit_failed';

export interface NativeTurnResult {
  response: string;
  turns: number;
  history: Message[];
  totalUsage: Usage;
  stopReason: StopReason;
  modelRunId: string | null;
  modelRunProvenance: NativeRunProvenance;
  stoppedBy?: NativeRunStoppedBy;
  [extra: string]: unknown;
}

/**
 * Everything about THIS turn the core cannot decide, stated in one answer so the core
 * never assembles a policy out of fragments.
 *
 * The prompt crosses as LAYERS, not as a string. Joining them and keeping them inside
 * a budget is arithmetic and belongs here; what each layer says belongs to the caller.
 */
export interface NativeTurnPolicy {
  /** The session lane and pool key this run serializes on. */
  channelKey: string;
  /** What this call opens with. */
  systemLayers: readonly PromptLayer[];
  /**
   * The complete current policy, asked for only when a durable thread was replaced.
   * A resume stub would REPLACE the thread's full policy with a fragment, so the
   * caller rebuilds it here - and, because rebuilding can cost a search, only here.
   */
  reanchorLayers?: () => Promise<readonly PromptLayer[]>;
  /** Base instructions a durable runtime re-anchors a live thread with. */
  resumeLayers?: () => Promise<readonly PromptLayer[]>;
  /** The policy the spawned process carries; a changed one must respawn, not inherit. */
  sessionPolicyFingerprint?: string;
  /** An explicit per-session native read boundary; absent preserves driver defaults. */
  restrictedReadRoots?: readonly string[];
  /** Native working directory for this session, supplied by the host. */
  nativeCwd?: string;
  /** The native built-in surface this turn's grant projects onto the process. */
  nativeTools?: string;
  /**
   * This session carries a standing composed policy rather than a per-call one, so a
   * lost thread is re-anchored with the whole of it instead of with a resume stub.
   */
  standingPolicy?: boolean;
}

/**
 * Opening and closing the record of one run.
 *
 * WHEN a run is opened is not this port's decision - the entry opens one for every
 * turn it actually runs, unless the caller already owns one. The port used to carry a
 * `shouldBegin` predicate, and the product answered it with its tool-routing mode, so
 * a whole backend's turns went unrecorded while running real tools.
 *
 * A consumer that cannot record a run must fail here rather than return nothing: a
 * turn whose run cannot be written must not run quietly.
 */
export interface NativeModelRunPort {
  begin(request: NativeTurnRequest | undefined, cliSessionId: string | null): Promise<string>;
  commit(modelRunId: string, summary: string, tokenCount?: number): Promise<void>;
  fail(modelRunId: string, summary: string, tokenCount?: number): Promise<void>;
}

/** The queue that serializes one session's runs. The core asks; it does not own one. */
export interface SessionLanes {
  enqueueWithSession<T>(
    sessionKey: string,
    task: () => Promise<T>,
    globalLane?: string,
    options?: { priority?: number }
  ): Promise<T>;
  /** Whether this exact session already has active or queued native work. */
  hasSessionWork?(sessionKey: string): boolean;
  getTotalQueueSize(): number;
}

/** What a run's tool call may touch, plus the run-local fields this entry adds. */
type RunLocalContext<TToolContext extends HostExecutionContext> = TToolContext & {
  backgroundTasks?: BackgroundTaskRegistry;
  procedureStimulus?: string;
  procedureRefs?: unknown;
  gatewayCallId?: string;
  signal?: AbortSignal;
  subagentThreadId?: string;
};

/**
 * The consumer, as the entry sees it: a handful of stated values and the ports it
 * calls when only the consumer can answer.
 */
export interface NativeSessionHost<
  TToolContext extends HostExecutionContext = HostExecutionContext,
> {
  readonly agent: IModelRunner;
  readonly backend: BackendType;
  readonly model: string;
  readonly maxTurns: number;
  readonly isGatewayMode: boolean;
  readonly runTokenBudget: number;
  readonly sessionPool: SessionPool;
  readonly lanes?: SessionLanes;
  readonly useLanes?: boolean;
  readonly postToolHandler?: PostToolHandler | null;
  /** Where an uploaded image is written so the runtime can read it back by path. */
  readonly inboundMediaDir?: string;
  /** Run-wide observers used when a request states none of its own. */
  readonly onTurn?: (turn: TurnInfo) => void;
  readonly onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  readonly onBudgetStop?: (info: BudgetStopInfo) => void;
  readonly onTokenUsage?: (record: {
    channel_key: string;
    agent_id?: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cost_usd?: number;
  }) => void;
  readonly onMetric?: (name: string, value: number, labels?: Record<string, string>) => void;

  /** Which global lane, if any, this session's runs share. */
  globalLaneFor?(sessionKey: string): string | undefined;
  /** Everything about this turn the core cannot decide. Asked once, after the waits. */
  turnPolicy(request: NativeTurnRequest | undefined): NativeTurnPolicy;
  /** A request may be narrowed before anything reads it (a private surface, a role). */
  projectRequest?(request: NativeTurnRequest): NativeTurnRequest;
  /** What a tool call is allowed to touch. Rebuilt once the run id exists. */
  executionContext(request: NativeTurnRequest | undefined): TToolContext | null;
  /** Conservatively rebind tool provenance when another input joins this native turn. */
  onSteeredInput?(context: TToolContext | null): TToolContext | null;
  /** What the runtime may be called with, for this turn's grant. */
  hostToolDefinitions(request: NativeTurnRequest | undefined): readonly HostToolDefinition[];
  createNativeEffectObserver?(
    executionContext: TToolContext | null
  ): NativeEffectObserver | undefined;
  modelRun?: NativeModelRunPort;
  /** Run one tool the model asked for. The one thing the core cannot do itself. */
  callTool(name: string, input: unknown, executionContext: TToolContext | null): Promise<unknown>;
  /** Text a consumer wants in front of a specific tool's result, or nothing. */
  toolPrelude?(
    name: string,
    input: unknown,
    executionContext: TToolContext | null
  ): Promise<string>;
  /** What the consumer wants kept once the answer stands. Observation, never a gate. */
  onRunFinished?(finished: {
    request: NativeTurnRequest | undefined;
    result: NativeTurnResult;
    channelKey: string;
    modelRunId: string | null;
    prompt: string;
    response: string;
  }): void | Promise<void>;
}

async function drainBackgroundTasks(tasks: Promise<unknown>[]): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

function withExecutionSurface<TToolContext extends HostExecutionContext>(
  executionContext: TToolContext | null,
  executionSurface: string
): TToolContext | null {
  if (!executionContext) {
    return null;
  }
  if ((executionContext as { executionSurface?: string }).executionSurface === executionSurface) {
    return executionContext;
  }
  return { ...executionContext, executionSurface } as TToolContext;
}

/**
 * The last user message as the model will read it.
 *
 * An uploaded image reaches a file-backed runtime as evidence with a local path.
 * The agent chooses how to inspect it; the host does not prescribe a tool order.
 */
export function formatLastUserMessage(history: Message[], options: { mediaDir?: string }): string {
  const imageEvidence = (path: string): string =>
    `Uploaded image: ${JSON.stringify({ localPath: path, trust: 'external_data' })}`;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') {
      continue;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    const parts: string[] = [];
    for (const block of content) {
      const anyBlock = block as unknown as {
        type: string;
        text?: string;
        localPath?: string;
        name?: string;
        input?: unknown;
        content?: string;
        is_error?: boolean;
        source?: { data?: string; media_type?: string };
      };
      if (anyBlock.type === 'text') {
        parts.push(anyBlock.text ?? '');
      } else if (anyBlock.type === 'image' && anyBlock.localPath) {
        parts.push(imageEvidence(anyBlock.localPath));
      } else if (anyBlock.type === 'image' && anyBlock.source?.data) {
        // Base64-encoded image -- save to disk so a runtime that reads files can open it
        const mediaDir = options.mediaDir;
        if (!mediaDir) {
          parts.push('[Image attached but no media directory is configured]');
          continue;
        }
        const mimeToExt: Record<string, string> = {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/jpg': '.jpg',
          'image/gif': '.gif',
          'image/webp': '.webp',
        };
        const ext = mimeToExt[anyBlock.source.media_type?.toLowerCase() || ''] || '.jpg';
        const imagePath = join(mediaDir, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
        try {
          mkdirSync(mediaDir, { recursive: true });
          writeFileSync(imagePath, Buffer.from(anyBlock.source.data, 'base64'));
          parts.push(imageEvidence(imagePath));
        } catch {
          parts.push('[Image attached but could not be processed]');
        }
      } else if (anyBlock.type === 'tool_result') {
        const status = anyBlock.is_error ? 'ERROR' : 'SUCCESS';
        parts.push(`[Tool Result: ${status}]\n${anyBlock.content}`);
      } else if (anyBlock.type === 'tool_use') {
        parts.push(
          `[Tool Call: ${anyBlock.name}]\nInput: ${JSON.stringify(anyBlock.input, null, 2)}`
        );
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** What a native child started by a run needs to be given its own authority. */
interface SubagentRunContext {
  request: NativeTurnRequest | undefined;
  parentModelRunId: string | null;
  cliSessionId: string | null;
  tools: readonly HostToolDefinition[];
  tier: 1 | 2 | 3;
  activeChildren: number;
  runFinished: boolean;
  nativeSessionId?: string;
  callerTurnId: number;
  executionContext: () => HostExecutionContext | null;
  callerChildren: Map<string, Promise<ChildRun | null>>;
  callerCalls: Set<Promise<unknown>>;
}

type ChildRun = SubagentBridge & { executionContext: HostExecutionContext | null };

/**
 * The entry a consumer holds: one session's runs, serialized on its lane.
 */
export class NativeSessionRunner<TToolContext extends HostExecutionContext = HostExecutionContext> {
  stopped = false;
  private readonly activeSteerBindings = new Map<
    string,
    { receipt: NativeInputReceipt; markShared: () => void }
  >();

  /**
   * What a native child started by a run on this session needs. Keyed by session key,
   * overwritten by each run on that session, and dropped once the run finished and no
   * child of it is still registered.
   */
  private readonly subagentRunContexts = new Map<string, SubagentRunContext>();
  private nextCallerTurnId = 0;
  // Keep only child ownership numbers across turns, not old authority or run contexts.
  private readonly callerChildOwners = new Map<
    string,
    {
      nativeSessionId: string;
      turns: Map<string, number>;
      aliases: Map<string, string>;
    }
  >();

  constructor(private readonly host: NativeSessionHost<TToolContext>) {}

  /** Retire native context only. Durable input, results and knowledge remain owned by the host. */
  async resetSession(sessionKey: string): Promise<void> {
    const reset = async (): Promise<void> => {
      if (this.stopped) throw new Error('Native session is stopped');
      const entry = this.host.sessionPool.peekSession(sessionKey);
      if (entry.busy) throw new Error('Cannot reset a busy native session');
      if (!this.host.agent.resetSession)
        throw new Error('Native runner does not support session reset');
      await this.host.agent.resetSession(entry.sessionId, sessionKey);
      this.host.sessionPool.invalidateSession(sessionKey);
      this.callerChildOwners.delete(sessionKey);
      this.subagentRunContexts.delete(sessionKey);
    };
    if (this.host.useLanes && this.host.lanes) {
      await this.host.lanes.enqueueWithSession(
        sessionKey,
        reset,
        this.host.globalLaneFor?.(sessionKey),
        { priority: 0 }
      );
    } else {
      await reset();
    }
  }

  /** Use the current turn's authority. Steering cannot replace its policy or open a new turn. */
  async steer(
    content: string,
    target: NativeInputReceipt,
    sessionKey: string,
    beforeSend?: () => void
  ): Promise<NativeInputReceipt> {
    if (this.stopped) throw new Error('Native session is stopped');
    if (target.backend !== this.host.backend) throw new Error('Native steering backend mismatch');
    if (!this.host.agent.steer) throw new Error('This harness does not support native steering');
    const binding = this.activeSteerBindings.get(sessionKey);
    if (this.host.onSteeredInput) {
      if (
        !binding ||
        binding.receipt.backend !== 'codex' ||
        target.backend !== 'codex' ||
        binding.receipt.sessionId !== target.sessionId ||
        binding.receipt.turnId !== target.turnId
      ) {
        throw new NativeSteeringTargetUnavailableError();
      }
    }
    return this.host.agent.steer(content, target, {
      sessionKey,
      beforeSend: () => {
        beforeSend?.();
        binding?.markShared();
      },
    });
  }

  /** Run one turn from text. */
  async run(prompt: string, request?: NativeTurnRequest): Promise<NativeTurnResult> {
    return this.runTurn([{ type: 'text', text: prompt }], request);
  }

  /**
   * Run one turn from content blocks.
   *
   * Per-call session key wins over the instance default: overlapping runs on a shared
   * session must never depend on mutated state to pick their lane.
   */
  async runTurn(content: ContentBlock[], request?: NativeTurnRequest): Promise<NativeTurnResult> {
    const { host } = this;
    if (host.useLanes && host.lanes) {
      const sessionKey = request?.sessionKey ?? host.turnPolicy(request).channelKey;
      if (request?.onQueued && !host.lanes.hasSessionWork) {
        logger.warn('Native queue notice is unavailable on this lane provider');
      } else if (request?.onQueued && host.lanes.hasSessionWork?.(sessionKey)) {
        try {
          request.onQueued();
        } catch (error) {
          logger.warn(
            `Native queue notice failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return host.lanes.enqueueWithSession(
        sessionKey,
        () => this.runTurnInternal(content, request),
        host.globalLaneFor?.(sessionKey),
        { priority: request?.lanePriority ?? 0 }
      );
    }
    return this.runTurnInternal(content, request);
  }

  /**
   * Close the harness. The runner that opened the process is the one that closes it;
   * queued work is given a bounded moment to drain first.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.host.agent.stop();

      const lanes = this.host.lanes;
      if (lanes) {
        const waitUntil = Date.now() + 5000;
        while (lanes.getTotalQueueSize() > 0 && Date.now() < waitUntil) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // NOTE: sessionPool is a shared singleton -- do NOT dispose here. The runtime's
      // own shutdown owns it.
    } catch (error) {
      console.error('Error during native session cleanup:', error);
    }
  }

  /**
   * Run the tools one model turn asked for.
   *
   * The guards, the abort, the metrics and the history shape are the same whatever a
   * tool does; what it does is `callTool`.
   */
  private async runToolCalls(
    content: ContentBlock[],
    stopAfterSuccessfulTools: string[] = [],
    executionContext: TToolContext | null = null,
    runScope: RunScope = { tier: 1 }
  ): Promise<InternalToolResultBlock[]> {
    const { host } = this;
    const modelToolContext = withExecutionSurface(executionContext, 'model_tool');
    const reactiveInternalContext = withExecutionSurface(executionContext, 'reactive_internal');
    const toolUseBlocks = content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );

    const results: InternalToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      let isError = false;
      let abort = false;
      let terminalCode: HostToolTerminalCode | undefined;
      runScope.streamCallbacks?.onToolUse?.(toolUse.name, toolUse.input as Record<string, unknown>);

      const toolStart = Date.now();
      try {
        const prelude =
          (await host.toolPrelude?.(toolUse.name, toolUse.input, reactiveInternalContext)) ?? '';

        const toolResult = await host.callTool(toolUse.name, toolUse.input, modelToolContext);
        const toolResultRecord = toolResult as Record<string, unknown>;
        result = JSON.stringify(toolResult, null, 2);

        const hasSuccess =
          toolResult !== null && typeof toolResult === 'object' && 'success' in toolResultRecord;
        if (hasSuccess && toolResultRecord.success === false) {
          isError = true;
        }
        abort = toolResultRecord?.abort === true;
        terminalCode =
          abort &&
          toolResultRecord.retryable === false &&
          isHostToolTerminalCode(toolResultRecord.code)
            ? (toolResultRecord.code as HostToolTerminalCode)
            : undefined;

        if (prelude) {
          result = `${prelude}\n\n---\n\n${result}`;
        }

        runScope.onToolUse?.(toolUse.name, toolUse.input, toolResult);

        host.postToolHandler?.processInBackground(
          toolUse.name,
          toolUse.input,
          toolResult,
          reactiveInternalContext as Parameters<PostToolHandler['processInBackground']>[3]
        );

        runScope.streamCallbacks?.onToolComplete?.(toolUse.name, toolUse.id, isError);
        host.onMetric?.('tool_duration_ms', Date.now() - toolStart, {
          tool: toolUse.name,
          error: String(isError),
        });
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);

        runScope.onToolUse?.(toolUse.name, toolUse.input, { error: result });
        host.onMetric?.('tool_duration_ms', Date.now() - toolStart, {
          tool: toolUse.name,
          error: 'true',
        });
        runScope.streamCallbacks?.onToolComplete?.(toolUse.name, toolUse.id, true);
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
        ...(abort ? { abort: true } : {}),
        ...(terminalCode ? { terminalCode } : {}),
      });

      if (abort) {
        break;
      }

      if (!isError && stopAfterSuccessfulTools.includes(toolUse.name)) {
        break;
      }
    }

    return results;
  }

  /**
   * One dynamic-tool bridge. The same-signature loop guard is private to the bridge, so a parent and its children
   * never share a counter. `recordExchange` is the ONLY way a bridge writes to a
   * conversation: a child passes none and therefore cannot touch the parent's history.
   */
  private buildHostToolBridge(params: {
    tools: readonly HostToolDefinition[];
    runScope: RunScope;
    executionContext: () => TToolContext | null;
    stopAfterSuccessfulTools: readonly string[];
    maxConsecutiveSameTool: number;
    recordExchange?: {
      assistant: (toolUse: ToolUseBlock) => void;
      result: (toolResult: InternalToolResultBlock) => void;
    };
  }): HostToolBridge {
    let consecutiveToolCalls = 0;
    let lastToolSignature = '';
    return {
      tools: params.tools,
      execute: async (call: HostToolCall) => {
        const callSignal = call.signal ?? new AbortController().signal;
        callSignal.throwIfAborted();
        const toolSignature = canonicalizeJSON({ name: call.name, input: call.input });
        const nextConsecutiveCount =
          toolSignature === lastToolSignature ? consecutiveToolCalls + 1 : 1;
        if (nextConsecutiveCount >= params.maxConsecutiveSameTool) {
          return {
            content: `Infinite loop detected: Tool "${call.name}" called ${nextConsecutiveCount} times consecutively`,
            isError: true,
            abort: true,
          };
        }

        consecutiveToolCalls = nextConsecutiveCount;
        lastToolSignature = toolSignature;
        const toolUse: ToolUseBlock = {
          type: 'tool_use',
          id: call.callId,
          name: call.name,
          input: call.input,
        };
        params.recordExchange?.assistant(toolUse);
        const executionContext = params.executionContext();
        const callExecutionContext = executionContext
          ? ({
              ...executionContext,
              gatewayCallId: call.callId,
              signal: callSignal,
            } as RunLocalContext<TToolContext>)
          : null;
        const [toolResult] = await this.runToolCalls(
          [toolUse],
          [...params.stopAfterSuccessfulTools],
          callExecutionContext,
          params.runScope
        );
        if (!toolResult) {
          callSignal.throwIfAborted();
          return {
            content: `Native tool "${call.name}" returned no result`,
            isError: true,
            abort: true,
          };
        }
        if (!toolResult.terminalCode) {
          callSignal.throwIfAborted();
        }
        params.recordExchange?.result(toolResult);
        return {
          content: toolResult.content,
          isError: toolResult.is_error === true,
          abort: toolResult.abort === true,
          terminalCode: toolResult.terminalCode as HostToolTerminalCode | undefined,
          stop: toolResult.is_error !== true && params.stopAfterSuccessfulTools.includes(call.name),
        };
      },
    };
  }

  /**
   * Give one native child its OWN authority.
   *
   * A parent's bridge closes over authority issued for the PARENT, which the child
   * cannot renew - inheriting it meant a long delegated run losing every tool mid-flight
   * and still reporting "done". So the child gets: its own model run under the parent's,
   * its own authority from the host issuer, its own execution context, and its own
   * bridge counters. When no issuer is reachable it gets nothing and says so - the
   * process refuses its calls rather than quietly borrowing.
   */
  async createSubagentBridge(info: SubagentBridgeRequest): Promise<SubagentBridge | null> {
    return this.createChildRun(info);
  }

  /** Both native dynamic tools and an attributed socket call use this child run. */
  private async createChildRun(info: SubagentBridgeRequest): Promise<ChildRun | null> {
    const { host } = this;
    const context = this.subagentRunContexts.get(info.sessionKey);
    if (!context) {
      console.warn(
        `[NativeTurn] subagent authority unavailable: no run context for session ${info.sessionKey} ` +
          `(thread=${info.agentThreadId})`
      );
      return null;
    }
    if (context.runFinished) {
      // Only a child announced DURING the run inherits that run's issuer. A finished run
      // stays reachable while a sibling is live; it must not mint authority hours later.
      console.warn(
        `[NativeTurn] subagent authority refused: run for session ${info.sessionKey} already ended ` +
          `(thread=${info.agentThreadId})`
      );
      return null;
    }
    // Claimed synchronously: the parent's finally must not drop the context while this
    // factory is still awaiting authority or a model run.
    context.activeChildren += 1;
    const abandon = (reason: string): null => {
      console.warn(reason);
      this.releaseSubagentRunContext(info.sessionKey, context);
      return null;
    };
    // A child asks the host for the same authority the parent asked for.
    const issuer = context.request?.prepareAccess;
    if (!issuer) {
      return abandon(
        `[NativeTurn] subagent authority unavailable: no host authority for ${info.sessionKey} ` +
          `(thread=${info.agentThreadId})`
      );
    }
    let access: unknown;
    try {
      access = await issuer();
    } catch (error) {
      return abandon(
        `[NativeTurn] subagent authority issuance failed thread=${info.agentThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!access) {
      return abandon(
        `[NativeTurn] subagent authority unavailable: the host stated none ` +
          `(thread=${info.agentThreadId})`
      );
    }
    const childRequest: NativeTurnRequest = {
      ...(context.request ?? {}),
      access,
      prepareAccess: undefined,
      parentModelRunId: context.parentModelRunId,
      sourceMessageRef: `subagent:${info.agentThreadId}`,
      // A child's own run cannot claim its parent's accepted mailbox input.
      nativeInputId: undefined,
    } as NativeTurnRequest;
    let modelRunId: string;
    try {
      if (!host.modelRun) {
        return abandon(
          `[NativeTurn] subagent model run unavailable: no model-run port ` +
            `(thread=${info.agentThreadId})`
        );
      }
      modelRunId = await host.modelRun.begin(childRequest, context.cliSessionId);
    } catch (error) {
      return abandon(
        `[NativeTurn] subagent model run could not begin thread=${info.agentThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const childTasks: Promise<unknown>[] = [];
    const backgroundTasks: BackgroundTaskRegistry = {
      register(task: Promise<unknown>): void {
        const observedTask = Promise.resolve(task);
        observedTask.catch(() => {
          // Re-thrown later by the child's release drain.
        });
        childTasks.push(observedTask);
      },
    };
    let childContext: TToolContext | null;
    let bridge: HostToolBridge;
    // The child's model run is already OPEN. Anything that throws while assembling its
    // context or bridge must fail that run and release the parent's context, or the run
    // stays `running` forever and the context stays pinned by a child that never existed.
    try {
      const base = host.executionContext({
        ...childRequest,
        modelRunId,
      } as NativeTurnRequest);
      childContext = base
        ? ({
            ...base,
            backgroundTasks,
            subagentThreadId: info.agentThreadId,
          } as RunLocalContext<TToolContext>)
        : null;
      // The child's own run scope: no stream callbacks, no onTurn, no onToolUse. Its work
      // is not this run's turns, and the parent's model run is already committed by then.
      const runScope: RunScope = { tier: context.tier };
      bridge = this.buildHostToolBridge({
        tools: context.tools,
        runScope,
        executionContext: () => childContext,
        stopAfterSuccessfulTools: [],
        maxConsecutiveSameTool: MAX_CONSECUTIVE_SAME_HOST_TOOL,
      });
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      try {
        await host.modelRun.fail(
          modelRunId,
          `subagent authority could not be assembled: ${summary}`
        );
      } catch (failError) {
        logger.warn(
          `Failed to mark subagent model run ${modelRunId} failed: ${
            failError instanceof Error ? failError.message : String(failError)
          }`
        );
      }
      return abandon(
        `[NativeTurn] subagent authority could not be assembled thread=${info.agentThreadId}: ${summary}`
      );
    }
    let released = false;
    return {
      bridge,
      executionContext: childContext,
      release: async (outcome) => {
        if (released) {
          return;
        }
        released = true;
        try {
          await drainBackgroundTasks(childTasks);
        } catch (error) {
          logger.warn(
            `subagent background drain failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        try {
          if (outcome.status === 'completed') {
            await host.modelRun?.commit(
              modelRunId,
              `subagent ${info.agentPath || info.agentThreadId} completed`
            );
          } else {
            // `unknown` is not success: the run is marked failed with the reason so the
            // ledger never carries a completion nobody confirmed.
            await host.modelRun?.fail(modelRunId, outcome.error ?? `subagent ${outcome.status}`);
          }
        } catch (error) {
          logger.warn(
            `subagent model run ${modelRunId} could not be closed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        this.releaseSubagentRunContext(info.sessionKey, context);
      },
    };
  }

  /** Resolve a harness caller only against a currently dispatched turn. */
  async withToolCaller<T>(
    caller: NativeToolCaller,
    execute: (context: HostExecutionContext) => Promise<T>
  ): Promise<T> {
    if (
      !caller ||
      typeof caller.session_id !== 'string' ||
      !caller.session_id ||
      typeof caller.tool_use_id !== 'string' ||
      !caller.tool_use_id ||
      (caller.agent_id !== undefined &&
        (typeof caller.agent_id !== 'string' || !caller.agent_id)) ||
      (caller.agent_type !== undefined && typeof caller.agent_type !== 'string')
    ) {
      throw new Error('Invalid native tool caller');
    }
    const entry = [...this.subagentRunContexts.entries()].find(
      ([, context]) => !context.runFinished && context.nativeSessionId === caller.session_id
    );
    if (!entry) throw new Error('Native tool caller has no matching active turn');
    const [sessionKey, context] = entry;
    if (caller.agent_id !== undefined) {
      const owners = this.callerChildOwners.get(sessionKey);
      const owner = owners?.turns.get(caller.agent_id);
      if (owner !== undefined && owner !== context.callerTurnId) {
        throw new Error('Native child caller belongs to a different turn');
      }
      owners?.turns.set(caller.agent_id, context.callerTurnId);
    }
    const call = (async () => {
      let executionContext = context.executionContext();
      if (caller.agent_id !== undefined) {
        let child = context.callerChildren.get(caller.agent_id);
        if (!child) {
          child = this.createChildRun({
            sessionKey,
            parentThreadId: caller.session_id,
            agentThreadId: caller.agent_id,
            agentPath: caller.agent_type ?? caller.agent_id,
          });
          // Store the promise before awaiting: concurrent calls share exactly one child.
          context.callerChildren.set(caller.agent_id, child);
        }
        const run = await child;
        if (!run) throw new Error('Native child authority could not be created');
        executionContext = run.executionContext;
      }
      if (!executionContext) throw new Error('Native tool caller has no execution context');
      return execute({ ...executionContext, gatewayCallId: caller.tool_use_id });
    })();
    context.callerCalls.add(call);
    try {
      return await call;
    } finally {
      context.callerCalls.delete(call);
    }
  }

  private async settleCallerRuns(
    context: SubagentRunContext | undefined,
    outcome: Parameters<SubagentBridge['release']>[0]
  ): Promise<void> {
    // Dynamic-tool children are settled by their native driver's own terminal events.
    if (!context || this.host.backend !== 'claude') return;
    context.runFinished = true;
    await Promise.allSettled(context.callerCalls);
    await Promise.all(
      [...context.callerChildren.values()].map(async (pending) => {
        const child = await pending;
        await child?.release(outcome);
      })
    );
  }

  /** Drop a run's subagent context once the run finished and no child still holds it. */
  private releaseSubagentRunContext(sessionKey: string, context: SubagentRunContext): void {
    context.activeChildren = Math.max(0, context.activeChildren - 1);
    if (
      context.runFinished &&
      context.activeChildren === 0 &&
      this.subagentRunContexts.get(sessionKey) === context
    ) {
      this.subagentRunContexts.delete(sessionKey);
    }
  }

  /** The run itself, with no queue around it. */
  private async runTurnInternal(
    content: ContentBlock[],
    request: NativeTurnRequest | undefined
  ): Promise<NativeTurnResult> {
    const { host } = this;
    if (this.stopped) {
      throw new AgentError('Agent loop is stopping', 'AGENT_STOPPED', undefined, false);
    }

    // Queue wait consumes no execution authority: only a host-supplied statement
    // can name this run's grant, and it is asked for after both lane waits. The
    // statement is kept reachable (rather than cleared) because a native child
    // spawned later asks the same host the same question.
    if (request?.prepareAccess) {
      request = { ...request, access: await request.prepareAccess() } as NativeTurnRequest;
      if (this.stopped) {
        throw new AgentError('Agent loop is stopping', 'AGENT_STOPPED', undefined, false);
      }
    }

    if (request?.prepareContent) {
      const admitted = await request.prepareContent();
      content = admitted.content;
      request = {
        ...request,
        procedureRefs: admitted.procedureRefs,
        prepareContent: undefined,
      };
      if (this.stopped) {
        throw new AgentError('Agent loop is stopping', 'AGENT_STOPPED', undefined, false);
      }
    }

    if (host.projectRequest && request) {
      request = host.projectRequest(request);
    }

    const runScope: RunScope = {
      streamCallbacks: request?.streamCallbacks,
      tier: 1,
      onTurn: request?.onTurn ?? host.onTurn,
      onToolUse: request?.onToolUse ?? host.onToolUse,
    };
    const history: Message[] = [];
    const runPrompt =
      request?.ownerJournalPrompt ??
      content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    // Budget accounting is separate from totalUsage (a published field): it includes cache
    // creation and cache reads, which are the bulk of a re-sent context and the cost being
    // bounded - a budget that ignored them would not have stopped a 4.28M-token run.
    let budgetTokens = 0;
    let stoppedBy: NativeRunStoppedBy | undefined;
    let turn = 0;
    let stopReason: StopReason = 'end_turn';
    let ownedModelRunId: string | null = null;
    let ownedModelRunCommitted = false;
    let nativeEffects = new NativeEffectReplayBoundary();
    const pendingBackgroundTasks: Promise<unknown>[] = [];
    const backgroundTasks: BackgroundTaskRegistry = {
      register(task: Promise<unknown>): void {
        const observedTask = Promise.resolve(task);
        observedTask.catch(() => {
          // Re-thrown later by drainBackgroundTasks; attach now to prevent unhandled rejections.
        });
        pendingBackgroundTasks.push(observedTask);
      },
    };

    const withRunLocals = (context: TToolContext | null): TToolContext | null =>
      context
        ? ({
            ...context,
            backgroundTasks,
            procedureStimulus: runPrompt,
            procedureRefs: request?.procedureRefs,
          } as RunLocalContext<TToolContext>)
        : null;

    let toolExecutionContext = withRunLocals(host.executionContext(request));
    // Track this run's tier for prompt sizing.
    const rawTier = request?.tier ?? 1;
    runScope.tier = rawTier === 1 || rawTier === 2 || rawTier === 3 ? rawTier : 1;

    // Infinite loop prevention
    const MAX_CONSECUTIVE_SAME_TOOL = MAX_CONSECUTIVE_SAME_HOST_TOOL;
    const policy = host.turnPolicy(request);
    if (policy.restrictedReadRoots && host.backend !== 'codex') {
      throw new Error('Native restricted read roots require the Codex backend');
    }
    if (policy.nativeCwd && host.backend !== 'codex') {
      throw new Error('Native working directory override requires the Codex backend');
    }
    const channelKey = policy.channelKey;
    let activeSteerBinding: { receipt: NativeInputReceipt; markShared: () => void } | undefined;
    if (host.onSteeredInput) {
      const observer = runScope.streamCallbacks;
      runScope.streamCallbacks = {
        ...observer,
        onAccepted: (receipt) => {
          observer?.onAccepted?.(receipt);
          let shared = false;
          const binding = {
            receipt,
            markShared: () => {
              if (shared) return;
              toolExecutionContext = host.onSteeredInput!(toolExecutionContext);
              shared = true;
            },
          };
          activeSteerBinding = binding;
          this.activeSteerBindings.set(channelKey, binding);
        },
      };
    }
    const compose = (layers: readonly PromptLayer[]): string =>
      composeLayers(layers, (message) => logger.warn(message));

    // The context object THIS run created, compared by identity before the finally marks
    // it finished: a later run on the same session key replaces the map entry.
    let ownedSubagentRunContext: SubagentRunContext | undefined;
    const callerSpawnNames = new Map<string, string>();
    const bindCallerChild = (agentId: string): void => {
      const context = ownedSubagentRunContext;
      const owners = this.callerChildOwners.get(channelKey);
      if (!context || !owners || owners.nativeSessionId !== context.nativeSessionId) return;
      // A delayed launch event from an older turn cannot undo an explicit later resume.
      if ((owners.turns.get(agentId) ?? 0) <= context.callerTurnId) {
        owners.turns.set(agentId, context.callerTurnId);
      }
    };
    const callerObserver = runScope.streamCallbacks;
    runScope.streamCallbacks = {
      ...callerObserver,
      onInputDispatch: (input) => {
        if (ownedSubagentRunContext) ownedSubagentRunContext.nativeSessionId = input.sessionId;
        if (
          host.backend === 'claude' &&
          this.callerChildOwners.get(channelKey)?.nativeSessionId !== input.sessionId
        ) {
          this.callerChildOwners.set(channelKey, {
            nativeSessionId: input.sessionId,
            turns: new Map(),
            aliases: new Map(),
          });
        }
        callerObserver?.onInputDispatch?.(input);
      },
      onSubagentStart: (info) => {
        bindCallerChild(info.agentThreadId);
        const name = callerSpawnNames.get(info.itemId);
        const owners = this.callerChildOwners.get(channelKey);
        if (name && owners && owners.nativeSessionId === ownedSubagentRunContext?.nativeSessionId) {
          owners.aliases.set(name, info.agentThreadId);
        }
        callerObserver?.onSubagentStart?.(info);
      },
      onToolUse: (name, input) => {
        host.sessionPool.touchSession(channelKey);
        if (host.backend === 'claude') {
          if (
            name === 'Agent' &&
            typeof input.name === 'string' &&
            typeof input.nativeToolUseId === 'string'
          ) {
            callerSpawnNames.set(input.nativeToolUseId, input.name);
          }
          // Claude 2.1.x resumes through SendMessage, addressed by native ID or
          // a name resolved from the observed Agent launch, before child calls run.
          if (name === 'SendMessage' && typeof input.to === 'string') {
            const owners = this.callerChildOwners.get(channelKey);
            bindCallerChild(owners?.aliases.get(input.to) ?? input.to);
          }
        }
        callerObserver?.onToolUse?.(name, input);
      },
    };

    // Use session pool for conversation continuity
    // IMPORTANT: if the caller passes a session id, use it directly to avoid double-locking
    let sessionIsNew = request?.resumeSession === undefined ? true : !request.resumeSession;
    let ownedSession = false;

    // Claude PersistentCLI: process alive -> CONTINUE (stdin message), process dead -> NEW.
    // Codex: durable runtime session alive -> CONTINUE, missing -> NEW.
    const isCodex = host.backend === 'codex';
    const isDurableRuntime = isCodex;
    const tracksSessionPolicy = isDurableRuntime || host.backend === 'claude';
    // --tools is part of the spawned surface: a different grant on the same session
    // must respawn the process instead of inheriting a stale tool list.
    const effectiveSessionPolicyFingerprint =
      host.backend === 'claude' && policy.sessionPolicyFingerprint !== undefined
        ? `${policy.sessionPolicyFingerprint}::tools=${policy.nativeTools ?? 'default'}`
        : policy.sessionPolicyFingerprint;
    let resolvedCliSessionId: string | null = request?.cliSessionId ?? null;

    if (request?.cliSessionId) {
      // Session routing travels per prompt() call via resolvedCliSessionId - no
      // shared-adapter mutation (setSessionId re-pointed channelKey/currentProcess
      // across awaits, cross-wiring concurrent lanes).
    } else if (request?.freshSession) {
      // Stateless lanes: session context is a cache, not persistence - every run
      // self-gathers and recalls; carrying prior runs' gather dumps only grows the
      // context (measured 146s -> 521s over 3 days; owner decision 2026-07-16).
      const cliSessionId = host.sessionPool.resetSession(channelKey);
      sessionIsNew = true;
      ownedSession = true;
      resolvedCliSessionId = cliSessionId;
    } else {
      // The native lane serializes this session before the pool is acquired.
      // A busy entry means another caller holds it outside this lane: reusing
      // and then releasing that entry would steal its session identity.
      const { sessionId: cliSessionId, isNew, busy } = host.sessionPool.getSession(channelKey);
      if (busy) {
        throw new AgentError(
          'Native session is busy outside its lane',
          'CLI_ERROR',
          undefined,
          true
        );
      }
      sessionIsNew = isNew;
      ownedSession = true;
      resolvedCliSessionId = cliSessionId;
    }

    // A run record is opened for EVERY turn this entry runs, with two exceptions that
    // are both stated rather than inferred: the caller already owns a run, or the
    // driver says it cannot stand behind one. Tool routing is not one of them.
    const callerOwnsModelRun = Boolean(request?.modelRunId);
    const runnerReportsRuns = host.agent.reportsModelRuns !== false;

    try {
      if (!callerOwnsModelRun && runnerReportsRuns && host.modelRun) {
        ownedModelRunId = await host.modelRun.begin(request, resolvedCliSessionId);
        request?.onModelRunStarted?.(ownedModelRunId);
        if (ownedModelRunId) {
          toolExecutionContext = withRunLocals(
            host.executionContext({
              ...(request ?? {}),
              modelRunId: ownedModelRunId,
            } as NativeTurnRequest)
          );
        }
      }
      if (callerOwnsModelRun) request?.onModelRunStarted?.(request.modelRunId!);

      let nativeObserver: NativeEffectObserver | undefined;
      try {
        nativeObserver = host.createNativeEffectObserver?.(toolExecutionContext);
      } catch {
        logger.warn('[NativeTurn] native observation setup failed');
      }
      nativeEffects = new NativeEffectReplayBoundary(nativeObserver);

      // This run's bridge is ITS OWN: the loop guards, the emergency budget, the history
      // writes and the turn observers all belong to this run. A native child gets a
      // separate bridge - sharing this closure let a child trip the parent's loop guard
      // and append its traces to the parent's committed model run.
      const hostToolDefinitions = host.hostToolDefinitions(request);
      const hostToolBridge: HostToolBridge | undefined =
        isDurableRuntime && host.isGatewayMode
          ? this.buildHostToolBridge({
              tools: hostToolDefinitions,
              runScope,
              executionContext: () => toolExecutionContext,
              stopAfterSuccessfulTools: request?.stopAfterSuccessfulTools ?? [],
              maxConsecutiveSameTool: MAX_CONSECUTIVE_SAME_TOOL,
              // A durable runtime does not return completed host exchanges, so record
              // them here: it reports the paired custom-tool exchange from its event
              // stream and this entry appends it exactly once.
              ...(isCodex
                ? {
                    recordExchange: {
                      assistant: (toolUse: ToolUseBlock): void => {
                        history.push({ role: 'assistant', content: [toolUse] });
                        runScope.onTurn?.({
                          turn,
                          role: 'assistant',
                          content: [toolUse],
                          stopReason: 'tool_use',
                        });
                      },
                      result: (toolResult: InternalToolResultBlock): void => {
                        const persistedToolResult = historyToolResult(toolResult);
                        history.push({ role: 'user', content: [persistedToolResult] });
                        runScope.onTurn?.({
                          turn,
                          role: 'user',
                          content: [persistedToolResult],
                        });
                      },
                    },
                  }
                : {}),
            })
          : undefined;
      if ((hostToolBridge && isCodex) || host.backend === 'claude') {
        // A child can be announced during this run and outlive it, so what its authority
        // needs is recorded now, per session key, and dropped when nothing needs it.
        // A previous run's context object stays referenced by ITS still-live children, so
        // this run starts its own count rather than inheriting one it can never settle.
        ownedSubagentRunContext = {
          request: request ? { ...request } : undefined,
          parentModelRunId: ownedModelRunId ?? request?.modelRunId ?? null,
          cliSessionId: resolvedCliSessionId,
          tools: hostToolDefinitions,
          tier: runScope.tier,
          activeChildren: 0,
          runFinished: false,
          callerTurnId: ++this.nextCallerTurnId,
          executionContext: () => toolExecutionContext,
          callerChildren: new Map(),
          callerCalls: new Set(),
        };
        this.subagentRunContexts.set(channelKey, ownedSubagentRunContext);
      }

      // Reset StopContinuation state for this channel to prevent leaking
      // retry counts from previous invocations

      // The input remains a user message; native compaction/continuation owns subsequent work.
      history.push({ role: 'user', content });
      const carry: NativePromptCarry = {
        turn,
        stopReason,
        stoppedBy,
        budgetTokens,
        resolvedCliSessionId,
        sessionIsNew,
      };
      await runNativePrompt<TToolContext>(
        carry,
        {
          channelKey,
          claudeNativeTools: policy.nativeTools,
          effectiveSessionPolicyFingerprint,
          restrictedReadRoots: policy.restrictedReadRoots,
          nativeCwd: policy.nativeCwd,
          history,
          prepareSessionContent: request?.prepareSessionContent,
          hostToolBridge,
          isCodex,
          isDurableRuntime,
          nativeEffects,
          ownedModelRunId,
          standingPolicy: policy.standingPolicy === true,
          systemPrompt: compose(policy.systemLayers),
          reanchor: policy.reanchorLayers
            ? async () => compose(await policy.reanchorLayers!())
            : undefined,
          resumeInstructions: policy.resumeLayers
            ? async () => compose(await policy.resumeLayers!())
            : undefined,
          runScope,
          toolExecutionContext,
          totalUsage,
          tracksSessionPolicy,
        },
        request ?? {},
        {
          agent: host.agent,
          backend: host.backend,
          model: host.model,
          runTokenBudget: host.runTokenBudget,
          sessionPool: host.sessionPool,
          onBudgetStop: host.onBudgetStop,
          onTokenUsage: host.onTokenUsage,
          onMetric: host.onMetric,
          formatLastMessageOnly: (messages) =>
            formatLastUserMessage(messages, { mediaDir: host.inboundMediaDir }),
        }
      );
      ({ turn, stopReason, stoppedBy, budgetTokens, resolvedCliSessionId, sessionIsNew } = carry);

      const finalResponse = extractTextResponse(history);

      const result: NativeTurnResult = {
        ...(stoppedBy ? { stoppedBy } : {}),
        response: finalResponse,
        turns: turn,
        history,
        totalUsage,
        stopReason,
        modelRunId: ownedModelRunId ?? request?.modelRunId ?? null,
        modelRunProvenance:
          (ownedModelRunId ?? request?.modelRunId) ? 'available' : 'backend_no_run',
      };
      await this.settleCallerRuns(
        ownedSubagentRunContext,
        stoppedBy
          ? { status: 'interrupted', error: `parent stopped: ${stoppedBy}` }
          : { status: 'completed' }
      );
      // Draining background work and committing the run are separate failures and get
      // separate catches. Sharing one meant a rejected background task skipped the commit
      // and was then reported as `commit_failed` - naming a failure that was never even
      // attempted, which is the exact habit this provenance state exists to break.
      try {
        await drainBackgroundTasks(pendingBackgroundTasks);
      } catch (backgroundError) {
        logger.warn(
          `background task drain failed: ${
            backgroundError instanceof Error ? backgroundError.message : String(backgroundError)
          }`
        );
      }
      try {
        if (ownedModelRunId && host.modelRun) {
          await host.modelRun.commit(
            ownedModelRunId,
            completionSummary(finalResponse),
            totalUsage.input_tokens + totalUsage.output_tokens
          );
          ownedModelRunCommitted = true;
        }
      } catch (commitError) {
        logger.warn(
          `model run commit failed: ${
            commitError instanceof Error ? commitError.message : String(commitError)
          }`
        );
      }
      if (ownedModelRunId && !ownedModelRunCommitted) {
        // The response still stands - the turn happened and the owner should get it.
        // What does NOT stand is the handle: the run record may be left uncommitted, so
        // returning its id would hand out provenance that cannot be resolved. Report the
        // answer, withhold the claim, and say which kind of absence this is - an
        // uncommitted record is a durability failure to repair, not the ordinary case of
        // a backend that reports no run at all.
        //
        // Deliberately NOT marked failed. The run did not fail; writing its completion
        // did. Relabelling a successful run as failed would tidy the state by recording
        // something untrue, and an existing test pins that decision. The orphan stays
        // visible, and the reason below is what a repair pass keys on.
        result.modelRunId = null;
        result.modelRunProvenance = 'commit_failed';
        logger.error(
          `Model run ${ownedModelRunId} may remain uncommitted; provenance reported as commit_failed`
        );
      }
      try {
        await host.onRunFinished?.({
          request,
          result,
          channelKey,
          modelRunId: ownedModelRunId,
          prompt: runPrompt,
          response: finalResponse,
        });
      } catch (observerError) {
        logger.error(
          `Run-finished observer failed: ${
            observerError instanceof Error ? observerError.message : String(observerError)
          }`
        );
      }
      if (stoppedBy) {
        // Budget interruption is returned structurally; keep admission uncertain.
        nativeEffects.failure(new Error('Native run stopped by token budget'));
      } else {
        nativeEffects.finished();
      }
      return result;
    } catch (error) {
      await this.settleCallerRuns(ownedSubagentRunContext, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      if (ownedModelRunId && !ownedModelRunCommitted && host.modelRun) {
        try {
          const summary = error instanceof Error ? error.message : String(error);
          await host.modelRun.fail(
            ownedModelRunId,
            summary,
            totalUsage.input_tokens + totalUsage.output_tokens
          );
        } catch (failError) {
          logger.warn(
            `Failed to mark model run ${ownedModelRunId} failed: ${
              failError instanceof Error ? failError.message : String(failError)
            }`
          );
        }
      }
      throw nativeEffects.failure(error);
    } finally {
      if (activeSteerBinding && this.activeSteerBindings.get(channelKey) === activeSteerBinding) {
        this.activeSteerBindings.delete(channelKey);
      }
      // A child that outlives this run still needs its authority recipe, so the context is
      // dropped only once the run finished AND no child of it is still registered.
      if (ownedSubagentRunContext) {
        ownedSubagentRunContext.runFinished = true;
        if (
          ownedSubagentRunContext.activeChildren === 0 &&
          this.subagentRunContexts.get(channelKey) === ownedSubagentRunContext
        ) {
          this.subagentRunContexts.delete(channelKey);
        }
      }
      // Always release the session lock, even on error, but only if we own it.
      if (ownedSession) {
        host.sessionPool.releaseSession(channelKey);
      }
    }
  }
}

export function createNativeSessionRunner<TToolContext extends HostExecutionContext>(
  host: NativeSessionHost<TToolContext>
): NativeSessionRunner<TToolContext> {
  return new NativeSessionRunner(host);
}

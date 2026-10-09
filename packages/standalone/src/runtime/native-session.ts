import type { JudgmentAccess } from '@jungjaehoon/mama-core';
import { memberSystemLayers } from './member-system-prompt.js';
import { backendEnvironment, credentialReadPaths, normalizeReadPaths } from './backend-security.js';
import { memberClaudeTmpDir } from './member-paths.js';
import { untrustedToolData } from '../utils/untrusted-content.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionCall,
  ActionResult,
  NativeToolCaller,
} from '@jungjaehoon/mama-core/action-contracts';
import type { ActionContext } from '@jungjaehoon/mama-core/api/catalog';

import {
  createNativeSessionRunner,
  type NativeModelRunPort,
  type NativeSessionRunner,
  type NativeTurnRequest,
  type NativeTurnResult,
  type NativeSessionHost,
} from '@jungjaehoon/mama-core/runtime/native-turn';
import { CodexRuntimeProcess } from '@jungjaehoon/mama-core/runtime/runtime-process';
import { PersistentCLIAdapter } from '@jungjaehoon/mama-core/runtime/drivers/persistent-cli-adapter';
import { getSessionPool, type SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import type { PromptLayer } from '@jungjaehoon/mama-core/runtime/prompt-layers';
import type {
  BackendType,
  ContentBlock,
  HostExecutionContext,
  HostToolDefinition,
  IModelRunner,
  NativeInputReceipt,
} from '@jungjaehoon/mama-core/runtime/drivers/types';
import type {
  SubagentBridge,
  SubagentBridgeRequest,
} from '@jungjaehoon/mama-core/runtime/runtime-process';
import {
  claudeOwnerAllowedTools,
  claudeOwnerDisallowedTools,
  claudeMemberDisallowedTools,
  projectClaudeNativeTools,
  type ClaudeToolRole,
} from '../agent/claude-native-tool-policy.js';
import { ensureMamaMcpConfig } from '../cli/runtime/action-mcp-config.js';
import {
  ensureClaudeCallerHook,
  type SandboxNetworkProxy,
} from '../cli/runtime/claude-caller-config.js';
import type { RuntimeBackend, RuntimeEffort, RuntimeSandbox } from './config.js';
import type { ActionSurface } from './action-surface.js';
import type { OwnerPolicyProvider, OwnerPolicySnapshot } from './owner-policy.js';

export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

export interface NativeDriverOptions {
  backend: RuntimeBackend;
  model: string;
  workspaceDir: string;
  cwd: string;
  runtimeRoot: string;
  sandbox: RuntimeSandbox;
  shellTool?: boolean;
  /** Enable live web search; disabled unless the consumer opts in. */
  webSearch?: boolean;
  permissionMode?: 'dontAsk';
  shellEnvironment?: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  deniedReadPaths: string[];
  allowLoginShell?: boolean;
  requestTimeout: number;
  requestMaxMs?: number;
  effort: RuntimeEffort;
  codexHome?: string;
  isolatedHome?: string;
  registryRoot?: string;
  pluginDir?: string;
  mcpConfigPath?: string;
  createSubagentBridge: (info: SubagentBridgeRequest) => Promise<SubagentBridge | null>;
}

export interface NativeSessionRequest extends NativeTurnRequest {
  /** Per-turn Claude builtin role; catalog actions remain on the MCP surface. */
  nativeRole?: ClaudeToolRole;
  sourceMessageRef?: string;
  sourceRefs?: readonly string[];
  access?: unknown;
  parentModelRunId?: string | null;
  /** Host-stated inclusive source-time ceiling for the current replay turn. */
  replaySourceEndMs?: number;
}

export interface NativeSessionOptions {
  backend: RuntimeBackend;
  model: string;
  workspaceDir: string;
  runtimeRoot: string;
  actionSurface: ActionSurface;
  principal?: {
    principalId: string;
    agentId: string;
    sessionKey: string;
    systemPrompt: string;
    prepareAccess: () => JudgmentAccess;
  };
  socketPath?: string;
  credentialPath?: string;
  journalPath?: string;
  deniedReadPaths?: readonly string[];
  ownerSystemPrompt?: string;
  ownerPolicyProvider?: OwnerPolicyProvider;
  effort?: RuntimeEffort;
  /** How long a turn may go without progress, in ms. */
  timeout: number;
  /** The longest one turn may run in all, in ms. */
  maxTurnMs?: number;
  maxTurns: number;
  runTokenBudget?: number;
  codexHome?: string;
  isolatedHome?: string;
  registryRoot?: string;
  replayKeyFile?: string;
  /** The host's logging proxy for the Claude shell sandbox's network (W35.4). */
  sandboxNetworkProxy?: SandboxNetworkProxy;
  pluginDir?: string;
  codexSandbox?: RuntimeSandbox;
  mcpConfigPath?: string;
  mcpServerPath?: string;
  agent?: IModelRunner;
  createAgent?: (options: NativeDriverOptions) => IModelRunner;
  sessionPool?: SessionPool;
  modelRun?: NativeModelRunPort;
  replaySourceEndMs?: () => number | undefined;
}

export interface NativeSession {
  readonly backend: RuntimeBackend;
  readonly sessionKey: string;
  readonly supportsNativeSubagents: boolean;
  hostToolDefinitions(): HostToolDefinition[];
  callAction(call: ActionCall, caller: NativeToolCaller): Promise<ActionResult>;
  resetSession(sessionKey: string): Promise<void>;
  runTurn(content: ContentBlock[], request?: NativeSessionRequest): Promise<NativeTurnResult>;
  steer(
    content: string,
    target: NativeInputReceipt,
    sessionKey: string
  ): Promise<NativeInputReceipt>;
  stop(): Promise<void>;
}

function actionToolDefinitions(
  surface: ActionSurface,
  access?: JudgmentAccess
): HostToolDefinition[] {
  return surface.hostToolDefinitions(access).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as HostToolDefinition['inputSchema'],
  }));
}

function toolContext(value: HostExecutionContext | null): {
  modelRunId?: string;
  gatewayCallId?: string;
  sourceMessageRef?: string;
  sourceRefs?: readonly string[];
  channelId?: string;
  replaySourceEndMs?: number;
} {
  if (!value) return {};
  const context = value as Record<string, unknown>;
  return {
    ...(typeof context.modelRunId === 'string' ? { modelRunId: context.modelRunId } : {}),
    ...(typeof context.gatewayCallId === 'string' ? { gatewayCallId: context.gatewayCallId } : {}),
    ...(typeof context.sourceMessageRef === 'string'
      ? { sourceMessageRef: context.sourceMessageRef }
      : {}),
    ...(Array.isArray(context.sourceRefs) ? { sourceRefs: context.sourceRefs as string[] } : {}),
    ...(typeof context.channelId === 'string' ? { channelId: context.channelId } : {}),
    ...(typeof context.replaySourceEndMs === 'number'
      ? { replaySourceEndMs: context.replaySourceEndMs }
      : {}),
  };
}

function modelToolResult(
  name: string,
  result: Awaited<ReturnType<ActionSurface['hostToolCall']>>
): unknown {
  if (result.status === 'completed') {
    return { success: true, data: untrustedToolData(name, result.data) };
  }
  return {
    success: false,
    status: result.status,
    error: untrustedToolData(name, result.error),
  };
}

function driverOptions(
  options: NativeSessionOptions,
  deniedReadPaths: string[],
  bridge: NativeDriverOptions['createSubagentBridge']
): NativeDriverOptions {
  const path = process.env.PATH;
  if (options.backend === 'codex' && !path?.trim()) {
    throw new Error('Owner Codex shell requires the host PATH');
  }
  return {
    backend: options.backend,
    processEnv: {
      ...backendEnvironment(),
      ...(options.principal === undefined ? {} : { TMPDIR: join(options.workspaceDir, '.tmp') }),
    },
    deniedReadPaths,
    model: options.model,
    workspaceDir: options.workspaceDir,
    cwd: options.workspaceDir,
    runtimeRoot: options.runtimeRoot,
    sandbox: 'workspace-write',
    // Owner decision 2026-09-26: shell for requested file work. This owner's Codex
    // home also serves native subagents and replay turns, which share this option.
    ...(options.backend === 'codex'
      ? {
          shellTool: true,
          webSearch: options.principal === undefined,
          // macOS login shells run path_helper and put the system Python before Homebrew.
          // Keep the daemon's toolchain PATH and the driver's isolated HOME; no user profiles.
          shellEnvironment: {
            PATH: path!,
            ...(options.principal === undefined
              ? {}
              : { TMPDIR: join(options.workspaceDir, '.tmp') }),
          },
          allowLoginShell: false,
        }
      : { permissionMode: 'dontAsk' as const }),
    requestTimeout: options.timeout,
    ...(options.maxTurnMs === undefined ? {} : { requestMaxMs: options.maxTurnMs }),
    effort: options.effort ?? 'medium',
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.isolatedHome === undefined ? {} : { isolatedHome: options.isolatedHome }),
    ...(options.registryRoot === undefined ? {} : { registryRoot: options.registryRoot }),
    ...(options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir }),
    ...(options.mcpConfigPath === undefined ? {} : { mcpConfigPath: options.mcpConfigPath }),
    createSubagentBridge: bridge,
  };
}

/** The Claude CLI's temp root: the workspace's for the owner, a short private one for a member. */
function claudeTmpDir(options: NativeSessionOptions): string {
  return options.principal === undefined
    ? join(options.workspaceDir, '.tmp')
    : memberClaudeTmpDir(options.principal.principalId);
}

function createDriver(
  options: NativeSessionOptions,
  nativeOptions: NativeDriverOptions,
  bridge: NativeDriverOptions['createSubagentBridge']
): IModelRunner {
  if (options.backend === 'codex') {
    return new CodexRuntimeProcess({
      hostRootDir: options.runtimeRoot,
      model: options.model,
      cwd: nativeOptions.cwd,
      sandbox: nativeOptions.sandbox,
      shellTool: nativeOptions.shellTool,
      webSearch: nativeOptions.webSearch,
      shellEnvironment: nativeOptions.shellEnvironment,
      processEnv: nativeOptions.processEnv,
      deniedReadPaths: nativeOptions.deniedReadPaths,
      allowLoginShell: nativeOptions.allowLoginShell,
      requestTimeout: nativeOptions.requestTimeout,
      ...(nativeOptions.requestMaxMs === undefined
        ? {}
        : { requestMaxMs: nativeOptions.requestMaxMs }),
      codexHome: options.codexHome,
      isolatedHome: options.isolatedHome,
      registryRoot: options.registryRoot,
      effort: nativeOptions.effort,
      createSubagentBridge: bridge,
    });
  }

  const mcpConfigPath = options.mcpConfigPath ?? `${options.runtimeRoot}/mama-mcp-config.json`;
  ensureMamaMcpConfig({
    mcpConfigPath,
    ...(options.mcpServerPath === undefined ? {} : { serverPath: options.mcpServerPath }),
    mamaHome: options.runtimeRoot,
    socketPath: options.socketPath,
    credentialPath: options.credentialPath,
    journalPath: options.journalPath,
    allowedActions: options.principal?.prepareAccess().actions,
  });
  return new PersistentCLIAdapter({
    workspaceDir: options.workspaceDir,
    model: options.model,
    mcpConfigPath,
    permissionMode: nativeOptions.permissionMode,
    allowedTools: claudeOwnerAllowedTools(options.workspaceDir).filter(
      (tool) => options.principal === undefined || !['WebFetch', 'WebSearch'].includes(tool)
    ),
    disallowedTools: (options.principal === undefined
      ? claudeOwnerDisallowedTools
      : claudeMemberDisallowedTools)(nativeOptions.deniedReadPaths, options.workspaceDir),
    processEnv: nativeOptions.processEnv,
    env: { CLAUDE_CODE_TMPDIR: claudeTmpDir(options) },
    pluginDir: nativeOptions.pluginDir,
    requestTimeout: nativeOptions.requestTimeout,
    ...(nativeOptions.requestMaxMs === undefined
      ? {}
      : { requestMaxMs: nativeOptions.requestMaxMs }),
    effort: nativeOptions.effort,
  });
}

/**
 * The owner session's system prompt: the standing instructions and the owner's policy file.
 * Both reach the agent whole, as Kagemusha's one prompt does; neither is an expendable layer.
 */
export function ownerSystemLayers(standing: string, ownerPolicy: string | null): PromptLayer[] {
  return [
    ...(standing ? [{ name: 'owner-standing', content: standing, priority: 1 }] : []),
    ...(ownerPolicy ? [{ name: 'owner-policy', content: ownerPolicy, priority: 1 }] : []),
  ];
}

/** Build one persistent owner session over the shared core native turn runner. */
export function createNativeSession(options: NativeSessionOptions): NativeSession {
  if (options.agent && options.createAgent) {
    throw new Error('Native session accepts an agent or a driver factory, not both');
  }
  if (
    options.backend === 'codex' &&
    options.codexSandbox !== undefined &&
    options.codexSandbox !== 'workspace-write'
  ) {
    throw new Error('The owner Codex session requires the workspace-write sandbox');
  }
  mkdirSync(options.workspaceDir, { recursive: true });
  if (options.principal !== undefined)
    mkdirSync(join(options.workspaceDir, '.tmp'), { recursive: true, mode: 0o700 });
  const readPaths = credentialReadPaths(
    options.runtimeRoot,
    options.codexHome,
    options.replayKeyFile
  ).concat(options.deniedReadPaths ?? []);
  const deniedReadPaths =
    options.principal === undefined ? readPaths : normalizeReadPaths(readPaths);
  if (options.backend === 'claude')
    ensureClaudeCallerHook(
      options.workspaceDir,
      deniedReadPaths,
      options.sandboxNetworkProxy,
      claudeTmpDir(options)
    );
  const sessionKey = options.principal?.sessionKey ?? OWNER_RUNTIME_SESSION_KEY;
  const prepareAccess =
    options.principal?.prepareAccess ?? (() => options.actionSurface.ownerAccess);
  const tools = actionToolDefinitions(options.actionSurface, options.principal?.prepareAccess());
  // Core prepares a member's access before it builds the tool list or runs a tool; without it a
  // member call must fail rather than reach the surface's owner default.
  const memberAccess = (access: unknown): JudgmentAccess => {
    if (!access) throw new Error(`No prepared access for ${options.principal!.principalId}`);
    return access as JudgmentAccess;
  };
  const runnerRef: { current?: NativeSessionRunner<HostExecutionContext> } = {};
  const bridge: NativeDriverOptions['createSubagentBridge'] = (info) =>
    runnerRef.current?.createSubagentBridge(info) ?? Promise.resolve(null);
  const configuredMcpOptions =
    options.backend === 'claude' &&
    (options.mcpConfigPath !== undefined || options.mcpServerPath !== undefined)
      ? {
          ...options,
          mcpConfigPath: options.mcpConfigPath ?? `${options.runtimeRoot}/mama-mcp-config.json`,
        }
      : options;
  if (
    configuredMcpOptions.backend === 'claude' &&
    configuredMcpOptions.mcpConfigPath !== undefined
  ) {
    ensureMamaMcpConfig({
      mcpConfigPath: configuredMcpOptions.mcpConfigPath,
      ...(configuredMcpOptions.mcpServerPath === undefined
        ? {}
        : { serverPath: configuredMcpOptions.mcpServerPath }),
      mamaHome: configuredMcpOptions.runtimeRoot,
      socketPath: configuredMcpOptions.socketPath,
      credentialPath: configuredMcpOptions.credentialPath,
      journalPath: configuredMcpOptions.journalPath,
      allowedActions: configuredMcpOptions.principal?.prepareAccess().actions,
    });
  }
  const nativeOptions = driverOptions(configuredMcpOptions, deniedReadPaths, bridge);
  const agent =
    configuredMcpOptions.agent ??
    configuredMcpOptions.createAgent?.(nativeOptions) ??
    createDriver(configuredMcpOptions, nativeOptions, bridge);
  const sessionPool = options.sessionPool ?? getSessionPool();
  const standingPrompt = options.principal?.systemPrompt ?? options.ownerSystemPrompt ?? '';
  const ownerPolicyProvider =
    options.principal === undefined ? options.ownerPolicyProvider : undefined;
  const emptyOwnerPolicy: OwnerPolicySnapshot = {
    content: null,
    fingerprint: '',
    loaded: false,
  };
  const defaultRole: ClaudeToolRole = { allowedTools: ['*'] };

  const host: NativeSessionHost<HostExecutionContext> = {
    agent,
    backend: options.backend as BackendType,
    model: options.model,
    maxTurns: options.maxTurns,
    isGatewayMode: options.backend === 'codex',
    runTokenBudget: options.runTokenBudget ?? 0,
    sessionPool,
    useLanes: false,
    turnPolicy: (request) => {
      const current = request as NativeSessionRequest | undefined;
      const systemPrompt = current?.systemPrompt ?? standingPrompt;
      const ownerPolicy = ownerPolicyProvider?.() ?? emptyOwnerPolicy;
      const requestedRole = current?.nativeRole ?? defaultRole;
      const role =
        options.principal === undefined
          ? requestedRole
          : {
              ...requestedRole,
              blockedTools: [...(requestedRole.blockedTools ?? []), 'WebFetch', 'WebSearch'],
            };
      const nativeTools = options.backend === 'claude' ? projectClaudeNativeTools(role) : undefined;
      const layers = (policy: string | null) =>
        options.principal === undefined
          ? ownerSystemLayers(systemPrompt, policy)
          : memberSystemLayers(systemPrompt);
      const systemLayers = layers(ownerPolicy.content);
      const buildSystemLayers = async () =>
        layers((ownerPolicyProvider?.() ?? emptyOwnerPolicy).content);
      return {
        channelKey: current?.sessionKey ?? sessionKey,
        systemLayers,
        reanchorLayers: buildSystemLayers,
        resumeLayers: buildSystemLayers,
        sessionPolicyFingerprint: JSON.stringify({
          backend: options.backend,
          model: options.model,
          nativeTools: nativeTools ?? null,
          systemPrompt,
          ownerPolicyFingerprint: ownerPolicy.fingerprint,
        }),
        ...(options.backend === 'codex' ? { nativeCwd: options.workspaceDir } : {}),
        ...(nativeTools === undefined ? {} : { nativeTools }),
        standingPolicy: true,
      };
    },
    executionContext: (request) => {
      const current = request as NativeSessionRequest | undefined;
      const replaySourceEndMs = current?.replaySourceEndMs ?? options.replaySourceEndMs?.();
      return {
        access: current?.access,
        ...(typeof current?.modelRunId === 'string' ? { modelRunId: current.modelRunId } : {}),
        ...(typeof current?.sourceMessageRef === 'string'
          ? { sourceMessageRef: current.sourceMessageRef }
          : {}),
        ...(current?.sourceRefs === undefined ? {} : { sourceRefs: current.sourceRefs }),
        channelId: current?.channelId ?? current?.sessionKey ?? sessionKey,
        agentId: options.principal?.agentId ?? options.actionSurface.ownerAccess.agentId,
        ...(replaySourceEndMs === undefined ? {} : { replaySourceEndMs }),
      };
    },
    createNativeEffectObserver: (context) => {
      const { modelRunId } = toolContext(context);
      return modelRunId ? options.actionSurface.createNativeEffectObserver(modelRunId) : undefined;
    },
    hostToolDefinitions: (request) =>
      options.principal === undefined
        ? tools
        : actionToolDefinitions(
            options.actionSurface,
            memberAccess((request as NativeSessionRequest | undefined)?.access)
          ),
    ...(options.modelRun === undefined ? {} : { modelRun: options.modelRun }),
    callTool: async (name, input, context) => {
      const facts = toolContext(context);
      if (!facts.gatewayCallId) {
        throw new Error('Native action call is missing its tool-call identity');
      }
      return modelToolResult(
        name,
        await options.actionSurface.hostToolCall(name, input, facts.gatewayCallId, {
          ...(options.principal === undefined ? {} : { access: memberAccess(context?.access) }),
          session: {
            ...(facts.modelRunId === undefined ? {} : { modelRunId: facts.modelRunId }),
            gatewayCallId: facts.gatewayCallId,
            ...(facts.sourceMessageRef === undefined
              ? {}
              : { sourceMessageRef: facts.sourceMessageRef }),
            ...(facts.sourceRefs === undefined ? {} : { sourceRefs: facts.sourceRefs }),
            ...(facts.channelId === undefined ? {} : { channelId: facts.channelId }),
            ...(facts.replaySourceEndMs === undefined
              ? {}
              : { replaySourceEndMs: facts.replaySourceEndMs }),
          },
        })
      );
    },
  };

  runnerRef.current = createNativeSessionRunner(host);
  return {
    backend: options.backend,
    sessionKey,
    supportsNativeSubagents: agent.supportsNativeSubagents === true,
    hostToolDefinitions: () =>
      options.principal === undefined
        ? [...tools]
        : actionToolDefinitions(options.actionSurface, options.principal.prepareAccess()),
    callAction: (call, caller) =>
      runnerRef.current!.withToolCaller(caller, async (context) => {
        const facts = toolContext(context);
        return options.actionSurface.dispatch(call, {
          access: options.principal?.prepareAccess() ?? (context.access as ActionContext['access']),
          session: facts,
        });
      }),
    resetSession: (sessionKey) => runnerRef.current!.resetSession(sessionKey),
    runTurn: (content, request) => {
      const nativeRequest = {
        ...(request ?? {}),
        sessionKey: request?.sessionKey ?? sessionKey,
        access: options.principal === undefined ? options.actionSurface.ownerAccess : undefined,
        prepareAccess: request?.prepareAccess ?? prepareAccess,
      } as NativeTurnRequest;
      return runnerRef.current!.runTurn(content, nativeRequest);
    },
    steer: (content, target, sessionKey) => runnerRef.current!.steer(content, target, sessionKey),
    stop: () => runnerRef.current!.stop(),
  };
}

export type { ContentBlock, NativeTurnResult };

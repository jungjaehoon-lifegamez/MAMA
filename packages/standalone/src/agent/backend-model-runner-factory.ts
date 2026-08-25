import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MAMAConfig } from '../cli/config/types.js';
import { expandPath } from '../cli/config/config-manager.js';
import { ClineCLIAdapter, type ClineCLIAdapterOptions } from './cline-cli-adapter.js';
import { projectClineNativeTools } from './cline-native-tool-policy.js';
import { PersistentCLIAdapter } from './persistent-cli-adapter.js';
import type { ClaudeCLIWrapperOptions } from './claude-cli-wrapper.js';
import type { IModelRunner } from './model-runner.js';
import {
  CODEX_AUXILIARY_TOOL_NAMES,
  type CodexAuxiliaryToolName,
} from './codex-auxiliary-tools.js';
import {
  CodexRuntimeProcess,
  type CodexRuntimeProcessOptions,
} from '../multi-agent/runtime-process.js';

export interface BackendModelRunnerOptions {
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  disableNativeTools?: boolean;
}

export interface BackendModelRunnerFactories {
  createClaude?: (options: ClaudeCLIWrapperOptions) => IModelRunner;
  createCodex?: (options: CodexRuntimeProcessOptions) => IModelRunner;
  createCline?: (options: ClineCLIAdapterOptions) => IModelRunner;
}

const CODEX_AUXILIARY_TOOLS = new Set<string>(CODEX_AUXILIARY_TOOL_NAMES);

export function resolveCodexAuxiliarySandbox(
  allowedTools: readonly string[] | undefined,
  disallowedTools: readonly string[] | undefined
): 'read-only' {
  if ((disallowedTools?.length ?? 0) > 0) {
    throw new Error('Codex auxiliary runners cannot enforce per-tool deny lists');
  }
  const tools = allowedTools ?? [];
  const unsupported = tools.filter((tool) => !CODEX_AUXILIARY_TOOLS.has(tool));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported Codex auxiliary tool policy: ${unsupported.join(', ')}`);
  }
  return 'read-only';
}

/**
 * Construct one isolated model runner from the configured primary backend.
 * Auxiliary runtime paths must use this factory instead of silently requiring Claude.
 */
export function createBackendModelRunner(
  config: MAMAConfig,
  options: BackendModelRunnerOptions = {},
  factories: BackendModelRunnerFactories = {}
): IModelRunner {
  const sessionId = options.sessionId ?? randomUUID();
  const model = options.model ?? config.agent.model;
  const systemPrompt = options.systemPrompt ?? '';
  const timeoutMs = options.timeoutMs ?? config.agent.timeout;
  const configuredCwd =
    config.agent.backend === 'codex' ? config.agent.codex_cwd : config.workspace?.path;
  const cwd = expandPath(options.cwd ?? configuredCwd ?? join(homedir(), '.mama/workspace'));

  if (config.agent.backend === 'codex') {
    const sandbox = resolveCodexAuxiliarySandbox(options.allowedTools, options.disallowedTools);
    const roots = [...new Set([join(homedir(), '.mama'), cwd])];
    const create =
      factories.createCodex ?? ((runnerOptions) => new CodexRuntimeProcess(runnerOptions));
    return create({
      defaultSessionKey: sessionId,
      model,
      systemPrompt,
      cwd,
      // Native shell/edit tools stay disabled in the managed Codex home. The read-only
      // thread sandbox is paired with an exact dynamic-tool bridge; Bash runs through
      // app-server command/exec with restricted roots and network disabled.
      sandbox,
      auxiliaryToolPolicy: {
        allowedTools: (options.allowedTools ?? []) as CodexAuxiliaryToolName[],
        roots,
      },
      requestTimeout: timeoutMs,
      codexHome: config.agent.codex_home ? expandPath(config.agent.codex_home) : undefined,
      // Shared managed config.toml: every writer must generate identical text or
      // they rewrite each other's reasoning effort on the next prompt.
      effort: config.agent.effort,
    });
  }

  if (config.agent.backend === 'cline') {
    const create = factories.createCline ?? ((runnerOptions) => new ClineCLIAdapter(runnerOptions));
    return create({
      command:
        process.env.MAMA_CLINE_COMMAND ?? config.agent.cline_command ?? process.env.CLINE_COMMAND,
      provider: config.agent.cline_provider ?? 'cline',
      model,
      systemPrompt,
      cwd,
      dataDir: config.agent.cline_data_dir,
      requestTimeout: timeoutMs,
      sessionId,
      allowedTools: projectClineNativeTools(options.allowedTools),
      disallowedTools: projectClineNativeTools(options.disallowedTools),
    });
  }

  const create =
    factories.createClaude ?? ((runnerOptions) => new PersistentCLIAdapter(runnerOptions));
  return create({
    sessionId,
    model,
    systemPrompt,
    requestTimeout: timeoutMs,
    dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? true,
    tools: options.disableNativeTools ? '' : undefined,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  });
}

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import {
  loadConfig as defaultLoadConfig,
  saveConfig as defaultSaveConfig,
  getDefaultMultiAgentConfig,
} from '../cli/config/config-manager.js';
import type { AgentPersonaConfig, MAMAConfig } from '../cli/config/types.js';
import {
  validateManagedAgentCreateInput,
  validateManagedAgentChanges,
} from './managed-agent-validation.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

type LooseConfig = MAMAConfig;
type ManagedAgentConfig = Omit<AgentPersonaConfig, 'id'>;

type LoadConfigFn = () => Promise<unknown>;
type SaveConfigFn = (config: unknown) => Promise<void>;
type ApplyFn = (config: Record<string, unknown>) => Promise<void>;
type RestartFn = (agentId: string) => Promise<void>;
type WritePersonaFileFn = (personaFile: string, content: string) => Promise<void> | void;

export interface ManagedAgentRuntimeSyncOptions {
  loadConfig?: LoadConfigFn;
  saveConfig?: SaveConfigFn;
  applyMultiAgentConfig?: ApplyFn | null;
  restartMultiAgentAgent?: RestartFn | null;
  writePersonaFile?: WritePersonaFileFn;
}

export interface CreateManagedAgentRuntimeInput {
  id: string;
  name: string;
  model: string;
  tier: number;
  backend?: string;
  system?: string;
}

export interface UpdateManagedAgentRuntimeInput {
  agentId: string;
  changes: Record<string, unknown>;
}

export interface ManagedAgentRuntimeSyncResult {
  snapshot: Record<string, unknown>;
  personaText: string | null;
  runtimeReloaded: boolean;
  config: LooseConfig;
}

let configMutationChain: Promise<void> = Promise.resolve();
const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    warn: (...args: unknown[]) => void;
  };
};
const logger = new DebugLogger('ManagedAgentRuntimeSync');

function expandHomePath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function defaultPersonaFile(agentId: string): string {
  return `~/.mama/personas/${agentId}.md`;
}

async function writePersonaFileDefault(personaFile: string, content: string): Promise<void> {
  const personaPath = expandHomePath(personaFile);
  await mkdir(dirname(personaPath), { recursive: true });
  await writeFile(personaPath, content, 'utf8');
}

function normalizeCreateBackend(
  backend: string | undefined,
  fallback: string | undefined
): ManagedAgentConfig['backend'] {
  const candidate = String(backend ?? fallback ?? 'claude').toLowerCase();
  if (candidate === 'codex') {
    return 'codex-mcp';
  }
  if (candidate === 'gemini') {
    return 'gemini';
  }
  if (candidate === 'codex-mcp') {
    return 'codex-mcp';
  }
  return 'claude';
}

async function applyRuntimeHooks(
  agentId: string,
  config: LooseConfig,
  options: ManagedAgentRuntimeSyncOptions
): Promise<boolean> {
  let runtimeReloaded = true;
  if (config.multi_agent && options.applyMultiAgentConfig) {
    try {
      await options.applyMultiAgentConfig(config.multi_agent as unknown as Record<string, unknown>);
    } catch (error) {
      logger.warn(
        `[${agentId}] applyMultiAgentConfig failed:`,
        error instanceof Error ? error.message : String(error)
      );
      runtimeReloaded = false;
    }
  }
  if (options.restartMultiAgentAgent) {
    try {
      await options.restartMultiAgentAgent(agentId);
    } catch (error) {
      logger.warn(
        `[${agentId}] restartMultiAgentAgent failed:`,
        error instanceof Error ? error.message : String(error)
      );
      runtimeReloaded = false;
    }
  }
  return runtimeReloaded;
}

async function runSerializedConfigMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = configMutationChain.then(task, task);
  configMutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function createManagedAgentRuntime(
  input: CreateManagedAgentRuntimeInput,
  options: ManagedAgentRuntimeSyncOptions = {}
): Promise<ManagedAgentRuntimeSyncResult> {
  const loadConfig = options.loadConfig ?? defaultLoadConfig;
  const saveConfig = options.saveConfig ?? defaultSaveConfig;
  const writePersonaFile = options.writePersonaFile ?? writePersonaFileDefault;
  const createError = validateManagedAgentCreateInput(input as unknown as Record<string, unknown>);
  if (createError) {
    throw new Error(createError);
  }

  return runSerializedConfigMutation(async () => {
    const config = (await loadConfig()) as LooseConfig;
    if (!config.multi_agent) {
      config.multi_agent = getDefaultMultiAgentConfig();
    }
    if (!config.multi_agent.agents) {
      config.multi_agent.agents = {};
    }
    if (config.multi_agent.agents[input.id]) {
      throw new Error(`Agent '${input.id}' already exists in config`);
    }

    const personaFile = defaultPersonaFile(input.id);
    const backend = normalizeCreateBackend(input.backend, config.agent?.backend);
    const snapshot: ManagedAgentConfig = {
      name: input.name,
      display_name: input.name,
      trigger_prefix: `!${input.id}`,
      persona_file: personaFile,
      tier: input.tier as 1 | 2 | 3,
      can_delegate: false,
      backend,
      model: input.model,
      enabled: true,
    };

    config.multi_agent.enabled = true;
    config.multi_agent.agents[input.id] = snapshot;

    const personaText = input.system?.trim() || `# ${input.name}\n\nYou are ${input.name}.`;
    await writePersonaFile(personaFile, personaText);
    await saveConfig(config);
    const runtimeReloaded = await applyRuntimeHooks(input.id, config, options);

    return {
      snapshot,
      personaText,
      runtimeReloaded,
      config,
    };
  });
}

export async function updateManagedAgentRuntime(
  input: UpdateManagedAgentRuntimeInput,
  options: ManagedAgentRuntimeSyncOptions = {}
): Promise<ManagedAgentRuntimeSyncResult> {
  const loadConfig = options.loadConfig ?? defaultLoadConfig;
  const saveConfig = options.saveConfig ?? defaultSaveConfig;
  const writePersonaFile = options.writePersonaFile ?? writePersonaFileDefault;
  const changeError = validateManagedAgentChanges(input.changes);
  if (changeError) {
    throw new Error(changeError);
  }

  return runSerializedConfigMutation(async () => {
    const config = (await loadConfig()) as LooseConfig;
    const agents = config.multi_agent?.agents;
    const currentAgent = (agents?.[input.agentId] ?? null) as ManagedAgentConfig | null;
    if (!currentAgent) {
      throw new Error(`Agent '${input.agentId}' not found in config`);
    }

    const updatedAgent: ManagedAgentConfig = { ...currentAgent };
    for (const key of [
      'name',
      'display_name',
      'tier',
      'backend',
      'model',
      'enabled',
      'trigger_prefix',
      'cooldown_ms',
      'can_delegate',
      'auto_continue',
      'effort',
      'tool_permissions',
      'persona_file',
    ]) {
      if (key in input.changes) {
        const value =
          key === 'backend'
            ? normalizeCreateBackend(input.changes[key] as string | undefined, updatedAgent.backend)
            : input.changes[key];
        (updatedAgent as Record<string, unknown>)[key] = value;
      }
    }

    if (!agents) {
      throw new Error(`Agent '${input.agentId}' not found in config`);
    }
    agents[input.agentId] = updatedAgent;

    const systemText =
      typeof input.changes.system === 'string' ? input.changes.system.trim() : null;
    if (systemText) {
      const personaFile =
        typeof updatedAgent.persona_file === 'string' && updatedAgent.persona_file.trim().length > 0
          ? updatedAgent.persona_file
          : defaultPersonaFile(input.agentId);
      updatedAgent.persona_file = personaFile;
      await writePersonaFile(personaFile, systemText);
    }

    await saveConfig(config);
    const runtimeReloaded = await applyRuntimeHooks(input.agentId, config, options);

    return {
      snapshot: updatedAgent,
      personaText: systemText,
      runtimeReloaded,
      config,
    };
  });
}

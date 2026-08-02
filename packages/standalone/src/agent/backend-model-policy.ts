import type { BackendType } from './model-runner.js';

const DEFAULT_MODEL_BY_BACKEND: Readonly<Record<BackendType, string>> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  cline: 'deepseek/deepseek-v4-flash',
};

export function defaultModelForBackend(backend: BackendType): string {
  return DEFAULT_MODEL_BY_BACKEND[backend];
}

export function resolveBackendScopedModel(input: {
  backend: BackendType;
  model?: string;
  inheritedBackend?: BackendType;
  inheritedModel?: string;
}): string {
  if (input.model?.trim()) return input.model.trim();
  if (input.backend === input.inheritedBackend && input.inheritedModel?.trim()) {
    return input.inheritedModel.trim();
  }
  return defaultModelForBackend(input.backend);
}

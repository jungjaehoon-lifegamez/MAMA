export type VNextRuntimeMode = 'legacy' | 'bootstrap';
export type VNextRuntimeFlagSource = 'default' | 'env' | 'config';

export interface VNextRuntimeFlags {
  enabled: boolean;
  mode: VNextRuntimeMode;
  source: VNextRuntimeFlagSource;
}

type EnvLike = Record<string, string | undefined>;

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    throw new Error(`Invalid MAMA_VNEXT_RUNTIME value: ${value}`);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'bootstrap', 'vnext'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'legacy', ''].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid MAMA_VNEXT_RUNTIME value: ${value}`);
}

function resolveConfigFlag(config: Record<string, unknown> | null | undefined): boolean | null {
  const runtime = config?.runtime;
  if (runtime && typeof runtime === 'object' && 'vnext' in runtime) {
    return parseBooleanFlag((runtime as { vnext?: unknown }).vnext);
  }
  const runtimeVNext = config?.runtime_vnext;
  if (runtimeVNext && typeof runtimeVNext === 'object' && 'enabled' in runtimeVNext) {
    return parseBooleanFlag((runtimeVNext as { enabled?: unknown }).enabled);
  }
  return null;
}

export function resolveVNextRuntimeFlags(
  config: Record<string, unknown> | null | undefined,
  env: EnvLike = process.env
): VNextRuntimeFlags {
  if (Object.prototype.hasOwnProperty.call(env, 'MAMA_VNEXT_RUNTIME')) {
    const enabled = parseBooleanFlag(env.MAMA_VNEXT_RUNTIME) ?? false;
    return {
      enabled,
      mode: enabled ? 'bootstrap' : 'legacy',
      source: 'env',
    };
  }

  const configEnabled = resolveConfigFlag(config);
  if (configEnabled !== null) {
    return {
      enabled: configEnabled,
      mode: configEnabled ? 'bootstrap' : 'legacy',
      source: 'config',
    };
  }

  return {
    enabled: false,
    mode: 'legacy',
    source: 'default',
  };
}

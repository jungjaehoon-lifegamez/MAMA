import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { MAMAConfig } from '../cli/config/types.js';
import { expandPath, getConfig, saveConfig } from '../cli/config/config-manager.js';

const ACTION_PATTERN_SOURCE = '<mama_setup_action>([\\s\\S]*?)</mama_setup_action>';
const LEGACY_ACTION_PATTERN =
  /\b(?:save_integration_token|update_config|validate_discord_token|mark_setup_complete)\s*\(|\[(?:validate token|save channel|mark_setup_complete)\]/i;
const MAX_ACTIONS_PER_RESPONSE = 8;
const MAX_ACTION_BYTES = 100_000;
const CONFIG_KEYS = new Set([
  'discord.token',
  'discord.enabled',
  'discord.default_channel_id',
  'slack.bot_token',
  'slack.app_token',
  'slack.enabled',
  'telegram.token',
  'telegram.allowed_chats',
  'telegram.enabled',
  'multi_agent.dangerouslySkipPermissions',
  'multi_agent.enabled',
]);
const GENERIC_UPDATE_CONFIG_KEYS = new Set(
  [...CONFIG_KEYS].filter(
    (key) =>
      !['discord.token', 'slack.bot_token', 'slack.app_token', 'telegram.token'].includes(key)
  )
);

export const SETUP_ACTION_PROTOCOL = `## MAMA Setup Host Actions

You do not have native setup/file tools. To perform a setup mutation, emit exactly one or more
JSON actions wrapped in <mama_setup_action> tags. The host validates and executes them, then sends
trusted results back in the same session. Never claim success before receiving a successful result.

Examples:
<mama_setup_action>{"type":"update_config","key":"discord.enabled","value":true}</mama_setup_action>
<mama_setup_action>{"type":"validate_discord_token","token":"..."}</mama_setup_action>
<mama_setup_action>{"type":"write_file","name":"USER.md","content":"# USER.md..."}</mama_setup_action>
<mama_setup_action>{"type":"mark_setup_complete"}</mama_setup_action>

Supported action schemas:
- update_config: {"type":"update_config","key":<allowed key>,"value":<value>}
- validate_discord_token: {"type":"validate_discord_token","token":"..."}
- write_file: {"type":"write_file","name":"IDENTITY.md|USER.md|SOUL.md|personas/<name>.md","content":"..."}
- save_integration_token:
  - Discord: {"type":"save_integration_token","platform":"discord","token":"..."}
  - Slack: {"type":"save_integration_token","platform":"slack","bot_token":"xoxb-...","app_token":"xapp-..."}
  - Telegram: {"type":"save_integration_token","platform":"telegram","token":"...","allowed_chats":["123"]}
  - Agent team: {"type":"save_integration_token","platform":"multi_agent","enabled":true}
- present_discovery_summary, present_security_warning, demonstrate_capability: {"type":"<name>", ...}
- complete_onboarding: {"type":"complete_onboarding","confirmed":true}
- mark_setup_complete: {"type":"mark_setup_complete"}

Allowed update_config keys: discord.enabled, discord.default_channel_id,
slack.enabled, telegram.allowed_chats,
telegram.enabled, multi_agent.dangerouslySkipPermissions,
multi_agent.enabled. Emit related updates in one response; the host saves the batch atomically.

write_file accepts IDENTITY.md, USER.md, SOUL.md, or personas/<name>.md. Every path is resolved by
the host under ~/.mama; never use the process working directory. Tokens inside action tags are
removed from browser-visible output.`;

export interface ParsedSetupActions {
  visibleText: string;
  actions: Array<Record<string, unknown>>;
}

export interface SetupActionResult {
  type: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface SetupActionExecutor {
  execute(action: Record<string, unknown>): Promise<SetupActionResult>;
  executeBatch(actions: Array<Record<string, unknown>>): Promise<SetupActionResult[]>;
}

export interface SetupActionExecutorOptions {
  loadConfig?: () => MAMAConfig;
  persistConfig?: (config: MAMAConfig) => Promise<void>;
  mamaHome?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function requiredString(action: Record<string, unknown>, key: string): string {
  const value = action[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function setConfigValue(config: MAMAConfig, key: string, value: unknown): void {
  if (!CONFIG_KEYS.has(key)) throw new Error(`Unsupported setup config key: ${key}`);
  const [section, field] = key.split('.');
  const root = config as unknown as Record<string, unknown>;
  const current = root[section];
  const target =
    typeof current === 'object' && current !== null
      ? (current as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  target[field] = value;
  root[section] = target;
}

function replaceConfigContents(target: MAMAConfig, source: MAMAConfig): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, structuredClone(source) as unknown as Record<string, unknown>);
}

function validateConfigValue(key: string, value: unknown): void {
  if (key.endsWith('.enabled') || key === 'multi_agent.dangerouslySkipPermissions') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    return;
  }
  if (key === 'telegram.allowed_chats') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`${key} must be a string array`);
    }
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
}

function resolveSetupFile(mamaHome: string, name: string): string {
  const normalized = name.replaceAll('\\', '/');
  const allowedRootFile = ['IDENTITY.md', 'USER.md', 'SOUL.md'].includes(normalized);
  const allowedPersona = /^personas\/[A-Za-z0-9_.-]+\.md$/.test(normalized);
  if (!allowedRootFile && !allowedPersona) throw new Error('Unsupported setup file name');
  const target = resolve(mamaHome, normalized);
  const rel = relative(mamaHome, target);
  if (rel.startsWith('..')) throw new Error('Setup file escaped ~/.mama');
  return target;
}

function writeSetupFile(mamaHome: string, name: string, content: string): string {
  if (Buffer.byteLength(content) > MAX_ACTION_BYTES)
    throw new Error('Setup file exceeds size limit');
  const target = resolveSetupFile(mamaHome, name);
  writeAtomicSetupFile(mamaHome, target, content);
  return target;
}

function writeAtomicSetupFile(mamaHome: string, target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const canonicalParent = realpathSync(dirname(target));
  if (relative(mamaHome, canonicalParent).startsWith('..')) {
    throw new Error('Setup file parent escaped ~/.mama');
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('Setup file target cannot be a symlink');
  }
  const temporary = join(canonicalParent, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function assertCompletedPersonaFile(mamaHome: string, file: string): void {
  const path = join(mamaHome, file);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`Cannot complete onboarding before ${file} is written safely`);
  }
  if (relative(mamaHome, realpathSync(path)).startsWith('..')) {
    throw new Error(`Cannot complete onboarding with ${file} outside ~/.mama`);
  }
}

export function parseSetupActions(text: string): ParsedSetupActions {
  const actionPattern = new RegExp(ACTION_PATTERN_SOURCE, 'g');
  const actions: Array<Record<string, unknown>> = [];
  let match: RegExpExecArray | null;
  while ((match = actionPattern.exec(text)) !== null) {
    if (actions.length >= MAX_ACTIONS_PER_RESPONSE) {
      throw new Error('Setup response exceeded its action limit');
    }
    if (Buffer.byteLength(match[1]) > MAX_ACTION_BYTES) {
      throw new Error('Setup action exceeded its size limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new Error('Setup action must contain valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Setup action must be a JSON object');
    }
    actions.push(parsed as Record<string, unknown>);
  }
  const visibleText = text.replace(new RegExp(ACTION_PATTERN_SOURCE, 'g'), '').trim();
  if (LEGACY_ACTION_PATTERN.test(visibleText)) {
    throw new Error('Setup response used unsupported legacy action syntax');
  }
  return {
    visibleText,
    actions,
  };
}

export function createSetupActionExecutor(
  options: SetupActionExecutorOptions = {}
): SetupActionExecutor {
  const loadConfig = options.loadConfig ?? getConfig;
  const persistConfig = options.persistConfig ?? saveConfig;
  const mamaHome = resolve(options.mamaHome ?? expandPath('~/.mama'));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  mkdirSync(mamaHome, { recursive: true });
  const canonicalMamaHome = realpathSync(mamaHome);

  const validateDiscordToken = async (
    token: string
  ): Promise<{ valid: boolean; clientId?: string }> => {
    const response = await fetchImpl('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { valid: false };
    const body = (await response.json()) as { id?: unknown };
    return { valid: true, clientId: typeof body.id === 'string' ? body.id : undefined };
  };

  const validateSlackTokens = async (botToken: string, appToken: string): Promise<boolean> => {
    const botResponse = await fetchImpl('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!botResponse.ok || ((await botResponse.json()) as { ok?: unknown }).ok !== true) {
      return false;
    }

    const appResponse = await fetchImpl('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${appToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return appResponse.ok && ((await appResponse.json()) as { ok?: unknown }).ok === true;
  };

  const validateTelegramToken = async (token: string): Promise<boolean> => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok && ((await response.json()) as { ok?: unknown }).ok === true;
  };

  const executeOne = async (
    action: Record<string, unknown>,
    workingConfig: MAMAConfig,
    markConfigDirty: () => void
  ): Promise<SetupActionResult> => {
    let type = 'unknown';
    try {
      type = requiredString(action, 'type');
      if (type === 'update_config') {
        const key = requiredString(action, 'key');
        if (!GENERIC_UPDATE_CONFIG_KEYS.has(key)) {
          throw new Error(`Unsupported setup config key: ${key}`);
        }
        validateConfigValue(key, action.value);
        setConfigValue(workingConfig, key, action.value);
        markConfigDirty();
        return { type, ok: true, data: { key } };
      }
      if (type === 'validate_discord_token') {
        const token = requiredString(action, 'token');
        const validation = await validateDiscordToken(token);
        return {
          type,
          ok: true,
          data: { valid: validation.valid, client_id: validation.clientId },
        };
      }
      if (type === 'write_file') {
        const name = requiredString(action, 'name');
        const content = requiredString(action, 'content');
        const path = writeSetupFile(canonicalMamaHome, name, content);
        return { type, ok: true, data: { file: basename(path) } };
      }
      if (type === 'save_integration_token') {
        const platform = requiredString(action, 'platform');
        if (platform === 'discord') {
          const token = requiredString(action, 'token');
          const validation = await validateDiscordToken(token);
          if (!validation.valid) throw new Error('Discord token validation failed');
          setConfigValue(workingConfig, 'discord.token', token);
          setConfigValue(workingConfig, 'discord.enabled', true);
        } else if (platform === 'slack') {
          const botToken = requiredString(action, 'bot_token');
          const appToken = requiredString(action, 'app_token');
          if (!(await validateSlackTokens(botToken, appToken))) {
            throw new Error('Slack token validation failed');
          }
          setConfigValue(workingConfig, 'slack.bot_token', botToken);
          setConfigValue(workingConfig, 'slack.app_token', appToken);
          setConfigValue(workingConfig, 'slack.enabled', true);
        } else if (platform === 'telegram') {
          const token = requiredString(action, 'token');
          if (!(await validateTelegramToken(token))) {
            throw new Error('Telegram token validation failed');
          }
          setConfigValue(workingConfig, 'telegram.token', token);
          const allowedChats = action.allowed_chats;
          if (
            allowedChats !== undefined &&
            (!Array.isArray(allowedChats) || allowedChats.some((item) => typeof item !== 'string'))
          ) {
            throw new Error('allowed_chats must be a string array');
          }
          if (allowedChats) setConfigValue(workingConfig, 'telegram.allowed_chats', allowedChats);
          setConfigValue(workingConfig, 'telegram.enabled', true);
        } else if (platform === 'multi_agent') {
          if (typeof action.enabled !== 'boolean') throw new Error('enabled must be boolean');
          setConfigValue(workingConfig, 'multi_agent.enabled', action.enabled);
        } else {
          throw new Error(`Unsupported integration platform: ${platform}`);
        }
        markConfigDirty();
        return { type, ok: true, data: { platform } };
      }
      if (
        type === 'present_discovery_summary' ||
        type === 'present_security_warning' ||
        type === 'demonstrate_capability'
      ) {
        return { type, ok: true };
      }
      if (type === 'complete_onboarding') {
        if (action.confirmed !== true) throw new Error('Onboarding must be confirmed');
        for (const file of ['IDENTITY.md', 'USER.md', 'SOUL.md']) {
          assertCompletedPersonaFile(canonicalMamaHome, file);
        }
      } else if (type !== 'mark_setup_complete') {
        throw new Error(`Unsupported setup action: ${type}`);
      }
      writeAtomicSetupFile(
        canonicalMamaHome,
        join(canonicalMamaHome, 'setup-complete.json'),
        `${JSON.stringify({ completed_at: now().toISOString() })}\n`
      );
      return { type, ok: true, data: { completed: true } };
    } catch (error) {
      return {
        type,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const executor: SetupActionExecutor = {
    async execute(action) {
      return (await executor.executeBatch([action]))[0];
    },
    async executeBatch(actions) {
      const sharedConfig = loadConfig();
      const workingConfig = structuredClone(sharedConfig);
      let configDirty = false;
      const results: SetupActionResult[] = [];
      for (const action of actions) {
        const result = await executeOne(action, workingConfig, () => {
          configDirty = true;
        });
        results.push(result);
        if (!result.ok) {
          return results.map((prior) =>
            configDirty &&
            prior.ok &&
            (prior.type === 'update_config' || prior.type === 'save_integration_token')
              ? {
                  ...prior,
                  ok: false,
                  data: { ...prior.data, rolled_back: true },
                  error: 'Config batch was rolled back because a later action failed',
                }
              : prior
          );
        }
      }
      if (configDirty) {
        try {
          await persistConfig(workingConfig);
          replaceConfigContents(sharedConfig, workingConfig);
        } catch (error) {
          return results.map((result) =>
            result.ok &&
            (result.type === 'update_config' || result.type === 'save_integration_token')
              ? {
                  ...result,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }
              : result
          );
        }
      }
      return results;
    },
  };
  return executor;
}

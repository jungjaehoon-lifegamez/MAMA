import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { parseConfig } from '../../runtime/config.js';
import { findExecutable, launchAgent, startScript } from '../launch-files.js';
import {
  CliInputError,
  createTerminalPrompt,
  nonblankLine,
  requireTTY,
  type PromptAdapter,
} from '../prompt.js';
import { shellQuote, updateSecrets, type SecretName } from '../secrets.js';

export interface InitOptions {
  home?: string;
  prompt?: PromptAdapter;
  cliPath?: string;
  nodePath?: string;
  findExecutable?: (name: string) => string | undefined;
}

const connectorNames = [
  'slack',
  'chatwork',
  'trello',
  'kagemusha',
  'calendar',
  'gmail',
  'drive',
  'sheets',
  'notion',
  'obsidian',
  'discord',
  'telegram',
  'imessage',
  'claude-code',
] as const;
const connectorSecrets: Record<string, SecretName[]> = {
  slack: ['MAMA_SLACK_TOKEN'],
  chatwork: ['MAMA_CHATWORK_TOKEN'],
  trello: ['MAMA_TRELLO_KEY', 'MAMA_TRELLO_TOKEN'],
  kagemusha: [],
  calendar: [],
  gmail: [],
  drive: [],
  sheets: [],
  notion: ['MAMA_NOTION_TOKEN'],
  obsidian: [],
  discord: ['MAMA_DISCORD_TOKEN'],
  telegram: ['MAMA_TELEGRAM_SOURCE_TOKEN'],
  imessage: [],
  'claude-code': [],
};

const gwsConnectorNames = new Set(['calendar', 'gmail', 'drive', 'sheets']);
const noSecretConnectorNames = new Set(['kagemusha', 'obsidian', 'imessage', 'claude-code']);

async function yes(prompt: PromptAdapter, label: string): Promise<boolean> {
  const value = (await prompt.text(`${label} [y/N]`)).trim().toLowerCase();
  if (['', 'n', 'no'].includes(value)) return false;
  if (['y', 'yes'].includes(value)) return true;
  throw new CliInputError('Answer yes or no.');
}

async function text(prompt: PromptAdapter, label: string): Promise<string> {
  return nonblankLine(await prompt.text(label)).trim();
}

async function optionalText(prompt: PromptAdapter, label: string): Promise<string | undefined> {
  const value = (await prompt.text(label)).trim();
  return value === '' ? undefined : nonblankLine(value).trim();
}

async function collectConnectors(
  prompt: PromptAdapter,
  secrets: Partial<Record<SecretName, string>>
): Promise<ConnectorsConfig> {
  const selected = (
    await prompt.text(
      `Connectors to enable (${connectorNames.join(', ')}; comma-separated, blank for none)`
    )
  ).trim();
  const names = selected === '' ? [] : [...new Set(selected.split(',').map((name) => name.trim()))];
  if (names.some((name) => !(connectorNames as readonly string[]).includes(name))) {
    throw new CliInputError(`Choose connectors from: ${connectorNames.join(', ')}`);
  }
  const config: ConnectorsConfig = {};
  for (const name of names) {
    for (const tokenName of connectorSecrets[name])
      secrets[tokenName] = nonblankLine(await prompt.secret(tokenName));
    if (name === 'slack')
      secrets.MAMA_SLACK_APP_TOKEN = nonblankLine(await prompt.secret('MAMA_SLACK_APP_TOKEN'));
    if (name === 'calendar')
      prompt.write(
        'Calendar currently reads the primary calendar only; its source channel id is calendar.'
      );

    if (name === 'gmail') {
      config.gmail = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { inbox: { role: 'hub' } },
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      };
      continue;
    }
    if (name === 'notion') {
      config.notion = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { workspace: { role: 'hub', name: 'Notion workspace' } },
        auth: { type: 'token', tokenName: 'MAMA_NOTION_TOKEN' },
      };
      continue;
    }
    if (name === 'obsidian') {
      const vaultPath = await text(prompt, 'Obsidian vault path');
      config.obsidian = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { vault: { role: 'hub', name: 'Vault', vaultPath } },
        auth: { type: 'none' },
      };
      continue;
    }
    if (name === 'claude-code') {
      const selectedProjects = (
        await text(prompt, 'Claude Code project directory names (comma-separated)')
      )
        .split(',')
        .map((project) => project.trim());
      if (selectedProjects.some((project) => !project || /[/\\\s]/.test(project))) {
        throw new CliInputError(
          'Enter Claude Code project directory names without paths or spaces.'
        );
      }
      const channels: ConnectorsConfig[string]['channels'] = {};
      for (const project of selectedProjects) {
        const alias = await text(prompt, `Display alias for ${project}`);
        channels[project] = { role: 'hub', name: alias };
      }
      config['claude-code'] = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels,
        auth: { type: 'none' },
      };
      continue;
    }
    if (name === 'drive') {
      const folderIds = (await text(prompt, 'Drive folder ids (comma-separated)'))
        .split(',')
        .map((id) => id.trim());
      if (folderIds.some((id) => !id || /\s/.test(id)))
        throw new CliInputError('Enter Drive folder ids separated by commas without spaces.');
      config.drive = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: Object.fromEntries(
          folderIds.map((folderId) => [folderId, { role: 'hub', folderId }])
        ),
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      };
      continue;
    }
    if (name === 'sheets') {
      const spreadsheetId = await text(prompt, 'Google Sheets spreadsheet id');
      const sheetRange = await text(prompt, 'Google Sheets header-and-data range');
      const dataRange = await optionalText(
        prompt,
        'Separate data range (blank to use the full range)'
      );
      config.sheets = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: {
          spreadsheet: {
            role: 'hub',
            spreadsheetId,
            sheetRange,
            ...(dataRange ? { dataRange } : {}),
          },
        },
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      };
      continue;
    }

    const ids = (
      await text(
        prompt,
        `${name} ${name === 'trello' ? 'board' : 'channel'} ids (comma-separated ids only)`
      )
    )
      .split(',')
      .map((id) => id.trim());
    if (ids.some((id) => !id || /\s/.test(id)))
      throw new CliInputError('Enter channel ids separated by commas, without display names.');
    if (name === 'calendar' && (ids.length !== 1 || ids[0] !== 'calendar')) {
      throw new CliInputError(
        'Calendar supports only the source channel id calendar (primary calendar).'
      );
    }
    config[name] = {
      enabled: true,
      pollIntervalMinutes: 5,
      channels: Object.fromEntries(
        ids.map((id) => [id, { role: 'hub', ...(name === 'trello' ? { boardId: id } : {}) }])
      ),
      auth: gwsConnectorNames.has(name)
        ? { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' }
        : noSecretConnectorNames.has(name)
          ? { type: 'none' }
          : { type: 'token', tokenName: connectorSecrets[name].at(-1)! },
    };
  }
  return config;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const prompt = options.prompt ?? createTerminalPrompt();
  requireTTY(prompt);
  const home = options.home ?? homedir();
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  if (existsSync(configPath))
    throw new CliInputError('config.yaml already exists; init will not overwrite it.');
  // A partial manual setup must also be reviewed by the owner before replacing files.
  for (const name of ['connectors.json', 'start.sh']) {
    if (existsSync(join(root, name)))
      throw new CliInputError(`${name} already exists; init will not overwrite it.`);
  }
  const backend = await text(prompt, 'Backend (claude|codex)');
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('Backend must be claude or codex.');
  const model = await text(prompt, 'Model');
  const machineTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneAnswer = (await prompt.text(`Owner timezone [${machineTimeZone}]`)).trim();
  const timezone = timezoneAnswer || machineTimeZone;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new CliInputError(`Timezone "${timezone}" is not a valid IANA time zone.`);
  }
  const secrets: Partial<Record<SecretName, string>> = {
    MAMA_TELEGRAM_TOKEN: nonblankLine(await prompt.secret('Telegram bot token')),
  };
  const chatId = await text(prompt, 'Telegram owner chat id');
  const userId = await text(prompt, 'Telegram owner user id');
  if (!/^-?[1-9]\d*$/.test(chatId) || !/^[1-9]\d*$/.test(userId)) {
    throw new CliInputError('Enter numeric Telegram chat and user ids.');
  }
  const connectors = await collectConnectors(prompt, secrets);
  const discordEnabled = await yes(prompt, 'Enable Discord owner messages');
  let discordConfig: Record<string, unknown> = {
    enabled: false,
    allowed_channels: [],
    owner_user_ids: [],
  };
  if (discordEnabled) {
    secrets.MAMA_DISCORD_TOKEN ??= nonblankLine(await prompt.secret('Discord bot token'));
    const channel = await text(prompt, 'Discord owner channel id');
    const user = await text(prompt, 'Discord owner user id');
    discordConfig = {
      enabled: true,
      owner_channel_id: channel,
      allowed_channels: [channel],
      owner_user_ids: [user],
    };
  }
  const slackEnabled = await yes(prompt, 'Enable Slack owner messages');
  let slackConfig: Record<string, unknown> = {
    enabled: false,
    allowed_channels: [],
    owner_user_ids: [],
  };
  if (slackEnabled) {
    secrets.MAMA_SLACK_TOKEN ??= nonblankLine(await prompt.secret('Slack bot token'));
    secrets.MAMA_SLACK_APP_TOKEN ??= nonblankLine(
      await prompt.secret('Slack Socket Mode app token')
    );
    const channel = await text(prompt, 'Slack owner channel id');
    const user = await text(prompt, 'Slack owner user id');
    slackConfig = {
      enabled: true,
      owner_channel_id: channel,
      allowed_channels: [channel],
      owner_user_ids: [user],
    };
  }
  const viewer: Record<string, string> = {};
  // Jev (TypeSafe) is the owner's choice: the agent's judge tool, off unless chosen here.
  const jevKeyPath = join(root, 'jev-key');
  const jevEnabled = await yes(
    prompt,
    'Use Jev (TypeSafe) so the agent can judge many messages or items without reading them all? Owner text in those calls goes to the Jev service'
  );
  let jevKey: string | undefined;
  if (jevEnabled && !existsSync(jevKeyPath)) {
    prompt.write('Get a Jev API key from TypeSafe: https://docs.typesafe.ai');
    jevKey = nonblankLine(await prompt.secret('Jev API key'));
  }
  if (await yes(prompt, 'Expose the viewer through a tunnel')) {
    const issuer = await text(prompt, 'Access issuer (HTTPS URL)');
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    viewer.MAMA_CF_ACCESS_ISSUER = url.origin;
    viewer.MAMA_CF_ACCESS_AUD = await text(prompt, 'Access audience');
    const hostname = await text(prompt, 'Viewer hostname (no scheme or path)');
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(hostname))
      throw new CliInputError('Enter a hostname without scheme or path.');
    viewer.MAMA_VIEWER_HOSTNAMES = hostname;
    const emails = (
      await prompt.text('Viewer owner emails for access monitoring (comma-separated, optional)')
    ).trim();
    if (emails) viewer.MAMA_VIEWER_OWNER_EMAILS = nonblankLine(emails);
  }
  const installLaunchAgent = await yes(
    prompt,
    'Write ~/Library/LaunchAgents/com.mama.server.plist'
  );
  const plistPath = join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist');
  if (installLaunchAgent && existsSync(plistPath))
    throw new CliInputError('com.mama.server.plist already exists; init will not overwrite it.');

  const config = parseConfig(
    {
      version: 1,
      timezone,
      agent: {
        backend,
        model,
        effort: 'medium',
        max_turns: 100,
        // A turn is stopped after 10 minutes without progress, or after an hour in all
        // (owner, 2026-10-03); a full report on 2026-09-29 was cut off at 300 s while working.
        timeout: 600_000,
        max_turn_ms: 3_600_000,
        run_token_budget: 0,
      },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: {
        enabled: true,
        owner_chat_id: chatId,
        allowed_chats: [chatId],
        owner_user_ids: [userId],
        polling: true,
      },
      discord: discordConfig,
      slack: slackConfig,
      delivery: { reports: 'telegram', notifications: 'telegram', security_alerts: 'telegram' },
      wiki: {
        enabled: true,
        vaultPath: join(root, 'workspace'),
        wikiDir: join(root, 'workspace', 'wiki'),
      },
      ...(jevEnabled ? { jev: { enabled: true } } : {}),
    },
    { home }
  );
  const locate = options.findExecutable ?? findExecutable;
  const backendPath = locate(backend);
  const gwsPath = locate('gws');
  const script = startScript({
    home,
    viewer,
    nodePath: options.nodePath ?? process.execPath,
    cliPath: options.cliPath ?? join(__dirname, '..', 'index.js'),
    executablePaths: [backendPath, gwsPath].filter((path): path is string => path !== undefined),
  });
  secrets.MAMA_AUTH_TOKEN = randomBytes(32).toString('hex');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'workspace', 'wiki'), { recursive: true, mode: 0o700 });
  // Finish all prompts before any write, and publish config last as the setup completion marker.
  updateSecrets(home, secrets);
  writeFileSync(join(root, 'connectors.json'), `${JSON.stringify(connectors, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(root, 'start.sh'), script, { flag: 'wx', mode: 0o700 });
  if (jevKey !== undefined) writeFileSync(jevKeyPath, `${jevKey}\n`, { flag: 'wx', mode: 0o600 });
  if (installLaunchAgent) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, launchAgent(home), { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(configPath, yaml.dump(config), { flag: 'wx', mode: 0o600 });
  prompt.write('Setup written. Credentials are stored only in auth.env (0600).');
  if (!backendPath)
    prompt.write(`Install ${backend} and add its bin directory to PATH in ~/.mama/start.sh.`);
  prompt.write(
    `If you have not logged in, run: ${backend === 'claude' ? 'claude auth login' : `CODEX_HOME=${shellQuote(join(root, '.codex'))} codex login`}`
  );
  if (Object.keys(connectors).some((name) => gwsConnectorNames.has(name))) {
    if (!gwsPath)
      prompt.write('Install gws and add its bin directory to PATH in ~/.mama/start.sh.');
    prompt.write('Log in with the Google scopes your selected connectors need: gws auth login.');
  }
  if (jevEnabled)
    prompt.write(
      `Jev is on (jev.enabled in config.yaml); its key is ${shellQuote(jevKeyPath)} (0600). Turn it off by removing jev.enabled.`
    );
  if (viewer.MAMA_VIEWER_HOSTNAMES)
    prompt.write(
      'Configure your tunnel to the local viewer and protect its hostname with the Access application above.'
    );
  if (installLaunchAgent)
    prompt.write(
      `After login, start with: launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`
    );
  else prompt.write(`After login, start with: ${shellQuote(join(root, 'start.sh'))}`);
}

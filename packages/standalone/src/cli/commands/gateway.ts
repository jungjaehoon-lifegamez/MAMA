import { Command } from 'commander';

import { loadConfig, saveConfig } from '../config/config-manager.js';

type WriteLine = (line: string) => void;
const writeStdout: WriteLine = (line) => process.stdout.write(`${line}\n`);

export interface GatewayTelegramSetOptions {
  tokenStdin: boolean;
  readToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  writeOut?: WriteLine;
}

export interface GatewayTelegramDetectOwnerOptions {
  confirm?: string;
  fetchImpl?: typeof fetch;
  writeOut?: WriteLine;
}

interface TelegramChatCandidate {
  id: string;
  label: string;
}

interface TelegramApiBody {
  ok?: unknown;
  error_code?: unknown;
  result?: unknown;
}

async function readTokenLine(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

async function readTelegramBody(response: Response): Promise<TelegramApiBody> {
  const body = (await response.json()) as unknown;
  return body && typeof body === 'object' ? (body as TelegramApiBody) : {};
}

function telegramCandidates(result: unknown): TelegramChatCandidate[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const candidates = new Map<string, TelegramChatCandidate>();
  for (const update of result) {
    if (!update || typeof update !== 'object') {
      continue;
    }
    const message = (update as { message?: unknown }).message;
    if (!message || typeof message !== 'object') {
      continue;
    }
    const chat = (message as { chat?: unknown }).chat;
    if (!chat || typeof chat !== 'object') {
      continue;
    }
    const record = chat as Record<string, unknown>;
    if (
      record.type !== 'private' ||
      (typeof record.id !== 'string' && typeof record.id !== 'number')
    ) {
      continue;
    }
    const id = String(record.id);
    const labelParts = [record.username, record.first_name, record.last_name].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0
    );
    candidates.set(id, { id, label: labelParts.join(' ') || 'private chat' });
  }
  return [...candidates.values()];
}

export async function gatewayTelegramSet(options: GatewayTelegramSetOptions): Promise<void> {
  if (!options.tokenStdin) {
    throw new Error('Telegram tokens must be provided with --token-stdin');
  }
  const token = (await (options.readToken ?? readTokenLine)()).trim();
  if (!token) {
    throw new Error('Telegram token stdin was empty');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readTelegramBody(response);
  if (!response.ok || body.ok !== true) {
    throw new Error('Telegram token validation failed');
  }

  const config = await loadConfig();
  config.telegram = {
    ...config.telegram,
    enabled: true,
    token,
  };
  await saveConfig(config);
  const writeOut = options.writeOut ?? writeStdout;
  writeOut('✓ Telegram token validated and enabled.');
  writeOut('Next: send the bot a private message, then run:');
  writeOut('  mama gateway telegram detect-owner');
}

export async function gatewayTelegramDetectOwner(
  options: GatewayTelegramDetectOwnerOptions = {}
): Promise<void> {
  const config = await loadConfig();
  const token = config.telegram?.token?.trim();
  if (!token) {
    throw new Error('Telegram token is not configured. Run: mama status');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readTelegramBody(response);
  if (response.status === 409 || body.error_code === 409) {
    throw new Error(
      'another consumer is polling this bot (daemon running?). Run: mama stop, then retry'
    );
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(`Telegram getUpdates failed (HTTP ${response.status})`);
  }

  const candidates = telegramCandidates(body.result);
  if (options.confirm !== undefined) {
    const confirmed = candidates.find((candidate) => candidate.id === options.confirm);
    if (!confirmed) {
      throw new Error('Confirmed chat was not found in the current private-message candidates');
    }
    config.telegram = {
      ...config.telegram,
      enabled: true,
      allowed_chats: [confirmed.id],
    };
    await saveConfig(config);
    const writeOut = options.writeOut ?? writeStdout;
    writeOut(`✓ Telegram owner chat confirmed: ${confirmed.id}`);
    writeOut('Run: mama status');
    return;
  }

  const writeOut = options.writeOut ?? writeStdout;
  if (candidates.length === 0) {
    writeOut('No private Telegram chat candidates found.');
    writeOut('Send the bot a private message, then run this command again.');
    return;
  }
  writeOut('Telegram owner candidates:');
  for (const candidate of candidates) {
    writeOut(`  ${candidate.id}  ${candidate.label}`);
  }
  writeOut('Confirm exactly one candidate:');
  writeOut('  mama gateway telegram detect-owner --confirm <chat-id>');
}

export function createGatewayCommand(): Command {
  const gateway = new Command('gateway').description('Configure messenger gateways');
  const telegram = gateway.command('telegram').description('Configure the Telegram gateway');

  telegram
    .option('--token-stdin', 'Read and validate the Telegram bot token from stdin')
    .action(async (options: { tokenStdin?: boolean }) => {
      if (!options.tokenStdin) {
        telegram.outputHelp();
        return;
      }
      await gatewayTelegramSet({ tokenStdin: true });
    });

  telegram
    .command('detect-owner')
    .description('List or confirm the owner private chat from Telegram updates')
    .option('--confirm <chat-id>', 'Write exactly this private chat as the owner trust anchor')
    .action(async (options: { confirm?: string }) => {
      await gatewayTelegramDetectOwner({ confirm: options.confirm });
    });

  return gateway;
}

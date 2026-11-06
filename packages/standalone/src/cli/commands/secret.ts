import { homedir } from 'node:os';
import { CliInputError, createTerminalPrompt, requireTTY, type PromptAdapter } from '../prompt.js';
import { listSecrets, secretName, updateSecrets } from '../secrets.js';
import { takeSecrets, type OpenRun } from '../runtime/setup-page.js';

const USAGE = 'Usage: mama secret set <NAME> [--non-interactive] | mama secret list';

/**
 * `mama secret set <NAME>` asks for the value with echo off at a terminal; with
 * `--non-interactive` the person's agent runs it, and the value is entered on the setup page
 * (install.md, W2.4.6). Either way it goes only to auth.env.
 */
export async function runSecret(
  args: string[],
  options: {
    home?: string;
    prompt?: PromptAdapter;
    platform?: NodeJS.Platform;
    openRun?: OpenRun;
    setupPageMs?: number;
  } = {}
): Promise<void> {
  const home = options.home ?? homedir();
  const prompt = options.prompt ?? createTerminalPrompt();
  if (args[0] === 'list' && args.length === 1) {
    for (const name of listSecrets(home)) prompt.write(name);
    return;
  }
  const nonInteractive = args.length === 3 && args[2] === '--non-interactive';
  if (args[0] !== 'set' || (args.length !== 2 && !nonInteractive)) throw new CliInputError(USAGE);
  if (!nonInteractive) requireTTY(prompt);
  const name = secretName(args[1]);
  const write = (line: string) => prompt.write(line);
  const value = nonInteractive
    ? (
        await takeSecrets(
          [
            {
              name,
              label: listSecrets(home).includes(name)
                ? `${name}. It replaces the one in auth.env.`
                : name,
            },
          ],
          `${name} is taken.`,
          {
            write,
            platform: options.platform ?? process.platform,
            ...(options.openRun ? { openRun: options.openRun } : {}),
            ...(options.setupPageMs === undefined ? {} : { lifetimeMs: options.setupPageMs }),
          }
        )
      )[name]!
    : await prompt.secret(name);
  updateSecrets(home, { [name]: value });
  write(`Updated ${name}. Restart the daemon to use the new value.`);
}

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { loadConfig, parseConfig, type W1Config } from '../../runtime/config.js';
import { installDocumentToolkit } from '../../tools/document-toolkit.js';
import { onToolkitSignal } from '../../tools/toolkit-process.js';
import { CliInputError } from '../prompt.js';

/** macOS keeps a Shared folder beside the home folders, readable by every session. */
export function defaultToolsRoot(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string | undefined {
  return platform === 'darwin' ? join(dirname(home), 'Shared', 'mama-tools') : undefined;
}

export async function runTools(
  args: string[],
  options: {
    home?: string;
    configPath?: string;
    toolsRoot?: string;
    platform?: NodeJS.Platform;
    install?: (config: W1Config) => Promise<unknown>;
    write?: (line: string) => void;
  } = {}
): Promise<void> {
  if (args.length !== 1 || args[0] !== 'install')
    throw new CliInputError('Usage: mama tools install');
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? join(home, '.mama', 'config.yaml');
  const config = loadConfig({ path: configPath, home });
  const root = config.tools_root ?? options.toolsRoot ?? defaultToolsRoot(options.platform, home);
  if (!root)
    throw new CliInputError(
      'Set tools_root to a writable directory outside HOME in config.yaml, then run mama tools install on the host'
    );
  const next = parseConfig({ ...config, tools_root: root }, { home });
  const needsRestart = config.tools_root === undefined || !existsSync(root);
  const unregister = onToolkitSignal(() => {}, { exit: true });
  try {
    if (options.install) await options.install(next);
    else
      await installDocumentToolkit({
        toolsRoot: root,
        memberRoot: config.member_root,
        home,
        write: options.write,
      });
  } catch (error) {
    throw new CliInputError(
      `Document toolkit install failed; run mama tools install on the host. ${error instanceof Error ? error.message : ''}`
    );
  } finally {
    unregister();
  }
  if (config.tools_root === undefined) {
    // Append one key so the owner's comments and layout survive. Initial enrollment of
    // tools_root needs a daemon restart; later installs switch current without either.
    const text = readFileSync(configPath, 'utf8');
    const raw = yaml.load(text) as Record<string, unknown>;
    const next = `${text}${text.endsWith('\n') ? '' : '\n'}tools_root: ${JSON.stringify(root)}\n`;
    let appended: Record<string, unknown> | undefined;
    try {
      appended = yaml.load(next) as Record<string, unknown> | undefined;
    } catch {
      appended = undefined; // A flow-style file cannot take an appended block key.
    }
    if (
      appended?.tools_root !== root ||
      Object.keys(appended).length !== Object.keys(raw).length + 1
    )
      throw new CliInputError(
        `Document toolkit installed, but tools_root could not be appended to ${configPath}; add tools_root: ${JSON.stringify(root)} there and restart the daemon`
      );
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, configPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  (options.write ?? console.log)(
    needsRestart
      ? 'Document toolkit installed. Restart the daemon once to load the tools_root PATH.'
      : 'Document toolkit installed; existing sessions use the updated current PATH.'
  );
}

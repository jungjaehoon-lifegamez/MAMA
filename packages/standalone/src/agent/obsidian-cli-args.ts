/**
 * The ONE production builder for Obsidian CLI arguments.
 *
 * Obsidian's CLI syntax is `obsidian [vault=<name>] <command> key=value ... [flags]`: the
 * vault selector is GLOBAL and must precede the command. Live wiki workorder #4569
 * (2026-09-06) emitted `[command, vault=mama-operator, ...]`, the CLI ignored the trailing
 * selector, and five MAMA pages landed in the owner's focused `finance` vault. The
 * gateway test used to duplicate the wrong algorithm instead of importing this one.
 */
export const OBSIDIAN_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'silent',
  'overwrite',
  'total',
]);

export function buildObsidianCliArgs(
  command: string,
  args: Record<string, string> | undefined,
  vaultName: string | null | undefined
): string[] {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('obsidian command is required');
  }
  if (!/^[a-z][a-z0-9:-]*$/.test(command)) {
    throw new Error('obsidian command must be one CLI command name');
  }
  const entries = Object.entries(args ?? {});
  if (entries.some(([key]) => key === 'vault')) {
    // The vault is host configuration. A model-supplied selector could redirect a write to
    // whatever vault it names, which is exactly the failure this module exists to prevent.
    throw new Error('obsidian args may not override the configured vault');
  }
  const cliArgs: string[] = [];
  if (vaultName) {
    cliArgs.push(`vault=${vaultName}`);
  }
  cliArgs.push(command);
  for (const [key, value] of entries) {
    if (value === 'true' && OBSIDIAN_BOOLEAN_FLAGS.has(key)) {
      cliArgs.push(key);
    } else {
      cliArgs.push(`${key}=${value}`);
    }
  }
  return cliArgs;
}

/** Parse the configured vault path from `obsidian vault=<name> vault`. */
export function parseObsidianVaultPath(output: string): string {
  const pathLine = output.split(/\r?\n/).find((line) => line.startsWith('path\t'));
  const path = pathLine?.slice('path\t'.length).trim();
  if (!path) {
    throw new Error('Obsidian CLI did not report the configured vault path');
  }
  return path;
}

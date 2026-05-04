const SENSITIVE_PROMPT_ARGS = new Set(['--system-prompt', '--append-system-prompt']);

export function formatCliArgsForLog(args: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    redacted.push(arg);
    if (SENSITIVE_PROMPT_ARGS.has(arg) && i + 1 < args.length) {
      const value = args[i + 1] ?? '';
      redacted.push(`[redacted ${value.length} chars]`);
      i++;
    }
  }
  return redacted;
}

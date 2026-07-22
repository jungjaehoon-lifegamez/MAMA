export type OperatorRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Proactive monitoring is a core operator behavior; an explicit 0 is the opt-out. */
export function isOperatorTriggerLoopEnabled(environment: OperatorRuntimeEnvironment): boolean {
  return environment.MAMA_TRIGGER_LOOP !== '0';
}

/**
 * Resolve the owner-report destination without requiring a duplicate secret setting.
 * Falling back is safe only for exactly one allowlisted private Telegram chat; groups
 * and ambiguous allowlists require the explicit environment setting.
 */
export function resolveOperatorReportChatId(
  environment: OperatorRuntimeEnvironment,
  allowedChats: readonly string[] | undefined
): string {
  const explicit = environment.MAMA_TRIGGER_LOOP_REPORT_CHAT?.trim();
  const privateChats = [...new Set((allowedChats ?? []).map((chat) => chat.trim()))].filter(
    (chat) => /^[1-9]\d*$/.test(chat)
  );
  if (explicit) return privateChats.includes(explicit) ? explicit : '';
  return privateChats.length === 1 ? privateChats[0] : '';
}

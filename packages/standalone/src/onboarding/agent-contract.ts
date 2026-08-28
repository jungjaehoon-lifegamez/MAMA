/**
 * The onboarding contract - the single source of onboarding truth.
 *
 * `mama --help` renders the static half (what the journey is), `mama status`
 * renders the dynamic half (where this install stands and the exact next
 * action per missing item). Everything else - plugin skill, README, the agent
 * driving a conversation - is a thin pointer to these two renders. Guidance
 * strings live ONLY here; duplicating them elsewhere reintroduces the drift
 * this module exists to kill.
 *
 * Pure evaluation: no I/O. Observation lives in assess-live.ts; this module
 * owns judgment and wording. The journey endpoint is deliberately not
 * "setup complete" but the first evidenced report arriving.
 */

export type OnboardingItemId =
  | 'config'
  | 'gateway'
  | 'trust_anchor'
  | 'owner_facts'
  | 'sources'
  | 'first_report';

export interface OnboardingItemState {
  id: OnboardingItemId;
  done: boolean;
  guidance: string;
}

export interface OnboardingState {
  complete: boolean;
  missing: OnboardingItemId[];
  items: OnboardingItemState[];
}

export interface AssessDeps {
  mamaHome: string;
  configExists: boolean;
  daemonRunning: boolean;
  telegramToken: boolean;
  allowedChats: boolean;
  ownerFacts: boolean;
  enabledConnectors: number;
  firstReportAt: string | null;
}

/** Journey order is fixed: `missing` reports in this order, always. */
export const ONBOARDING_ITEMS: readonly OnboardingItemId[] = [
  'config',
  'gateway',
  'trust_anchor',
  'owner_facts',
  'sources',
  'first_report',
] as const;

/**
 * Telegram allows exactly one polling consumer, so gateway/anchor work must
 * happen with the daemon stopped. The contract owns this ordering knowledge -
 * the commands themselves carry no pre-guards.
 */
const STOP_DAEMON_FIRST = 'Stop the daemon first: mama stop (Telegram allows one polling consumer)';

function guidanceFor(id: OnboardingItemId, deps: AssessDeps): string {
  switch (id) {
    case 'config':
      return 'Run: mama init (checks backend auth and writes ~/.mama/config.yaml)';
    case 'gateway': {
      const line = 'Run: mama gateway telegram set-token <bot-token> (create one via @BotFather)';
      return deps.daemonRunning ? `${STOP_DAEMON_FIRST}\n${line}` : line;
    }
    case 'trust_anchor': {
      const line = deps.telegramToken
        ? 'Human step: send any message to the bot, then run: mama gateway telegram detect-owner'
        : 'Set the gateway token first (see the gateway item), then: mama gateway telegram detect-owner';
      return deps.daemonRunning ? `${STOP_DAEMON_FIRST}\n${line}` : line;
    }
    case 'owner_facts':
      return 'Run: mama owner --name <name> --language <lang> --timezone <tz>';
    case 'sources':
      return 'Run: mama connector add <name> (mama connector list shows what exists)';
    case 'first_report':
      return 'Run: mama start, then: mama report now - the journey ends when the first report arrives';
  }
}

function isDone(id: OnboardingItemId, deps: AssessDeps): boolean {
  switch (id) {
    case 'config':
      // mama init already gates backend availability + auth fail-loud, so an
      // existing config implies auth passed at init time; later auth rot fails
      // loudly at start/run - the real boundary (review decision #3).
      return deps.configExists;
    case 'gateway':
      return deps.telegramToken;
    case 'trust_anchor':
      return deps.allowedChats;
    case 'owner_facts':
      return deps.ownerFacts;
    case 'sources':
      return deps.enabledConnectors >= 1;
    case 'first_report':
      return deps.firstReportAt !== null;
  }
}

export function assessOnboarding(deps: AssessDeps): OnboardingState {
  const items: OnboardingItemState[] = ONBOARDING_ITEMS.map((id) => ({
    id,
    done: isDone(id, deps),
    guidance: guidanceFor(id, deps),
  }));
  const missing = items.filter((i) => !i.done).map((i) => i.id);
  return { complete: missing.length === 0, missing, items };
}

/** Static contract block for `mama --help` and the README pointer. */
export function renderContractIntro(): string {
  return [
    'MAMA is an always-on agent server: it reads your work channels and',
    'delivers evidenced reports. The setup journey ends when the FIRST REPORT',
    'arrives - not when installation finishes.',
    '',
    'New install? Run: mama status - it shows exactly what is missing and the',
    'next command for each item. Machine-readable: mama status --json',
  ].join('\n');
}

/** Dynamic contract block for `mama status` when onboarding is incomplete. */
export function renderContractStatus(state: OnboardingState): string {
  if (state.complete) {
    return 'Onboarding: complete';
  }
  const lines: string[] = ['Onboarding: incomplete', ''];
  for (const item of state.items) {
    const mark = item.done ? '[x]' : '[ ]';
    lines.push(`${mark} ${item.id}`);
    if (!item.done) {
      for (const g of item.guidance.split('\n')) {
        lines.push(`      ${g}`);
      }
    }
  }
  const next = state.items.find((i) => !i.done);
  if (next) {
    lines.push('', `Next: ${next.guidance.split('\n').pop() ?? ''}`);
  }
  return lines.join('\n');
}

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
  | 'daemon'
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
  configLoadable: boolean;
  daemonRunning: boolean;
  telegramConfigured: boolean;
  allowedChats: boolean;
  enabledConnectors: number;
  readyConnectors: number;
  firstReportAt: string | null;
}

/** Journey order is fixed: `missing` reports in this order, always. */
export const ONBOARDING_ITEMS: readonly OnboardingItemId[] = [
  'config',
  'gateway',
  'trust_anchor',
  'daemon',
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
      const line =
        'Run: mama gateway telegram --token-stdin (create the bot token with @BotFather first)';
      return deps.daemonRunning ? `${STOP_DAEMON_FIRST}\n${line}` : line;
    }
    case 'trust_anchor': {
      const line = deps.telegramConfigured
        ? 'Human step: send any message to the bot, then run: mama gateway telegram detect-owner'
        : 'Human step: configure the gateway first, send any message to the bot, then run: mama gateway telegram detect-owner';
      return deps.daemonRunning ? `${STOP_DAEMON_FIRST}\n${line}` : line;
    }
    case 'daemon':
      return 'Start the daemon: mama start';
    case 'sources':
      return deps.enabledConnectors === 0
        ? 'Run: mama connector add <name> (mama connector list shows what exists)'
        : 'Run: mama connector status (fix authentication until at least one source connects)';
    case 'first_report':
      return 'Run: mama report now - the journey ends when the first report arrives';
  }
}

function isDone(id: OnboardingItemId, deps: AssessDeps): boolean {
  switch (id) {
    case 'config':
      // mama init already gates backend availability + auth fail-loud, so an
      // loadable config implies auth passed at init time; later auth rot fails
      // loudly at start/run - the real boundary (review decision #3).
      return deps.configLoadable;
    case 'gateway':
      return deps.telegramConfigured;
    case 'trust_anchor':
      return deps.allowedChats;
    case 'daemon':
      return deps.daemonRunning;
    case 'sources':
      return deps.readyConnectors >= 1;
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
    'next command for each item, including facts that require a human step.',
    'Machine-readable: mama status --json',
  ].join('\n');
}

/** Dynamic contract block for `mama status` when onboarding is incomplete. */
export function renderContractStatus(state: OnboardingState): string {
  if (state.complete) {
    return 'Onboarding: complete';
  }
  const missing = state.items.filter((item) => !item.done);
  const agentActions = missing.filter((item) => item.id !== 'trust_anchor');
  const humanActions = missing.filter((item) => item.id === 'trust_anchor');
  const lines: string[] = ['Onboarding: incomplete'];

  const appendActions = (heading: string, items: OnboardingItemState[]): void => {
    if (items.length === 0) {
      return;
    }
    lines.push('', heading);
    for (const item of items) {
      lines.push(`[ ] ${item.id}`);
      for (const guidance of item.guidance.split('\n')) {
        lines.push(`      ${guidance}`);
      }
    }
  };

  appendActions('Agent can do now:', agentActions);
  appendActions('Human required:', humanActions);

  const nextAgentAction = agentActions[0];
  if (nextAgentAction) {
    lines.push('', `Next: ${nextAgentAction.guidance.split('\n').pop() ?? ''}`);
  }
  return lines.join('\n');
}

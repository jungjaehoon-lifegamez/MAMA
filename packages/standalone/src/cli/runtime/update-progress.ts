import { MESSENGER_SECRETS } from '../commands/daemon.js';
import { defaultTelegramCall, readAuthEnv } from './diagnostics.js';
import { readUpdateRequest, updateRequestPath } from './update-request.js';

/*
 * What `mama update` reports to the chat an /update came from (docs/development/work/update.md,
 * PR 4). A group may read it, so an event carries versions, step numbers and error codes only:
 * never a path, a message the CLI printed, or anything the owner wrote. The texts are built from
 * those fields alone, and each field is checked again before it is sent.
 */

export type UpdateProgress =
  | { readonly kind: 'plan'; readonly from: string; readonly to: string }
  | { readonly kind: 'current'; readonly version: string }
  | { readonly kind: 'step'; readonly from: string; readonly to: string; readonly step: number }
  /** A step of the new version failed; the rollback reports next. */
  | {
      readonly kind: 'failed';
      readonly from: string;
      readonly to: string;
      readonly step: number;
      readonly code: string | null;
    }
  /** The stop or the snapshot failed; nothing was swapped. */
  | {
      readonly kind: 'not_updated';
      readonly from: string;
      readonly to: string;
      readonly step: number;
      readonly code: string;
    }
  | { readonly kind: 'rolling_back'; readonly from: string; readonly to: string }
  | {
      readonly kind: 'rolled_back';
      readonly from: string;
      readonly to: string;
      readonly step: number;
    }
  | { readonly kind: 'rollback_stopped'; readonly from: string; readonly to: string }
  /** `running`: the daemon answered the release; false when it is not running now. */
  | {
      readonly kind: 'updated';
      readonly from: string;
      readonly to: string;
      readonly running: boolean;
    }
  /** The update ended on an error: a refusal before anything changed, or a step that threw. */
  | { readonly kind: 'error'; readonly code: string };

/** The step table's names (update.md, PR 3), for the chat. */
export const UPDATE_STEP_NAMES: Readonly<Record<number, string>> = {
  5: 'stage the new version',
  6: 'drain and stop',
  7: 'snapshot',
  8: 'swap',
  9: 'hand over to the new version',
  10: 'service files',
  11: 'doctor',
  12: 'toolkit',
  13: 'start held',
  14: 'wait for the boot',
};

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CODE = /^[A-Za-z0-9_.]{1,64}$/;

function version(value: string): string {
  return VERSION.test(value) ? value : 'unknown';
}

/** A code as the chat may see it: a token, never free text. */
export function progressCode(value: unknown): string | null {
  return typeof value === 'string' && CODE.test(value) ? value : null;
}

function step(number: number): string {
  const name = UPDATE_STEP_NAMES[number];
  return name === undefined ? `step ${number}` : `step ${number} (${name})`;
}

export function progressText(event: UpdateProgress): string {
  switch (event.kind) {
    case 'plan':
      return `update ${version(event.from)} → ${version(event.to)}: starting`;
    case 'current':
      return `already on ${version(event.version)}`;
    case 'step':
      return `update ${version(event.from)} → ${version(event.to)}: ${step(event.step)}`;
    case 'failed':
      return `update ${version(event.from)} → ${version(event.to)}: ${step(event.step)} failed${progressCode(event.code) === null ? '' : `: ${progressCode(event.code)}`}`;
    case 'not_updated':
      return `not updated: ${step(event.step)} failed: ${progressCode(event.code) ?? 'UNKNOWN'}; ${version(event.from)} stays installed`;
    case 'rolling_back':
      return `rolling back to ${version(event.from)}`;
    case 'rolled_back':
      return `rolled back: ${version(event.from)} runs again; ${step(event.step)} of the update to ${version(event.to)} failed`;
    case 'rollback_stopped':
      return `the rollback to ${version(event.from)} stopped; MAMA stays stopped until mama update --rollback runs on its machine`;
    case 'updated':
      return event.running
        ? `updated: ${version(event.from)} → ${version(event.to)}; it runs`
        : `updated: ${version(event.from)} → ${version(event.to)}; MAMA is not running now; start it on its machine`;
    case 'error':
      return `update ended: ${progressCode(event.code) ?? 'UNKNOWN'}; the update log on MAMA's machine has the details`;
  }
}

export interface ProgressSink {
  send(event: UpdateProgress): void;
  /**
   * Wait until every event sent so far has gone out (or failed and been logged), for at most
   * PROGRESS_FLUSH_DEADLINE_MS; what is still unsent then is dropped and counted in the log.
   */
  flush(): Promise<void>;
}

/**
 * One send's limit. The flushes before a child CLI and at the end run while MAMA is stopped, so
 * a Bot API that does not answer must not hold the install down; Telegram answers in well under
 * a second when it answers at all.
 */
export const PROGRESS_SEND_TIMEOUT_MS = 3_000;
/** The whole flush's limit, however many sends wait: the stopped window grows by at most this. */
export const PROGRESS_FLUSH_DEADLINE_MS = 5_000;

export const NO_PROGRESS: ProgressSink = {
  send: () => {},
  flush: async () => {},
};

export type TelegramCall = typeof defaultTelegramCall;

/**
 * Progress to the /update's chat through the Bot API's sendMessage alone: the daemon may be
 * stopped, and a getUpdates here would take its updates. The chat comes from
 * runtime/update-request.json and the bot token alone from auth.env, as doctor reads it. A send
 * that fails is logged (to update.log, the job's output) and the update goes on. Repeats of a step
 * (the journal is saved more than once in a step) are sent once.
 */
export function telegramProgress(options: {
  root: string;
  log: (line: string) => void;
  call?: TelegramCall;
}): ProgressSink {
  const call = options.call ?? defaultTelegramCall;
  let target: { token: string; chatId: string } | null = null;
  let chain = Promise.resolve();
  /** Sends queued or in flight; a flush past its deadline drops the queued ones. */
  let pending = 0;
  let generation = 0;
  let lastStep: number | null = null;
  const deliver = async (text: string): Promise<void> => {
    try {
      if (target === null) {
        const request = readUpdateRequest(updateRequestPath(options.root));
        if (request === null) throw new Error('no runtime/update-request.json');
        const name = MESSENGER_SECRETS.telegram[0];
        const token = readAuthEnv(options.root)[name];
        if (!token?.trim()) throw new Error(`auth.env has no ${name}`);
        target = { token, chatId: request.chatId };
      }
      const reply = await call(
        target.token,
        'sendMessage',
        { chat_id: target.chatId, text },
        PROGRESS_SEND_TIMEOUT_MS
      );
      if (reply.ok !== true) {
        options.log(
          `update progress not sent: Telegram answered ${String(reply.error_code ?? 'not ok')}`
        );
      }
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // The request's URL holds the token; an error that quotes it does not reach the log.
      const token = target?.token;
      options.log(`update progress not sent: ${token ? text.split(token).join('<token>') : text}`);
    }
  };
  return {
    send: (event) => {
      if (event.kind === 'step') {
        if (event.step === lastStep) return;
        lastStep = event.step;
      }
      const text = progressText(event);
      const queuedIn = generation;
      pending += 1;
      chain = chain.then(async () => {
        try {
          if (queuedIn === generation) await deliver(text);
        } finally {
          pending -= 1;
        }
      });
    },
    flush: async () => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), PROGRESS_FLUSH_DEADLINE_MS);
      });
      const outcome = await Promise.race([chain.then(() => 'sent' as const), late]);
      clearTimeout(timer);
      if (outcome === 'late') {
        // The one in flight ends on its own timeout; those queued behind it are not sent.
        options.log(
          `update progress: ${pending} message(s) not sent within ${PROGRESS_FLUSH_DEADLINE_MS} ms; dropped`
        );
        generation += 1;
        chain = Promise.resolve();
      }
    },
  };
}

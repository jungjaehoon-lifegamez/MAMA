import { execFile } from 'node:child_process';
import type { SourceTool } from './types.js';

/**
 * The scope a gws login asks for each Google source's service (2026-10-31). Gmail, Calendar and
 * Sheets are read only. Drive keeps full `drive`: the same login serves deliver.drive.file, which
 * uploads into the folder the owner names and sets its readers, and `drive.file` reaches only
 * files this client created or the person opened with it (Google's Drive scope guide), not that
 * folder. `--scopes` is passed to Google as written; gws ignores `-s` beside it and adds only its
 * identity scopes (gws `auth_commands.rs`, `resolve_scopes`, `handle_login_inner`).
 */
export const GWS_LOGIN_SCOPES: Readonly<Record<string, string>> = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  sheets: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  drive: 'https://www.googleapis.com/auth/drive',
};

/**
 * The Google Workspace CLI the Google sources (calendar, gmail, drive, sheets) run. The npm
 * package is a Node script (`bin` run.js, `postinstall` `node install.js`) that fetches the
 * native binary; the Homebrew formula installs that binary. Its login needs an OAuth client of
 * the person's own: without one, `gws auth login` exits at once with `401 No OAuth client
 * configured` (install-notes.md, measured on 0.11.1). The client file is gws's own credential,
 * like a backend's login, not a MAMA secret.
 */
export const gwsTool: SourceTool = {
  command: 'gws',
  loginArgs: 'auth login',
  scopeFlag: '--scopes',
  loginScope: (service) => {
    const scope = GWS_LOGIN_SCOPES[service];
    if (scope === undefined) throw new Error(`No gws login scope is known for ${service}`);
    return scope;
  },
  beforeLogin:
    'gws signs in through an OAuth client of your own: in Google Cloud Console, create an OAuth client of type Desktop app, download its JSON and save it as ~/.config/gws/client_secret.json (mode 0600).',
  npmPackage: '@googleworkspace/cli',
  brewFormula: 'googleworkspace-cli',
};

/** The login, for a source's own error: doctor prints the command that runs it on this install. */
export const gwsLogin = `mama doctor names the ${gwsTool.command} ${gwsTool.loginArgs} command for this install`;

/** A source's error when the service cannot run gws; doctor names how to install it here. */
export const gwsMissing = `${gwsTool.command} is not on the service's PATH; mama doctor names how to install it, and ${gwsLogin}`;

/** A source's error when `gws --version` fails: not found (ENOENT), or found but not running. */
export function gwsUnavailable(error: unknown): string {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? gwsMissing
    : `${gwsTool.command} is on the service's PATH but ${gwsTool.command} --version failed (${error instanceof Error ? error.message : String(error)})`;
}

export interface GwsCallOptions {
  maxBuffer?: number;
  /** Defaults to 60 s; a download names its own. */
  timeoutMs?: number;
  /** Where gws runs; a response gws writes to a file (not JSON) lands here. */
  cwd?: string;
}

/** Where the JSON gws prints starts: the first line opening an object or an array. */
function jsonLines(raw: string): string | null {
  const lines = raw.split('\n');
  const start = lines.findIndex(
    (line) => line.trimStart().startsWith('{') || line.trimStart().startsWith('[')
  );
  return start === -1 ? null : lines.slice(start).join('\n');
}

/** The error object gws prints: `{"error":{"code","message","reason"}}` (gws `error.rs`). */
export interface GwsReportedError {
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  /** For `accessNotConfigured`: where the API is enabled in the client's Cloud project. */
  enable_url?: unknown;
}

/** A failure gws reported itself; `reported` is its error object as printed. */
export class GwsCliError extends Error {
  constructor(
    readonly reported: GwsReportedError,
    options?: ErrorOptions
  ) {
    super(`gws CLI returned an error: ${JSON.stringify(reported)}`, options);
  }
}

/** gws prints the API's error as JSON on stdout and exits non-zero; that error names the cause. */
function stdoutError(stdout: string, exit: Error): Error | null {
  const json = jsonLines(stdout);
  if (json === null) return null;
  let parsed: { error?: unknown };
  try {
    parsed = JSON.parse(json) as { error?: unknown };
  } catch {
    // Not the API's error JSON: the exit error is the report.
    return null;
  }
  return parsed.error === undefined
    ? null
    : new GwsCliError(parsed.error as GwsReportedError, { cause: exit });
}

async function execGwsStdoutAsync(args: string[], options?: GwsCallOptions): Promise<string> {
  const timeout = options?.timeoutMs ?? 60_000;
  return new Promise<string>((resolve, reject) => {
    execFile(
      'gws',
      args,
      {
        encoding: 'utf8',
        maxBuffer: options?.maxBuffer,
        timeout,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error, value) => {
        if (error?.killed) {
          reject(
            new Error(`gws ${args.slice(0, 3).join(' ')} timed out after ${timeout} ms`, {
              cause: error,
            })
          );
          return;
        }
        if (error) {
          reject(stdoutError(value, error) ?? error);
          return;
        }
        resolve(value);
      }
    );
  });
}

export function parseGwsOutput(raw: string): unknown {
  const json = jsonLines(raw);
  if (json === null) throw new Error('No JSON found in gws CLI output');
  const result: unknown = JSON.parse(json);
  if (result && typeof result === 'object' && 'error' in result) {
    throw new GwsCliError(result.error as GwsReportedError);
  }
  return result;
}

/** Google's reasons for a rate or quota refusal (403 or 429). */
const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

export type GwsFailureKind =
  | 'missing'
  | 'signed_out'
  | 'scope_missing'
  | 'api_disabled'
  | 'quota'
  | 'too_large'
  | 'other';

/**
 * Google's own wording for a missing scope and for an API the client's project has not enabled.
 * APIs that answer in the newer error shape (Sheets v4: `status` and `details`, no `errors[]`)
 * carry no reason gws can read, so it prints `reason: "unknown"` (gws `executor.rs`,
 * `handle_error_response`) and only Google's message names the cause.
 */
const SCOPE_MESSAGE = /insufficient authentication scopes/i;
const DISABLED_MESSAGE = /has not been used in project/i;
const ENABLE_URL = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"]+/;

/**
 * Why a gws call failed, read from gws's own report: ENOENT (not on PATH), the output buffer
 * overflowing, or the error object gws printed. 401 is gws's `authError` (no sign-in, or one
 * Google no longer refreshes); a missing scope is 403 `insufficientPermissions`; an API the
 * client's Cloud project has not enabled is 403 `accessNotConfigured` with `enable_url`, or the
 * same two in Google's words where gws found no reason.
 */
export function gwsFailure(error: unknown): {
  kind: GwsFailureKind;
  detail: string;
  enableUrl?: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return { kind: 'missing', detail };
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'too_large', detail };
  if (!(error instanceof GwsCliError)) return { kind: 'other', detail };
  const { code: status, reason, enable_url: enableUrl } = error.reported;
  const message = typeof error.reported.message === 'string' ? error.reported.message : '';
  if (status === 401) return { kind: 'signed_out', detail };
  if (status === 429 || (typeof reason === 'string' && QUOTA_REASONS.has(reason)))
    return { kind: 'quota', detail };
  if (reason === 'insufficientPermissions' || (status === 403 && SCOPE_MESSAGE.test(message)))
    return { kind: 'scope_missing', detail };
  if (reason === 'accessNotConfigured' || (status === 403 && DISABLED_MESSAGE.test(message))) {
    const url = typeof enableUrl === 'string' ? enableUrl : ENABLE_URL.exec(message)?.[0];
    return { kind: 'api_disabled', detail, ...(url === undefined ? {} : { enableUrl: url }) };
  }
  return { kind: 'other', detail };
}

/**
 * A Google source's sign-in check: one read that its own service's scope allows. `gws auth status`
 * cannot be it: it exits 0 signed in or not (gws's `handle_status_succeeds_without_credentials`),
 * and its `token_valid` says only that the sign-in can be refreshed, not which services it grants
 * (a login with Gmail's scope alone grants Gmail alone). Resolves with undefined when the read
 * works, or with why it did not, in gws's own words: no sign-in, an ended one, a missing scope,
 * the network.
 */
export async function gwsReadRefusal(
  label: string,
  what: string,
  args: string[]
): Promise<string | undefined> {
  try {
    await execGwsAsync(args);
    return undefined;
  } catch (error) {
    const failure = gwsFailure(error);
    return failure.kind === 'missing'
      ? `${label}: ${gwsMissing}`
      : `${label}: ${gwsTool.command} cannot read ${what} with its sign-in (${failure.detail}). Sign in with its access (${gwsLogin}), then retry.`;
  }
}

/** Run non-JSON gws commands with argv and without blocking the daemon. */
export function execGwsTextAsync(args: string[]): Promise<string> {
  return execGwsStdoutAsync(args);
}

/** Keep upstream page tokens in argv, never in a shell command; do not block the daemon. */
export async function execGwsAsync(args: string[], options?: GwsCallOptions): Promise<unknown> {
  const stdout = await execGwsStdoutAsync(args, options);
  return parseGwsOutput(stdout);
}

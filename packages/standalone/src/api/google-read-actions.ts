/**
 * google.read — the owner's Gmail, Calendar and Sheets, and Google Docs as text, read on demand
 * through gws, run by the daemon with its own sign-in (owner, 2026-10-31;
 * docs/development/work/google-read.md). The agent names the method as gws takes it; the host
 * builds the whole command, so no gws flag is an input: nothing is uploaded or sent, and no page
 * dump is asked for. gws writes any response that is not JSON to a file in its working directory
 * (gws executor.rs, handle_binary_response), so each call runs in a directory of its own under
 * runtime/, which no agent reads, removed after the call; such a response is refused, never
 * left where the agent could open it past the cap, the quoting and the trace. The allowlist is the
 * read-only guard: the sign-in carries Drive write access for deliver.drive.file, and a login made
 * before 2026-10-31 may carry write access to every service. The agent's shell stays closed.
 * Nothing is saved as a source; tool_traces keeps its usual bounded, redacted summary of each call
 * (observeCall).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionRegistration } from '@jungjaehoon/mama-core';

import {
  execGwsAsync,
  gwsFailure,
  gwsLogin,
  gwsMissing,
  gwsTool,
} from '../connectors/framework/gws-utils.js';
import type { GwsCall } from './drive-actions.js';

export const GOOGLE_READ_ACTION = 'google.read';

/**
 * The read methods, per service, as gws takes them after the service name. The connectors call
 * most of them; `users labels list` names the label ids messages carry. Drive's listing, file
 * metadata and downloads are drive.read and drive.download; only a Google Doc, Sheet or Slides
 * file read as text is new here.
 */
export const GOOGLE_READ_METHODS = {
  gmail: [
    'users getProfile',
    'users labels list',
    'users messages list',
    'users messages get',
    'users threads list',
    'users threads get',
  ],
  calendar: ['calendarList list', 'events list', 'events get'],
  drive: ['files export'],
  sheets: ['spreadsheets get', 'spreadsheets values get'],
} as const;

export type GoogleService = keyof typeof GOOGLE_READ_METHODS;

/**
 * About 25,000 tokens of ASCII JSON: Claude Code's default limit for one MCP tool result, which a
 * code_act return meets, while a Codex turn takes the result whole. Japanese or Korean text costs
 * about a token per character, so a page of it near the cap is several times that. A page over it
 * is narrowed by the request, not cut: cut JSON does not parse.
 */
export const GOOGLE_READ_MAX_CHARS = 100_000;

/**
 * gws's stdout held in the daemon for one call: Node's own execFile default, stated because
 * execGwsAsync otherwise passes none, which lifts the bound. gws prints indented JSON, so this sits
 * well above the result cap.
 */
const GOOGLE_READ_MAX_BUFFER = 1024 * 1024;

/**
 * Google's system parameters that make the response something other than JSON: `alt` (media,
 * proto, sse) and `callback` (JSONP, whatever the function name), each also with a `$` prefix.
 * gws passes any parameter it does not know through to the URL (executor.rs, build_url).
 */
const NOT_JSON_PARAMS: Readonly<Record<string, (value: unknown) => boolean>> = {
  alt: (value) => value !== 'json',
  $alt: (value) => value !== 'json',
  callback: () => true,
  $callback: () => true,
};

export interface GoogleReadPorts {
  /** A directory only the daemon reads (under the MAMA home's runtime/): each call's own cwd. */
  scratchDir: string;
  gws?: GwsCall;
}

function failure(name: string, message: string, kind?: 'invalid_input' | 'denied'): Error {
  return Object.assign(new Error(message), {
    name,
    ...(kind === undefined ? {} : { code: kind }),
  });
}

function allowedSet(): string {
  return Object.entries(GOOGLE_READ_METHODS)
    .map(([service, methods]) => `${service}: ${methods.join(', ')}`)
    .join('; ');
}

/**
 * The method the call names, or why it is not one google.read runs. Token by token, so one
 * argument holding "users messages list" is not taken for three.
 */
function method(service: GoogleService, argv: readonly string[]): string {
  const named = argv.join(' ');
  const found = (GOOGLE_READ_METHODS[service] as readonly string[]).find((allowed) => {
    const tokens = allowed.split(' ');
    return tokens.length === argv.length && tokens.every((token, index) => token === argv[index]);
  });
  if (found !== undefined) return found;
  const flag = argv.find((token) => token.startsWith('-') || token.startsWith('+'));
  throw failure(
    'google_method_not_allowed',
    `google.read runs read methods only, and gws ${service} ${named} is not one. ` +
      (flag === undefined
        ? ''
        : `argv names the method only: ${flag} is not taken. Parameters go in params; the host adds --params itself and passes no other flag, because --output writes a file, --upload and --json send content, --page-all dumps every page, and helper commands (+name) are not read methods. `) +
      `Allowed: ${allowedSet()}.`,
    'invalid_input'
  );
}

function tooLarge(command: string, size: number | null): Error {
  const over = `gws ${command} returned ${size === null ? 'more than the output buffer holds' : `${size} characters`}, over the ${GOOGLE_READ_MAX_CHARS} google.read returns`;
  return failure(
    'google_read_too_large',
    command.endsWith(' list')
      ? `${over}. Ask for fewer per page (maxResults or pageSize, then pageToken for the next page) or only the parts you need (fields).`
      : `${over}. This is one item, and google.read does not return an item in parts. A smaller form of it may fit (format "metadata" for a message's headers, a smaller range of a sheet); a Drive file is fetched whole with drive.download.`
  );
}

/** What the agent is told when gws itself failed, in terms it can act on or relay. */
function gwsError(error: unknown, service: GoogleService, command: string): Error {
  const found = gwsFailure(error);
  switch (found.kind) {
    case 'missing':
      return failure('gws_missing', gwsMissing);
    case 'too_large':
      return tooLarge(command, null);
    case 'signed_out':
      return failure(
        'google_signed_out',
        `gws has no working sign-in (${found.detail}). Ask the owner to sign in again (${gwsLogin}, with ${gwsTool.loginScope(service)} among its --scopes), then retry.`
      );
    case 'scope_missing':
      return failure(
        'google_scope_missing',
        `gws's sign-in does not grant ${service} (${found.detail}). The login must include ${gwsTool.loginScope(service)}. ${gwsLogin}, with the scopes of the Google sources that are on; if ${service} is not among them, the owner adds it to that line's --scopes list (gws auth login --scopes <those scopes>,${gwsTool.loginScope(service)}) and signs in again, then retry.`
      );
    case 'api_disabled':
      return failure(
        'google_api_disabled',
        `The ${service} API is not enabled in the Cloud project of gws's OAuth client (${found.detail}). Ask the owner to enable it${found.enableUrl === undefined ? ' in Google Cloud Console' : ` at ${found.enableUrl}`}, then retry.`
      );
    case 'quota':
      return failure(
        'google_quota',
        `Google refused gws ${command} for rate or quota (${found.detail}). Retry later, with fewer calls or smaller pages.`
      );
    case 'other':
      return failure('google_api_error', `gws ${command} failed: ${found.detail}`);
  }
}

export function googleReadActionRegistrations(ports: GoogleReadPorts): ActionRegistration[] {
  const gws = ports.gws ?? execGwsAsync;
  return [
    {
      contract: {
        name: GOOGLE_READ_ACTION,
        readsConnector: { fromInput: 'service' },
        summary:
          'Read the owner\'s Gmail, Calendar and Sheets, or a Google Doc as text, live through gws, as `gws <service> <argv…> --params <params>`, for what the stored sources do not hold. Read methods only: gmail users getProfile, users labels list, users messages list|get, users threads list|get; calendar calendarList list, events list|get; sheets spreadsheets get, spreadsheets values get; drive files export, which returns a Google Doc, Sheet or Slides file as text (mimeType text/plain, text/csv, text/html or text/markdown). Find and fetch Drive files with drive.read and drive.download. params is the method\'s --params JSON (userId "me" for Gmail). A list returns one page with its nextPageToken; pass it as pageToken for the next. A result over 100,000 characters is refused: ask for a smaller page (maxResults or pageSize, fields) or a smaller form of one item (format "metadata", a smaller range). Not in a replay. Nothing is saved as a source; tool_traces keeps a bounded, redacted excerpt of each result, as for every action.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['service', 'argv'],
          properties: {
            service: { type: 'string', enum: Object.keys(GOOGLE_READ_METHODS) },
            argv: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 1 },
              description:
                'The resource path and method after the service, as gws takes them, e.g. ["users", "messages", "list"].',
            },
            params: {
              type: 'object',
              description:
                'The method\'s URL and query parameters, as gws --params takes them, e.g. {"userId": "me", "q": "from:client newer_than:30d", "maxResults": 20}.',
            },
          },
        },
        examples: [
          {
            title: 'Mail matching a search',
            input: {
              service: 'gmail',
              argv: ['users', 'messages', 'list'],
              params: { userId: 'me', q: 'subject:estimate newer_than:90d', maxResults: 20 },
            },
          },
          {
            title: "One message's headers and snippet",
            input: {
              service: 'gmail',
              argv: ['users', 'messages', 'get'],
              params: { userId: 'me', id: 'message-id', format: 'metadata' },
            },
          },
          {
            title: 'Events in a week',
            input: {
              service: 'calendar',
              argv: ['events', 'list'],
              params: {
                calendarId: 'primary',
                timeMin: '2026-11-02T00:00:00Z',
                timeMax: '2026-11-09T00:00:00Z',
                singleEvents: true,
                orderBy: 'startTime',
              },
            },
          },
          {
            title: 'A Google Doc as text',
            input: {
              service: 'drive',
              argv: ['files', 'export'],
              params: { fileId: 'doc-id', mimeType: 'text/plain' },
            },
          },
          {
            title: 'A sheet range',
            input: {
              service: 'sheets',
              argv: ['spreadsheets', 'values', 'get'],
              params: { spreadsheetId: 'sheet-id', range: 'Sheet1!A1:F50' },
            },
          },
        ],
      },
      exec: async (input, context) => {
        // A replay reads sources only up to its window's end; Google read now is past it.
        if (context.session?.replaySourceEndMs !== undefined)
          throw failure(
            'google_read_replay',
            'google.read reads Google as it is now, and a replay turn reads sources only up to the end of its window; it is not available in a replay.',
            'denied'
          );
        const values = input as {
          service: GoogleService;
          argv: string[];
          params?: Record<string, unknown>;
        };
        const named = method(values.service, values.argv);
        const command = `${values.service} ${named}`;
        const params = values.params ?? {};
        for (const [key, notJson] of Object.entries(NOT_JSON_PARAMS)) {
          if (params[key] !== undefined && notJson(params[key]))
            throw failure(
              'google_read_media_refused',
              `google.read returns JSON or text, and ${key} ${JSON.stringify(params[key])} asks Google for another format, which gws writes to a file; leave ${key} out (a file is fetched with drive.download).`,
              'invalid_input'
            );
        }
        const exported = named === 'files export';
        // An export is always a file; it is read back from the call's own directory as text.
        if (
          exported &&
          (typeof params.mimeType !== 'string' || !params.mimeType.startsWith('text/'))
        )
          throw failure(
            'google_read_media_refused',
            `drive files export returns text here: give params.mimeType a text type (text/plain for a Doc or Slides file, text/csv for a Sheet's first sheet, text/html, text/markdown); other formats are fetched with drive.download.`,
            'invalid_input'
          );
        const args = [
          values.service,
          ...values.argv,
          ...(values.params === undefined ? [] : ['--params', JSON.stringify(params)]),
          ...(exported ? ['--output', 'export'] : []),
        ];
        mkdirSync(ports.scratchDir, { recursive: true, mode: 0o700 });
        const dir = mkdtempSync(join(ports.scratchDir, 'call-'));
        try {
          let result: unknown;
          try {
            result = await gws(args, {
              cwd: dir,
              maxBuffer: GOOGLE_READ_MAX_BUFFER,
              ...(exported ? { timeoutMs: 120_000 } : {}),
            });
          } catch (error) {
            throw gwsError(error, values.service, command);
          }
          if (exported) {
            const text = readFileSync(join(dir, 'export'), 'utf8');
            if (text.length > GOOGLE_READ_MAX_CHARS) throw tooLarge(command, text.length);
            return { mimeType: params.mimeType, characters: text.length, text };
          }
          // gws's report of a response it wrote to a file: refused, and the file goes with dir.
          if (result !== null && typeof result === 'object' && 'saved_file' in result)
            throw failure(
              'google_read_media_refused',
              `gws ${command} answered with something other than JSON, which gws wrote to a file; google.read returns JSON only, so the file was removed unread. Leave out parameters that change the format.`
            );
          const size = JSON.stringify(result ?? null).length;
          if (size > GOOGLE_READ_MAX_CHARS) throw tooLarge(command, size);
          return result;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
  ];
}

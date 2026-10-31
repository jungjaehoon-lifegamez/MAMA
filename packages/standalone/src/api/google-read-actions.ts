/**
 * google.read — the owner's Gmail, Calendar and Sheets, and Google Docs as text, read on demand
 * through gws, run by the daemon with its own sign-in (owner, 2026-10-31;
 * docs/development/work/google-read.md). The agent names the method as gws takes it; the host
 * builds the whole command, so no gws flag is an input: nothing is uploaded, sent, written to a
 * file the agent names, or dumped page after page. The allowlist is the read-only guard: the
 * sign-in carries Drive write access for deliver.drive.file, and a login made before 2026-10-31
 * may carry write access to every service. The agent's shell stays closed. Nothing is saved as a
 * source; tool_traces keeps its usual bounded, redacted summary of each call (observeCall).
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
 * code_act return meets, while a Codex turn takes the result whole. A page over it is narrowed by
 * the request, not cut: cut JSON does not parse.
 */
export const GOOGLE_READ_MAX_CHARS = 100_000;

/**
 * gws's stdout held in the daemon for one call: Node's own execFile default, stated because
 * execGwsAsync otherwise passes none, which lifts the bound. gws prints indented JSON, so this sits
 * well above the result cap.
 */
const GOOGLE_READ_MAX_BUFFER = 1024 * 1024;

const NARROW =
  'narrow the request: fields (only the parts you need), maxResults or pageSize (fewer per page, ' +
  'then pageToken for the next), format "metadata" for mail headers, or a smaller range';

export interface GoogleReadPorts {
  /** A directory only the daemon reads (under the MAMA home's runtime/), for export files. */
  scratchDir: string;
  gws?: GwsCall;
}

function failure(name: string, message: string, kind?: 'invalid_input'): Error {
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

/** The method the call names, or why it is not one google.read runs. */
function method(service: GoogleService, argv: readonly string[]): string {
  const named = argv.join(' ');
  if ((GOOGLE_READ_METHODS[service] as readonly string[]).includes(named)) return named;
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
  return failure(
    'google_read_too_large',
    `gws ${command} returned ${size === null ? 'more than the output buffer holds' : `${size} characters`}, over the ${GOOGLE_READ_MAX_CHARS} google.read returns; ${NARROW}. A whole file is fetched with drive.download.`
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
        `gws's sign-in does not grant ${service} (${found.detail}). Ask the owner to sign in again with ${gwsTool.loginScope(service)} among its --scopes (${gwsLogin}; it names the scopes of the Google sources that are on), then retry.`
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
          'Read the owner\'s Gmail, Calendar and Sheets, or a Google Doc as text, live through gws, as `gws <service> <argv…> --params <params>`, for what the stored sources do not hold. Read methods only: gmail users getProfile, users labels list, users messages list|get, users threads list|get; calendar calendarList list, events list|get; sheets spreadsheets get, spreadsheets values get; drive files export, which returns a Google Doc, Sheet or Slides file as text (mimeType text/plain, text/csv, text/html or text/markdown). Find and fetch Drive files with drive.read and drive.download. params is the method\'s --params JSON (userId "me" for Gmail). A list returns one page with its nextPageToken; pass it as pageToken for the next. A result over 100,000 characters is refused: narrow it with fields, maxResults/pageSize or a smaller range. Nothing is saved as a source; tool_traces keeps a bounded, redacted excerpt of each result, as for every action.',
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
      exec: async (input) => {
        const values = input as {
          service: GoogleService;
          argv: string[];
          params?: Record<string, unknown>;
        };
        const named = method(values.service, values.argv);
        const command = `${values.service} ${named}`;
        const params = values.params ?? {};
        // gws writes any response that is not JSON to a file (executor.rs handle_binary_response),
        // in its working directory unless --output names one; a file is drive.download's job.
        if (params.alt !== undefined && params.alt !== 'json')
          throw failure(
            'google_read_media_refused',
            `google.read returns JSON or text, and alt ${JSON.stringify(params.alt)} asks gws for the file itself; fetch a file with drive.download.`,
            'invalid_input'
          );
        const args = [
          values.service,
          ...values.argv,
          ...(values.params === undefined ? [] : ['--params', JSON.stringify(params)]),
        ];
        if (named !== 'files export') {
          let result: unknown;
          try {
            result = await gws(args, { maxBuffer: GOOGLE_READ_MAX_BUFFER });
          } catch (error) {
            throw gwsError(error, values.service, command);
          }
          const size = JSON.stringify(result ?? null).length;
          if (size > GOOGLE_READ_MAX_CHARS) throw tooLarge(command, size);
          return result;
        }
        // An export is always a file; the host names it where no agent reads, returns the text.
        if (typeof params.mimeType !== 'string' || !params.mimeType.startsWith('text/'))
          throw failure(
            'google_read_media_refused',
            `drive files export returns text here: give params.mimeType a text type (text/plain for a Doc or Slides file, text/csv for a Sheet's first sheet, text/html, text/markdown); other formats are fetched with drive.download.`,
            'invalid_input'
          );
        mkdirSync(ports.scratchDir, { recursive: true, mode: 0o700 });
        const dir = mkdtempSync(join(ports.scratchDir, 'export-'));
        try {
          const output = join(dir, 'export');
          try {
            await gws([...args, '--output', output], { timeoutMs: 120_000 });
          } catch (error) {
            throw gwsError(error, values.service, command);
          }
          const text = readFileSync(output, 'utf8');
          if (text.length > GOOGLE_READ_MAX_CHARS) throw tooLarge(command, text.length);
          return { mimeType: params.mimeType, characters: text.length, text };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
  ];
}

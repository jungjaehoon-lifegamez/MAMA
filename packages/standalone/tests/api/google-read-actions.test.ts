import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import {
  GOOGLE_READ_MAX_CHARS,
  GOOGLE_READ_METHODS,
  googleReadActionRegistrations,
} from '../../src/api/google-read-actions.js';
import { gwsMissing } from '../../src/connectors/framework/gws-utils.js';

let root: string;
let bin: string;
let scratch: string;
let log: string;
let cwdLog: string;

/**
 * A `gws` stand-in on PATH that records its argv, one argument per line, and the directory it runs
 * in, then runs `script`.
 */
function fakeGws(script: string): void {
  writeFileSync(
    join(bin, 'gws'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\npwd -P > '${cwdLog}'\n${script}\n`
  );
  chmodSync(join(bin, 'gws'), 0o755);
}

const argvRun = (): string[] | null =>
  existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : null;
/** Where the last gws ran: a directory of its own under the scratch directory. */
const ranIn = (): string => readFileSync(cwdLog, 'utf8').trim();

const access: ActionContext['access'] = {
  principalId: 'owner',
  agentId: 'agent',
  actions: ['google.read'],
  connectors: ['gmail', 'calendar', 'drive', 'sheets'],
  scopes: [],
};

const read = (input: Record<string, unknown>, session?: ActionContext['session']) =>
  createDispatcher(createCatalog(googleReadActionRegistrations({ scratchDir: scratch })))(
    { action: 'google.read', input },
    { access, ...(session === undefined ? {} : { session }) }
  );

describe('google.read', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'google-read-'));
    bin = join(root, 'bin');
    scratch = join(root, 'runtime', 'google-read');
    log = join(root, 'argv');
    cwdLog = join(root, 'cwd');
    mkdirSync(bin);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs each read method as gws <service> <argv> --params <JSON>, and nothing else', async () => {
    fakeGws(`echo '{"ok":true}'`);
    for (const [service, methods] of Object.entries(GOOGLE_READ_METHODS)) {
      for (const method of methods) {
        if (method === 'files export') continue;
        const argv = method.split(' ');
        const result = await read({ service, argv, params: { userId: 'me' } });
        expect(result, `${service} ${method}`).toMatchObject({
          status: 'completed',
          data: { ok: true },
        });
        expect(argvRun()).toEqual([service, ...argv, '--params', '{"userId":"me"}']);
        expect(ranIn().startsWith(`${realpathSync(scratch)}/call-`)).toBe(true);
        expect(readdirSync(scratch)).toEqual([]);
      }
    }
    // Without params the host passes no --params either.
    await read({ service: 'calendar', argv: ['calendarList', 'list'] });
    expect(argvRun()).toEqual(['calendar', 'calendarList', 'list']);
  });

  it.each([
    ['gmail', ['users', 'messages', 'send']],
    ['gmail', ['users', 'drafts', 'create']],
    ['gmail', ['users', 'messages', 'trash']],
    ['calendar', ['events', 'insert']],
    ['calendar', ['events', 'delete']],
    ['sheets', ['spreadsheets', 'values', 'update']],
    ['drive', ['files', 'create']],
    ['drive', ['permissions', 'create']],
    // Drive's listing and file reads are drive.read and drive.download.
    ['drive', ['files', 'list']],
    ['drive', ['files', 'get']],
    ['gmail', ['users', 'nothing']],
  ])('refuses %s %j before gws runs, naming the allowed set', async (service, argv) => {
    fakeGws(`echo '{"ok":true}'`);
    const result = await read({ service, argv, params: {} });
    expect(result).toMatchObject({
      status: 'failed',
      error: { kind: 'invalid_input', code: 'google_method_not_allowed' },
    });
    const { message } = (result as { error: { message: string } }).error;
    expect(message).toContain(`gws ${service} ${argv.join(' ')} is not one`);
    expect(message).toContain('Allowed: gmail: users getProfile, users labels list');
    expect(message).toContain('drive: files export');
    expect(argvRun()).toBeNull();
  });

  it.each([
    [['users', 'messages', '--output']],
    [['users', 'messages', '--upload']],
    [['users', '--page-all']],
    [['+triage']],
  ])('says why flags and helpers are not taken: %j', async (argv) => {
    fakeGws(`echo '{"ok":true}'`);
    const result = await read({ service: 'gmail', argv });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'google_method_not_allowed' },
    });
    expect((result as { error: { message: string } }).error.message).toContain(
      'is not taken. Parameters go in params; the host adds --params itself'
    );
    expect(argvRun()).toBeNull();
  });

  it('refuses the parameters that ask Google for something other than JSON', async () => {
    fakeGws(`echo '{"ok":true}'`);
    for (const extra of [
      { alt: 'media' },
      { alt: 'proto' },
      { $alt: 'media' },
      // JSONP whatever the function is called, "json" included.
      { callback: 'f' },
      { callback: 'json' },
      { $callback: 'f' },
    ]) {
      expect(
        await read({
          service: 'gmail',
          argv: ['users', 'threads', 'get'],
          params: { userId: 'me', id: 't1', ...extra },
        }),
        JSON.stringify(extra)
      ).toMatchObject({
        status: 'failed',
        error: { kind: 'invalid_input', code: 'google_read_media_refused' },
      });
    }
    expect(argvRun()).toBeNull();
    expect(
      await read({
        service: 'gmail',
        argv: ['users', 'messages', 'get'],
        params: { userId: 'me', id: 'm1', alt: 'json' },
      })
    ).toMatchObject({ status: 'completed' });
  });

  it('exports a Google Doc as text through a file the host names, then removes it', async () => {
    fakeGws(
      [
        'out=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done',
        `printf 'Spec v3\\nThe client asked for blue.' > "$out"`,
        `echo '{"status":"success","saved_file":"x","bytes":31}'`,
      ].join('\n')
    );
    const result = await read({
      service: 'drive',
      argv: ['files', 'export'],
      params: { fileId: 'doc1', mimeType: 'text/plain' },
    });
    expect(result).toEqual({
      status: 'completed',
      data: {
        mimeType: 'text/plain',
        characters: 34,
        text: 'Spec v3\nThe client asked for blue.',
      },
    });
    const args = argvRun()!;
    expect(args.slice(0, 5)).toEqual([
      'drive',
      'files',
      'export',
      '--params',
      '{"fileId":"doc1","mimeType":"text/plain"}',
    ]);
    // Relative to the call's own directory, not to wherever the daemon runs.
    expect(args.slice(5)).toEqual(['--output', 'export']);
    expect(ranIn().startsWith(`${realpathSync(scratch)}/call-`)).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('refuses a response gws wrote to a file, and removes the file unread', async () => {
    // gws's handle_binary_response for a parameter that changes the format: the body goes to
    // download.<ext> in its working directory and stdout carries only where it went.
    fakeGws(
      [
        `printf 'the whole thread' > download.js`,
        `echo '{"status":"success","saved_file":"download.js","mimeType":"text/javascript","bytes":16}'`,
      ].join('\n')
    );
    const result = await read({
      service: 'gmail',
      argv: ['users', 'threads', 'get'],
      params: { userId: 'me', id: 't1', unforeseen: 'x' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'google_read_media_refused' },
    });
    expect(JSON.stringify(result)).not.toContain('the whole thread');
    expect(ranIn().startsWith(`${realpathSync(scratch)}/call-`)).toBe(true);
    expect(existsSync(join(ranIn(), 'download.js'))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
    expect(existsSync(join(process.cwd(), 'download.js'))).toBe(false);
  });

  it('takes argv token by token: one argument holding a whole method is refused', async () => {
    fakeGws(`echo '{"ok":true}'`);
    expect(
      await read({ service: 'gmail', argv: ['users messages list'], params: { userId: 'me' } })
    ).toMatchObject({ status: 'failed', error: { code: 'google_method_not_allowed' } });
    expect(argvRun()).toBeNull();
  });

  it('is not available in a replay, which reads sources only up to its window', async () => {
    fakeGws(`echo '{"ok":true}'`);
    expect(
      await read(
        { service: 'gmail', argv: ['users', 'messages', 'list'], params: { userId: 'me' } },
        { replaySourceEndMs: Date.parse('2026-09-30T00:00:00Z') }
      )
    ).toMatchObject({ status: 'failed', error: { kind: 'denied', code: 'google_read_replay' } });
    expect(argvRun()).toBeNull();
  });

  it('refuses an export to a format that is not text', async () => {
    fakeGws(`echo '{"ok":true}'`);
    for (const params of [{ fileId: 'doc1', mimeType: 'application/pdf' }, { fileId: 'doc1' }]) {
      expect(await read({ service: 'drive', argv: ['files', 'export'], params })).toMatchObject({
        status: 'failed',
        error: { kind: 'invalid_input', code: 'google_read_media_refused' },
      });
    }
    expect(argvRun()).toBeNull();
  });

  it('refuses a result over the cap with how to narrow it, and never cuts one', async () => {
    const big = join(root, 'big.json');
    writeFileSync(big, JSON.stringify({ messages: 'a'.repeat(GOOGLE_READ_MAX_CHARS) }));
    fakeGws(`cat '${big}'`);
    const page = await read({ service: 'gmail', argv: ['users', 'messages', 'list'] });
    expect(page).toMatchObject({ status: 'failed', error: { code: 'google_read_too_large' } });
    const { message } = (page as { error: { message: string } }).error;
    expect(message).toContain(`${GOOGLE_READ_MAX_CHARS + 15} characters, over the 100000`);
    expect(message).toContain('fields');
    expect(message).toContain('pageToken');

    // One item cannot be paged; the refusal says so instead of promising that fields helps.
    const item = await read({
      service: 'gmail',
      argv: ['users', 'messages', 'get'],
      params: { userId: 'me', id: 'm1' },
    });
    const single = (item as { error: { message: string } }).error.message;
    expect(single).toContain('google.read does not return an item in parts');
    expect(single).toContain('format "metadata"');
    expect(single).not.toContain('fields');
    expect(single).not.toContain('pageToken');

    // Past the 1 MiB output buffer gws is stopped, with the same refusal.
    writeFileSync(big, JSON.stringify({ messages: 'a'.repeat(1_200_000) }));
    expect(await read({ service: 'gmail', argv: ['users', 'messages', 'list'] })).toMatchObject({
      status: 'failed',
      error: {
        code: 'google_read_too_large',
        message: expect.stringContaining('more than the output buffer holds'),
      },
    });

    // An export over the cap is refused too, and its file does not stay.
    fakeGws(
      [
        'out=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done',
        `cat '${big}' > "$out"`,
        `echo '{"status":"success"}'`,
      ].join('\n')
    );
    expect(
      await read({
        service: 'drive',
        argv: ['files', 'export'],
        params: { fileId: 'doc1', mimeType: 'text/plain' },
      })
    ).toMatchObject({ status: 'failed', error: { code: 'google_read_too_large' } });
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('names gws missing from the service PATH', async () => {
    vi.stubEnv('PATH', `${join(root, 'empty')}:/usr/bin:/bin`);
    expect(await read({ service: 'gmail', argv: ['users', 'getProfile'] })).toMatchObject({
      status: 'failed',
      error: { code: 'gws_missing', message: gwsMissing },
    });
  });

  it.each([
    [
      'no sign-in',
      'calendar',
      '{"error":{"code":401,"message":"No credentials found","reason":"authError"}}',
      2,
      'google_signed_out',
      'Ask the owner to sign in again (mama doctor names the gws auth login command for this install',
    ],
    [
      'a sign-in without the service',
      'calendar',
      '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","reason":"insufficientPermissions"}}',
      1,
      'google_scope_missing',
      "The login must include https://www.googleapis.com/auth/calendar.readonly. mama doctor names the gws auth login command for this install, with the scopes of the Google sources that are on; if calendar is not among them, the owner adds it to that line's --scopes list (gws auth login --scopes <those scopes>,https://www.googleapis.com/auth/calendar.readonly)",
    ],
    [
      'an API the Cloud project has not enabled',
      'sheets',
      '{"error":{"code":403,"message":"Sheets API has not been used","reason":"accessNotConfigured","enable_url":"https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1"}}',
      1,
      'google_api_disabled',
      'enable it at https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1',
    ],
    [
      // Sheets v4 answers in the newer shape (status, details; no errors[]), so gws finds no reason.
      'a Sheets sign-in without Sheets',
      'sheets',
      '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","reason":"unknown"}}',
      1,
      'google_scope_missing',
      'The login must include https://www.googleapis.com/auth/spreadsheets.readonly.',
    ],
    [
      'Sheets not enabled in the Cloud project',
      'sheets',
      '{"error":{"code":403,"message":"Google Sheets API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123 then retry.","reason":"unknown"}}',
      1,
      'google_api_disabled',
      'enable it at https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123, then retry',
    ],
    [
      'a rate limit',
      'gmail',
      '{"error":{"code":429,"message":"Too many requests","reason":"rateLimitExceeded"}}',
      1,
      'google_quota',
      'Retry later, with fewer calls or smaller pages',
    ],
    [
      'a per-user quota',
      'gmail',
      '{"error":{"code":403,"message":"User rate limit exceeded","reason":"userRateLimitExceeded"}}',
      1,
      'google_quota',
      'for rate or quota',
    ],
    [
      'anything else',
      'gmail',
      '{"error":{"code":404,"message":"Requested entity was not found.","reason":"notFound"}}',
      1,
      'google_api_error',
      'failed: gws CLI returned an error: {"code":404',
    ],
  ])('maps %s to %s', async (_case, service, printed, exit, code, says) => {
    fakeGws(`echo '${printed}'\nexit ${exit}`);
    const argv = GOOGLE_READ_METHODS[service as 'gmail'][0]!.split(' ');
    const result = await read({ service, argv, params: {} });
    expect(result).toMatchObject({ status: 'failed', error: { code } });
    expect((result as { error: { message: string } }).error.message).toContain(says);
  });
});

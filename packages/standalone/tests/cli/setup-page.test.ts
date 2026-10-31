/**
 * The setup page (src/cli/runtime/setup-page.ts) on a real loopback socket. No browser opens: the
 * opener is a stand-in that records its arguments, and the test reads the redirect file as the
 * browser would. Requests go over a raw socket, so the Host header is exactly what the test says.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { CliInputError } from '../../src/cli/prompt.js';
import {
  openSetupPage,
  type SetupField,
  type SetupPage,
} from '../../src/cli/runtime/setup-page.js';

const TOKEN = 'fixture-page-token';

interface Opened {
  page: SetupPage;
  lines: string[];
  opened: string[][];
  file: string;
  url: URL;
}

let open: Opened | undefined;
afterEach(() => {
  open?.page.close();
  open = undefined;
});

/** A field whose check refuses `refused` and takes anything else, recording what it was given. */
function field(name: string, secret: boolean, refused: string, seen: string[]): SetupField {
  return {
    name,
    label: `The ${name}`,
    secret,
    check: async (value) => {
      seen.push(value);
      if (value === refused) throw new CliInputError(`${name} refused; try another`);
      return `${name} taken`;
    },
  };
}

async function serve(
  fields: SetupField[],
  options: { lifetimeMs?: number; exit?: Promise<number> } = {}
): Promise<Opened> {
  const lines: string[] = [];
  const opened: string[][] = [];
  const page = await openSetupPage({
    fields,
    write: (line) => lines.push(line),
    platform: 'darwin',
    openRun: async (command, args) => {
      opened.push([command, ...args]);
      return { exit: options.exit ?? Promise.resolve(0) };
    },
    ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
  });
  const file = opened[0]![1]!;
  const url = new URL(/url=(http[^"]+)"/.exec(readFileSync(file, 'utf8'))![1]!);
  open = { page, lines, opened, file, url };
  return open;
}

/** One HTTP/1.1 request as written, over its own connection. */
function request(
  url: URL,
  options: { method?: string; path?: string; host?: string[]; body?: string } = {}
): Promise<{ status: number; head: string; body: string }> {
  const body = options.body ?? '';
  const text = [
    `${options.method ?? 'GET'} ${options.path ?? url.pathname} HTTP/1.1`,
    ...(options.host ?? [url.host]).map((host) => `Host: ${host}`),
    'Connection: close',
    ...(options.method === 'POST'
      ? ['Content-Type: application/x-www-form-urlencoded', `Content-Length: ${body.length}`]
      : []),
    '',
    body,
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.on('data', (chunk) => (out += chunk));
    socket.on('end', () => {
      const at = out.indexOf('\r\n\r\n');
      resolve({
        status: Number(out.split(' ')[1]),
        head: out.slice(0, at),
        body: out.slice(at + 4),
      });
    });
    socket.on('error', reject);
  });
}

const post = (url: URL, name: string, value: string) =>
  request(url, {
    method: 'POST',
    body: new URLSearchParams({ [name]: value }).toString(),
  });

describe('the setup page', () => {
  it('takes each field in order, shows a refusal with the form again, and stops after the last', async () => {
    const seen: string[] = [];
    const { url, lines } = await serve([
      field('token', true, 'wrong-token', seen),
      field('code', false, '000000', seen),
    ]);
    const first = await request(url);
    expect(first.status).toBe(200);
    // A plain text box: no password manager offers to keep a bot token.
    expect(first.body).toContain('name="token" type="text" autocomplete="off"');
    expect(first.body).toContain('spellcheck="false"');
    expect(first.body).not.toContain('type="password"');
    expect(first.head).toMatch(/^Cache-Control: no-store$/im);
    expect(first.head).toMatch(/^Referrer-Policy: no-referrer$/im);
    // Nothing is loaded from anywhere else.
    expect(first.body).not.toMatch(/<(script|link|img|iframe)\b|src=|https?:\/\//i);

    const refused = await post(url, 'token', 'wrong-token');
    expect(refused.status).toBe(200);
    expect(refused.body).toContain('token refused; try another');
    expect(refused.body).toContain('name="token"');
    const taken = await post(url, 'token', TOKEN);
    expect(taken.body).toContain('token taken');
    expect(taken.body).toContain('name="code" type="text"');
    // A reload shows the current field.
    expect((await request(url)).body).toContain('name="code"');

    expect((await post(url, 'code', '000000')).body).toContain('code refused');
    const done = await post(url, 'code', '123456');
    expect(done.body).toContain('code taken');
    expect(done.body).not.toContain('<form');
    expect(seen).toEqual(['wrong-token', TOKEN, '000000', '123456']);
    // One value per field: once the last is taken the page is gone.
    await expect(post(url, 'code', '654321')).rejects.toThrow(/ECONNREFUSED/);
    expect(seen).toHaveLength(4);
    expect(lines.at(-1)).toBe('setup page closed');
  });

  it('answers only its own path, by GET or POST', async () => {
    const seen: string[] = [];
    const { url } = await serve([field('token', true, '', seen)]);
    expect((await request(url, { path: `/${'A'.repeat(43)}` })).status).toBe(404);
    expect((await request(url, { path: '/' })).status).toBe(404);
    // A token sent in a URL goes into history and logs; it is not taken.
    const query = await request(url, { path: `${url.pathname}?token=${TOKEN}` });
    expect(query.status).toBe(404);
    expect((await request(url, { method: 'PUT' })).status).toBe(405);
    expect(seen).toEqual([]);
  });

  it('is served at localhost on any port, and refuses another name or two Host headers', async () => {
    const { url } = await serve([field('token', true, '', [])]);
    // An SSH forward reaches it through another local port.
    for (const host of ['localhost:2222', '127.0.0.1', `[::1]:${url.port}`])
      expect((await request(url, { host: [host] })).status, host).toBe(200);
    // A rebinding site sends its own name.
    expect((await request(url, { host: [`evil.test:${url.port}`] })).status).toBe(421);
    expect((await request(url, { host: [url.host, 'evil.test'] })).status).toBe(421);
    expect((await request(url, { host: [url.host, url.host] })).status).toBe(421);
  });

  it('keeps its URL in a 0600 file in a 0700 folder, and nowhere else', async () => {
    const { url, file, opened, lines } = await serve([field('token', true, '', [])]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    // The opener gets the file's path only.
    expect(opened).toEqual([['open', file]]);
    expect(lines).toEqual([expect.stringMatching(/^setup page: opened in the browser from /)]);
    expect(lines[0]).toContain(`from ${file}; it closes at `);
    const nonce = url.pathname.slice(1);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const text of [...lines, ...opened.flat()]) expect(text.includes(nonce)).toBe(false);
  });

  it('names the file to open when the opener fails, at once or later', async () => {
    let exited!: (status: number) => void;
    const { file, lines } = await serve([field('token', true, '', [])], {
      exit: new Promise((resolve) => (exited = resolve)),
    });
    exited(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines).toEqual([
      `setup page: opened in the browser from ${file}; it closes at ${lines[0]!.slice(-5)}`,
      expect.stringMatching(
        new RegExp(
          `^setup page: open exited 1, so the browser may not have opened; open file://${file} in the browser; it closes at \\d\\d:\\d\\d$`
        )
      ),
    ]);
    open?.page.close();
    // An opener that cannot start (none installed) is named the same way.
    const missing: string[] = [];
    const page = await openSetupPage({
      fields: [field('token', true, '', [])],
      write: (line) => missing.push(line),
      platform: 'linux',
      openRun: async () => {
        throw Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
      },
    });
    page.close();
    expect(missing[0]).toMatch(
      /^setup page: the browser did not open \(xdg-open is not installed\); open file:\/\/.+\/open\.html in the browser; it closes at \d\d:\d\d$/
    );
  });

  it('takes entries while an opener stays in the foreground', async () => {
    // xdg-open without a desktop runs the browser itself until it quits.
    const seen: string[] = [];
    const { url, lines } = await serve([field('token', true, '', seen)], {
      exit: new Promise(() => {}),
    });
    expect(lines[0]).toMatch(/^setup page: opened in the browser from /);
    expect((await post(url, 'token', TOKEN)).body).toContain('token taken');
    expect(seen).toEqual([TOKEN]);
  });

  it.each([
    ['half a request line', () => 'GET /half'],
    [
      'headers that never end',
      (url: URL) => `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n`,
    ],
    [
      'a body that never comes',
      (url: URL) =>
        `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 50\r\n\r\ntok`,
    ],
  ])('drops a connection holding %s when it closes, so setup can exit', async (_label, text) => {
    const { page, url } = await serve([field('token', true, '', [])]);
    const socket: Socket = connect(Number(url.port), '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(text(url));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dropped = new Promise((resolve) => socket.once('close', resolve));
    page.close();
    await dropped;
  });

  it('keeps the page when a client goes away in the middle of its entry', async () => {
    const seen: string[] = [];
    const { page, url } = await serve([field('token', true, '', seen)]);
    let stopped = false;
    page.stopped.catch(() => (stopped = true));
    const socket = connect(Number(url.port), '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 50\r\n\r\ntoken=`
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect((await post(url, 'token', TOKEN)).body).toContain('token taken');
    expect(seen).toEqual([TOKEN]);
  });

  it('answers an entry the setup stopped during with its sentence and no form', async () => {
    let release!: () => void;
    const { page, url } = await serve([
      {
        name: 'token',
        label: 'The token',
        secret: true,
        check: () =>
          new Promise<string>((_resolve, reject) => {
            release = () => reject(new CliInputError('fixture: the setup stopped'));
          }),
      },
    ]);
    const reply = post(url, 'token', TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    page.close();
    release();
    const { body } = await reply;
    expect(body).toContain('fixture: the setup stopped');
    expect(body).toContain('This page has closed.');
    expect(body).not.toContain('<form');
  });

  it('never shows or prints an entered value', async () => {
    const { url, lines } = await serve([
      field('token', true, TOKEN, []),
      field('code', false, '', []),
    ]);
    const refused = await post(url, 'token', TOKEN);
    const taken = await post(url, 'token', `${TOKEN}-2`);
    for (const text of [refused.body, taken.body, ...lines]) expect(text).not.toContain(TOKEN);
  });

  it('stops at the end of its lifetime, removing the redirect file', async () => {
    const { page, file, lines } = await serve([field('token', true, '', [])], { lifetimeMs: 30 });
    await expect(page.stopped).rejects.toThrow(
      /^the setup page expired at \d\d:\d\d; nothing was written$/
    );
    expect(existsSync(dirname(file))).toBe(false);
    expect(lines.at(-1)).toBe('setup page closed');
  });

  it('takes one entry at a time while a check runs', async () => {
    let release!: () => void;
    const { url } = await serve([
      {
        name: 'code',
        label: 'The code',
        secret: false,
        check: () =>
          new Promise<string>((resolve) => {
            release = () => resolve('taken');
          }),
      },
    ]);
    const first = post(url, 'code', '111111');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await post(url, 'code', '222222')).status).toBe(409);
    release();
    expect((await first).body).toContain('taken');
  });

  it('stops with an unexpected error a check throws', async () => {
    const { page, url } = await serve([
      {
        name: 'token',
        label: 'The token',
        secret: true,
        check: async () => {
          throw new TypeError('fixture failure');
        },
      },
    ]);
    expect((await post(url, 'token', TOKEN)).status).toBe(500);
    await expect(page.stopped).rejects.toThrow('fixture failure');
  });
});

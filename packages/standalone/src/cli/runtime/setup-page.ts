import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAllowedHost } from '../../api/viewer-request-security.js';
import { CliInputError } from '../prompt.js';

/**
 * The setup page (install.md, W2.4.5b): a page on this machine, served by the running command,
 * where the person enters what must not pass through the conversation or a command line, one
 * named field after another. It listens on 127.0.0.1 at a path of 32 random bytes. Loopback is
 * shared by every account on the machine and `ps` shows every process's arguments, so the URL
 * goes only into a redirect file this account alone can read, which the browser opens: it is
 * never printed and never an argument.
 */

/** As long as /bind's wait (telegram-pairing.ts) and Codex's device code. */
export const SETUP_PAGE_MS = 15 * 60_000;

/** One form holds one field; the page reads a body into memory, and a larger one is not a form. */
const BODY_LIMIT = 16 * 1024;

export interface SetupField {
  /** The form field's name. */
  readonly name: string;
  /** What the page asks for. */
  readonly label: string;
  /** Typed into a password box. No field's value is shown back or printed either way. */
  readonly secret: boolean;
  /**
   * Takes the entered value. It resolves with what the page says once the value is taken, or
   * rejects with a CliInputError whose sentence the page shows above the same form again.
   */
  check(value: string): Promise<string>;
}

/** Runs the browser opener and resolves with its exit status; tests replace it. */
export type OpenRun = (command: string, args: string[]) => Promise<number>;

export const defaultOpenRun: OpenRun = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });

export interface SetupPage {
  /**
   * Rejects when the page stops before every field is taken: at the end of its lifetime with the
   * expiry sentence, or with a check's unexpected error. It never resolves.
   */
  readonly stopped: Promise<never>;
  /** Stops the server and removes the redirect file's folder; a second call does nothing. */
  close(): void;
}

/** HH:MM on this machine's clock, as the person reads it. */
function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** The whole page, with nothing loaded from anywhere else. */
function html(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAMA setup</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f1f1f; background: #fff; }
input { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem; margin: 0.25rem 0 0.75rem; }
button { font: inherit; padding: 0.5rem 1rem; }
.refused { color: #a40000; }
</style>
</head>
<body>
<h1>MAMA setup</h1>
${body}
</body>
</html>
`;
}

/** The body as text, or undefined past BODY_LIMIT; a larger body is read through and dropped. */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > BODY_LIMIT ? undefined : Buffer.concat(chunks).toString('utf8'))
    );
    req.on('error', reject);
  });
}

/**
 * Serve the page for `fields`, in order, and open it in the browser. Each field is taken once its
 * check accepts it; after the last, the page shows what that check said and stops.
 */
export async function openSetupPage(options: {
  fields: readonly SetupField[];
  write: (line: string) => void;
  platform: NodeJS.Platform;
  openRun?: OpenRun;
  lifetimeMs?: number;
}): Promise<SetupPage> {
  const { fields, write } = options;
  const nonce = randomBytes(32).toString('base64url');
  const path = Buffer.from(`/${nonce}`);
  const lifetimeMs = options.lifetimeMs ?? SETUP_PAGE_MS;
  const deadline = Date.now() + lifetimeMs;
  const until = clock(deadline);
  let index = 0;
  /** What the page said when the last field was taken, shown above the next one. */
  let notice: string | undefined;
  let checking = false;
  let closed = false;
  let folder: string | undefined;
  let stop!: (error: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = reject;
  });
  // The caller awaits it while it waits on the page; once nothing does, a stop is no unhandled
  // rejection.
  stopped.catch(() => {});

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    write('setup page closed');
  };

  const form = (field: SetupField, said: string | undefined, refusal?: string) =>
    html(
      [
        said === undefined ? '' : `<p>${escape(said)}</p>`,
        refusal === undefined ? '' : `<p class="refused" role="alert">${escape(refusal)}</p>`,
        '<form method="post" autocomplete="off">',
        `<label for="${escape(field.name)}">${escape(field.label)}</label>`,
        `<input id="${escape(field.name)}" name="${escape(field.name)}" type="${field.secret ? 'password' : 'text'}" required autofocus spellcheck="false" autocapitalize="off">`,
        '<button type="submit">Continue</button>',
        '</form>',
        `<p>This page closes at ${until}.</p>`,
      ]
        .filter(Boolean)
        .join('\n')
    );

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {}
  ) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      // The browser keeps no copy once the server stops, and tells no other host the URL.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
      ...headers,
    });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // A rebinding site sends its own name; an SSH forward on another local port still works.
    if (!isAllowedHost(req))
      return send(res, 421, html('<p>This page answers only at 127.0.0.1 or localhost.</p>'));
    // The nonce is what keeps other accounts on this machine out, so it is compared in constant
    // time. A GET with a query is another path: nothing entered in a URL is taken.
    const requested = Buffer.from(req.url ?? '');
    if (closed || requested.length !== path.length || !timingSafeEqual(requested, path))
      return send(res, 404, html('<p>Not found.</p>'));
    const field = fields[index]!;
    if (req.method === 'GET') return send(res, 200, form(field, notice));
    if (req.method !== 'POST')
      return send(res, 405, html('<p>Not allowed.</p>'), { Allow: 'GET, POST' });
    // A check can take seconds (the pairing code's answer waits for the bot's poll); a second
    // submission meanwhile would answer a question nobody asks.
    if (checking)
      return send(
        res,
        409,
        form(field, notice, 'The last entry is still being checked; wait for its answer.')
      );
    checking = true;
    try {
      const body = await readBody(req);
      if (body === undefined)
        return send(res, 413, form(field, notice, 'That entry is too long for this page.'));
      let said: string;
      try {
        said = await field.check(new URLSearchParams(body).get(field.name) ?? '');
      } catch (error) {
        if (!(error instanceof CliInputError)) throw error;
        return send(res, 200, form(field, notice, error.message));
      }
      index += 1;
      notice = said;
      if (index < fields.length) return send(res, 200, form(fields[index]!, said));
      // One value per field, then the page stops: a later submission cannot change one.
      send(res, 200, html(`<p>${escape(said)}</p>`));
      close();
    } finally {
      checking = false;
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent)
        send(res, 500, html("<p>Setup stopped; the command's output says why.</p>"));
      close();
      stop(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    throw new CliInputError(
      `The setup page could not listen on 127.0.0.1 (${error.code ?? error.message}); a sandbox may forbid it. Let this command listen on localhost, or run it outside the sandbox.`
    );
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${nonce}`;
  let file: string;
  try {
    // mkdtemp makes the folder 0700 for this account; the file is 0600 in it.
    folder = mkdtempSync(join(tmpdir(), 'mama-setup-'));
    file = join(folder, 'open.html');
    writeFileSync(
      file,
      `<!doctype html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<meta http-equiv="refresh" content="0;url=${url}">\n<title>MAMA setup</title>\n<p><a href="${url}">Open the MAMA setup page</a></p>\n`,
      { flag: 'wx', mode: 0o600 }
    );
  } catch (error) {
    server.close();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  // A forgotten setup does not keep a page that takes a secret. Nothing calls close() before this
  // line runs: a request is handled only once this function awaits the opener.
  const timer = setTimeout(() => {
    close();
    stop(new CliInputError(`the setup page expired at ${until}; nothing was written`));
  }, lifetimeMs);

  const command = options.platform === 'darwin' ? 'open' : 'xdg-open';
  let failure: string | undefined;
  try {
    const status = await (options.openRun ?? defaultOpenRun)(command, [file]);
    if (status !== 0) failure = `${command} exited ${status}`;
  } catch (error) {
    failure =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${command} is not installed`
        : `${command} failed: ${(error as Error).message}`;
  }
  // The file's path holds no secret: it is the way in when no browser opened.
  write(
    failure === undefined
      ? `setup page: opened in the browser from ${file}; it closes at ${until}`
      : `setup page: the browser did not open (${failure}); open ${pathToFileURL(file).href} in the browser; it closes at ${until}`
  );
  return { stopped, close };
}

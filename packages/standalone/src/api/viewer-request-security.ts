import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { redactTraceText } from '@jungjaehoon/mama-core/runtime/trace-summary';
import {
  isTunnelRequest,
  type ViewerIdentity,
  type ViewerAuthObservation,
} from './auth-middleware.js';
import type { SecurityEvent, SecurityEventClass } from './security-events.js';

function hostname(authority: string): string | null {
  if (!authority || authority.length > 260 || /[\s\\/@?#,%]/.test(authority)) return null;
  const match = authority.startsWith('[')
    ? authority.match(/^(\[[0-9a-fA-F:]+\])(?::([0-9]+))?$/)
    : authority.match(/^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/);
  if (!match) return null;
  const port = match[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const host = match[1]!;
  if (host.startsWith('[')) {
    if (isIP(host.slice(1, -1)) !== 6) return null;
    return new URL(`http://${host}`).hostname;
  }
  const canonical = host.toLowerCase().replace(/\.$/, '');
  if (
    canonical.length > 253 ||
    canonical.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  // Do not let URL's legacy numeric IPv4 normalization turn attacker input into loopback.
  return canonical;
}

/**
 * DNS rebinding can reach the loopback socket: one Host header, naming localhost, 127.0.0.1 or
 * [::1] on any port, or one of `configured`. The viewer configures its tunnel's names; the setup
 * page none.
 */
export function isAllowedHost(req: IncomingMessage, configured: readonly string[] = []): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  if (
    req.rawHeaders?.filter(
      (_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'host'
    ).length > 1
  )
    return false;
  const requested = hostname(host);
  if (requested === null) return false;
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const value of configured) {
    const name = hostname(value.trim());
    if (name !== null) allowed.add(name);
  }
  return allowed.has(requested);
}

/** Host must be approved before local auth. */
export function isAllowedViewerHost(req: IncomingMessage): boolean {
  return isAllowedHost(req, (process.env.MAMA_VIEWER_HOSTNAMES ?? '').split(','));
}

/**
 * A page of another origin made the owner's browser send this request: a link, or a page granted
 * loopback access. Browsers set Sec-Fetch-Site and a page cannot. `same-site` is another port on
 * this loopback host or a sibling of the tunnel's name, so it is another page too; the viewer's own
 * page sends `same-origin`, the address bar `none`, and curl and Node nothing.
 */
export function isOtherPageRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

function configuredValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        value &&
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|AUTH_KEY|AUTHORIZATION|ISSUER|HOSTNAME|HOSTNAMES|API_HOST|OWNER_EMAILS)$/i.test(
          name
        )
    )
    .flatMap(([, value]) =>
      value!
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
    .sort((left, right) => right.length - left.length);
}

function auditField(value: string, limit = 256): string {
  let safe = value;
  for (const configured of configuredValues()) {
    safe = safe.split(configured).join('[redacted]');
    safe = safe.split(encodeURIComponent(configured)).join('[redacted]');
  }
  return Array.from(redactTraceText(safe), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? '_' : character;
  })
    .join('')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, limit);
}

function auditPath(req: IncomingMessage): string {
  const target = req.url ?? '/';
  try {
    const path = new URL(target, 'http://localhost').pathname;
    // A path may contain an encoded credential; decode only for redaction, never routing.
    let decoded = decodeURIComponent(path);
    // Request-supplied credentials may also be copied into the URL by a scanner.
    for (const name of [
      'authorization',
      'cf-access-jwt-assertion',
      'cf-access-authenticated-user-email',
      'host',
    ]) {
      const value = req.headers[name];
      if (typeof value === 'string' && value) {
        decoded = decoded.split(value).join('[redacted]');
        if (name === 'authorization' && value.startsWith('Bearer '))
          decoded = decoded.split(value.slice(7)).join('[redacted]');
      }
    }
    return auditField(decoded.replace(/[^/\s@]+@[^/\s@]+/g, '[email]'));
  } catch {
    return '[invalid-path]';
  }
}

// Scanner fingerprints: common secret-file and admin-console probes, not a routing policy.
const SCANNER_PATHS = [
  '/.env',
  '/.git',
  '/wp-login.php',
  '/phpmyadmin',
  '/.aws',
  '/config',
  '/server-status',
  '/mama-memory.db',
];

function securityClass(
  req: IncomingMessage,
  status: number,
  audit: ViewerAuthObservation & { identity: ViewerIdentity | null },
  path: string
): SecurityEventClass {
  if (status === 421) return 'host_rejected';
  // The other 403 is a denied action, and such a request is refused before any action runs.
  if (status === 403 && isOtherPageRequest(req)) return 'cross_origin';
  const lower = path.toLowerCase();
  if (SCANNER_PATHS.some((probe) => lower === probe || lower.startsWith(probe + '/')))
    return 'probe';
  if (
    Object.keys(req.headers).some((name) => name.startsWith('cf-access-')) &&
    !audit.accessVerified
  )
    return 'forged_access_header';
  if (audit.unknownIdentity) return 'unknown_identity';
  if (audit.identity === null || audit.identity === 'local') {
    // Unauthenticated assets served on purpose (the web manifest, static viewer files) are fetched by
    // browsers without cookies; only a refused request is a failed authentication.
    if (status === 401 || status === 403) return 'auth_failed';
    return status < 400 ? 'public_asset' : 'request_failed';
  }
  if (status >= 200 && status < 400) return 'owner_access';
  return 'request_failed';
}

export function viewerRequestAudit(
  req: IncomingMessage,
  res: ServerResponse,
  record: (event: SecurityEvent) => void
): ViewerAuthObservation & {
  identity: ViewerIdentity | null;
  log: () => void;
} {
  let logged = false;
  const audit = {
    identity: null as ViewerIdentity | null,
    accessVerified: false,
    unknownIdentity: false,
    log() {
      if (logged || (!isTunnelRequest(req) && ![401, 403, 421].includes(res.statusCode))) return;
      logged = true;
      const ray = req.headers['cf-ray'];
      const country = req.headers['cf-ipcountry'];
      const path = auditPath(req);
      const event: SecurityEvent = {
        time: new Date().toISOString(),
        class: securityClass(req, res.statusCode, audit, path),
        method: [
          'GET',
          'HEAD',
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          'OPTIONS',
          'TRACE',
          'CONNECT',
        ].includes(req.method ?? '')
          ? req.method!
          : 'UNKNOWN',
        path,
        status: res.statusCode,
        cfRay:
          typeof ray !== 'string'
            ? null
            : /^[a-fA-F0-9]{16,32}(?:-[A-Z]{3,8})?$/.test(ray)
              ? auditField(ray)
              : '[invalid]',
        ...(country === undefined
          ? {}
          : {
              country:
                typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : '[invalid]',
            }),
        identity: audit.identity === 'local' ? 'anonymous' : (audit.identity ?? 'anonymous'),
      };
      console.info(`[viewer] ${JSON.stringify(event)}`);
      record(event);
    },
  };
  res.once('finish', audit.log);
  res.once('close', audit.log);
  return audit;
}

/** Error messages and stacks can contain secrets or deployment URLs; emit diagnostic metadata. */
export function logViewerInternalError(error: unknown): void {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'URIError'].includes(error.name)
      ? error.name
      : 'Error';
  const rawCode =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'string' &&
    /^(EACCES|ENOENT|EIO|EMFILE|ENFILE|EPERM|EISDIR|SQLITE_ERROR|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_CANTOPEN|SQLITE_FULL)$/.test(
      rawCode
    )
      ? rawCode
      : 'UNEXPECTED';
  const message = safeErrorDetail(error instanceof Error ? error.message : String(error), 800);
  const stack =
    error instanceof Error
      ? redactTraceText(error.stack ?? '')
          .split('\n')
          .slice(1, 6)
          .map((line) => safeErrorDetail(line, 240))
      : [];
  const cause =
    error instanceof Error && error.cause !== undefined
      ? safeErrorDetail(
          error.cause instanceof Error ? error.cause.message : String(error.cause),
          400
        )
      : undefined;
  console.error(
    `[viewer] ${JSON.stringify({ event: 'internal_error', name, code, message, stack, cause })}`
  );
}

function safeErrorDetail(value: string, limit: number): string {
  return auditField(value, 4000)
    .replace(/https?:\/\/[^\s)'"]+/gi, '[url]')
    .replace(/(?:file:\/\/)?(?:\/[^\s/:'"()]+){2,}/g, '[path]')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*(?::[0-9]+)?\b/gi, '[host]')
    .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?\b/g, '[address]')
    .slice(0, limit);
}

import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TimeZoneSetting } from '../runtime/timezone.js';

export type SecurityEventClass =
  | 'owner_access'
  | 'public_asset'
  | 'auth_failed'
  | 'forged_access_header'
  | 'host_rejected'
  | 'probe'
  | 'unknown_identity'
  | 'request_failed';

export interface SecurityEvent {
  time: string;
  class: SecurityEventClass;
  method: string;
  path: string;
  status: number;
  cfRay: string | null;
  country?: string;
  identity: 'token' | 'anonymous' | `access:${string}`;
}

export interface SecurityEventOptions {
  path?: string;
  replay?: boolean;
  sendToOwner?: (text: string, idempotencyKey: string) => Promise<void>;
  timeZone: TimeZoneSetting;
}

const ALERT_WINDOW_MS = 10 * 60 * 1000;
// Agent attempts are rare and each one matters to the owner: an attempt that sends data is never
// grouped (a harmless request first must not hide an upload after it); other attempts are grouped
// only in a burst, a script retrying within a minute.
const OUTBOUND_ALERT_WINDOW_MS = 60 * 1000;

/** One alert per class per window; later events in the window are counted on the next alert. */
function createAlertGate<Class extends string>(windowMs: number) {
  const lastAlert = new Map<Class, { time: number; suppressed: number }>();
  return (eventClass: Class, shouldAlert: boolean): { alert: boolean; suppressed: number } => {
    const now = Date.now();
    const previous = lastAlert.get(eventClass);
    const suppressed = shouldAlert && previous !== undefined && now - previous.time < windowMs;
    if (suppressed) previous.suppressed++;
    const suppressedSinceLastAlert = previous?.suppressed ?? 0;
    if (shouldAlert && !suppressed) {
      // Reserve before asynchronous delivery, including failures; this is one alert per class.
      lastAlert.set(eventClass, { time: now, suppressed: 0 });
    }
    return { alert: shouldAlert && !suppressed, suppressed: suppressedSinceLastAlert };
  };
}

function appendSecurityEvent(path: string, event: object): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(event) + '\n');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function createSecurityEventRecorder(options: SecurityEventOptions) {
  const path = options.path ?? join(homedir(), '.mama', 'logs', 'security-events.jsonl');
  const gate = createAlertGate<SecurityEventClass>(ALERT_WINDOW_MS);

  return {
    path,
    record(observed: SecurityEvent): void {
      // The event id is the alert's idempotency key too, so a Telegram alert in the message ledger
      // leads back to its line here.
      const shouldAlert =
        observed.class !== 'owner_access' && observed.class !== 'public_asset' && !options.replay;
      const { alert, suppressed: suppressedSinceLastAlert } = gate(observed.class, shouldAlert);
      const event = { eventId: randomUUID(), ...observed, suppressedSinceLastAlert };
      if (!appendSecurityEvent(path, event)) {
        // Observation failures must not change the response or expose filesystem details.
        console.error('[viewer] security_event_write_failed');
      }

      if (!alert) return;
      const timeZone = options.timeZone.get();
      const localTime = new Date(event.time).toLocaleString('ko-KR', { timeZone });
      const text = [
        'Viewer security alert',
        `Class: ${event.class}`,
        `Path: ${event.path}`,
        `Status: ${event.status}`,
        `Suppressed since previous alert: ${suppressedSinceLastAlert}`,
        `Time: ${localTime} (${timeZone})`,
        `Country: ${event.country ?? 'unknown'}`,
      ].join('\n');
      void (async () => {
        try {
          if (!options.sendToOwner) throw new Error('Owner alert delivery is unavailable');
          await options.sendToOwner(text, `viewer-security:${event.eventId}`);
        } catch {
          // Gateway errors can include credentials and destination identifiers.
          console.error('[viewer] security_alert_failed');
        }
      })();
    },
  };
}

/**
 * An agent's outbound attempt, seen and reported, never blocked: a native shell command that opens
 * a network connection (W35), a connection the shell sandbox's proxy refused (W35.4), or a web
 * fetch (owner, 2026-10-05).
 */
export interface OutboundAttemptEvent {
  time: string;
  /**
   * `outbound_send` when the command sends data, `outbound_attempt` for another command,
   * `outbound_connect` for a connection the sandbox proxy refused, `web_fetch` for a page fetch.
   */
  class: 'outbound_attempt' | 'outbound_send' | 'outbound_connect' | 'web_fetch';
  /** The native tool, or `sandbox proxy`. */
  tool: string;
  /** The command or URL as traced (bounded, secrets masked), or the proxy request and destination. */
  summary: string | null;
  /** null when it cannot be known: an encrypted tunnel carries whatever it carries. */
  sendsData: boolean | null;
  /** The run the command came from; the proxy does not know it, the time correlates. */
  modelRunId: string | null;
  /** The tool call's id, `gateway_call_id` of its `tool_traces` row. */
  callId: string | null;
}

// The command or request comes from the agent: a line break in it must not start a line of the
// alert that looks like the host's own.
const oneLine = (value: string | null): string =>
  value === null
    ? '(not recorded)'
    : [...value]
        .map((char) => {
          const code = char.charCodeAt(0);
          if (code >= 0x20 && code !== 0x7f) return char;
          return char === '\n' ? ' \u23ce ' : ' ';
        })
        .join('');

function outboundAlertText(event: OutboundAttemptEvent, suppressed: number, local: string): string {
  const sends = event.sendsData === null ? 'unknown' : event.sendsData ? 'yes' : 'no';
  if (event.class === 'web_fetch') {
    return [
      'Agent web fetch',
      `URL: ${oneLine(event.summary)}`,
      `Run: ${event.modelRunId ?? 'unknown'}`,
      `Suppressed since previous alert: ${suppressed}`,
      `Time: ${local}`,
    ].join('\n');
  }
  const lines =
    event.class === 'outbound_connect'
      ? [
          'Agent outbound connection (refused by the sandbox proxy)',
          `Request: ${oneLine(event.summary)}`,
          `Sends data: ${sends}`,
        ]
      : [
          'Agent outbound attempt',
          `Tool: ${event.tool}`,
          `Command: ${oneLine(event.summary)}`,
          `Sends data: ${sends}`,
          `Run: ${event.modelRunId ?? 'unknown'}`,
        ];
  return [...lines, `Suppressed since previous alert: ${suppressed}`, `Time: ${local}`].join('\n');
}

/** The host a fetched URL names, or the traced text itself when it does not parse as a URL. */
function fetchHost(summary: string | null): string {
  if (summary === null) return '';
  try {
    return new URL(summary).host;
  } catch {
    return summary;
  }
}

export function createOutboundEventRecorder(options: SecurityEventOptions) {
  const path = options.path ?? join(homedir(), '.mama', 'logs', 'security-events.jsonl');
  const gate = createAlertGate<string>(OUTBOUND_ALERT_WINDOW_MS);
  return {
    path,
    record(observed: OutboundAttemptEvent): void {
      // A command that sends data always alerts. Proxy connections and web fetches are grouped per
      // destination, so one destination cannot hide another; other commands are grouped in a burst.
      const { alert, suppressed } =
        observed.class === 'outbound_send'
          ? { alert: !options.replay, suppressed: 0 }
          : observed.class === 'outbound_connect'
            ? gate(`outbound_connect ${observed.summary ?? ''}`, !options.replay)
            : observed.class === 'web_fetch'
              ? gate(`web_fetch ${fetchHost(observed.summary)}`, !options.replay)
              : gate(observed.class, !options.replay);
      const event = { eventId: randomUUID(), ...observed, suppressedSinceLastAlert: suppressed };
      if (!appendSecurityEvent(path, event)) console.error('[agent] security_event_write_failed');
      if (!alert) return;
      const timeZone = options.timeZone.get();
      const localTime = new Date(event.time).toLocaleString('ko-KR', { timeZone });
      const text = outboundAlertText(event, suppressed, `${localTime} (${timeZone})`);
      void (async () => {
        try {
          if (!options.sendToOwner) throw new Error('Owner alert delivery is unavailable');
          await options.sendToOwner(text, `agent-outbound:${event.eventId}`);
        } catch {
          // Gateway errors can include credentials and destination identifiers.
          console.error('[agent] security_alert_failed');
        }
      })();
    },
  };
}

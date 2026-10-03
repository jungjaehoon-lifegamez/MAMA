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
// Agent attempts are rare and each one matters to the owner; only a burst (a script retrying
// within a minute) is grouped.
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

/** A native shell command that opens a network connection (W35): seen and reported, never blocked. */
export interface OutboundAttemptEvent {
  time: string;
  class: 'outbound_attempt';
  tool: string;
  /** The command as traced: bounded, secret-shaped values masked. */
  summary: string | null;
  sendsData: boolean;
  modelRunId: string;
  /** The tool call's id, `gateway_call_id` of its `tool_traces` row. */
  callId: string | null;
}

export function createOutboundEventRecorder(options: SecurityEventOptions) {
  const path = options.path ?? join(homedir(), '.mama', 'logs', 'security-events.jsonl');
  const gate = createAlertGate<OutboundAttemptEvent['class']>(OUTBOUND_ALERT_WINDOW_MS);
  return {
    path,
    record(observed: OutboundAttemptEvent): void {
      const { alert, suppressed } = gate(observed.class, !options.replay);
      const event = { eventId: randomUUID(), ...observed, suppressedSinceLastAlert: suppressed };
      if (!appendSecurityEvent(path, event)) console.error('[agent] security_event_write_failed');
      if (!alert) return;
      const timeZone = options.timeZone.get();
      const localTime = new Date(event.time).toLocaleString('ko-KR', { timeZone });
      const text = [
        'Agent outbound attempt',
        `Tool: ${event.tool}`,
        `Command: ${event.summary ?? '(not recorded)'}`,
        `Sends data: ${event.sendsData ? 'yes' : 'no'}`,
        `Run: ${event.modelRunId}`,
        `Suppressed since previous alert: ${suppressed}`,
        `Time: ${localTime} (${timeZone})`,
      ].join('\n');
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

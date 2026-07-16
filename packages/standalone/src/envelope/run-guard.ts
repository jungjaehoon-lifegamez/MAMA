import { parseEnvelopeExpiresAt } from './expiry.js';

/**
 * True when the envelope cannot authorize the work still ahead of it.
 * marginMs treats "expires within the margin" as expired, so a run stops
 * BEFORE burning a turn whose writes are already doomed. Unparseable
 * expires_at counts as expired: never proceed on a malformed authority bound.
 */
export function envelopeExpired(
  envelope: { expires_at: string },
  now: number = Date.now(),
  marginMs = 0
): boolean {
  try {
    return parseEnvelopeExpiresAt(envelope.expires_at) <= now + marginMs;
  } catch {
    return true;
  }
}

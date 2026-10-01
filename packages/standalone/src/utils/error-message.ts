/**
 * An error's message followed by up to two causes, as `fetch failed: other side closed`.
 *
 * Node's fetch reports every network failure as "fetch failed" and keeps the reason in `cause`,
 * so the message alone cannot tell a reset connection from a timeout or a failed lookup.
 */
export function messageWithCauses(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && messages.length < 3) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(': ').replace(/\s+/g, ' ');
}

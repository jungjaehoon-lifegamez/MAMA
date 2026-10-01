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
    messages.push(ownMessage(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(': ').replace(/\s+/g, ' ');
}

function ownMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  // A refused connection to a host with several addresses is an AggregateError with no message
  // and one error per address.
  const first = error instanceof AggregateError ? error.errors[0] : undefined;
  if (first instanceof Error && first.message !== '') return first.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}

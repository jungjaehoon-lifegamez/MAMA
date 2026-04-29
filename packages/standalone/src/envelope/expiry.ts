const ISO_8601_TIMESTAMP_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseEnvelopeExpiresAt(expiresAt: string): number {
  if (!ISO_8601_TIMESTAMP_WITH_TIMEZONE.test(expiresAt)) {
    throw new Error(`expires_at must be an ISO 8601 timestamp with timezone, got: ${expiresAt}`);
  }

  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new Error(`expires_at is not parseable as an ISO 8601 timestamp: ${expiresAt}`);
  }

  return expiresMs;
}

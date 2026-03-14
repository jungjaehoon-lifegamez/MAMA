const TRUSTED_PROXY_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  ...(process.env.MAMA_TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
]);

export function isLocalAddress(address: string | null | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isTrustedProxyPeer(address: string | null | undefined): boolean {
  return !!address && TRUSTED_PROXY_IPS.has(address);
}

export function getForwardedClientAddress(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string | null };
}): string {
  const remoteAddress = req.socket?.remoteAddress || null;
  if (!isTrustedProxyPeer(remoteAddress)) {
    return remoteAddress || 'unknown';
  }

  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return remoteAddress || 'unknown';
}

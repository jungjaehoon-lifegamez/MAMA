export type SourceLocatorKind = 'db' | 'file' | 'url' | 'connector' | 'unknown';

export function detectSourceLocatorKind(locator: string | null | undefined): SourceLocatorKind {
  if (typeof locator !== 'string' || locator.trim().length === 0) {
    return 'unknown';
  }

  const trimmed = locator.trim();
  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return 'url';
  }
  if (normalized.startsWith('file://')) {
    return 'file';
  }
  if (
    normalized.startsWith('drive://') ||
    normalized.startsWith('gmail://') ||
    normalized.startsWith('calendar://') ||
    normalized.startsWith('sheets://')
  ) {
    return 'connector';
  }
  if (
    normalized.endsWith('.db') ||
    normalized.includes('/raw.db') ||
    normalized.includes('\\raw.db')
  ) {
    return 'db';
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return 'file';
  }

  return 'unknown';
}

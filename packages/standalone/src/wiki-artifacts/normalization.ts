import { isValidPageType, type WikiPage, type WikiPageType } from '../wiki/types.js';
import { normalizeWikiPagePath } from '../wiki/path-safety.js';

export type WikiArtifactConfidence = WikiPage['confidence'];

const CONFIDENCE_VALUES = new Set<string>(['high', 'medium', 'low']);

export function requiredWikiString(value: unknown, field: string, prefix: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${prefix} ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${prefix} ${field} must not be empty`);
  }
  return trimmed;
}

export function normalizeWikiPageType(
  value: string | undefined,
  prefix: string,
  defaultType: WikiPageType = 'entity'
): WikiPageType {
  if (value === undefined || value.trim().length === 0) {
    return defaultType;
  }
  const normalized = requiredWikiString(value, 'type', prefix);
  if (!isValidPageType(normalized)) {
    throw new Error(`${prefix} type is not supported: ${normalized}`);
  }
  return normalized;
}

export function normalizeWikiConfidence(
  value: string | undefined,
  prefix: string,
  defaultConfidence: WikiArtifactConfidence = 'medium'
): WikiArtifactConfidence {
  if (value === undefined || value.trim().length === 0) {
    return defaultConfidence;
  }
  const normalized = requiredWikiString(value, 'confidence', prefix);
  if (!CONFIDENCE_VALUES.has(normalized)) {
    throw new Error(`${prefix} confidence is not supported: ${normalized}`);
  }
  return normalized as WikiArtifactConfidence;
}

export { normalizeWikiPagePath };

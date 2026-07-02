import { isAbsolute, posix } from 'path';

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const RESERVED_ROOT_PATHS = new Set(['index.md', 'log.md']);
const RESERVED_ROOT_DIRECTORIES = new Set(['projects', 'lessons', 'synthesis']);

export function normalizeWikiPagePath(value: unknown, field: string = 'wiki page path'): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    isAbsolute(trimmed) ||
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed)
  ) {
    throw new Error(`${field} must stay inside the wiki directory`);
  }
  if (trimmed.split('/').includes('..')) {
    throw new Error(`${field} must not contain parent-directory traversal`);
  }

  const normalized = posix.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new Error(`${field} must not contain parent-directory traversal`);
  }
  if (normalized === '.' || normalized === './' || normalized.endsWith('/')) {
    throw new Error(`${field} must point to a wiki file, not a directory`);
  }
  if (RESERVED_ROOT_PATHS.has(normalized.toLowerCase())) {
    throw new Error(`${field} must not overwrite reserved wiki files`);
  }
  if (RESERVED_ROOT_DIRECTORIES.has(normalized.toLowerCase())) {
    throw new Error(`${field} must not overwrite reserved wiki directories`);
  }
  return normalized;
}

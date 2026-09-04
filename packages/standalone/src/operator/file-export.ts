/**
 * file_export: the smallest path from "make me a file" to a file the owner can receive.
 *
 * Writes only under the private workspace exports root (the same root telegram_send and
 * drive_upload accept through resolvePrivateWorkspaceFile), never overwrites (wx flag),
 * never escapes the root, and returns the bytes and sha256 the executor records as an
 * effect. csv and md ship first: both need no dependency and both open where the owner
 * works. Formula-leading cells are neutralised because the owner opens the csv in Excel.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type ExportFormat = 'csv' | 'md';

export interface ExportFileInput {
  format: ExportFormat;
  name: string;
  columns?: string[];
  rows?: Array<Record<string, string | number | null>>;
  content?: string;
}

export interface ExportFileResult {
  path: string;
  bytes: number;
  sha256: string;
}

export const EXPORT_DIR_NAME = 'exports';
const MAX_ROWS = 5_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** The one place the exports root is computed. Mirrors owner-event-effects.ts (MAMA_WORKSPACE). */
export function resolveExportRoot(env: NodeJS.ProcessEnv = process.env): string {
  const workspace = resolve(env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace'));
  return join(workspace, EXPORT_DIR_NAME);
}

/** Safe basename: ascii letters, digits and dashes; everything else (including path parts) collapses. */
export function slugExportName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'export';
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  // A leading =, +, -, @ (or a tab/CR) is a formula to a spreadsheet: prefix an apostrophe.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function renderCsv(
  rows: Array<Record<string, string | number | null>>,
  columns?: string[]
): string {
  const header =
    columns && columns.length > 0 ? columns : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column] ?? null)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function timestampSuffix(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Pure apart from the write. Never overwrites; never escapes the root. */
export async function exportFile(
  input: ExportFileInput,
  root: string,
  nowMs: number = Date.now()
): Promise<ExportFileResult> {
  if (input.format !== 'csv' && input.format !== 'md') {
    throw new Error(`file_export: unsupported format ${String(input.format)}`);
  }
  let body: string;
  if (input.format === 'csv') {
    if (!Array.isArray(input.rows)) {
      throw new Error('file_export: csv requires rows');
    }
    if (input.rows.length > MAX_ROWS) {
      throw new Error(`file_export: csv rows exceed ${MAX_ROWS}`);
    }
    body = renderCsv(input.rows, input.columns);
  } else {
    if (typeof input.content !== 'string' || input.content.trim() === '') {
      throw new Error('file_export: md requires content');
    }
    body = input.content.endsWith('\n') ? input.content : `${input.content}\n`;
  }
  const bytes = Buffer.byteLength(body, 'utf-8');
  if (bytes > MAX_BYTES) {
    throw new Error(`file_export: ${bytes} bytes exceeds ${MAX_BYTES}`);
  }
  const realRoot = resolve(root);
  mkdirSync(realRoot, { recursive: true });
  const base = `${slugExportName(input.name)}-${timestampSuffix(nowMs)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fileName = `${base}${attempt === 0 ? '' : `-${attempt}`}.${input.format}`;
    const path = resolve(realRoot, fileName);
    if (path !== realRoot && !path.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`file_export: refusing to write outside ${realRoot}`);
    }
    try {
      writeFileSync(path, body, { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue; // never overwrite: same second, same name -> counter
      }
      throw error;
    }
    return { path, bytes, sha256: createHash('sha256').update(body).digest('hex') };
  }
  throw new Error('file_export: could not find a free file name');
}

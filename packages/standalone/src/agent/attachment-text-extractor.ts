import { closeSync, openSync, readSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
declare const __dirname: string;
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.xml',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.log',
  '.rtf',
]);

export async function extractAttachmentText(
  filePath: string,
  maxOutputBytes: number
): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.docx') {
    return extractOfficeText(filePath, extension, maxOutputBytes);
  }
  if (extension === '.xlsx') {
    return extractOfficeText(filePath, extension, maxOutputBytes);
  }
  if (extension === '.pdf') {
    return truncateUtf8(await extractPdfText(filePath, maxOutputBytes), maxOutputBytes);
  }
  const bytes = readBounded(filePath, maxOutputBytes + 1);
  if (TEXT_EXTENSIONS.has(extension)) {
    return truncateUtf8(bytes.toString('utf8'), maxOutputBytes);
  }
  if (!bytes.includes(0)) {
    const text = decodeValidUtf8Prefix(bytes);
    if (text !== null) {
      return truncateUtf8(text, maxOutputBytes);
    }
  }
  throw new Error(`Unsupported attachment format: ${extension || '(no extension)'}`);
}

async function extractOfficeText(
  filePath: string,
  extension: '.docx' | '.xlsx',
  maxOutputBytes: number
): Promise<string> {
  const scriptPath = resolve(__dirname, '../../scripts/attachment/extract-office-text.js');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--max-old-space-size=192', scriptPath, filePath, extension, String(maxOutputBytes)],
      {
        timeout: 15_000,
        maxBuffer: Math.max(maxOutputBytes + 64 * 1024, 1024 * 1024),
        encoding: 'utf8',
      }
    );
    return stdout;
  } catch (error) {
    throw new Error(`Office attachment extraction failed: ${errorMessage(error)}`);
  }
}

function readBounded(filePath: string, maxBytes: number): Buffer {
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

async function extractPdfText(filePath: string, maxOutputBytes: number): Promise<string> {
  const maxBuffer = Math.max(maxOutputBytes * 4, 1024 * 1024);
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-nopgbrk', filePath, '-'], {
      timeout: 30_000,
      maxBuffer,
      encoding: 'utf8',
    });
    return stdout;
  } catch (portableError) {
    if (process.platform !== 'darwin' || !isExecutableMissing(portableError)) {
      throw new Error(`PDF text extraction is unavailable: ${errorMessage(portableError)}`);
    }

    const scriptPath = resolve(__dirname, '../../scripts/attachment/extract-pdf-text.swift');
    try {
      const { stdout } = await execFileAsync(
        'swift',
        [scriptPath, filePath, String(maxOutputBytes)],
        {
          timeout: 30_000,
          maxBuffer,
          encoding: 'utf8',
        }
      );
      return stdout;
    } catch (platformError) {
      throw new Error(`PDF text extraction failed: ${errorMessage(platformError)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutableMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function decodeValidUtf8Prefix(bytes: Buffer): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let trailingBytes = 0; trailingBytes <= Math.min(3, bytes.length); trailingBytes += 1) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - trailingBytes));
    } catch {
      // A bounded read may end in the middle of one UTF-8 code point. Only
      // trim the maximum possible trailing sequence; invalid interior bytes
      // still fail all attempts and remain classified as binary.
    }
  }
  return null;
}

function truncateUtf8(content: string, maxOutputBytes: number): string {
  const bytes = Buffer.from(content);
  if (bytes.length <= maxOutputBytes) {
    return content;
  }
  const prefix = decodeValidUtf8Prefix(bytes.subarray(0, maxOutputBytes)) ?? '';
  return `${prefix}\n\n[Truncated at ${maxOutputBytes} bytes]`;
}

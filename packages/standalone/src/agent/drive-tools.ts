import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, relative } from 'path';
import { promisify } from 'util';

import { parseGwsOutput } from '../connectors/framework/gws-utils.js';
import { UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION } from '../utils/untrusted-content.js';

const execFileAsync = promisify(execFile);
const SAFE_DRIVE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_QUERY =
  /^(name|mimeType)\s+(contains|=)\s+'[^']*'(\s+(and|or)\s+(name|mimeType)\s+(contains|=)\s+'[^']*')*$/;
const DEFAULT_DRIVE_DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_DRIVE_LIST_PAGES = 1_000;

export type DriveGwsRunner = (args: string[]) => Promise<string>;

export interface DriveToolServiceOptions {
  workspaceRoot?: string;
  runGws?: DriveGwsRunner;
  maxDownloadBytes?: number;
}

export interface UntrustedDriveEvidence<T> {
  source: 'google-drive';
  trust: 'untrusted_external_data';
  instruction: string;
  data: T;
}

export interface DriveBrowseInput {
  folderId?: string;
  driveId?: string;
  query?: string;
}

export interface DriveFindFolderInput {
  driveId: string;
  path: string;
}

export interface DriveDownloadInput {
  fileId: string;
  fileName?: string;
}

export interface DriveUploadInput {
  localPath: string;
  folderId: string;
  fileName?: string;
}

async function defaultRunGws(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gws', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function requireDriveId(value: string | undefined, field: string): string {
  if (!value || !SAFE_DRIVE_ID.test(value)) {
    throw new Error(`${field} must be a non-empty Google Drive identifier.`);
  }
  return value;
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed = parseGwsOutput(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('gws returned an invalid JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function readObjectArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) {
    throw new Error(`gws returned an invalid ${field} array.`);
  }
  return value as Array<Record<string, unknown>>;
}

function readNextPageToken(result: Record<string, unknown>): string | undefined {
  const token = result.nextPageToken;
  if (token === undefined) return undefined;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('gws returned an invalid nextPageToken.');
  }
  return token;
}

function sanitizeFileName(value: string | undefined, fallback: string): string {
  const candidate = Array.from(basename(value?.trim() || fallback), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? '_' : character;
  }).join('');
  if (!candidate || candidate === '.' || candidate === '..') return fallback;
  return candidate;
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function configuredDriveDownloadLimit(): number {
  const configured = Number(process.env.MAMA_DRIVE_MAX_DOWNLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DRIVE_DOWNLOAD_LIMIT_BYTES;
}

export function asUntrustedDriveEvidence<T>(data: T): UntrustedDriveEvidence<T> {
  return {
    source: 'google-drive',
    trust: 'untrusted_external_data',
    instruction: UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
    data,
  };
}

export class DriveToolService {
  private readonly workspaceRoot: string;
  private readonly downloadRoot: string;
  private readonly runGws: DriveGwsRunner;
  private readonly maxDownloadBytes: number;

  constructor(options: DriveToolServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? join(homedir(), '.mama', 'workspace');
    this.downloadRoot = join(this.workspaceRoot, 'media', 'inbound', 'drive');
    this.runGws = options.runGws ?? defaultRunGws;
    this.maxDownloadBytes = options.maxDownloadBytes ?? configuredDriveDownloadLimit();
  }

  async listDrives(): Promise<Array<Record<string, unknown>>> {
    const drives: Array<Record<string, unknown>> = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
      const result = parseObject(
        await this.runGws([
          'drive',
          'drives',
          'list',
          '--params',
          JSON.stringify({ fields: 'nextPageToken,drives(id,name)', pageToken }),
        ])
      );
      drives.push(...readObjectArray(result.drives, 'drives'));
      pageToken = readNextPageToken(result);
      if (!pageToken) return drives;
      if (seenTokens.has(pageToken)) throw new Error('gws returned a repeated nextPageToken.');
      seenTokens.add(pageToken);
    }
    throw new Error(`Drive listing exceeded ${MAX_DRIVE_LIST_PAGES} pages.`);
  }

  async browse(input: DriveBrowseInput): Promise<Array<Record<string, unknown>>> {
    const parentId = requireDriveId(input.folderId ?? input.driveId, 'folderId or driveId');
    const driveId = input.driveId ? requireDriveId(input.driveId, 'driveId') : undefined;
    let query = `'${parentId}' in parents`;
    if (input.query) {
      if (!SAFE_QUERY.test(input.query)) {
        throw new Error(
          'Unsupported query format. Allowed fields are name and mimeType with contains or =.'
        );
      }
      query += ` and ${input.query}`;
    }
    const params: Record<string, unknown> = {
      q: query,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)',
      orderBy: 'name',
    };
    if (driveId) {
      params.corpora = 'drive';
      params.driveId = driveId;
    }
    const files: Array<Record<string, unknown>> = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
      if (pageToken) params.pageToken = pageToken;
      const result = parseObject(
        await this.runGws(['drive', 'files', 'list', '--params', JSON.stringify(params)])
      );
      files.push(...readObjectArray(result.files, 'files'));
      pageToken = readNextPageToken(result);
      if (!pageToken) return files;
      if (seenTokens.has(pageToken)) throw new Error('gws returned a repeated nextPageToken.');
      seenTokens.add(pageToken);
    }
    throw new Error(`Drive browsing exceeded ${MAX_DRIVE_LIST_PAGES} pages.`);
  }

  async findFolder(input: DriveFindFolderInput): Promise<{ folderId: string; path: string }> {
    const driveId = requireDriveId(input.driveId, 'driveId');
    const segments = input.path.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error('path must contain safe folder name segments.');
    }

    let currentId = driveId;
    for (const segment of segments) {
      const escaped = segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const params = {
        q: `'${currentId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder'`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'drive',
        driveId,
        fields: 'files(id,name)',
      };
      const result = parseObject(
        await this.runGws(['drive', 'files', 'list', '--params', JSON.stringify(params)])
      );
      const files = readObjectArray(result.files, 'files');
      const folderId = files[0]?.id;
      if (typeof folderId !== 'string' || !SAFE_DRIVE_ID.test(folderId)) {
        throw new Error(`Drive folder not found: ${segment}`);
      }
      currentId = folderId;
    }
    return { folderId: currentId, path: input.path };
  }

  async download(input: DriveDownloadInput): Promise<{ path: string; fileName: string }> {
    const fileId = requireDriveId(input.fileId, 'fileId');
    mkdirSync(this.downloadRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.downloadRoot, 0o700);
    const metadata = parseObject(
      await this.runGws([
        'drive',
        'files',
        'get',
        '--params',
        JSON.stringify({ fileId, supportsAllDrives: true, fields: 'name,size' }),
      ])
    );
    const declaredSize = Number(metadata.size);
    if (Number.isFinite(declaredSize) && declaredSize > this.maxDownloadBytes) {
      throw new Error('Drive file exceeds the download limit.');
    }
    const metadataName = typeof metadata.name === 'string' ? metadata.name : `${fileId}.bin`;
    const fileName = sanitizeFileName(input.fileName, metadataName);
    const id = randomUUID();
    const tempPath = join(this.downloadRoot, `.${id}.part`);
    const outputPath = join(this.downloadRoot, `${id}-${fileName}`);
    try {
      await this.runGws([
        'drive',
        'files',
        'get',
        '--params',
        JSON.stringify({ fileId, alt: 'media', supportsAllDrives: true }),
        '--output',
        tempPath,
      ]);
      if (!existsSync(tempPath)) {
        throw new Error('Drive download did not create the requested file.');
      }
      if (statSync(tempPath).size > this.maxDownloadBytes) {
        throw new Error('Drive file exceeds the download limit.');
      }
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, outputPath);
      chmodSync(outputPath, 0o600);
      return { path: outputPath, fileName };
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw error;
    }
  }

  async upload(input: DriveUploadInput): Promise<{ fileId: string; name: string }> {
    const folderId = requireDriveId(input.folderId, 'folderId');
    if (!existsSync(input.localPath)) {
      throw new Error('Upload file does not exist.');
    }
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceRoot = realpathSync(this.workspaceRoot);
    const localPath = realpathSync(input.localPath);
    if (!isWithin(workspaceRoot, localPath)) {
      throw new Error('Drive uploads are restricted to the private MAMA workspace.');
    }
    if (!statSync(localPath).isFile()) {
      throw new Error('Drive upload source must be a regular file.');
    }
    const fileName = sanitizeFileName(input.fileName, basename(localPath));
    const result = parseObject(
      await this.runGws([
        'drive',
        'files',
        'create',
        '--params',
        JSON.stringify({ uploadType: 'multipart', supportsAllDrives: true }),
        '--json',
        JSON.stringify({ name: fileName, parents: [folderId] }),
        '--upload',
        localPath,
      ])
    );
    if (typeof result.id !== 'string' || typeof result.name !== 'string') {
      throw new Error('gws returned an invalid Drive upload result.');
    }
    return { fileId: result.id, name: result.name };
  }
}

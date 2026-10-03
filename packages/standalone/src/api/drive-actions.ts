/**
 * drive.read and drive.download — Google Drive read live, as Kagemusha reads it, through the gws
 * CLI the calendar connector already uses (its keyring holds the credential). Nothing from Drive
 * is stored. Drive has no running connector (its change poller stays off), so the gws call is a
 * port instead of the connector registry trello.read uses.
 */
import { mkdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';

import { execGwsAsync, type GwsCallOptions } from '../connectors/framework/gws-utils.js';
import { safeFileName } from './attachment-actions.js';

export type GwsCall = (args: string[], options?: GwsCallOptions) => Promise<unknown>;

export interface DriveActionPorts {
  ownerPrincipalId: string;
  downloadsDir?: string;
  gws?: GwsCall;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string };
  parents?: string[];
  driveId?: string;
  webViewLink?: string;
}

const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,lastModifyingUser(displayName),parents,driveId,webViewLink';
const LIST_BUFFER = 16 * 1024 * 1024;
const BROWSE_MAX = 100;
// alt=media refuses Google-native files (fileNotDownloadable); these three export to the formats
// the file readers in help("files") open.
const EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
};

function invalid(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

function ownerOnly(action: string, access: ActionContext['access'], ownerPrincipalId: string) {
  if (access.principalId === ownerPrincipalId) return;
  const error = new Error(`${action} is the owner's; no Drive grant exists for other principals`);
  error.name = 'drive_out_of_scope';
  throw error;
}

/** A file or folder id from an id or a Drive/Docs link, as cards and messages carry them. */
export function driveId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required`);
  const text = value.trim();
  if (!text.includes('://')) {
    if (/^[\w-]+$/.test(text)) return text;
    throw invalid(`${field} must be a Drive id or link`);
  }
  const found =
    /\/(?:d|folders)\/([\w-]+)/.exec(text)?.[1] ?? /[?&]id=([\w-]+)/.exec(text)?.[1] ?? null;
  if (found === null) throw invalid(`${field} names no Drive file: ${text}`);
  return found;
}

/** A free-text value inside a Drive query string literal. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fileView(file: DriveFile) {
  return {
    id: file.id,
    name: file.name,
    type: file.mimeType,
    folder: file.mimeType === FOLDER,
    size: file.size === undefined ? null : Number(file.size),
    modified: file.modifiedTime ?? null,
    modifiedBy: file.lastModifyingUser?.displayName ?? null,
    drive: file.driveId ?? null,
    parents: file.parents ?? [],
    link: file.webViewLink ?? null,
  };
}

export function driveActionRegistrations(ports: DriveActionPorts): ActionRegistration[] {
  const gws = ports.gws ?? execGwsAsync;
  const list = async (params: Record<string, unknown>): Promise<DriveFile[]> => {
    const result = (await gws(
      [
        'drive',
        'files',
        'list',
        '--params',
        JSON.stringify({
          ...params,
          corpora: 'allDrives',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields: `files(${FILE_FIELDS})`,
        }),
      ],
      { maxBuffer: LIST_BUFFER }
    )) as { files?: DriveFile[] };
    return result.files ?? [];
  };
  const metadata = async (id: string): Promise<DriveFile> =>
    (await gws([
      'drive',
      'files',
      'get',
      '--params',
      JSON.stringify({ fileId: id, supportsAllDrives: true, fields: FILE_FIELDS }),
    ])) as DriveFile;

  return [
    {
      contract: {
        name: 'drive.read',
        readsConnector: { fixed: 'drive' },
        summary:
          'Read Google Drive live. drives lists the shared drives; browse lists a folder (folder: a folder id, a shared drive id, a folder link or "root" for My Drive; path walks subfolders by name; name narrows by text), at most 100 entries; file reads one file by id or Drive/Docs link (name, type, size, modified time and editor, link); search finds files by name or content across all drives (text; limit up to 50), newest first. Nothing is stored; fetch a file with drive.download.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['view'],
          properties: {
            view: { type: 'string', enum: ['drives', 'browse', 'file', 'search'] },
            folder: {
              type: 'string',
              minLength: 1,
              description: 'Folder id, shared drive id, folder link or "root".',
            },
            path: {
              type: 'string',
              minLength: 1,
              description: 'Subfolder names under folder, e.g. "2026/October".',
            },
            name: {
              type: 'string',
              minLength: 1,
              description: 'Text the entry names contain, e.g. "draft".',
            },
            file: {
              type: 'string',
              minLength: 1,
              description: 'File id or a Drive/Docs link.',
            },
            text: {
              type: 'string',
              minLength: 1,
              description: 'Words in a file name or content, e.g. "feedback".',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Search results; defaults to 20.',
            },
          },
        },
        examples: [
          { title: 'Shared drives', input: { view: 'drives' } },
          { title: 'A file behind a link', input: { view: 'file', file: 'drive-link-or-id' } },
          { title: 'Find by name', input: { view: 'search', text: 'feedback' } },
        ],
      },
      exec: async (input, context) => {
        ownerOnly('drive.read', context.access, ports.ownerPrincipalId);
        const values = input as Record<string, unknown>;
        switch (values.view) {
          case 'drives': {
            const result = (await gws([
              'drive',
              'drives',
              'list',
              '--params',
              JSON.stringify({ pageSize: 100, fields: 'drives(id,name)' }),
            ])) as { drives?: Array<{ id: string; name: string }> };
            return { drives: result.drives ?? [] };
          }
          case 'browse': {
            let folder = driveId(values.folder, 'folder');
            const path = typeof values.path === 'string' ? values.path : undefined;
            for (const segment of (path ?? '').split('/').filter(Boolean)) {
              const [next] = await list({
                q: `${quoted(folder)} in parents and name = ${quoted(segment)} and mimeType = '${FOLDER}' and trashed = false`,
                pageSize: 1,
              });
              if (next === undefined) throw invalid(`No folder named "${segment}" in ${folder}`);
              folder = next.id;
            }
            const name = typeof values.name === 'string' ? values.name : undefined;
            const entries = await list({
              q: `${quoted(folder)} in parents and trashed = false${name === undefined ? '' : ` and name contains ${quoted(name)}`}`,
              pageSize: BROWSE_MAX + 1,
              orderBy: 'folder,name',
            });
            if (entries.length > BROWSE_MAX) {
              throw invalid(
                `Folder ${folder} has more than ${BROWSE_MAX} entries; narrow it with name or path`
              );
            }
            return { folder, entries: entries.map(fileView) };
          }
          case 'file':
            return { file: fileView(await metadata(driveId(values.file, 'file'))) };
          case 'search': {
            if (typeof values.text !== 'string') throw invalid('drive.read search needs text');
            const text = quoted(values.text);
            const files = await list({
              q: `(name contains ${text} or fullText contains ${text}) and trashed = false`,
              pageSize: values.limit === undefined ? 20 : Number(values.limit),
              orderBy: 'modifiedTime desc',
            });
            return { files: files.map(fileView) };
          }
          default:
            throw invalid('drive.read view must be drives, browse, file or search');
        }
      },
    },
    {
      contract: {
        name: 'drive.download',
        readsConnector: { fixed: 'drive' },
        summary:
          'Fetch one Google Drive file (file: id or Drive/Docs link) into the daemon downloads directory (read-only for you) and return its saved path and size. Google Docs, Sheets and Slides are exported as docx, xlsx and pptx; folders and other Google-native types are refused.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['file'],
          properties: {
            file: {
              type: 'string',
              minLength: 1,
              description: 'File id or a Drive/Docs link.',
            },
          },
        },
        examples: [{ title: 'Fetch a linked file', input: { file: 'drive-link-or-id' } }],
      },
      exec: async (input, context) => {
        ownerOnly('drive.download', context.access, ports.ownerPrincipalId);
        if (!ports.downloadsDir?.trim()) throw new Error('Downloads directory is not configured');
        const file = await metadata(driveId((input as Record<string, unknown>).file, 'file'));
        const exported = EXPORTS[file.mimeType];
        if (exported === undefined && file.mimeType.startsWith('application/vnd.google-apps.')) {
          throw invalid(`${file.name} is a ${file.mimeType}, which drive.download cannot fetch`);
        }
        const targetDir = join(ports.downloadsDir, 'drive');
        mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const name =
          exported === undefined || extname(file.name).toLowerCase() === exported.extension
            ? file.name
            : `${file.name}${exported.extension}`;
        const targetPath = join(targetDir, `${safeFileName(file.id)}_${safeFileName(name)}`);
        await gws(
          exported === undefined
            ? [
                'drive',
                'files',
                'get',
                '--params',
                JSON.stringify({ fileId: file.id, alt: 'media', supportsAllDrives: true }),
                '--output',
                targetPath,
              ]
            : [
                'drive',
                'files',
                'export',
                '--params',
                JSON.stringify({ fileId: file.id, mimeType: exported.mimeType }),
                '--output',
                targetPath,
              ],
          { timeoutMs: 120_000 }
        );
        return {
          file: file.id,
          name: file.name,
          type: file.mimeType,
          exportedAs: exported?.mimeType ?? null,
          path: targetPath,
          size: statSync(targetPath).size,
        };
      },
    },
  ];
}

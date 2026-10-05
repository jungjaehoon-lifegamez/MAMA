/**
 * deliver.drive.file — a file too large for the owner's messengers goes to the Drive folder the
 * owner names, readable by the readers the owner names (W8; owner, 2026-10-05). The daemon makes
 * the gws calls with its own credential and returns a receipt: the file's link, size and hashes.
 * Readers are set on each file, so the receipt says exactly who can read it; no public link is
 * made, and the folder itself stays the owner's.
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';

import { execGwsAsync } from '../connectors/framework/gws-utils.js';
import type { DriveReader, W1DriveDeliveryConfig } from '../runtime/config.js';
import { ownerOnly, type GwsCall } from './drive-actions.js';
import { openWorkspaceFile, readWorkspaceFile } from './file-delivery.js';

/** The largest owner file so far was 257 MB (2026-10-05); 2 GiB stays near ten minutes. */
export const DRIVE_DELIVERY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// 260 MB went up in 61 s (2026-10-05): allow a quarter of that speed, plus two minutes.
const uploadTimeoutMs = (size: number): number => 120_000 + Math.ceil(size / (1024 * 1024)) * 1_000;

const FIELDS = 'id,name,size,md5Checksum,webViewLink';

export interface DriveDeliveryPorts {
  ownerPrincipalId: string;
  /** The owner workspace; files are sent from its files/ directory. */
  workspaceDir: string;
  /** A daemon-owned directory the agent cannot write; the validated bytes are staged there. */
  stagingDir: string;
  delivery: W1DriveDeliveryConfig;
  gws?: GwsCall;
}

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  md5Checksum?: string;
  webViewLink?: string;
}

function permission(reader: DriveReader): Record<string, string> {
  if ('domain' in reader) return { type: 'domain', role: 'reader', domain: reader.domain };
  if ('group' in reader) return { type: 'group', role: 'reader', emailAddress: reader.group };
  return { type: 'user', role: 'reader', emailAddress: reader.user };
}

/** Copy the validated descriptor into the staging file, hashing the bytes that will be sent. */
async function stage(fd: number, target: string): Promise<{ md5: string; sha256: string }> {
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  const out = openSync(target, 'w', 0o600);
  try {
    for await (const chunk of readWorkspaceFile(fd)) {
      md5.update(chunk);
      sha256.update(chunk);
      writeSync(out, chunk);
    }
  } finally {
    closeSync(out);
  }
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}

export function driveDeliveryActionRegistrations(ports: DriveDeliveryPorts): ActionRegistration[] {
  const gws = ports.gws ?? execGwsAsync;
  const { folder, readers } = ports.delivery;
  // One delivery per operation at a time: a retry that arrives while the first attempt is still
  // uploading waits for it instead of passing the lookup and uploading a second copy.
  const inFlight = new Map<string, Promise<unknown>>();
  const send = async (values: { path: string; name?: unknown }, operationId: string) => {
    const file = openWorkspaceFile(
      join(ports.workspaceDir, 'files'),
      values.path,
      DRIVE_DELIVERY_MAX_BYTES
    );
    const name = typeof values.name === 'string' ? values.name : basename(file.path);
    mkdirSync(ports.stagingDir, { recursive: true, mode: 0o700 });
    const staged = join(
      ports.stagingDir,
      `${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}${extname(file.path)}`
    );
    try {
      let hashes: { md5: string; sha256: string };
      try {
        hashes = await stage(file.fd, staged);
      } finally {
        closeSync(file.fd);
      }
      const escaped = operationId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const found = (await gws([
        'drive',
        'files',
        'list',
        '--params',
        JSON.stringify({
          q: `'${folder}' in parents and appProperties has { key='mamaOperationId' and value='${escaped}' } and trashed=false`,
          fields: `files(${FIELDS})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      ])) as { files?: DriveFile[] };
      const earlier = found.files?.[0];
      if (earlier !== undefined && earlier.md5Checksum !== hashes.md5) {
        throw new Error(
          `operation ${operationId} already sent Drive file ${earlier.id} with other content`
        );
      }
      const sent =
        earlier ??
        ((await gws(
          [
            'drive',
            'files',
            'create',
            '--params',
            JSON.stringify({ supportsAllDrives: true, fields: FIELDS }),
            '--json',
            JSON.stringify({
              name,
              parents: [folder],
              appProperties: { mamaOperationId: operationId, mamaSha256: hashes.sha256 },
            }),
            '--upload',
            staged,
          ],
          { timeoutMs: uploadTimeoutMs(file.size) }
        )) as DriveFile);
      if (sent.md5Checksum !== hashes.md5) {
        throw new Error(
          `Drive stored ${sent.id} with md5 ${sent.md5Checksum ?? 'none'}, not the sent ${hashes.md5}`
        );
      }
      // Applied on a retry too: a stop between upload and sharing leaves a file nobody can read.
      for (const reader of readers) {
        await gws([
          'drive',
          'permissions',
          'create',
          '--params',
          JSON.stringify({
            fileId: sent.id,
            supportsAllDrives: true,
            sendNotificationEmail: false,
            fields: 'id',
          }),
          '--json',
          JSON.stringify(permission(reader)),
        ]);
      }
      return {
        fileId: sent.id,
        name: sent.name,
        link: sent.webViewLink ?? null,
        size: file.size,
        md5: hashes.md5,
        sha256: hashes.sha256,
        readers,
        operationId,
        idempotent: earlier !== undefined,
      };
    } finally {
      rmSync(staged, { force: true });
    }
  };
  return [
    {
      contract: {
        name: 'deliver.drive.file',
        summary:
          "Send one regular file under the owner workspace files directory (up to 2 GiB) to the owner's Drive delivery folder, readable by the readers set in config; use it for a file over the messengers' 50 MB limit. Returns the link, size, md5 and sha256; a retry of the same operation returns the file already sent instead of sending it again. Put the link in your reply and record the link and sha256 on the work item's revision.",
        inputSchema: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1 },
            name: {
              type: 'string',
              minLength: 1,
              description: 'Drive file name; the file name by default.',
            },
          },
        },
        examples: [
          {
            title: 'Send a large result',
            input: { path: '/workspace/files/translated.pptx' },
          },
        ],
      },
      exec: async (input: unknown, context: ActionContext) => {
        ownerOnly('deliver.drive.file', context.access, ports.ownerPrincipalId);
        const values = input as { path?: unknown; name?: unknown };
        if (typeof values.path !== 'string' || values.path.trim() === '') {
          throw new Error('path is required');
        }
        const operationId = context.operationId;
        if (typeof operationId !== 'string' || operationId.trim() === '') {
          throw new Error('deliver.drive.file requires an operation id');
        }
        const running = inFlight.get(operationId);
        if (running !== undefined) return running;
        const delivery = send({ ...values, path: values.path }, operationId).finally(() =>
          inFlight.delete(operationId)
        );
        inFlight.set(operationId, delivery);
        return delivery;
      },
    },
  ];
}

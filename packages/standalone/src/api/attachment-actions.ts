import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionContext,
  ActionRegistration,
  ActionSchemaObject,
  MemoryReadAllowance,
} from '@jungjaehoon/mama-core';
import type { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import {
  attachmentConnector,
  type AttachmentMatchRule,
  type AttachmentListRequest,
} from '../connectors/framework/attachments.js';
import { extractChatworkFileIds } from '../connectors/chatwork/index.js';
import { extractSlackFileIds } from '../connectors/slack/index.js';
import type { StoredSourceReader } from './stored-source-reader.js';
import {
  OWNER_FILE_MAX_UPLOAD_BYTES,
  validateWorkspaceFile,
  type OwnerFileSender,
} from './file-delivery.js';

export interface AttachmentActionPorts {
  stored?: StoredSourceReader | null;
  connectors?: () => ConnectorRegistry | null;
  workspaceDir?: string;
  downloadsDir?: string;
  principalPaths?: (principalId: string) => { workspaceDir: string; downloadsDir: string };
  telegram?: () => OwnerFileSender | null;
  discord?: () => OwnerFileSender | null;
  slack?: () => OwnerFileSender | null;
}

const attachmentRefSchema: ActionSchemaObject = {
  type: 'object',
  required: ['observationRef'],
  additionalProperties: false,
  properties: {
    observationRef: {
      type: 'string',
      pattern: '\\S',
      description: 'Exact stored observation handle returned by source.search, e.g. "obs_test".',
    },
  },
};

const attachmentDownloadSchema: ActionSchemaObject = {
  type: 'object',
  required: ['observationRef', 'fileId'],
  additionalProperties: false,
  properties: {
    observationRef: {
      type: 'string',
      pattern: '\\S',
      description: 'Exact stored observation handle carrying the message attachment.',
    },
    fileId: {
      type: 'string',
      pattern: '\\S',
      description: 'Provider file id returned by source.attachment.list.',
    },
  },
};

const ownerFileSchema: ActionSchemaObject = {
  type: 'object',
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      pattern: '\\S',
      description: 'Absolute path under the workspace files directory.',
    },
    caption: {
      type: 'string',
      maxLength: 1_024,
      description: 'Optional file caption.',
    },
  },
};

type StoredAttachmentObservation = {
  observationRef: string;
  source: string;
  sourceAt?: number | null;
  channel?: string | null;
  author?: string | null;
  metadata?: Record<string, unknown>;
  content?: string;
};

function requiredStoredReader(ports: AttachmentActionPorts): StoredSourceReader {
  if (!ports.stored) {
    const error = new Error('Stored source reader is not configured for attachment actions');
    error.name = 'attachment_source_unavailable';
    throw error;
  }
  return ports.stored;
}

function sourceAllowance(
  context: ActionContext
): Pick<MemoryReadAllowance, 'maxSourceMs'> | undefined {
  return context.readAllowance?.maxSourceMs === undefined
    ? undefined
    : { maxSourceMs: context.readAllowance.maxSourceMs };
}

async function readObservation(
  ports: AttachmentActionPorts,
  input: Record<string, unknown>,
  context: ActionContext
): Promise<StoredAttachmentObservation> {
  const observationRef = input.observationRef;
  if (typeof observationRef !== 'string' || observationRef.trim() === '') {
    throw new Error('attachment action requires observationRef');
  }
  const result = await requiredStoredReader(ports).readObservation(
    observationRef,
    context.access,
    sourceAllowance(context)
  );
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Stored observation ${observationRef} is malformed`);
  }
  const observation = result as unknown as StoredAttachmentObservation;
  if (typeof observation.source !== 'string' || observation.source.trim() === '') {
    throw new Error(`Stored observation ${observationRef} has no connector source`);
  }
  return observation;
}

function providerFor(
  ports: AttachmentActionPorts,
  source: string
): ReturnType<typeof attachmentConnector> {
  if (source !== 'chatwork' && source !== 'slack') {
    const error = new Error(
      `Connector ${source} does not support source attachments. Supported connectors: chatwork, slack.`
    );
    error.name = 'invalid_input';
    throw error;
  }
  const registry = ports.connectors?.();
  if (!registry) throw new Error(`Connector registry is not available for ${source} attachments`);
  const connector = registry.get(source);
  if (!connector) throw new Error(`Connector ${source} is not active for attachments`);
  return attachmentConnector(connector);
}

function record(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : ''))
    .map((item) => item.trim())
    .filter(Boolean);
}

function roomIdFor(observation: StoredAttachmentObservation): string {
  const metadata = observation.metadata ?? {};
  const direct = metadata.roomId ?? metadata.chatworkRoomId ?? metadata.channelId;
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  if (typeof direct === 'number' && Number.isSafeInteger(direct)) return String(direct);
  const originalChannel = metadata.originalChannel;
  if (typeof originalChannel === 'string') {
    if (observation.source === 'chatwork' && /^\d+$/.test(originalChannel.trim())) {
      return originalChannel.trim();
    }
    const separator = originalChannel.indexOf(':');
    if (separator > 0 && originalChannel.slice(0, separator) === observation.source) {
      const suffix = originalChannel.slice(separator + 1).trim();
      if (suffix !== '') return suffix;
    }
  }
  throw new Error(`Observation ${observation.observationRef} has no ${observation.source} room id`);
}

function idsFor(observation: StoredAttachmentObservation): {
  ids: string[];
  fileIdRule: Extract<AttachmentMatchRule, 'metadata_file_id' | 'text_marker'> | undefined;
} {
  const metadata = observation.metadata;
  if (observation.source === 'chatwork') {
    const ids = record(metadata, 'chatworkFileIds');
    if (ids.length > 0) return { ids, fileIdRule: 'metadata_file_id' };
    const contentIds = extractChatworkFileIds(observation.content ?? '');
    return { ids: contentIds, fileIdRule: contentIds.length > 0 ? 'text_marker' : undefined };
  }
  const ids = record(metadata, 'slackFileIds');
  if (ids.length > 0) return { ids, fileIdRule: 'metadata_file_id' };
  const contentIds = extractSlackFileIds(observation.content ?? '');
  return { ids: contentIds, fileIdRule: contentIds.length > 0 ? 'text_marker' : undefined };
}

export function safeFileName(name: string): string {
  // Keep the provider's name readable (the owner receives this file); drop only what could
  // leave the directory or break a path.
  const safe = [...name]
    .map((char) =>
      char === '/' || char === '\\' || char < ' ' || (char >= '\u007f' && char <= '\u009f')
        ? '_'
        : char
    )
    .join('');
  if (safe === '' || safe === '.' || safe === '..') throw new Error('Attachment filename is empty');
  return safe;
}

function attachmentRequest(observation: StoredAttachmentObservation): AttachmentListRequest {
  const { ids, fileIdRule } = idsFor(observation);
  return {
    roomId: roomIdFor(observation),
    sourceAtMs: observation.sourceAt ?? null,
    ...(observation.metadata?.accountId === undefined
      ? {}
      : { accountId: String(observation.metadata.accountId) }),
    ...(typeof observation.author === 'string' ? { author: observation.author } : {}),
    ...(observation.metadata?.messageId === undefined
      ? {}
      : { messageId: String(observation.metadata.messageId) }),
    ...(ids.length === 0 ? {} : { fileIds: ids }),
    ...(fileIdRule === undefined ? {} : { fileIdRule }),
  };
}

function workspaceFilesRoot(ports: AttachmentActionPorts): string {
  if (!ports.workspaceDir?.trim())
    throw new Error('Attachment workspace directory is not configured');
  return join(ports.workspaceDir, 'files');
}

export function createAttachmentActionRegistrations(
  ports: AttachmentActionPorts,
  ownerPrincipalId: string
): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'source.attachment.list',
        summary:
          'List files attached to one preserved Chatwork or Slack observation, including the matching rule, provider file id, name, size, and upload time. Other sources have no attachment support and fail as invalid input. Download a listed file with source.attachment.download and its fileId.',
        inputSchema: attachmentRefSchema,
        examples: [{ title: 'List message attachments', input: { observationRef: 'obs_test' } }],
      },
      exec: async (input, context) => {
        const observation = await readObservation(ports, input as Record<string, unknown>, context);
        const provider = providerFor(ports, observation.source);
        const files = await provider.listAttachments(attachmentRequest(observation));
        return {
          observationRef: observation.observationRef,
          connector: observation.source,
          files,
        };
      },
    },
    {
      contract: {
        name: 'source.attachment.download',
        summary:
          'Download a file belonging to the cited Chatwork or Slack observation into the daemon downloads directory (read-only for the agent) and return its saved path and size.',
        inputSchema: attachmentDownloadSchema,
        examples: [
          {
            title: 'Fetch one listed attachment',
            input: { observationRef: 'obs_test', fileId: 'file_test' },
          },
        ],
      },
      exec: async (input, context) => {
        const values = input as Record<string, unknown>;
        const fileId = values.fileId;
        if (typeof fileId !== 'string' || fileId.trim() === '')
          throw new Error('fileId is required');
        const observation = await readObservation(ports, values, context);
        const provider = providerFor(ports, observation.source);
        const roomId = roomIdFor(observation);
        const request = attachmentRequest(observation);
        const unrelated = request.fileIds !== undefined && !request.fileIds.includes(fileId);
        const listed = unrelated
          ? []
          : await provider.listAttachments({
              ...request,
              ...(request.fileIds === undefined ? {} : { fileIds: [fileId] }),
            });
        const descriptor = listed.find((file) => file.fileId === fileId);
        if (!descriptor) {
          throw new Error(
            `File ${fileId} does not belong to observation ${observation.observationRef} room ${roomId}`
          );
        }
        const downloadsDir =
          ports.principalPaths?.(context.access.principalId).downloadsDir ?? ports.downloadsDir;
        if (!downloadsDir?.trim())
          throw new Error('Attachment downloads directory is not configured');
        const targetDir = join(downloadsDir, observation.source, safeFileName(roomId));
        mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const targetPath = join(
          targetDir,
          `${safeFileName(fileId)}_${safeFileName(descriptor.name)}`
        );
        const downloaded = await provider.downloadAttachment({
          roomId,
          fileId,
          targetPath,
        });
        const size = statSync(targetPath).size;
        if (size !== downloaded.size) {
          throw new Error(`Downloaded file ${fileId} size changed while saving`);
        }
        return {
          observationRef: observation.observationRef,
          connector: observation.source,
          fileId,
          path: targetPath,
          size,
        };
      },
    },
    // A messenger's file action exists only when its sender is wired: the daemon wires the
    // messengers that are enabled with file_delivery on, so the agent sees no file route it lacks.
    ...(['telegram', 'discord', 'slack'] as const)
      .filter((messenger) => ports[messenger] !== undefined)
      .map((messenger) => ({
        contract: {
          name: `deliver.${messenger}.file`,
          summary: `Send one regular file under the caller's workspace files directory through ${messenger}; images and documents use the messenger upload API.`,
          inputSchema: ownerFileSchema,
          examples: [
            { title: 'Send a workspace result', input: { path: '/workspace/files/result.xlsx' } },
          ],
        },
        exec: async (input: unknown, context: ActionContext) => {
          const values = input as Record<string, unknown>;
          const path = values.path;
          if (typeof path !== 'string' || path.trim() === '') throw new Error('path is required');
          if (typeof context.operationId !== 'string' || context.operationId.trim() === '') {
            throw new Error(`deliver.${messenger}.file requires an operation id`);
          }
          const sender = ports[messenger]?.();
          if (!sender) throw new Error(`${messenger} file delivery port is not configured`);
          const isMember = context.access.principalId !== ownerPrincipalId;
          // A member without its own paths must never inherit the owner's file authority.
          if (isMember && !ports.principalPaths)
            throw new Error('Member file delivery requires principal paths');
          const filesRoot = workspaceFilesRoot(
            ports.principalPaths
              ? { workspaceDir: ports.principalPaths(context.access.principalId).workspaceDir }
              : ports
          );
          const validated = validateWorkspaceFile(
            filesRoot,
            path,
            OWNER_FILE_MAX_UPLOAD_BYTES,
            isMember
          );
          const caption = values.caption === undefined ? undefined : String(values.caption);
          const result =
            isMember && messenger === 'telegram'
              ? await sender.sendFile(validated.path, caption, context.operationId, {
                  access: context.access,
                  filesRoot,
                })
              : await sender.sendFile(validated.path, caption, context.operationId);
          return { path: validated.path, ...result };
        },
      })),
  ];
}

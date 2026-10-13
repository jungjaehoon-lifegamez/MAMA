import type { ActionRegistration } from '@jungjaehoon/mama-core';
import { homedir } from 'node:os';
import { credentialReadPaths } from '../runtime/backend-security.js';
import { createDocumentRenderer, type DocumentRenderOptions } from '../tools/document-render.js';

export interface DocumentActionPorts extends DocumentRenderOptions {
  workspaceDir?: string;
  ownerPrincipalId: string;
  principalPaths?: (principalId: string) => { workspaceDir: string; runtimeRoot?: string };
  principalDeniedReadPaths?: (principalId: string) => readonly string[];
}

export function documentActionRegistrations(ports: DocumentActionPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'document.render',
        summary:
          "Render an office document or PDF in the caller's own workspace to PDF and page PNGs. Returns workspace-relative paths, page count and embedded fonts per page. Look at every PNG before sending the document. Requires the host's mama tools install; no packages can be installed by sessions. Maximum 50 MiB and 50 pages; a new output directory beside the input preserves existing files. PDF inputs are rasterized directly.",
        inputSchema: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              pattern: '\\S',
              description:
                'Absolute or workspace-relative office/PDF file path inside your own workspace.',
            },
          },
        },
      },
      exec: async (input, context) => {
        const path = (input as { path?: unknown }).path;
        if (typeof path !== 'string' || !path.trim())
          throw new Error('document.render requires a path');
        const personal = context.access.principalId !== ports.ownerPrincipalId;
        if (personal && !ports.principalPaths)
          throw new Error('Document render requires the caller workspace');
        const paths = personal
          ? ports.principalPaths!(context.access.principalId)
          : { workspaceDir: ports.workspaceDir };
        if (!paths.workspaceDir) throw new Error('Document render workspace is not configured');
        const extra =
          'runtimeRoot' in paths && typeof paths.runtimeRoot === 'string'
            ? credentialReadPaths(paths.runtimeRoot)
            : [];
        return createDocumentRenderer({
          ...ports,
          deniedReadPaths: [
            homedir(),
            ...(personal && ports.principalDeniedReadPaths
              ? ports.principalDeniedReadPaths(context.access.principalId)
              : (ports.deniedReadPaths ?? [])),
            ...extra,
          ],
        }).render(paths.workspaceDir, path);
      },
    },
  ];
}

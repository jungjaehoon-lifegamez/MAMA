import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  realpathSync,
  readFileSync,
  existsSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type { StoredSourceReader } from '../../src/api/stored-source-reader.js';
import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import {
  createAttachmentActionRegistrations,
  type AttachmentActionPorts,
} from '../../src/api/attachment-actions.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const access = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['source.attachment.list', 'source.attachment.download', 'deliver.telegram.file'],
  connectors: ['chatwork', 'slack'],
  connectorWideRead: ['chatwork', 'slack'],
  scopes: [],
} as unknown as ActionContext['access'];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mama-attachment-actions-'));
  roots.push(value);
  const workspace = join(realpathSync(value), 'workspace');
  mkdirSync(workspace);
  return workspace;
}

function observation(source: 'chatwork' | 'slack', metadata: Record<string, unknown>) {
  return {
    source,
    observationRef: 'obs-test',
    sourceId: `${source}:message-test`,
    sourceAt: 600_000,
    channel: source === 'chatwork' ? 'room-display' : 'channel-display',
    metadata,
    content: 'message body',
  };
}

function action(
  ports: AttachmentActionPorts,
  name: string
): NonNullable<ReturnType<typeof createAttachmentActionRegistrations>[number]>['exec'] {
  const registration = createAttachmentActionRegistrations(ports).find(
    (entry) => entry.contract.name === name
  );
  if (!registration) throw new Error(`missing test action ${name}`);
  return registration.exec;
}

function portsFor(
  workspaceDir: string,
  storedObservation: Record<string, unknown>,
  connector: object,
  telegram?: Record<string, unknown>
): AttachmentActionPorts {
  const stored = {
    readObservation: vi.fn().mockResolvedValue(storedObservation),
  } as unknown as StoredSourceReader;
  const registry = {
    get: vi.fn().mockReturnValue(connector),
  };
  return {
    stored,
    connectors: () => registry as never,
    workspaceDir,
    downloadsDir: join(dirname(workspaceDir), 'downloads'),
    telegram: () => telegram as never,
  };
}

async function chatwork(http: typeof fetch): Promise<ChatworkConnector> {
  vi.stubEnv('CHATWORK_ATTACHMENT_TEST_TOKEN', 'fixture-token');
  const connector = new ChatworkConnector(
    {
      enabled: true,
      pollIntervalMinutes: 5,
      channels: { '501': { role: 'hub', name: 'room-test' } },
      auth: { type: 'token', tokenName: 'CHATWORK_ATTACHMENT_TEST_TOKEN' },
    },
    { fetch: http }
  );
  await connector.init();
  return connector;
}

const chatworkFile = {
  file_id: 901,
  filename: 'fixture.pdf',
  filesize: 5,
  upload_time: 598,
};

describe('attachment actions', () => {
  it.each(['source.attachment.list', 'source.attachment.download'])(
    '%s reports unsupported connectors as invalid_input with supported connectors',
    async (name) => {
      const workspace = root();
      const stored = {
        ...observation('chatwork', { roomId: 'channel-test' }),
        source: 'synthetic',
      };
      const input = name.endsWith('.download')
        ? { observationRef: 'obs-test', fileId: 'file-test' }
        : { observationRef: 'obs-test' };

      await expect(
        action(portsFor(workspace, stored, {}), name)(input, {
          access,
          operationId: `unsupported-${name}`,
        })
      ).rejects.toMatchObject({
        name: 'invalid_input',
        message: expect.stringContaining('chatwork, slack'),
      });
    }
  );

  it('downloads outside the workspace when its directory is swapped during download', async () => {
    const workspace = root();
    const outside = root();
    const directory = join(workspace, 'files', 'chatwork', '501');
    mkdirSync(directory, { recursive: true });
    const http = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/files/901')) return Response.json(chatworkFile);
      if (url.endsWith('/files/901?create_download_url=1')) {
        return Response.json({
          ...chatworkFile,
          download_url: 'https://download.example.test/901',
        });
      }
      if (url === 'https://download.example.test/901') {
        renameSync(directory, `${directory}-original`);
        symlinkSync(outside, directory);
        return new Response('bytes');
      }
      throw new Error('Unexpected fixture request');
    });
    const download = action(
      portsFor(
        workspace,
        observation('chatwork', { roomId: '501', chatworkFileIds: ['901'] }),
        await chatwork(http)
      ),
      'source.attachment.download'
    );
    await expect(
      download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'swapped-directory' }
      )
    ).resolves.toMatchObject({
      path: join(dirname(workspace), 'downloads', 'chatwork', '501', '901_fixture.pdf'),
      size: 5,
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each(['metadata', 'text_marker'])(
    'downloads only the requested attachment with an unavailable sibling (%s)',
    async (kind) => {
      const workspace = root();
      const http = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/files/902')) return new Response(null, { status: 404 });
        if (url.endsWith('/files/901')) return Response.json(chatworkFile);
        if (url.endsWith('/files/901?create_download_url=1')) {
          return Response.json({
            ...chatworkFile,
            download_url: 'https://download.example.test/901',
          });
        }
        if (url === 'https://download.example.test/901') return new Response('bytes');
        throw new Error('Unexpected fixture request');
      });
      const stored = observation('chatwork', {
        roomId: '501',
        ...(kind === 'metadata' ? { chatworkFileIds: ['901', '902'] } : {}),
      });
      if (kind === 'text_marker')
        stored.content = '[download:901] valid [download:902] unavailable';
      const download = action(
        portsFor(workspace, stored, await chatwork(http)),
        'source.attachment.download'
      );
      const result = (await download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'requested-file' }
      )) as { path: string };
      expect(readFileSync(result.path, 'utf8')).toBe('bytes');
      expect(http.mock.calls.some(([url]) => String(url).includes('/files/902'))).toBe(false);
    }
  );

  it('refuses delivery when the files root itself is replaced by a symlink', async () => {
    const workspace = root();
    const outside = root();
    writeFileSync(join(outside, 'private.txt'), 'outside bytes');
    symlinkSync(outside, join(workspace, 'files'));
    const sender = { sendFile: vi.fn().mockResolvedValue({ size: 13, sentAs: 'document' }) };
    const deliver = action(
      { workspaceDir: workspace, telegram: () => sender },
      'deliver.telegram.file'
    );
    await expect(
      deliver(
        { path: join(workspace, 'files', 'private.txt') },
        { access, operationId: 'root-symlink' }
      )
    ).rejects.toThrow(/files.*directory|symlink/);
    expect(sender.sendFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      metadata: { roomId: '501', chatworkFileIds: [901] },
      content: 'message body',
      rule: 'metadata_file_id',
    },
    { metadata: { roomId: '501' }, content: '[download:901] fixture.pdf', rule: 'text_marker' },
  ])('fetches a Chatwork attachment directly from $rule', async ({ metadata, content, rule }) => {
    const http = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== 'https://api.chatwork.com/v2/rooms/501/files/901') {
        throw new Error(`Unexpected URL: ${input}`);
      }
      return Response.json(chatworkFile);
    });
    const stored = { ...observation('chatwork', metadata), content };
    const list = action(portsFor(root(), stored, await chatwork(http)), 'source.attachment.list');

    const result = await list({ observationRef: 'obs-test' }, { access, operationId: 'op-list' });

    expect(result).toMatchObject({
      files: [{ fileId: '901', name: 'fixture.pdf', matchedBy: rule }],
    });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('uses the stored uploader account id for Chatwork time matching', async () => {
    const http = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== 'https://api.chatwork.com/v2/rooms/501/files?account_id=3') {
        throw new Error(`Unexpected URL: ${input}`);
      }
      return Response.json([chatworkFile, { ...chatworkFile, file_id: 902, upload_time: 299 }]);
    });
    const stored = {
      ...observation('chatwork', { roomId: '501', accountId: 3, messageId: 'message-test' }),
      author: 'actor-test',
    };
    const list = action(portsFor(root(), stored, await chatwork(http)), 'source.attachment.list');

    const result = await list({ observationRef: 'obs-test' }, { access, operationId: 'op-list' });

    expect(result).toMatchObject({ files: [{ fileId: '901', matchedBy: 'upload_time' }] });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'resolves an imported Chatwork author with matching member=%s',
    async (matches) => {
      const http = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://api.chatwork.com/v2/rooms/501/members') {
          return Response.json([
            { account_id: 3, name: matches ? 'actor-imported' : 'actor-other' },
          ]);
        }
        if (url === 'https://api.chatwork.com/v2/rooms/501/files?account_id=3') {
          return Response.json([chatworkFile]);
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      const stored = {
        ...observation('chatwork', { originalChannel: 'chatwork:501' }),
        author: 'actor-imported',
      };
      const list = action(portsFor(root(), stored, await chatwork(http)), 'source.attachment.list');
      const result = list({ observationRef: 'obs-test' }, { access, operationId: 'op-list' });

      if (matches) {
        await expect(result).resolves.toMatchObject({
          files: [{ fileId: '901', matchedBy: 'upload_time' }],
        });
      } else {
        await expect(result).rejects.toThrow(/No Chatwork room member.*actor-imported/);
      }
      expect(http).toHaveBeenCalledTimes(matches ? 2 : 1);
    }
  );

  it('downloads a Chatwork file using direct room checks without listing files', async () => {
    const workspace = root();
    const http = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.chatwork.com/v2/rooms/501/files/901')
        return Response.json(chatworkFile);
      if (url === 'https://api.chatwork.com/v2/rooms/501/files/901?create_download_url=1') {
        return Response.json({
          ...chatworkFile,
          download_url: 'https://download.example.test/901',
        });
      }
      if (url === 'https://download.example.test/901') return new Response('bytes');
      throw new Error(`Unexpected URL: ${url}`);
    });
    const download = action(
      portsFor(
        workspace,
        observation('chatwork', { roomId: '501', chatworkFileIds: ['901'] }),
        await chatwork(http)
      ),
      'source.attachment.download'
    );

    const result = await download(
      { observationRef: 'obs-test', fileId: '901' },
      { access, operationId: 'op-download' }
    );

    const expectedPath = join(
      dirname(workspace),
      'downloads',
      'chatwork',
      '501',
      '901_fixture.pdf'
    );
    expect(result).toMatchObject({ path: expectedPath, size: 5 });
    expect(readFileSync(expectedPath, 'utf8')).toBe('bytes');
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('surfaces a room lookup 404 before creating a Chatwork download', async () => {
    const workspace = root();
    const http = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const download = action(
      portsFor(
        workspace,
        observation('chatwork', { roomId: '502', chatworkFileIds: ['901'] }),
        await chatwork(http)
      ),
      'source.attachment.download'
    );

    await expect(
      download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'op-download' }
      )
    ).rejects.toThrow(/file 901.*not available in room 502.*404/);
    expect(http.mock.calls.map(([url]) => url)).toEqual([
      'https://api.chatwork.com/v2/rooms/502/files/901',
    ]);
    expect(existsSync(join(workspace, 'files'))).toBe(false);
  });

  it('lists Slack attachments from the observation metadata and room', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: 'F-901',
          name: 'feedback-test.pdf',
          size: 1_234,
          uploadTime: 200_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi.fn(),
    };
    const list = action(
      portsFor(
        workspace,
        observation('slack', { channelId: 'channel-test', slackFileIds: ['F-901'] }),
        connector
      ),
      'source.attachment.list'
    );

    const result = await list({ observationRef: 'obs-test' }, { access, operationId: 'op-list' });

    expect(connector.listAttachments).toHaveBeenCalledWith({
      roomId: 'channel-test',
      sourceAtMs: 600_000,
      fileIds: ['F-901'],
      fileIdRule: 'metadata_file_id',
    });
    expect(result).toMatchObject({
      observationRef: 'obs-test',
      connector: 'slack',
      files: [{ fileId: 'F-901', name: 'feedback-test.pdf', matchedBy: 'metadata_file_id' }],
    });
  });

  it('lists a Slack attachment from the stored slack_file marker when metadata is absent', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([]),
      downloadAttachment: vi.fn(),
    };
    const stored = observation('slack', { channelId: 'channel-test' });
    stored.content = 'message body (slack_file:F-902)';
    const list = action(portsFor(workspace, stored, connector), 'source.attachment.list');

    await list({ observationRef: 'obs-test' }, { access, operationId: 'op-marker' });

    expect(connector.listAttachments).toHaveBeenCalledWith({
      roomId: 'channel-test',
      sourceAtMs: 600_000,
      fileIds: ['F-902'],
      fileIdRule: 'text_marker',
    });
  });

  it.each(['metadata', 'message'])(
    'refuses a same-room file unrelated to the observation (%s)',
    async (matching) => {
      const workspace = root();
      const http = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const file = { ...chatworkFile, message_id: 'other-message' };
        if (url.endsWith('/files?account_id=3')) return Response.json([file]);
        if (url.endsWith('/files/901')) return Response.json(file);
        if (url.endsWith('/files/902')) return Response.json({ ...file, file_id: 902 });
        if (url.endsWith('/files/901?create_download_url=1'))
          return Response.json({ ...file, download_url: 'https://download.example.test/901' });
        if (url === 'https://download.example.test/901') return new Response('bytes');
        throw new Error(`Unexpected fixture URL: ${url}`);
      });
      const stored = observation('chatwork', {
        roomId: '501',
        accountId: 3,
        messageId: 'cited-message',
        ...(matching === 'metadata' ? { chatworkFileIds: ['902'] } : {}),
      });
      const download = action(
        portsFor(workspace, stored, await chatwork(http)),
        'source.attachment.download'
      );
      await expect(
        download(
          { observationRef: 'obs-test', fileId: '901' },
          { access, operationId: 'wrong-observation' }
        )
      ).rejects.toThrow(/does not belong to observation/);
      expect(existsSync(join(workspace, 'files'))).toBe(false);
    }
  );

  it('ignores a symlink in the former workspace download directory', async () => {
    const workspace = root();
    const outside = root();
    mkdirSync(join(workspace, 'files'));
    symlinkSync(outside, join(workspace, 'files', 'chatwork'));
    const connector = {
      listAttachments: async () => [
        {
          fileId: '901',
          name: 'file.txt',
          size: 5,
          uploadTime: 600_000,
          matchedBy: 'metadata_file_id',
        },
      ],
      downloadAttachment: async ({ targetPath }: { targetPath: string }) => {
        writeFileSync(targetPath, 'bytes');
        return { size: 5 };
      },
    };
    const download = action(
      portsFor(
        workspace,
        observation('chatwork', { roomId: '501', chatworkFileIds: ['901'] }),
        connector
      ),
      'source.attachment.download'
    );
    await expect(
      download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'outside-directory' }
      )
    ).resolves.toMatchObject({
      path: join(dirname(workspace), 'downloads', 'chatwork', '501', '901_file.txt'),
      size: 5,
    });
    expect(existsSync(join(outside, '501', '901_file.txt'))).toBe(false);
  });

  it('downloads into the daemon downloads connector room directory and returns its size', async () => {
    const workspace = root();
    mkdirSync(join(workspace, 'files'), { recursive: true });
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: '901',
          name: 'feedback bad.pdf',
          size: 5,
          uploadTime: 600_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi.fn(async ({ targetPath }: { targetPath: string }) => {
        writeFileSync(targetPath, 'bytes');
        return {
          descriptor: {
            fileId: '901',
            name: 'feedback bad.pdf',
            size: 5,
            uploadTime: 600_000,
            matchedBy: 'upload_time',
          },
          size: 5,
        };
      }),
    };
    const download = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), connector),
      'source.attachment.download'
    );

    const result = await download(
      { observationRef: 'obs-test', fileId: '901' },
      { access, operationId: 'op-download' }
    );

    const expected = join(
      dirname(workspace),
      'downloads',
      'chatwork',
      '501',
      '901_feedback bad.pdf'
    );
    expect(connector.downloadAttachment).toHaveBeenCalledWith({
      roomId: '501',
      fileId: '901',
      targetPath: expected,
    });
    expect(result).toEqual({
      observationRef: 'obs-test',
      connector: 'chatwork',
      fileId: '901',
      path: expected,
      size: 5,
    });
  });

  it('surfaces a provider room refusal and does not create a download', async () => {
    const workspace = root();
    const connector = {
      listAttachments: vi.fn().mockResolvedValue([
        {
          fileId: '901',
          name: 'feedback-test.pdf',
          size: 5,
          uploadTime: 600_000,
          matchedBy: 'metadata_file_id',
        },
      ]),
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error('Chatwork file 901 is not available in room 501')),
    };
    const download = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), connector),
      'source.attachment.download'
    );

    await expect(
      download(
        { observationRef: 'obs-test', fileId: '901' },
        { access, operationId: 'op-download' }
      )
    ).rejects.toThrow(/not available in room 501/);
  });

  it('offers a file action only for messengers whose sender is wired', () => {
    const names = (ports: AttachmentActionPorts) =>
      createAttachmentActionRegistrations(ports)
        .map((entry) => entry.contract.name)
        .filter((name) => name.startsWith('deliver.'));
    expect(names({})).toEqual([]);
    expect(names({ telegram: () => null })).toEqual(['deliver.telegram.file']);
    expect(names({ telegram: () => null, slack: () => null })).toEqual([
      'deliver.telegram.file',
      'deliver.slack.file',
    ]);
  });

  it('refuses every Telegram path class outside the workspace files root', async () => {
    const workspace = root();
    const files = join(workspace, 'files');
    mkdirSync(files, { recursive: true });
    const outside = join(workspace, 'outside.txt');
    const regular = join(files, 'regular.txt');
    const symlink = join(files, 'link.txt');
    const directory = join(files, 'directory');
    const oversized = join(files, 'oversized.bin');
    writeFileSync(outside, 'outside');
    writeFileSync(regular, 'regular');
    symlinkSync(outside, symlink);
    mkdirSync(directory);
    writeFileSync(oversized, '');
    truncateSync(oversized, 50 * 1024 * 1024 + 1);
    const sender = { sendFile: vi.fn() };
    const deliver = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), {}, sender),
      'deliver.telegram.file'
    );

    await expect(deliver({ path: outside }, { access, operationId: 'op-outside' })).rejects.toThrow(
      /under the workspace files directory/
    );
    await expect(deliver({ path: symlink }, { access, operationId: 'op-symlink' })).rejects.toThrow(
      /symlink/
    );
    await expect(
      deliver({ path: directory }, { access, operationId: 'op-directory' })
    ).rejects.toThrow(/regular file/);
    await expect(deliver({ path: oversized }, { access, operationId: 'op-large' })).rejects.toThrow(
      /owner messenger upload limit/
    );
    expect(sender.sendFile).not.toHaveBeenCalled();
  });

  it('sends the validated path through the late-bound Telegram port with the operation id', async () => {
    const workspace = root();
    const files = join(workspace, 'files');
    mkdirSync(files, { recursive: true });
    const path = join(files, 'result.txt');
    writeFileSync(path, 'result');
    const sender = {
      sendFile: vi.fn().mockResolvedValue({ messageId: 22, sentAs: 'document', size: 6 }),
    };
    const deliver = action(
      portsFor(workspace, observation('chatwork', { roomId: '501' }), {}, sender),
      'deliver.telegram.file'
    );

    const result = await deliver(
      { path, caption: 'result caption' },
      { access, operationId: 'op-file' }
    );

    const realPath = realpathSync(path);
    expect(sender.sendFile).toHaveBeenCalledWith(realPath, 'result caption', 'op-file');
    expect(result).toMatchObject({ path: realPath, size: 6, sentAs: 'document' });
  });
});

/** Wiki actions bind native owner calls to the configured vault and file publisher. */
import type { ActionRegistration } from '@jungjaehoon/mama-core';
import {
  listWikiPages,
  normalizeWikiRelativePath,
  readWikiPageContent,
  readWikiPages,
  WIKI_LIST_MAX_PATHS,
  WIKI_READ_MAX_PAGE_CHARS,
} from '../wiki/wiki-read.js';
import { WIKI_PAGE_TYPES } from '../wiki/types.js';
import { moveWikiPages, WIKI_MOVE_MAX, type WikiMove } from '../wiki/wiki-move.js';
import { applyWikiEdits, readWikiSection, type WikiSectionEdit } from '../wiki/wiki-edits.js';
import { WIKI_HUMAN_MARKER } from '../wiki/wiki-read.js';
import {
  createWikiPublishAdapter,
  MAX_WIKI_PAGE_CONTENT_CHARS,
  type WikiPublishAdapter,
} from '../wiki-artifacts/wiki-publish-adapter.js';
import type { WikiPagePublisher, WikiPublishPageInput } from '../wiki-artifacts/types.js';

export interface WikiVaultBinding {
  path: string;
  name: string | null;
  /** Set once the CLI proves it targets this vault; host-owned mutable state. */
  verified?: boolean;
}

export interface WikiPorts {
  /** The configured wiki vault — absent until the wiki agent opens it. */
  vault?: WikiVaultBinding | null;
  /** The page writer the api routes bind (ObsidianWriter callback). */
  publisher?: WikiPagePublisher | null;
  /** An override publish adapter; defaults to createWikiPublishAdapter(publisher). */
  publishAdapter?: WikiPublishAdapter | null;
}

const namedError = (code: string, message: string): Error => {
  const error = new Error(message);
  error.name = code;
  return error;
};

function requireVault(ports: WikiPorts): WikiVaultBinding {
  if (!ports.vault) {
    throw namedError('TOOL_ERROR', 'Wiki vault path not configured');
  }
  return ports.vault;
}

export function wikiActionRegistrations(ports: WikiPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'manage.wiki.publish',
        recallableWrite: true,
        summary:
          'Publish wiki pages in the configured vault. pages is an array of page objects with required relative path, title, type and Markdown content string; type must be explicit and nonblank. Read an existing page first and pass its expectedContentVersion to update it; use null for a new versioned file. sourceRefs can name exact raw observations.',
        inputSchema: {
          type: 'object',
          required: ['pages'],
          properties: {
            pages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'title', 'type', 'content'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  title: { type: 'string', minLength: 1 },
                  type: { type: 'string', enum: WIKI_PAGE_TYPES },
                  content: { type: 'string', minLength: 1, maxLength: MAX_WIKI_PAGE_CONTENT_CHARS },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  expectedContentVersion: {
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                  },
                  sourceIds: { type: 'array', items: { type: 'string' } },
                  sourceRefs: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        examples: [
          {
            title: 'Publish one evidence-linked current-state page',
            input: {
              pages: [
                {
                  path: 'work/current.md',
                  title: 'Current work state',
                  type: 'synthesis',
                  content: '# Current work state\n\nDated facts, evidence, and open questions.',
                  expectedContentVersion: null,
                  sourceRefs: [{ kind: 'raw', connector: 'chatwork', id: 'obs_example' }],
                },
              ],
            },
          },
        ],
      },
      exec: (input) => {
        const pagesInput = (input as { pages?: WikiPublishPageInput[] }).pages;
        if (!pagesInput || !Array.isArray(pagesInput)) {
          throw namedError('TOOL_ERROR', 'manage.wiki.publish requires pages array');
        }
        const adapter =
          ports.publishAdapter ?? createWikiPublishAdapter({ publisher: ports.publisher });
        try {
          const publishResult = adapter.publish({ pages: pagesInput });
          return {
            success: true,
            message: `Wiki published: ${publishResult.pagesPublished} pages`,
            artifactsStored: publishResult.artifactsStored,
          };
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki publish failed'
          );
        }
      },
    },
    {
      contract: {
        name: 'manage.wiki.update',
        recallableWrite: true,
        summary:
          'Update one existing wiki page by sections instead of republishing it. Append-only edits can omit expectedContentVersion; any section replacement must pass the version from manage.wiki.read. Title, type and evidence ids are kept, and sourceIds adds evidence ids to the page metadata.',
        inputSchema: {
          type: 'object',
          required: ['path', 'edits'],
          properties: {
            path: { type: 'string', pattern: '^.+\\.md$' },
            expectedContentVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            edits: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                required: ['section'],
                properties: {
                  section: {
                    type: 'string',
                    minLength: 1,
                    description: 'The exact heading line of the page, e.g. "## History"',
                  },
                  append: { type: 'string', minLength: 1 },
                  replace: { type: 'string', minLength: 1 },
                },
              },
            },
            sourceIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
        examples: [
          {
            title: 'Rewrite a section whose knowledge changed',
            input: {
              path: 'projects/example.md',
              expectedContentVersion: 'a'.repeat(64),
              edits: [
                {
                  section: '## Decisions and specifications',
                  replace: '- Delivery files are PSD at 4K; layer names follow the client sheet.',
                },
              ],
            },
          },
        ],
      },
      exec: (input) => {
        const body = input as {
          path: string;
          expectedContentVersion?: string;
          edits: WikiSectionEdit[];
          sourceIds?: string[];
        };
        const vault = requireVault(ports);
        const path = normalizeWikiRelativePath(body.path);
        const current = readWikiPageContent(vault.path, path);
        if (current === null) {
          throw namedError(
            'TOOL_ERROR',
            `Wiki page not found: ${path}; create it with manage.wiki.publish`
          );
        }
        const page = parseWrittenPage(current.content);
        const requiresVersion = body.edits.some((edit) => edit.replace !== undefined);
        if (requiresVersion && body.expectedContentVersion === undefined) {
          const error = new Error(
            'Section replacement requires expectedContentVersion from manage.wiki.read'
          );
          error.name = 'invalid_input';
          throw error;
        }
        if (
          body.expectedContentVersion !== undefined &&
          current.version !== body.expectedContentVersion
        ) {
          // Carry what a retry needs, so a concurrent writer's change does not cost a whole-page read.
          const sections = Object.fromEntries(
            body.edits.map((edit) => [edit.section, readWikiSection(page.body, edit.section)])
          );
          throw namedError(
            'TOOL_ERROR',
            `Wiki page changed since it was read: ${path}; contentVersion is now ${current.version}; current text of the sections you edit: ${JSON.stringify(sections)}`
          );
        }
        let content: string;
        try {
          content = applyWikiEdits(page.body, body.edits);
        } catch (error) {
          // Name the page's headings so the retry needs no whole-page read.
          const headings = page.body.split('\n').filter((line) => /^#{1,6}\s/.test(line));
          throw namedError(
            'TOOL_ERROR',
            `${error instanceof Error ? error.message : 'Wiki edit failed'}; this page's headings: ${headings.join(' | ')}`
          );
        }
        const adapter =
          ports.publishAdapter ?? createWikiPublishAdapter({ publisher: ports.publisher });
        try {
          adapter.publish({
            pages: [
              {
                path,
                title: page.title,
                type: page.type ?? undefined,
                ...(page.confidence === null ? {} : { confidence: page.confidence }),
                content,
                expectedContentVersion: current.version,
                sourceIds: [...new Set([...page.sourceIds, ...(body.sourceIds ?? [])])],
              },
            ],
          });
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki update failed'
          );
        }
        const written = readWikiPageContent(vault.path, path);
        if (written === null)
          throw namedError('TOOL_ERROR', `Wiki page vanished after update: ${path}`);
        return { success: true, message: `Wiki updated: ${path}`, contentVersion: written.version };
      },
    },
    {
      contract: {
        name: 'manage.wiki.move',
        summary: `Move or rename wiki pages: moves lists up to ${WIKI_MOVE_MAX} {from, to} relative .md paths, and folders are made as needed. The batch moves all or none: a missing from, a to that exists, a path used twice and index.md/log.md are refused. Links to a moved page are not rewritten; fix the pages that link to it (Home.md) with manage.wiki.update.`,
        inputSchema: {
          type: 'object',
          required: ['moves'],
          properties: {
            moves: {
              type: 'array',
              minItems: 1,
              maxItems: WIKI_MOVE_MAX,
              items: {
                type: 'object',
                required: ['from', 'to'],
                properties: {
                  from: { type: 'string', pattern: '^.+\\.md$' },
                  to: { type: 'string', pattern: '^.+\\.md$' },
                },
              },
            },
          },
        },
        examples: [
          {
            title: 'Move a daily page into its month folder',
            input: {
              moves: [{ from: 'daily/2026-09-01.md', to: 'daily/2026-09/2026-09-01.md' }],
            },
          },
        ],
      },
      exec: (input) => {
        const vault = requireVault(ports);
        try {
          const moved = moveWikiPages(vault.path, (input as { moves: WikiMove[] }).moves);
          return { success: true, message: `Wiki pages moved: ${moved.length}`, moved };
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki move failed'
          );
        }
      },
    },
    {
      contract: {
        name: 'manage.wiki.read',
        summary:
          'List wiki paths with no paths (page using nextCursor and readVersion as list_cursor/list_version), or read exact relative .md paths from the configured wiki directory. Continue long page content using nextContentOffset and the same content_versions entry; restart if its version changes.',
        inputSchema: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string', pattern: '^.+\\.md$' } },
            list_cursor: { type: 'string', minLength: 1 },
            list_version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            list_limit: { type: 'integer', minimum: 1, maximum: WIKI_LIST_MAX_PATHS },
            content_offset: { type: 'integer', minimum: 0 },
            content_limit: { type: 'integer', minimum: 1, maximum: WIKI_READ_MAX_PAGE_CHARS },
            content_versions: { type: 'object' },
          },
        },
        examples: [
          { title: 'List wiki page paths', input: { list_limit: 50 } },
          {
            title: 'Read one current-state page',
            input: { paths: ['work/current.md'], content_limit: 4_000 },
          },
        ],
      },
      exec: (input) => {
        const vault = requireVault(ports);
        const readInput = input as {
          paths?: unknown;
          list_cursor?: unknown;
          list_version?: unknown;
          list_limit?: unknown;
          content_offset?: unknown;
          content_limit?: unknown;
          content_versions?: Record<string, string | null>;
        };
        try {
          const listing =
            readInput.paths === undefined ||
            (Array.isArray(readInput.paths) && readInput.paths.length === 0);
          if (listing) {
            if (
              readInput.content_offset !== undefined ||
              readInput.content_limit !== undefined ||
              readInput.content_versions !== undefined
            ) {
              throw new Error('manage.wiki.read list cannot combine with content read options');
            }
            return {
              success: true,
              ...listWikiPages({
                root: vault.path,
                cursor: readInput.list_cursor,
                version: readInput.list_version,
                limit: readInput.list_limit,
              }),
            };
          }
          if (
            readInput.list_cursor !== undefined ||
            readInput.list_version !== undefined ||
            readInput.list_limit !== undefined
          ) {
            throw new Error('manage.wiki.read content cannot combine with list options');
          }
          return {
            success: true,
            ...readWikiPages({
              root: vault.path,
              paths: readInput.paths,
              contentOffset: readInput.content_offset,
              contentLimit: readInput.content_limit,
              contentVersions: readInput.content_versions,
            }),
          };
        } catch (error) {
          throw namedError(
            'TOOL_ERROR',
            error instanceof Error ? error.message : 'Wiki read failed'
          );
        }
      },
    },
  ];
}

/**
 * A page as the writer stored it: frontmatter scalars (JSON-quoted), the source_ids list,
 * and the body without the title heading or the human section (the writer re-adds both).
 */
function parseWrittenPage(content: string): {
  title: string;
  type: string | null;
  confidence: string | null;
  sourceIds: string[];
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match)
    throw namedError(
      'TOOL_ERROR',
      'Wiki page has no frontmatter; republish it with manage.wiki.publish'
    );
  const scalar = (key: string): string | null => {
    const line = match[1]!.split('\n').find((candidate) => candidate.startsWith(`${key}: `));
    if (!line) return null;
    const raw = line.slice(key.length + 2).trim();
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  };
  const title = scalar('title');
  if (!title) throw namedError('TOOL_ERROR', 'Wiki page frontmatter has no title');
  const sourceIds: string[] = [];
  const lines = match[1]!.split('\n');
  const at = lines.indexOf('source_ids:');
  if (at !== -1) {
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith('  - ')) break;
      const raw = line.slice(4).trim();
      sourceIds.push(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
    }
  }
  let body = content.slice(match[0].length).replace(/^\s+/, '');
  if (body.startsWith(`# ${title}`)) body = body.slice(`# ${title}`.length).replace(/^\s+/, '');
  const human = body.indexOf(WIKI_HUMAN_MARKER);
  if (human !== -1) body = body.slice(0, human).trimEnd();
  return { title, type: scalar('type'), confidence: scalar('confidence'), sourceIds, body };
}

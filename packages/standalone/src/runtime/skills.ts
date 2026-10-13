import {
  isErasedRecord,
  readMemoryRecordById,
  readMemoryRecordsInScopes,
  type DatabaseInstance,
  type MemoryRecord,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { load } from 'js-yaml';
import { assertOwnedDirectory, assertToolsOwnership } from './tools-paths.js';
import { invalidInput } from '../utils/invalid-input.js';

export interface SkillPaths {
  workspace(principalId: string): string;
  toolsRoot?: string;
}
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  kind: 'workflow' | 'file';
  scope: 'personal' | 'common';
  topic?: string;
  applies_when?: string;
  path?: string;
  error?: string;
  revision?: string;
}
interface SkillFile {
  relativePath: string;
  path: string;
  bytes: Buffer;
  mode: number;
}
interface FileSkill {
  name: string;
  description: string;
  text: string;
  files: SkillFile[];
}
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE_LIMIT = 128;
const FILE_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const FRONTMATTER_BYTES = 16 * 1024;

export function skillDenied(): Error {
  return Object.assign(new Error('Skill is not readable in this session'), { name: 'denied' });
}
function validateName(name: string): void {
  if (!NAME.test(name) || name === '.' || name === '..')
    throw invalidInput(
      'Invalid skill name: use up to 64 lowercase letters, digits, dots, underscores or hyphens'
    );
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
function entries(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
function createOwnedDirectory(path: string): void {
  try {
    assertOwnedDirectory(path);
  } catch (error) {
    if (!missing(error)) throw error;
    mkdirSync(path, { mode: 0o755 });
    assertOwnedDirectory(path);
  }
}
function within(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}
function assertSourcePath(base: string, path: string): void {
  if (!within(base, realpathSync(path))) throw invalidInput('Skill path escapes its source folder');
  for (let current = base; ; ) {
    if (lstatSync(current).isSymbolicLink()) throw invalidInput('Skill symlinks are refused');
    if (current === path) break;
    current = join(current, relative(current, path).split(sep)[0]!);
  }
}
/** Never traverse an agent-supplied alias, including the skills parent itself. */
function personalFolder(workspace: string, name: string): string {
  validateName(name);
  const base = realpathSync(workspace);
  const parent = join(base, 'skills');
  if (lstatSync(parent).isSymbolicLink())
    throw invalidInput('Skill source skills folder must not be a symlink');
  const folder = join(parent, name);
  if (lstatSync(folder).isSymbolicLink() || !within(base, realpathSync(folder)))
    throw invalidInput('Skill source must stay inside its workspace without symlinks');
  return folder;
}
/** Bound a snapshot before copying. No symlinks, special files or outside-file aliases. */
function readFolder(folder: string): FileSkill {
  const base = realpathSync(folder);
  const files: SkillFile[] = [];
  let total = 0;
  let count = 0;
  const walk = (path: string) => {
    if (++count > FILE_LIMIT * 2) throw invalidInput('Skill has too many file/directory entries');
    const meta = lstatSync(path);
    assertSourcePath(base, path);
    if (meta.isDirectory()) {
      for (const name of entries(path)) walk(join(path, name));
      return;
    }
    if (!meta.isFile() || meta.nlink !== 1)
      throw invalidInput('Skill files must be regular files without hard links');
    if (files.length >= FILE_LIMIT || meta.size > FILE_BYTES || total + meta.size > TOTAL_BYTES)
      throw invalidInput('Skill exceeds 128 files, 2 MiB per file or 8 MiB total');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (current.dev !== meta.dev || current.ino !== meta.ino || current.size !== meta.size)
        throw invalidInput('Skill file changed while being read');
      const bytes = Buffer.alloc(meta.size);
      // A bounded descriptor read cannot allocate an unbounded buffer if a file grows.
      let read = 0;
      while (read < bytes.length) {
        const size = readSync(fd, bytes, read, bytes.length - read, read);
        if (size === 0) break;
        read += size;
      }
      const after = fstatSync(fd);
      assertSourcePath(base, path);
      const named = lstatSync(path);
      if (
        read !== bytes.length ||
        after.size !== meta.size ||
        after.mtimeMs !== meta.mtimeMs ||
        named.dev !== meta.dev ||
        named.ino !== meta.ino ||
        named.nlink !== 1
      )
        throw invalidInput('Skill file changed while being read');
      files.push({ path, relativePath: relative(base, path), bytes, mode: meta.mode & 0o111 });
      total += bytes.length;
    } finally {
      closeSync(fd);
    }
  };
  walk(folder);
  const text = files.find((file) => file.relativePath === 'SKILL.md')?.bytes.toString('utf8');
  return { ...readMetadata(text), text: text!, files };
}

function readMetadata(text: string | undefined): Pick<FileSkill, 'name' | 'description'> {
  const frontmatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw invalidInput('SKILL.md requires frontmatter name and description');
  const metadata = load(frontmatter[1]!) as { name?: unknown; description?: unknown } | null;
  if (
    !metadata ||
    typeof metadata.name !== 'string' ||
    typeof metadata.description !== 'string' ||
    !metadata.description.trim()
  )
    throw invalidInput('SKILL.md requires frontmatter name and description');
  validateName(metadata.name);
  if (metadata.description.length > 2_000)
    throw invalidInput('Skill description exceeds 2000 characters');
  return { name: metadata.name, description: metadata.description.trim() };
}

/** Inventory reads file names/mtimes, and at most 16 KiB of SKILL.md frontmatter. */
function listFolder(
  folder: string
): Pick<FileSkill, 'name' | 'description'> & { revision: string } {
  const base = realpathSync(folder);
  const revision = createHash('sha256');
  let count = 0;
  const walk = (path: string) => {
    if (++count > FILE_LIMIT * 2) throw invalidInput('Skill has too many file/directory entries');
    const meta = lstatSync(path);
    assertSourcePath(base, path);
    revision.update(JSON.stringify([relative(base, path), meta.mtimeMs, meta.size]));
    if (meta.isDirectory()) {
      for (const name of entries(path)) walk(join(path, name));
    } else if (!meta.isFile() || meta.nlink !== 1) {
      throw invalidInput('Skill files must be regular files without hard links');
    }
  };
  walk(folder);
  const path = join(base, 'SKILL.md');
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const meta = fstatSync(fd);
    if (!meta.isFile() || meta.nlink !== 1 || meta.dev !== before.dev || meta.ino !== before.ino)
      throw invalidInput('Skill file changed while being read');
    const bytes = Buffer.alloc(Math.min(meta.size, FRONTMATTER_BYTES));
    let offset = 0;
    let text = '';
    while (offset < bytes.length) {
      const size = readSync(fd, bytes, offset, Math.min(4096, bytes.length - offset), offset);
      if (size === 0) break;
      offset += size;
      text = bytes.subarray(0, offset).toString('utf8');
      if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) break;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (
      after.size !== meta.size ||
      after.mtimeMs !== meta.mtimeMs ||
      named.dev !== meta.dev ||
      named.ino !== meta.ino
    )
      throw invalidInput('Skill file changed while being read');
    return { ...readMetadata(text), revision: revision.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** Published trees are sealed; never follow a link while making one removable. */
function removeVersion(path: string): void {
  const unseal = (path: string) => {
    const meta = lstatSync(path);
    if (meta.isSymbolicLink()) return;
    chmodSync(path, meta.isDirectory() ? 0o755 : 0o644);
    if (meta.isDirectory()) for (const name of entries(path)) unseal(join(path, name));
  };
  unseal(path);
  rmSync(path, { recursive: true });
}

export function createSkillStore(ports: {
  adapter: DatabaseInstance;
  commonPrincipalId: string;
  commonScopes(): readonly MemoryScopeRef[];
  paths?: SkillPaths;
}) {
  const personalScopes = (id: string): MemoryScopeRef[] =>
    id === ports.commonPrincipalId ? [] : [{ kind: 'user', id }];
  const workflowScopes = (id: string): MemoryScopeRef[] => [
    ...ports.commonScopes(),
    ...personalScopes(id),
  ];
  const isCommon = (record: MemoryRecord) =>
    record.scopes.some((scope) =>
      ports.commonScopes().some((common) => common.kind === scope.kind && common.id === scope.id)
    );
  const workflows = async (id: string): Promise<MemoryRecord[]> =>
    (
      await readMemoryRecordsInScopes(ports.adapter, workflowScopes(id), {
        kind: 'workflow',
        status: 'active',
        excludeAmendments: true,
      })
    ).filter((record): record is MemoryRecord => !isErasedRecord(record));
  const fileEntry = (
    skill: Pick<FileSkill, 'name' | 'description'> & { revision?: string },
    scope: SkillEntry['scope'],
    path: string
  ): SkillEntry => ({
    id: `file:${scope}:${skill.name}`,
    name: skill.name,
    description: skill.description,
    kind: 'file',
    scope,
    path,
    ...(skill.revision === undefined ? {} : { revision: skill.revision }),
  });
  const commonRoot = () =>
    ports.paths?.toolsRoot ? join(ports.paths.toolsRoot, 'skills') : undefined;
  /** The host alone creates these links; source skills never contain a link. */
  const publishedFolder = (name: string): string => {
    validateName(name);
    const root = commonRoot();
    if (!root) throw skillDenied();
    assertOwnedDirectory(root);
    const pointer = join(root, name);
    const meta = lstatSync(pointer);
    if (!meta.isSymbolicLink() || meta.uid !== process.getuid?.())
      throw invalidInput('Common skill must have a host-owned publication link');
    const target = readlinkSync(pointer);
    if (
      isAbsolute(target) ||
      !target.startsWith(`.versions/${name}-`) ||
      target.split('/').length !== 2
    )
      throw invalidInput('Common skill publication escapes its version folder');
    const folder = join(root, target);
    assertOwnedDirectory(join(root, '.versions'));
    assertOwnedDirectory(folder);
    if (!within(realpathSync(join(root, '.versions')), realpathSync(folder)))
      throw invalidInput('Common skill publication escapes its version folder');
    return folder;
  };
  const list = async (id: string): Promise<SkillEntry[]> => {
    const skills: SkillEntry[] = (await workflows(id)).map((record) => ({
      id: record.id,
      name: record.topic,
      topic: record.topic,
      description: record.summary,
      applies_when: record.applies_when,
      kind: 'workflow',
      scope: isCommon(record) ? 'common' : 'personal',
    }));
    const invalid = (scope: SkillEntry['scope'], name: string, path: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      skills.push({
        id: `file:${scope}:${name}`,
        name,
        kind: 'file',
        scope,
        path,
        description: `Invalid skill: ${message}`,
        error: message,
      });
      if (scope === 'common') console.error('[Skills] Common folder host error', path, message);
    };
    const listFiles = (
      scope: SkillEntry['scope'],
      parent: string,
      folder: (name: string) => string
    ) => {
      let names: string[];
      try {
        if (lstatSync(parent).isSymbolicLink())
          throw invalidInput('Skills folder must not be a symlink');
        names = entries(parent);
        if (scope === 'common') assertOwnedDirectory(parent);
      } catch (error) {
        if (!missing(error)) invalid(scope, 'skills', parent, error);
        return;
      }
      for (const name of names) {
        if (!NAME.test(name)) continue;
        try {
          const meta = lstatSync(join(parent, name));
          if (!meta.isDirectory() && !meta.isSymbolicLink()) continue;
          const skill = listFolder(folder(name));
          if (skill.name !== name)
            throw invalidInput('Skill frontmatter name must match its folder');
          skills.push(fileEntry(skill, scope, join(parent, name)));
        } catch (error) {
          invalid(scope, name, join(parent, name), error);
        }
      }
    };
    if (ports.paths && id !== ports.commonPrincipalId) {
      try {
        const workspace = ports.paths.workspace(id);
        listFiles('personal', join(workspace, 'skills'), (name) => personalFolder(workspace, name));
      } catch (error) {
        invalid('personal', 'skills', 'skills', error);
      }
    }
    const root = commonRoot();
    if (root) listFiles('common', root, publishedFolder);
    return skills.sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  };
  const read = async (id: string, skillId: string) => {
    if (skillId.startsWith('file:')) {
      const match = /^file:(personal|common):([^:]+)$/.exec(skillId);
      if (!match || !ports.paths) throw skillDenied();
      const scope = match[1] as 'personal' | 'common';
      const name = match[2]!;
      if (scope === 'personal' && id === ports.commonPrincipalId) throw skillDenied();
      const folder =
        scope === 'personal'
          ? personalFolder(ports.paths.workspace(id), name)
          : publishedFolder(name);
      const skill = readFolder(folder);
      if (skill.name !== name) throw invalidInput('Skill frontmatter name must match its folder');
      return {
        ...fileEntry(skill, scope, folder),
        text: skill.text,
        files: skill.files.map(({ path, relativePath, bytes }) => ({
          path,
          relativePath,
          size: bytes.length,
        })),
      };
    }
    const record = await readMemoryRecordById(ports.adapter, skillId, workflowScopes(id));
    if (!record || isErasedRecord(record) || record.kind !== 'workflow') throw skillDenied();
    return {
      ...record,
      name: record.topic,
      description: record.summary,
      scope: isCommon(record) ? ('common' as const) : ('personal' as const),
    };
  };
  const installed = () => {
    const root = ports.paths?.toolsRoot;
    if (!root)
      throw invalidInput(
        'Common file skills require tools_root; run mama tools install on the host'
      );
    assertToolsOwnership(root);
    try {
      assertOwnedDirectory(root);
      const marker = join(root, '.mama-document-toolkit');
      const meta = lstatSync(marker);
      if (
        !meta.isFile() ||
        meta.uid !== process.getuid?.() ||
        readFileSync(marker, 'utf8') !== 'mama-document-toolkit-v1\n'
      )
        throw invalidInput(
          'Common file skills require a managed toolkit; run mama tools install on the host'
        );
    } catch (error) {
      if (missing(error))
        throw invalidInput(
          'Common file skills require tools_root; run mama tools install on the host'
        );
      throw error;
    }
    return root;
  };
  const publish = (name: string) => {
    validateName(name);
    const tools = installed();
    const source = personalFolder(ports.paths!.workspace(ports.commonPrincipalId), name);
    const skill = readFolder(source);
    if (skill.name !== name) throw invalidInput('Skill frontmatter name must match its folder');
    const root = join(tools, 'skills');
    const versions = join(root, '.versions');
    createOwnedDirectory(root);
    createOwnedDirectory(versions);
    const version = `${name}-${randomUUID()}`;
    const target = join(versions, version);
    const pointer = join(root, name);
    const temp = join(root, `.publish-${randomUUID()}`);
    let previous: string | undefined;
    try {
      previous = publishedFolder(name);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    mkdirSync(target, { mode: 0o755 });
    try {
      for (const file of skill.files) {
        const path = join(target, file.relativePath);
        mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o755 });
        writeFileSync(path, file.bytes, { flag: 'wx', mode: file.mode ? 0o555 : 0o444 });
      }
      const seal = (path: string) => {
        for (const entry of entries(path)) {
          const child = join(path, entry);
          if (lstatSync(child).isDirectory()) seal(child);
        }
        chmodSync(path, 0o555);
      };
      seal(target);
      symlinkSync(join('.versions', version), temp);
      renameSync(temp, pointer); // One atomic replacement; readers see one complete immutable version.
    } catch (error) {
      rmSync(temp, { force: true });
      removeVersion(target);
      throw error;
    }
    pruneVersions(name, new Set([target, ...(previous ? [previous] : [])]));
    return { name, path: pointer, status: 'published' as const };
  };
  const pruneVersions = (name: string, keep: ReadonlySet<string>) => {
    const versions = join(commonRoot()!, '.versions');
    assertOwnedDirectory(versions);
    const versionName = new RegExp(
      `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
    );
    for (const entry of entries(versions)) {
      const path = join(versions, entry);
      if (!versionName.test(entry) || keep.has(path)) continue;
      assertOwnedDirectory(path);
      removeVersion(path);
    }
  };
  const unpublish = (name: string) => {
    validateName(name);
    installed();
    publishedFolder(name);
    rmSync(join(commonRoot()!, name));
    pruneVersions(name, new Set());
    return { name, status: 'unpublished' as const };
  };
  return { list, read, workflows, workflowScopes, publish, unpublish };
}
export type SkillStore = ReturnType<typeof createSkillStore>;

/** Full inventory is remembered locally; only capped names/descriptions reach a turn. */
export function createSkillTurnContext(list: () => Promise<SkillEntry[]>) {
  const sessions = new Map<string, Map<string, { name: string; revision?: string }>>();
  return async (
    isNewSession: boolean,
    stateless = false,
    sessionKey = 'runtime'
  ): Promise<string> => {
    const previous = sessions.get(sessionKey);
    const skills = await list();
    const current = new Map(
      skills.map((skill) => [
        `${skill.scope}:${skill.id}`,
        { name: skill.name, revision: skill.revision },
      ])
    );
    const oneLine = (text: string) =>
      text
        .replace(/[\r\n<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
    let text: string;
    if (isNewSession || stateless || previous === undefined) {
      const lines: string[] = [];
      let size = 0;
      for (const skill of skills.slice(0, 24)) {
        const line = `- ${oneLine(skill.name)} (${skill.kind}, ${skill.scope}; skill.read ${skill.id}): ${oneLine(skill.description)}`;
        if (size + line.length > 3_600) break;
        lines.push(line);
        size += line.length + 1;
      }
      text = [
        '[skills]',
        ...lines,
        ...(skills.length > lines.length
          ? [`${skills.length - lines.length} more; use skill.list.`]
          : []),
        skills.length
          ? 'Read the steps with skill.read; choose relevance yourself.'
          : 'No skills saved yet; use skill.list to check later.',
      ].join('\n');
    } else {
      const added = [...current]
        .filter(([id]) => !previous.has(id))
        .map(([, skill]) => oneLine(skill.name));
      const removed = [...previous]
        .filter(([id]) => !current.has(id))
        .map(([, skill]) => oneLine(skill.name));
      const updated = [...current]
        .filter(([id, skill]) => previous.has(id) && previous.get(id)!.revision !== skill.revision)
        .map(([, skill]) => oneLine(skill.name));
      text =
        added.length || removed.length || updated.length
          ? `[skills changed] added: ${added.slice(0, 24).join(', ') || 'none'}; removed: ${removed.slice(0, 24).join(', ') || 'none'}; updated: ${updated.slice(0, 24).join(', ') || 'none'}; use skill.list and skill.read.${added.length + removed.length + updated.length > 24 ? ' More changes in skill.list.' : ''}`
          : '';
    }
    if (!stateless) sessions.set(sessionKey, current);
    return text;
  };
}

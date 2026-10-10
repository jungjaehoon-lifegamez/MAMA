import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import {
  createPrincipalRepository,
  exportPrincipalRecords,
  erasePrincipalRecords,
  type ActionContract,
  type ActionRegistration,
  type JudgmentAccess,
  type PrincipalErasureReceipt,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { RawStore } from '../storage/source-archive.js';
import type { OwnerMessageLedger } from '../gateways/telegram-message-ledger.js';
import { memberPaths, memberClaudeTmpDir } from '../runtime/member-paths.js';
import type { createSerialTurnChain } from '../runtime/principal-sessions.js';
import { physicalReadPath } from '../runtime/backend-security.js';
import { OWNER_FILE_MAX_UPLOAD_BYTES, type TelegramFileSender } from './file-delivery.js';

export interface MemberRecordsTelegram extends TelegramFileSender {
  /** Host-only member DM, resolved from current registry access; true means Telegram accepted it. */
  sendMemberText(access: JudgmentAccess, text: string, operationId: string): Promise<boolean>;
}
export interface MemberRecordsPorts {
  root: string;
  rawStore: RawStore;
  mailbox(): Mailbox;
  ledger(): OwnerMessageLedger | undefined;
  telegram(): MemberRecordsTelegram | undefined;
  access(id: string): JudgmentAccess;
  turnChain: ReturnType<typeof createSerialTurnChain>;
  retire(id: string): Promise<void>;
  serve(id: string): void;
  recordExchange(id: string, ref: string, text: string, deliveryVerified: boolean): void;
}

// Writers: member-session.ts supplies the member codexHome/authSourcePath; the core
// CodexAppServerProcess copies auth to <codexHome>/auth.json. memberPaths supplies
// runtime/session-credential to startRuntime, whose writeCredential writes that exact file.
export const MEMBER_EXPORT_CREDENTIAL_FILES = [
  '.codex/auth.json',
  'runtime/session-credential',
] as const;
const archiveSuffix = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function memberTrees(root: string, id: string): string[] {
  const paths = memberPaths(root, id);
  const temp = memberClaudeTmpDir(id);
  // IDs are already safe path components; escape '-' too so the expression matches exactly.
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const archives = (parent: string, identity: string) =>
    existsSync(parent)
      ? readdirSync(parent)
          .filter((name) =>
            new RegExp(`^\\.retired-${escape(identity)}-${archiveSuffix}$`).test(name)
          )
          .map((name) => join(parent, name))
      : [];
  return [
    paths.runtimeRoot,
    temp,
    ...archives(root, id),
    ...archives(dirname(temp), basename(temp)),
  ].filter(existsSync);
}
interface MemberFile {
  path: string;
  name: string;
  size: number;
}
function filesInTrees(root: string, id: string): MemberFile[] {
  const files: MemberFile[] = [];
  const walk = (path: string, name: string, runtimeRoot: string | undefined) => {
    const stat = lstatSync(path);
    const local = runtimeRoot === undefined ? undefined : relative(runtimeRoot, path);
    if (stat.isDirectory()) {
      // NativeSession creates this exact temporary directory. Member folders named temp/tmp
      // elsewhere, and regular files in the member's separate Claude temp tree, are records.
      if (local === 'workspace/.tmp') return;
      for (const entry of readdirSync(path).sort())
        walk(join(path, entry), `${name}/${entry}`, runtimeRoot);
    } else if (stat.isFile()) {
      if (MEMBER_EXPORT_CREDENTIAL_FILES.some((file) => local === file)) return;
      if (
        local !== undefined &&
        new RegExp(`^workspace/files/member-export-${archiveSuffix}\\.zip$`).test(local)
      )
        return;
      if (stat.nlink !== 1) throw new Error(`Member export refuses a hard-linked file: ${name}`);
      files.push({ path, name, size: stat.size });
    }
  };
  const liveRuntime = memberPaths(root, id).runtimeRoot;
  for (const tree of memberTrees(root, id)) {
    const runtimeRoot =
      tree === liveRuntime ? tree : dirname(tree) === root ? join(tree, 'runtime') : undefined;
    walk(tree, `files/${basename(tree)}`, runtimeRoot);
  }
  return files;
}

const denied = () =>
  Object.assign(
    new Error(
      'Personal records require an active member own message turn and a later confirmation'
    ),
    { name: 'denied' }
  );
interface Token {
  value: string;
  principalId: string;
  inputId: number;
  issuedAt: number;
}
interface Scheduled {
  principalId: string;
  inputId: number;
  commandId: string;
}

function receiptText(
  core: PrincipalErasureReceipt | undefined,
  product: Record<string, number>,
  failure: unknown,
  step: string
): string {
  const stepNames: Record<string, string> = {
    retire: 'native session retirement',
    export_delivery: 'export delivery',
    core: 'personal records',
    chat_raw: 'chat records',
    message_ledger: 'delivery history',
  };
  const lines = [
    failure
      ? `Erasure stopped at ${stepNames[step] ?? step}: ${failure instanceof Error ? failure.message : String(failure)}.`
      : 'Your personal records and files were erased.',
  ];
  if (failure)
    lines.push(
      'Earlier steps are done. Make a new erasure request and pass its preview confirmationToken in a later member message to finish the rest.'
    );
  for (const [store, counts] of Object.entries(core?.counts ?? {})) {
    const nonZero = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([action, n]) => `${n} ${action === 'in_flight' ? 'in flight' : action}`);
    if (nonZero.length) lines.push(`${store}: ${nonZero.join(', ')}.`);
  }
  for (const [store, n] of Object.entries(product)) {
    if (n > 0 && !['files', 'fileBytes', 'fileTrees'].includes(store))
      lines.push(`${store}: ${n} deleted.`);
  }
  lines.push(
    `Files: ${product.files ?? 0} files, ${product.fileBytes ?? 0} bytes.`,
    'Your enrollment and grants are kept.'
  );
  return lines.join('\n');
}

export function createMemberRecords(options: {
  adapter: DatabaseInstance;
  isMessageTurn(ref: string, principalId: string): boolean;
  ports?: MemberRecordsPorts;
}) {
  const tokens = new Map<string, Token>();
  const scheduled = new Map<number, Scheduled>();
  const blocked = new Set<string>();
  const jobs = new Set<Promise<void>>();
  const ports = () => {
    if (!options.ports) throw new Error('Member records require member_root and delivery ports');
    return options.ports;
  };
  const dm = (access: JudgmentAccess) => {
    const targets = access.destinations?.filter((target) => target.kind === 'telegram');
    if (targets?.length !== 1 || !targets[0]!.id.trim())
      throw new Error('Member records require exactly one registered Telegram DM');
    return targets[0]!.id;
  };
  const productExport = (id: string) => {
    const p = ports();
    const ledger = p.ledger();
    if (!ledger) throw new Error('Live message ledger is not configured');
    const stores = {
      connector_event_index: options.adapter
        .prepare(
          "SELECT * FROM connector_event_index WHERE source_connector='chat' AND memory_scope_kind='user' AND memory_scope_id=? ORDER BY rowid"
        )
        .all(id),
      ...p.rawStore.exportScope('chat', 'user', id),
      message_ledger: ledger.listForTelegramDm(dm(p.access(id))),
    };
    return {
      stores,
      counts: Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, rows.length])),
    };
  };
  const buildAndSend = async (id: string, operationId: string) => {
    const p = ports();
    const core = exportPrincipalRecords(options.adapter, id);
    const product = productExport(id);
    const files = filesInTrees(p.root, id);
    const filesRoot = join(memberPaths(p.root, id).workspaceDir, 'files');
    // Reject linked ancestors before creating the output: validating only at upload is too late.
    if (physicalReadPath(filesRoot) !== resolve(filesRoot))
      throw new Error('Member export output directory must not be a symlink');
    mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
    const path = join(filesRoot, `member-export-${randomUUID()}.zip`);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    let size = 0;
    let finished = false;
    const zip = new Zip((error, chunk, final) => {
      if (error) throw error;
      writeSync(fd, chunk);
      size += chunk.length;
      finished = final;
    });
    try {
      const json = (name: string, value: unknown) => {
        const entry = new ZipDeflate(name, { level: 6 });
        zip.add(entry);
        entry.push(strToU8(JSON.stringify(value)), true);
      };
      json('core.json', core);
      json('product.json', product);
      const buffer = Buffer.alloc(64 * 1024);
      for (const file of files) {
        const input = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(input);
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error(`Member export file changed: ${file.name}`);
          const entry = new ZipDeflate(file.name, { level: 6 });
          zip.add(entry);
          let count: number;
          while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0)
            entry.push(buffer.subarray(0, count));
          entry.push(new Uint8Array(), true);
        } finally {
          closeSync(input);
        }
      }
      zip.end();
      if (!finished) throw new Error('Member export zip did not finish');
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    try {
      if (size > OWNER_FILE_MAX_UPLOAD_BYTES)
        throw new Error(
          `Member export is ${size} bytes; Telegram limit is ${OWNER_FILE_MAX_UPLOAD_BYTES} bytes (50 MiB)`
        );
      const telegram = p.telegram();
      if (!telegram) throw new Error('Member Telegram delivery is not configured');
      const result = await telegram.sendFile(path, undefined, operationId, {
        access: p.access(id),
        filesRoot,
      });
      // sendFile resolves only on Telegram acceptance or a verified delivered idempotent receipt.
      return {
        path,
        size,
        delivery: result,
        counts: { core: core.counts, product: product.counts },
      };
    } finally {
      rmSync(path, { force: true });
    }
  };
  const sendReceipt = async (job: Scheduled, text: string) => {
    const p = ports();
    let verified = false;
    try {
      verified = await p
        .telegram()!
        .sendMemberText(p.access(job.principalId), text, `${job.commandId}:receipt`);
    } catch (error) {
      console.error('[Member records] receipt delivery failed', error);
    }
    p.recordExchange(job.principalId, `host:${job.commandId}`, text, verified);
  };
  const enqueue = (work: () => Promise<void>) => {
    const pending = ports().turnChain(work);
    jobs.add(pending);
    void pending
      .catch((error) => console.error('[Member records] scheduled work failed', error))
      .finally(() => jobs.delete(pending));
  };
  const cancelConfirmation = (row: MailboxRow, outcome: 'dead' | 'uncertain', reason: string) => {
    const job = scheduled.get(row.id);
    if (!job || row.principalId !== job.principalId) return;
    scheduled.delete(row.id);
    blocked.delete(job.principalId);
    const text = `Erasure did not run because the confirming turn did not complete (${outcome}: ${reason}).\nYour personal records and files were kept. Make a new erasure request and confirm its preview in a later member message.\nYour enrollment and grants are kept.`;
    enqueue(() => sendReceipt(job, text));
  };
  const erase = async (job: Scheduled) => {
    const p = ports();
    const { principalId: id, commandId } = job;
    const product: Record<string, number> = {};
    let core: PrincipalErasureReceipt | undefined;
    let failedStep = 'retire';
    let failure: unknown;
    try {
      p.mailbox().cancelQueued(id, 'member_erase');
      await p.retire(id);
      failedStep = 'export_delivery';
      await buildAndSend(id, `${commandId}:export`);
      failedStep = 'connector_event_index';
      product.connector_event_index = options.adapter
        .prepare(
          "DELETE FROM connector_event_index WHERE source_connector='chat' AND memory_scope_kind='user' AND memory_scope_id=?"
        )
        .run(id).changes;
      failedStep = 'core';
      core = erasePrincipalRecords(options.adapter, { principalId: id, commandId });
      failedStep = 'chat_raw';
      Object.assign(product, p.rawStore.eraseScope('chat', 'user', id));
      failedStep = 'message_ledger';
      const ledger = p.ledger();
      if (!ledger) throw new Error('Live message ledger is not configured');
      product.message_ledger = ledger.eraseTelegramDm(dm(p.access(id)));
      failedStep = 'files';
      product.files = 0;
      product.fileBytes = 0;
      product.fileTrees = 0;
      for (const tree of memberTrees(p.root, id)) {
        // Delete links as links, never traverse into an owner's or another member's directory.
        const remaining = filesInTrees(p.root, id).filter(
          (file) =>
            relative(tree, file.path) !== '..' && !relative(tree, file.path).startsWith('../')
        );
        rmSync(tree, { recursive: true, force: true });
        product.files += remaining.length;
        product.fileBytes += remaining.reduce((n, file) => n + file.size, 0);
        product.fileTrees++;
      }
    } catch (error) {
      failure = error;
    }
    try {
      p.serve(id);
      await sendReceipt(job, receiptText(core, product, failure, failedStep));
    } finally {
      blocked.delete(id);
    }
  };
  const registrations: ActionRegistration[] = [
    'records.export',
    'records.erase',
  ].map<ActionRegistration>((name) => ({
    contract: {
      name,
      summary:
        name === 'records.export'
          ? "Export the caller's personal records and files as one zip to their registered Telegram DM (50 MiB), excluding credentials. Only an active member's own message turn is allowed."
          : "Preview erasure of the caller's personal records and files. Pass the confirmationToken from this preview in a later member message to confirm. The host exports after that turn completes and erases only after Telegram accepts the export. Enrollment, grants and shared revisions are kept.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties:
          name === 'records.export'
            ? ({} as NonNullable<ActionContract['inputSchema']['properties']>)
            : { confirmationToken: { type: 'string', minLength: 1 } },
      },
    },
    exec: async (input, context) => {
      const id = context.access.principalId;
      const principal = createPrincipalRepository(options.adapter).findById(id);
      const ref = context.session?.sourceMessageRef;
      if (
        principal?.kind !== 'member' ||
        principal.status !== 'active' ||
        context.session?.replaySourceEndMs !== undefined ||
        !ref ||
        ref.startsWith('subagent:') ||
        !options.isMessageTurn(ref, id)
      )
        throw denied();
      const p = ports();
      const row = p.mailbox().readInput(ref, id);
      if (!row || row.kind !== 'owner_message' || blocked.has(id)) throw denied();
      if (name === 'records.export')
        return buildAndSend(id, `member-export:${id}:${row.id}:${randomUUID()}`);
      const value = (input as { confirmationToken?: string }).confirmationToken;
      if (value !== undefined) {
        const token = tokens.get(id);
        if (
          !token ||
          token.value !== value ||
          token.principalId !== id ||
          row.id <= token.inputId ||
          row.createdAt <= token.issuedAt
        )
          throw denied();
        tokens.delete(id);
        const commandId = `member-erase:${id}:${row.id}`;
        scheduled.set(row.id, { principalId: id, inputId: row.id, commandId });
        blocked.add(id);
        return { status: 'scheduled', commandId };
      }
      const core = exportPrincipalRecords(options.adapter, id);
      const product = productExport(id);
      const files = filesInTrees(p.root, id);
      const token: Token = {
        value: randomUUID(),
        principalId: id,
        inputId: row.id,
        issuedAt: Date.now(),
      };
      tokens.set(id, token);
      return {
        status: 'preview',
        counts: { core: core.counts, product: product.counts },
        fileCount: files.length,
        fileBytes: files.reduce((n, file) => n + file.size, 0),
        confirmationToken: token.value,
      };
    },
  }));
  return {
    registrations,
    isBlocked: (id: string) => blocked.has(id),
    onSettled: (row: MailboxRow) => {
      const job = scheduled.get(row.id);
      if (!job || row.principalId !== job.principalId) return;
      scheduled.delete(row.id);
      // Never await this inside core's drain. The next shared slot owns the complete job.
      enqueue(() => erase(job));
    },
    onDead: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'dead', reason),
    onUncertain: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'uncertain', reason),
    idle: async () => {
      await Promise.allSettled([...jobs]);
    },
  };
}

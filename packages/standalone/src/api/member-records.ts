import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { relative } from 'node:path';
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
import type { createSerialTurnChain } from '../runtime/principal-sessions.js';
import type { TelegramFileSender } from './file-delivery.js';
import { buildMemberExport, memberFileInventory, memberTrees } from './member-export.js';

export interface MemberRecordsTelegram extends TelegramFileSender {
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
  isStopping(): boolean;
  resumeQueued(): void;
  recordExchange(id: string, ref: string, text: string, deliveryVerified: boolean): void;
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
  kind: 'export' | 'erase';
  release(): void;
}

function receiptText(
  core: PrincipalErasureReceipt | undefined,
  product: Record<string, number>,
  failure: unknown,
  step: string,
  omittedFiles: readonly string[],
  uncertain: boolean
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
      uncertain
        ? 'The export delivery is uncertain. Nothing was erased. Check whether the file arrived before asking again.'
        : 'Earlier steps are done. Make a new erasure request and pass its preview confirmationToken in a later member message to finish the rest.'
    );
  for (const [store, counts] of Object.entries(core?.counts ?? {})) {
    const nonZero = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([action, n]) => `${n} ${action === 'in_flight' ? 'in flight' : action}`);
    if (nonZero.length) lines.push(`${store}: ${nonZero.join(', ')}.`);
  }
  for (const [store, n] of Object.entries(product)) {
    if (n > 0 && !['files', 'fileBytes', 'fileTrees', 'cancelledMessages'].includes(store))
      lines.push(`${store}: ${n} deleted.`);
  }
  lines.push(
    `Files: ${product.files ?? 0} files, ${product.fileBytes ?? 0} bytes.`,
    `${product.cancelledMessages ?? 0} ${product.cancelledMessages === 1 ? 'message sent after your confirmation was' : 'messages sent after your confirmation were'} cancelled unanswered.`,
    'Your enrollment and grants are kept.'
  );
  for (const name of omittedFiles)
    lines.push(
      `Left out of the export (a link is outside your files or in a private host directory): ${name}.`
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
  let activeJobs = 0;
  const results = new Map<
    string,
    {
      status: 'sent' | 'not_sent' | 'erased' | 'failed';
      fileCount: number;
      fileBytes: number;
      omittedFiles: string[];
      failedStep?: string;
    }
  >();
  const enqueue = (work: () => Promise<void>) => {
    const pending = ports().turnChain.next(async () => {
      activeJobs++;
      try {
        await work();
      } finally {
        activeJobs--;
        if (!ports().isStopping()) ports().resumeQueued();
      }
    });
    jobs.add(pending);
    void pending
      .catch((error) => console.error('[Member records] scheduled work failed', error))
      .finally(() => jobs.delete(pending));
  };
  const take = (row: MailboxRow) => {
    const job = scheduled.get(row.id);
    if (!job || job.principalId !== row.principalId) return;
    scheduled.delete(row.id);
    return job;
  };
  const cancelConfirmation = (row: MailboxRow, outcome: 'dead' | 'uncertain', reason: string) => {
    const job = take(row);
    if (!job) return;
    blocked.delete(job.principalId);
    if (!ports().isStopping()) {
      const label = job.kind === 'erase' ? 'Erasure' : 'Export';
      enqueue(() =>
        sendReceipt(
          job,
          `${label} did not run because the ${job.kind === 'erase' ? 'confirming' : 'requesting'} turn did not complete (${outcome}: ${reason}).\nYour personal records and files were kept. Make a new request in a later member message.\nYour enrollment and grants are kept.`
        )
      );
    }
    job.release();
  };
  const runJob = async (job: Scheduled) => {
    const p = ports(),
      id = job.principalId;
    const product: Record<string, number> = { cancelledMessages: 0 };
    let core: PrincipalErasureReceipt | undefined;
    let archive: Awaited<ReturnType<typeof buildMemberExport>> | undefined;
    let failedStep = 'export',
      failure: unknown,
      uncertain = false;
    let delivered = false;
    try {
      archive = await buildMemberExport(
        p.root,
        id,
        exportPrincipalRecords(options.adapter, id),
        productExport(id)
      );
      failedStep = 'export_delivery';
      try {
        const telegram = p.telegram();
        if (!telegram) throw new Error('Member Telegram delivery is not configured');
        await telegram.sendFile(archive.path, undefined, `${job.commandId}:export`, {
          access: p.access(id),
          filesRoot: archive.filesRoot,
        });
        delivered = true;
      } catch (error) {
        uncertain = p.ledger()?.get(`file:${job.commandId}:export`)?.deliveryUncertain === true;
        throw error;
      } finally {
        rmSync(archive.path, { force: true });
      }
      if (job.kind === 'erase') {
        failedStep = 'retire';
        await p.retire(id);
        // Delivery and complete unserving/retirement precede cancellation. The shared slot
        // prevents any member turn or steering while these queued rows are cancelled.
        p.mailbox().cancelQueued(id, 'member_erase');
        product.cancelledMessages = Number(
          (
            options.adapter
              .prepare(
                "SELECT count(*) AS n FROM mailbox_inputs WHERE principal_id=? AND id>? AND kind='owner_message' AND status='dead' AND last_error='member_erase'"
              )
              .get(id, job.inputId) as { n: number }
          ).n
        );
        failedStep = 'connector_event_index';
        product.connector_event_index = options.adapter
          .prepare(
            "DELETE FROM connector_event_index WHERE source_connector='chat' AND memory_scope_kind='user' AND memory_scope_id=?"
          )
          .run(id).changes;
        failedStep = 'core';
        core = erasePrincipalRecords(options.adapter, {
          principalId: id,
          commandId: job.commandId,
        });
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
          const remaining = memberFileInventory(p.root, id).allFiles.filter(
            (file) =>
              relative(tree, file.path) !== '..' && !relative(tree, file.path).startsWith('../')
          );
          rmSync(tree, { recursive: true, force: true });
          product.files += remaining.length;
          product.fileBytes += remaining.reduce((n, file) => n + file.size, 0);
          product.fileTrees++;
        }
      }
    } catch (error) {
      failure = error;
    }
    try {
      try {
        p.serve(id);
      } catch (error) {
        failedStep = 'serve';
        failure = error;
      }
      const omittedFiles = archive?.omittedFiles ?? [];
      results.set(job.commandId, {
        status:
          job.kind === 'erase' ? (failure ? 'failed' : 'erased') : delivered ? 'sent' : 'not_sent',
        fileCount: archive?.fileCount ?? 0,
        fileBytes: archive?.fileBytes ?? 0,
        omittedFiles,
        ...(failure ? { failedStep } : {}),
      });
      let text: string;
      if (job.kind === 'erase')
        text = receiptText(core, product, failure, failedStep, omittedFiles, uncertain);
      else {
        text = uncertain
          ? `Export delivery is uncertain at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
          : failure
            ? delivered
              ? `Export sent, but service restoration stopped at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
              : `Export not sent at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
            : 'Export sent: your personal records and files were sent to your registered Telegram DM.';
        if (uncertain)
          text +=
            '\nThe export delivery is uncertain. Check whether the file arrived before asking again.';
        text += `\nFiles: ${archive?.fileCount ?? 0} files, ${archive?.fileBytes ?? 0} bytes.\nYour enrollment and grants are kept.`;
        for (const name of omittedFiles)
          text += `\nLeft out of the export (a link is outside your files or in a private host directory): ${name}.`;
      }
      await sendReceipt(job, text);
    } finally {
      blocked.delete(id);
    }
  };
  const schedule = (kind: Scheduled['kind'], row: MailboxRow) => {
    const commandId = `member-${kind}:${row.principalId}:${row.id}`;
    scheduled.set(row.id, {
      principalId: row.principalId,
      inputId: row.id,
      commandId,
      kind,
      release: ports().turnChain.hold(),
    });
    blocked.add(row.principalId);
    return { status: 'scheduled', commandId };
  };
  const registrations: ActionRegistration[] = [
    'records.export',
    'records.erase',
  ].map<ActionRegistration>((name) => ({
    contract: {
      name,
      summary:
        name === 'records.export'
          ? "Schedule export of the caller's personal records and files as one zip to their registered Telegram DM (50 MiB). The host exports after this member message completes and records a receipt. Excludes account settings and names files whose links leave the member's trees."
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
      if (name === 'records.export') return schedule('export', row);
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
        return schedule('erase', row);
      }
      const core = exportPrincipalRecords(options.adapter, id);
      const product = productExport(id);
      const inventory = memberFileInventory(p.root, id);
      const files = inventory.files;
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
        omittedFiles: inventory.omittedFiles,
      };
    },
  }));
  return {
    registrations,
    result: (commandId: string) => results.get(commandId),
    isBusy: () => activeJobs > 0 || blocked.size > 0,
    isBlocked: (id: string) => blocked.has(id),
    onSettled: (row: MailboxRow) => {
      const job = take(row);
      if (!job) return;
      if (ports().isStopping()) blocked.delete(job.principalId);
      else enqueue(() => runJob(job));
      job.release();
    },
    onDead: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'dead', reason),
    onUncertain: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'uncertain', reason),
    idle: async () => {
      await Promise.allSettled([...jobs]);
    },
  };
}

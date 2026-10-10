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
import {
  buildMemberExport,
  memberFileInventory,
  memberInventorySnapshot,
} from './member-export.js';

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
  recordExchange(
    id: string,
    kind: 'export' | 'erase',
    ref: string,
    text: string,
    deliveryVerified: boolean
  ): void;
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
    file_check: 'file check',
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
        : ['retire', 'export', 'export_delivery', 'file_check'].includes(step)
          ? 'Nothing was erased. Ask again for a new preview and pass its confirmationToken in a later member message.'
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
    `${product.cancelledMessages ?? 0} ${product.cancelledMessages === 1 ? 'message in the queue was' : 'messages in the queue were'} cancelled unanswered.`,
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
  const jobs = new Set<Promise<unknown>>();
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
    p.recordExchange(job.principalId, job.kind, `host:${job.commandId}`, text, verified);
  };
  // Members whose erasure is scheduled or running. Only these pause claims for everyone: the
  // member must stay unserved with its queue untouched until the export is delivered. An export
  // deletes nothing, so it holds the chain only while its archive is built.
  const erasing = new Set<string>();
  const track = (work: Promise<unknown>) => {
    jobs.add(work);
    void work
      .catch((error) => console.error('[Member records] scheduled work failed', error))
      .finally(() => jobs.delete(work));
  };
  const enqueue = (work: (leaveChain: () => void) => Promise<void>) => {
    track(
      ports().turnChain.next(async () => {
        let leaveChain!: () => void;
        const left = new Promise<void>((resolve) => (leaveChain = resolve));
        const run = work(leaveChain);
        track(run);
        try {
          await Promise.race([left, run]);
        } finally {
          if (!ports().isStopping()) ports().resumeQueued();
        }
      })
    );
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
    erasing.delete(job.principalId);
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
  const runJob = async (job: Scheduled, leaveChain: () => void) => {
    const p = ports(),
      id = job.principalId;
    let left = false;
    // An export's archive is a consistent snapshot once built: the member may run turns again
    // and the upload continues outside the shared chain.
    const leave = () => {
      if (left || job.kind !== 'export') return;
      left = true;
      blocked.delete(id);
      leaveChain();
    };
    const product: Record<string, number> = { cancelledMessages: 0 };
    let core: PrincipalErasureReceipt | undefined;
    let archive: Awaited<ReturnType<typeof buildMemberExport>> | undefined;
    let failedStep = job.kind === 'erase' ? 'retire' : 'export',
      failure: unknown,
      uncertain = false;
    let delivered = false;
    try {
      if (job.kind === 'erase') await p.retire(id);
      failedStep = 'export';
      archive = await buildMemberExport(
        p.root,
        id,
        exportPrincipalRecords(options.adapter, id),
        productExport(id)
      );
      leave();
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
        // Retirement removed the writers and intake before the snapshot. Check and delete
        // synchronously after delivery, with no await between them that could admit a write.
        failedStep = 'file_check';
        const inventory = memberFileInventory(p.root, id);
        if (memberInventorySnapshot(inventory) !== archive.fileSnapshot)
          throw new Error('Your files changed while the export was being sent');
        failedStep = 'files';
        product.files = 0;
        product.fileBytes = 0;
        product.fileTrees = 0;
        for (const tree of inventory.trees) {
          const remaining = inventory.allFiles.filter(
            (file) =>
              relative(tree, file.path) !== '..' && !relative(tree, file.path).startsWith('../')
          );
          rmSync(tree, { recursive: true, force: true });
          product.files += remaining.length;
          product.fileBytes += remaining.reduce((n, file) => n + file.size, 0);
          product.fileTrees++;
        }
        failedStep = 'queued_inputs';
        // Delivered in the export and never dispatched: cancelled here, they are terminal, so
        // the core erase below removes them with their refs.
        product.cancelledMessages = p.mailbox().cancelQueued(id, 'member_erase');
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
        product.message_ledger = ledger.eraseTelegramDm(dm(p.access(id)), [
          `file:${job.commandId}:export`,
        ]);
      }
    } catch (error) {
      failure = error;
    }
    try {
      try {
        p.serve(id);
      } catch (error) {
        // Keep the step that stopped the job: it decides what was erased and what remains.
        if (failure === undefined) {
          failedStep = 'serve';
          failure = error;
        } else
          failure = new Error(
            `${failure instanceof Error ? failure.message : String(failure)}; serving the member again also failed: ${error instanceof Error ? error.message : String(error)}`
          );
      }
      const omittedFiles = archive?.omittedFiles ?? [];
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
      if (job.kind === 'export') leave();
      else {
        blocked.delete(id);
        erasing.delete(id);
      }
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
    if (kind === 'erase') erasing.add(row.principalId);
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
          : "Preview erasure of the caller's personal records and files, with separate file totals for export and deletion. Pass the confirmationToken from this preview in a later member message to confirm. The host exports after that turn completes and erases only after Telegram accepts the export. Enrollment, grants and shared revisions are kept.",
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
        eraseFileCount: inventory.allFiles.length,
        eraseFileBytes: inventory.allFiles.reduce((n, file) => n + file.size, 0),
        confirmationToken: token.value,
        omittedFiles: inventory.omittedFiles,
      };
    },
  }));
  return {
    registrations,
    isBusy: () => erasing.size > 0,
    isBlocked: (id: string) => blocked.has(id),
    onSettled: (row: MailboxRow) => {
      const job = take(row);
      if (!job) return;
      if (ports().isStopping()) {
        blocked.delete(job.principalId);
        erasing.delete(job.principalId);
      } else enqueue((leaveChain) => runJob(job, leaveChain));
      job.release();
    },
    onDead: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'dead', reason),
    onUncertain: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'uncertain', reason),
    idle: async () => {
      await Promise.allSettled([...jobs]);
    },
  };
}

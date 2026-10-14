import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
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
import { outboundLedgerKey, type OwnerMessageLedger } from '../gateways/telegram-message-ledger.js';
import type { createSerialTurnChain } from '../runtime/principal-sessions.js';
import type { TelegramFileSender } from './file-delivery.js';
import {
  buildMemberExport,
  memberFileInventory,
  memberInventorySnapshot,
} from './member-export.js';

export interface MemberRecordsTelegram extends TelegramFileSender {
  sendMemberText(access: JudgmentAccess, text: string, operationId: string): Promise<boolean>;
  memberTextDelivered(access: JudgmentAccess, operationId: string): boolean;
  retireMemberJobText(operationId: string): void;
}
export interface MemberRecordsPorts {
  root: string;
  rawStore: RawStore;
  mailbox(): Mailbox;
  ledger(): OwnerMessageLedger | undefined;
  telegram(): MemberRecordsTelegram | undefined;
  access(id: string): JudgmentAccess;
  turnChain(id: string): ReturnType<typeof createSerialTurnChain>;
  retire(id: string): Promise<void>;
  serve(id: string): void;
  isStopping(): boolean;
  isReady(): boolean;
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
  hostInputId?: number;
  release(): void;
}

interface ErasureState {
  phase: 'confirmed' | 'exporting' | 'delivered' | 'erasing' | 'receipt' | 'done';
  product: Record<string, number>;
  archive?: Awaited<ReturnType<typeof buildMemberExport>>;
  core?: PrincipalErasureReceipt;
  text?: string;
  receiptDelivered?: boolean;
  exportAttempted?: boolean;
  receiptAttempted?: boolean;
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
        ? 'The export delivery is uncertain. Nothing was erased. No file was resent. Ask again for a new preview and confirm it in a later member message.'
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
  const deferredInputs = (id: string) =>
    options.adapter
      .prepare(
        "SELECT id, stimulus_id FROM mailbox_inputs WHERE principal_id=? AND kind='owner_message' AND status IN ('pending','claimed') AND json_extract(payload_json,'$.deferredMemberMessage')=1"
      )
      .all(id) as Array<{ id: number; stimulus_id: string }>;
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
  // The confirming member alone is excluded from all claims, including host inputs.
  // Its durable erasure carrier is reconciled here, outside the mailbox claim loop.
  const erasing = new Set<string>();
  // Members with an export still uploading: their turns run, but no second export or erasure
  // starts until this one is delivered, so archives and uploads never pile up.
  const exporting = new Set<string>();
  const track = (work: Promise<unknown>) => {
    jobs.add(work);
    void work
      .catch((error) => console.error('[Member records] scheduled work failed', error))
      .finally(() => jobs.delete(work));
  };
  const enqueue = (id: string, work: (leaveChain: () => void) => Promise<void>) => {
    const runSlot = async () => {
      let leaveChain!: () => void;
      const left = new Promise<void>((resolve) => (leaveChain = resolve));
      const run = work(leaveChain);
      track(run);
      try {
        await Promise.race([left, run]);
      } finally {
        if (!ports().isStopping()) ports().resumeQueued();
      }
    };
    track(ports().turnChain(id).next(runSlot));
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
    if (job.kind === 'erase' && ports().isStopping()) {
      // Native stop can interrupt the confirming turn after the host accepted its command.
      // The consent is durable; stopping the process is not cancellation of that consent.
      job.release();
      return;
    }
    if (job.kind === 'erase') {
      cancelErasureConfirmation(job, outcome, reason);
      launchErasure(job);
      job.release();
      return;
    }
    if (job.hostInputId !== undefined) ports().mailbox().ack(job.hostInputId);
    blocked.delete(job.principalId);
    erasing.delete(job.principalId);
    if (!ports().isStopping()) {
      const label = 'Export';
      enqueue(job.principalId, () =>
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
    // and the upload continues outside that member's chain.
    const leave = () => {
      if (left || job.kind !== 'export') return;
      left = true;
      exporting.add(id);
      blocked.delete(id);
      leaveChain();
    };
    let archive: Awaited<ReturnType<typeof buildMemberExport>> | undefined;
    let failedStep = 'export',
      failure: unknown,
      uncertain = false;
    let delivered = false;
    try {
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
    } catch (error) {
      failure = error;
    }
    try {
      const omittedFiles = archive?.omittedFiles ?? [];
      let text: string;
      {
        text = uncertain
          ? `Export delivery is uncertain at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
          : failure
            ? delivered
              ? `Export sent, but service restoration stopped at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
              : `Export not sent at ${failedStep}: ${failure instanceof Error ? failure.message : String(failure)}.`
            : 'Export sent: your personal records and files were sent to your registered Telegram DM.';
        if (uncertain)
          text +=
            '\nThe export delivery is uncertain. No file was resent. Check your DM for the export before requesting another export.';
        text += `\nFiles: ${archive?.fileCount ?? 0} files, ${archive?.fileBytes ?? 0} bytes.\nYour enrollment and grants are kept.`;
        for (const name of omittedFiles)
          text += `\nLeft out of the export (a link is outside your files or in a private host directory): ${name}.`;
      }
      await sendReceipt(job, text);
    } finally {
      if (job.kind === 'export') {
        leave();
        exporting.delete(id);
      } else {
        blocked.delete(id);
        erasing.delete(id);
      }
    }
  };

  const runningErasures = new Set<number>();
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const checkpoint = (job: Scheduled, state: ErasureState) => {
    // Consumer progress is opaque to core; the host stimulus identity stays immutable.
    ports()
      .mailbox()
      .checkpointHostJob(job.hostInputId!, JSON.parse(JSON.stringify(state)));
  };
  const cancelErasureConfirmation = (job: Scheduled, outcome: string, reason: string) => {
    const state = ports().mailbox().hostJobCheckpoint(job.hostInputId!) as unknown as ErasureState;
    state.phase = 'receipt';
    state.text = `Erasure did not run because the confirming turn did not complete (${outcome}: ${reason}).\nYour personal records and files were kept. Make a new request in a later member message.\nYour enrollment and grants are kept.`;
    checkpoint(job, state);
  };
  const runErasure = async (job: Scheduled) => {
    const p = ports(),
      id = job.principalId;
    const state = p.mailbox().hostJobCheckpoint(job.hostInputId!) as unknown as ErasureState;
    if (state.phase === 'done') {
      p.serve(id);
      p.mailbox().ack(job.hostInputId!);
      blocked.delete(id);
      erasing.delete(id);
      return;
    }
    let step = 'retire';
    let uncertainExport = false;
    try {
      if (state.phase === 'confirmed') {
        if (p.isStopping()) return;
        await p.retire(id);
        if (p.isStopping()) return;
        step = 'export';
        state.archive = await buildMemberExport(
          p.root,
          id,
          exportPrincipalRecords(options.adapter, id),
          productExport(id)
        );
        state.phase = 'exporting';
        checkpoint(job, state);
      }
      if (state.phase === 'exporting') {
        if (p.isStopping()) return;
        step = 'export_delivery';
        // A boot recreates native directories. Retire them before checking the persisted snapshot.
        await p.retire(id);
        if (p.isStopping()) return;
        // This principal remains reserved and excluded. Its native writers are gone and the
        // archive touches only its known paths; other directory jobs need not wait for upload.
        p.turnChain(id).releaseDirectoryWait();
        const entry = p.ledger()?.get(`file:${job.commandId}:export`);
        if (entry?.state !== 'delivered') {
          // The ledger has retention. A lost/expired receipt after a persisted send boundary
          // cannot turn an attempted upload back into a never-attempted one.
          if (!entry && state.exportAttempted) {
            uncertainExport = true;
            throw new Error('The export delivery is uncertain: its receipt is missing');
          }
          // A persisted attempt without a definitive receipt is never permission to delete.
          // In particular, a processing entry left by a crash may have reached Telegram.
          if (entry && (entry.deliveryUncertain || entry.state === 'processing'))
            throw new Error('The export delivery is uncertain');
          if (!state.archive) throw new Error('The export snapshot is missing');
          if (entry) throw new Error('The export delivery was not confirmed');
          state.exportAttempted = true;
          checkpoint(job, state);
          await p.telegram()!.sendFile(state.archive.path, undefined, `${job.commandId}:export`, {
            access: p.access(id),
            filesRoot: state.archive.filesRoot,
          });
        }
        state.phase = 'delivered';
        checkpoint(job, state);
        if (p.isStopping()) return;
      }
      if (state.phase === 'delivered') {
        if (p.isStopping()) return;
        await p.retire(id);
        if (p.isStopping()) return;
        if (state.archive) rmSync(state.archive.path, { force: true });
        step = 'file_check';
        const inventory = memberFileInventory(p.root, id);
        if (!state.archive || memberInventorySnapshot(inventory) !== state.archive.fileSnapshot)
          throw new Error('Your files changed while the export was being sent');
        state.product.files = inventory.allFiles.length;
        state.product.fileBytes = inventory.allFiles.reduce((n, file) => n + file.size, 0);
        state.product.fileTrees = inventory.trees.length;
        state.phase = 'erasing';
        checkpoint(job, state); // Deletion may now replay each remaining store, never the upload.
      }
      if (state.phase === 'erasing') {
        step = 'files';
        // No await between the delivered file check and the deletion on the first run.
        for (const tree of memberFileInventory(p.root, id).trees)
          rmSync(tree, { recursive: true, force: true });
        const product = { ...state.product };
        let core = state.core;
        options.adapter.transaction(() => {
          product.cancelledMessages += p.mailbox().cancelQueued(
            id,
            'member_erase',
            deferredInputs(id).map((row) => row.id)
          );
          step = 'connector_event_index';
          product.connector_event_index =
            (product.connector_event_index ?? 0) +
            options.adapter
              .prepare(
                "DELETE FROM connector_event_index WHERE source_connector='chat' AND memory_scope_kind='user' AND memory_scope_id=?"
              )
              .run(id).changes;
          step = 'core';
          core = erasePrincipalRecords(options.adapter, {
            principalId: id,
            commandId: job.commandId,
          });
          checkpoint(job, { ...state, product, core });
        });
        // A rolled-back transaction must not report its attempted deletes as completed.
        state.product = product;
        state.core = core;
        step = 'chat_raw';
        // Save intended totals before crossing the independent raw database/file-ledger boundary.
        const rawCounts = p.rawStore.exportScope('chat', 'user', id);
        for (const [name, rows] of Object.entries(rawCounts)) state.product[name] ??= rows.length;
        const ledger = p.ledger();
        if (!ledger) throw new Error('Live message ledger is not configured');
        state.product.message_ledger ??= ledger
          .listForTelegramDm(dm(p.access(id)))
          .filter(
            (entry) =>
              entry.key !== `file:${job.commandId}:export` &&
              !deferredInputs(id).some((row) => row.stimulus_id === entry.key)
          ).length;
        checkpoint(job, state);
        p.rawStore.eraseScope('chat', 'user', id);
        step = 'message_ledger';
        ledger.eraseTelegramDm(dm(p.access(id)), [
          `file:${job.commandId}:export`,
          ...deferredInputs(id).map((row) => row.stimulus_id),
        ]);
        state.text = receiptText(
          state.core,
          state.product,
          undefined,
          '',
          state.archive?.omittedFiles ?? [],
          false
        );
        state.phase = 'receipt';
        delete state.archive;
        checkpoint(job, state);
      }
    } catch (error) {
      // Retirement races shutdown before any deletion. Keep the confirmed job resumable.
      if (p.isStopping() && ['confirmed', 'exporting', 'delivered'].includes(state.phase)) return;
      const entry = p.ledger()?.get(`file:${job.commandId}:export`);
      const uncertain =
        uncertainExport ||
        (state.phase === 'exporting' &&
          (entry?.deliveryUncertain === true || entry?.state === 'processing'));
      state.text = receiptText(
        state.core,
        state.product,
        error,
        step,
        state.archive?.omittedFiles ?? [],
        uncertain
      );
      state.phase = 'receipt';
      checkpoint(job, state);
    }
    if (state.phase === 'receipt') {
      if (state.archive) rmSync(state.archive.path, { force: true });
      if (p.isStopping()) return;
      try {
        p.serve(id);
      } catch (error) {
        if (!state.receiptAttempted && !state.receiptDelivered) {
          state.text = `${state.text}\nserving the member again also failed: ${error instanceof Error ? error.message : String(error)}.`;
          checkpoint(job, state);
        } else {
          // Once a receipt crossed the send boundary, its text is immutable: a later service
          // failure cannot change what the transport delivered or what the chat records.
          console.error('[Member records] service restoration failed after receipt attempt', error);
        }
        // Keep the receipt carrier and principal exclusion until service restoration succeeds.
        // The recovery tick retries this phase; deferred messages must not run unserved.
        throw error;
      }
      const telegram = p.telegram();
      p.turnChain(id).releaseDirectoryWait();
      if (!telegram) throw new Error('Member Telegram delivery is not configured');
      const operation = `${job.commandId}:receipt`;
      if (!state.receiptDelivered) {
        state.receiptDelivered = telegram.memberTextDelivered(p.access(id), operation);
        if (!state.receiptDelivered) {
          const entry = p.ledger()?.get(outboundLedgerKey(operation));
          if (!entry?.deliveryUncertain && !(!entry && state.receiptAttempted)) {
            state.receiptAttempted = true;
            checkpoint(job, state);
            try {
              state.receiptDelivered = await telegram.sendMemberText(
                p.access(id),
                state.text!,
                operation
              );
              if (!state.receiptDelivered)
                throw new Error('Erasure receipt delivery was not confirmed');
            } catch (error) {
              const attempted = p.ledger()?.get(outboundLedgerKey(operation));
              // A failed pre-claim call is retryable. An uncertain send is final for this
              // data job: record it unverified without resending or blocking later turns.
              if (!attempted) {
                state.receiptAttempted = false;
                checkpoint(job, state);
              }
              if (!attempted?.deliveryUncertain) throw error;
            }
          }
        }
        checkpoint(job, state);
      }
      p.recordExchange(
        id,
        'erase',
        `host:${job.commandId}`,
        state.text!,
        state.receiptDelivered === true
      );
      options.adapter.transaction(() => {
        state.phase = 'done';
        delete state.archive;
        checkpoint(job, state);
        p.mailbox().ack(job.hostInputId!);
      });
      blocked.delete(id);
      erasing.delete(id);
    }
  };
  const launchErasure = (job: Scheduled) => {
    if (runningErasures.has(job.hostInputId!)) return;
    runningErasures.add(job.hostInputId!);
    enqueue(job.principalId, async () => {
      try {
        await runErasure(job);
      } finally {
        runningErasures.delete(job.hostInputId!);
      }
    });
  };
  const durableRows = () =>
    options.ports
      ? (options.adapter
          .prepare(
            "SELECT id, stimulus_id, principal_id, payload_json FROM mailbox_inputs WHERE kind='host_job' AND channel_key='member-erasure' AND status IN ('pending','claimed') ORDER BY id"
          )
          .all() as Array<{
          id: number;
          stimulus_id: string;
          principal_id: string;
          payload_json: string;
        }>)
      : [];
  // Restore exclusion before any boot-time claim. A live confirmation still waits for settlement;
  // after a crash its process no longer owns files, so recovery can take the same member slot.
  for (const row of durableRows()) {
    blocked.add(row.principal_id);
    erasing.add(row.principal_id);
  }
  const recover = () => {
    // An assembly without member_root has no personal-record host runner or delivery ports.
    if (!options.ports) return;
    if (ports().isStopping() || !ports().isReady()) return;
    for (const row of durableRows()) {
      const payload = JSON.parse(row.payload_json) as { inputId: number };
      if (scheduled.has(payload.inputId)) continue;
      // Core reconciliation owns uncertain native intake, even after its process is gone.
      const mailbox = ports().mailbox();
      const status = mailbox.inputStatus(payload.inputId);
      const confirmation = mailbox.nativeInputs.get(payload.inputId);
      const job: Scheduled = {
        principalId: row.principal_id,
        inputId: payload.inputId,
        commandId: row.stimulus_id,
        kind: 'erase',
        hostInputId: row.id,
        release: () => {},
      };
      const state = mailbox.hostJobCheckpoint(row.id) as unknown as ErasureState;
      // A confirmed command is still waiting for native settlement. A crash before the
      // cancellation callback cannot turn an incomplete confirming turn into permission to erase.
      if (state.phase === 'confirmed' && (status !== 'acked' || confirmation?.state !== 'settled'))
        cancelErasureConfirmation(
          job,
          status === 'dead' ? 'dead' : (confirmation?.state ?? 'unsettled'),
          confirmation?.error ??
            `confirmation input status=${status ?? 'missing'}, native state=${confirmation?.state ?? 'missing'}`
        );
      if (status === 'acked' || status === 'dead')
        mailbox.quarantine(payload.inputId, 'member_erasure_confirmation_recovered');
      launchErasure(job);
    }
  };
  const schedule = (kind: Scheduled['kind'], row: MailboxRow) => {
    const commandId = `member-${kind}:${row.principalId}:${row.id}`;
    let hostInputId: number | undefined;
    if (kind === 'erase')
      options.adapter.transaction(() => {
        hostInputId =
          ports()
            .mailbox()
            .enqueue({
              id: commandId,
              kind: 'host_job',
              principalId: row.principalId,
              channelKey: 'member-erasure',
              payload: { inputId: row.id },
              occurredAt: Date.now(),
            }) ?? ports().mailbox().readInput(commandId, row.principalId)!.id;
        if (!ports().mailbox().hostJobCheckpoint(hostInputId))
          ports()
            .mailbox()
            .checkpointHostJob(hostInputId, {
              phase: 'confirmed',
              product: { cancelledMessages: 0 },
            });
      });
    scheduled.set(row.id, {
      principalId: row.principalId,
      inputId: row.id,
      commandId,
      kind,
      ...(hostInputId === undefined ? {} : { hostInputId }),
      release: ports().turnChain(row.principalId).hold(),
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
      if (exporting.has(id))
        throw Object.assign(
          new Error('An export is still being sent to your DM; ask again after it arrives'),
          { name: 'denied' }
        );
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
    excludePrincipals: () => [...erasing],
    recover,
    startRecovery: () => {
      if (!options.ports) return;
      recover();
      recoveryTimer ??= setInterval(recover, 5_000);
      recoveryTimer.unref();
    },
    stopRecovery: () => {
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = undefined;
    },
    isBlocked: (id: string) => blocked.has(id),
    onSettled: (row: MailboxRow) => {
      const job = take(row);
      if (!job) return;
      if (ports().isStopping()) {
        if (job.kind !== 'erase') blocked.delete(job.principalId);
      } else {
        // Export writes workspace/files; erasure recreates this member's runtime/temp paths.
        // Other members already deny those paths, so both use only this member's chain.
        if (job.kind === 'erase') launchErasure(job);
        else enqueue(job.principalId, (leaveChain) => runJob(job, leaveChain));
      }
      job.release();
    },
    onDead: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'dead', reason),
    onUncertain: (row: MailboxRow, reason: string) => cancelConfirmation(row, 'uncertain', reason),
    idle: async () => {
      await Promise.allSettled([...jobs]);
    },
  };
}

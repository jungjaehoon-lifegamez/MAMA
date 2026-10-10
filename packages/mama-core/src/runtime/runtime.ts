import type { ContentBlock, PromptCallbacks } from './drivers/types.js';
import { NativeSteeringTargetUnavailableError } from './drivers/types.js';
import type { NativeTurnResult } from './native-turn.js';
/**
 * Runtime — the one subject that opens and owns the action surface.
 *
 * §4.3: `runtime.start` alone opens the DB, native session, model and socket;
 * `stop` closes only what it opened. Product assembly states the paths — core
 * never guesses `~/.mama`. This module is the socket·credential half of that
 * subject: it issues this boot's session credential, mounts the action socket
 * on the shared catalog/dispatch, and on `stop` releases exactly those two
 * things. The adapter, catalog and dispatcher stay product-owned — the daemon
 * opens its one DB and builds the one action surface, and the runtime serves
 * them rather than opening a second stack. There is never a second start
 * subject per profile.
 *
 * It is also the loop's intake. `accept` is the one door a stimulus enters by —
 * an owner's message, a connector delta, a scheduled time — and it does exactly
 * two things: prove the stated principal is one this runtime serves, and make
 * the stimulus durable. It returns a receipt of acceptance and nothing more.
 * What the stimulus MEANS, and what to do about it, is the agent's; a host that
 * classified it here would be choosing the model's work for it.
 *
 * The intake is opened before the socket, for the same reason the credential
 * table is: a producer must never reach a runtime whose intake does not exist
 * yet.
 *
 * And the runtime carries what it accepted through to the loop: the claim, the
 * lease, the retry backoff and the ack are the runtime's, so no producer has to
 * hold a stimulus while a turn runs and no producer has to remember one that
 * failed. What runs inside a delivery is the native session the product already
 * has — this is the delivery half of the mailbox, never a second turn loop.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ActionSessionFacts } from '../action-contracts.js';
import type { ActionCatalog } from '../api/catalog.js';
import type { ActionDispatcher } from '../api/dispatch.js';
import type { TextCompletion } from './text-completion.js';
import type { JudgmentAccess } from '../knowledge/judgments.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type { NativeInputDispatch, NativeInputReceipt } from './drivers/types.js';
import type { NativeTurnResultRecord } from './native-input-journal.js';
import { createActionIpcServer, type IpcRequest } from '../client/ipc.js';
import {
  Mailbox,
  isStimulusKind,
  type MailboxRow,
  type Stimulus,
  type StimulusKind,
} from './mailbox.js';

/** The paths product assembly must state — the runtime never derives them. */
export interface RuntimePaths {
  /** Private Unix socket the action catalog is served on. */
  socketPath: string;
}

function writeCredential(path: string, credential: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, credential, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * One caller of this runtime. The credential file is what names the principal:
 * whoever presents that token is that principal and gets exactly its access.
 * The path is stated by the product for the same reason every other path is —
 * core composing `<dir>/<principalId>` would let a principal's name choose a
 * file.
 */
export interface RuntimePrincipal {
  access: JudgmentAccess;
  /** Rotated-per-boot token file (0600) this principal's callers present. */
  credentialPath: string;
  /**
   * The run this principal's calls answer to, when its host can name one.
   *
   * An action whose authority is the run — execution evidence — is uncallable
   * on a surface that names none, and a socket cannot derive a run from a
   * request. The host that assembles the principal states it here, once, beside
   * the access; a host that cannot name it omits it and its calls stay honestly
   * unattributed.
   */
  runEvidenceScope?: ActionSessionFacts['runEvidenceScope'];
}

/**
 * The harness this runtime opened, from the outside.
 *
 * §4.3 gives `runtime.start` the DB, the native session, the model and the
 * socket, and gives `stop` exactly what start opened. The session itself is
 * built by product assembly - which harness, which workspace, which persona is
 * the product's statement - and handed here so that ONE subject decides when it
 * is alive. Before this, shutdown stopped the loop, disposed the session pool
 * and closed the socket as three separate steps in one function, and the order
 * between them was that function's private knowledge.
 */
export interface NativeInvocationOptions {
  nativeInputId?: string;
  onModelRunStarted?: (modelRunId: string) => void;
  prepareSessionContent?: (
    session: import('./drivers/types.js').NativeSessionState
  ) => Promise<ContentBlock[]>;
  streamCallbacks?: PromptCallbacks;
}

export interface NativeSessionHandle {
  /** One request to the native harness; model/tool iteration remains inside that harness. */
  runTurn?(content: ContentBlock[], request?: NativeInvocationOptions): Promise<NativeTurnResult>;
  /** Retire the native context and its pool route, preserving durable product records. */
  resetSession?(sessionKey: string): Promise<void>;
  /** Add input to the exact active turn; the runtime journals this input separately. */
  steer?(
    content: string,
    target: NativeInputReceipt,
    sessionKey: string,
    beforeSend?: () => void
  ): Promise<NativeInputReceipt>;
  /** Release the harness and the sessions it holds. Called once, by `stop`. */
  stop(): Promise<void>;
}

/**
 * A delivery that must NOT be tried again.
 *
 * Retry is the runtime's default because most failures are transient. Some are
 * not: an external effect whose outcome is unknown cannot be replayed on a
 * guess (§4.3), and a stimulus whose delivery already spent one must park where
 * a person can see it rather than repeat it. Throwing this from `deliver` says
 * exactly that — park the row dead, spend no attempt, and name it through
 * `onDead`.
 */
export class StimulusQuarantine extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StimulusQuarantine';
  }
}

/**
 * How an accepted stimulus reaches the loop.
 *
 * The runtime journals dispatch before native IO and ACKs the native receipt.
 * Returning from `deliver` settles the consumer adapter; it does not prove a
 * judgment or an external effect. After dispatch, failures require reconciliation.
 * Only failures known to precede dispatch remain eligible for automatic retry.
 *
 * This is delivery, not a second turn loop: what runs inside `deliver` is the
 * native session the product already has, with its own resume, steering and
 * turn observation. Nothing here interprets the stimulus, and nothing here
 * decides a turn is finished — an ack says the loop took it and no more.
 */
export interface NativeDeliveryContext {
  nativeInputId: string;
  /** Read the one final result for a shared turn under this input's principal. */
  resultForReceipt(receipt: NativeInputReceipt): NativeTurnResultRecord | null;
  run<TRequest extends object>(
    content: ContentBlock[],
    request?: TRequest & NativeInvocationOptions
  ): Promise<NativeTurnResult>;
  /** Native steer acceptance, never a model result or an effect receipt. */
  steer(
    content: string,
    target: NativeInputReceipt,
    sessionKey: string
  ): Promise<NativeInputReceipt>;
  wasDispatched(): boolean;
  /** Must persist successfully before writing the input to the native transport. */
  onInputDispatch(input: NativeInputDispatch): void;
  /** Native acknowledgement, distinct from model completion and external effects. */
  onAccepted(receipt: NativeInputReceipt): void;
}

export interface StimulusDelivery {
  deliver(row: MailboxRow, context: NativeDeliveryContext): Promise<void>;
  /** Reuse recorded results only. Never submit the input to a model again. */
  reconcile?(row: MailboxRow): Promise<'settled' | 'unresolved'>;
  onUncertain?(row: MailboxRow, reason: string): void | Promise<void>;
  /** Consumer ports may still be opening; keep accepted inputs without spending attempts. */
  ready?(): boolean;
  /**
   * A row this runtime parked dead, named once, as it happens.
   *
   * The runtime owns the claim and the retry, so it is the only subject that
   * knows a stimulus was lost for good. A consumer that had to discover its own
   * losses by re-reading the table would be claiming rows again to find them -
   * which is the second claimer this door exists to remove.
   */
  onDead?(row: MailboxRow, reason: string): void | Promise<void>;
  /** Terminal acknowledgement, including reconciliation. Reporting cannot change the drain. */
  onSettled?(row: MailboxRow): void | Promise<void>;
  /**
   * Kinds delivered ahead of the rest. §4.3 forbids a host FIFO in which the
   * person's current request waits behind a mass replay; stating the owner's
   * own message here is what keeps that from happening.
   */
  prefer?: readonly StimulusKind[];
  /** How long a claim may go unacked before it returns to pending. */
  leaseMs?: number;
  /** How many rows one tick delivers before yielding. */
  maxPerTick?: number;
  /** Bound inputs waiting for native ACK; accepted model results do not consume this window. */
  maxPendingInputs?: number;
  /**
   * How often to look when nothing has been accepted. `0` means only on accept.
   *
   * This is the floor under acceptance, not the way work normally arrives, so
   * it is paced to the shortest retry backoff rather than to latency: an accept
   * drains immediately, and nothing else becomes deliverable between ticks
   * except a retry whose minimum wait is a minute.
   */
  intervalMs?: number;
}

/**
 * What acceptance means, and what it does not.
 *
 * `accepted` says the stimulus is durable and will be delivered. It is not a
 * claim that anything has been read, decided or done — v7 §4.4 is explicit that
 * a delivery ACK is not a work receipt, and this receipt is one step earlier
 * than that. `duplicate` says every ref the producer stated was already
 * durable, so there is no new row and nothing was lost.
 */
export interface StimulusReceipt {
  /** The durable row, or `null` when the stimulus was already held. */
  inputId: string | null;
  state: 'accepted' | 'duplicate';
}

export interface StartRuntimeOptions {
  paths: RuntimePaths;
  catalog: ActionCatalog;
  dispatch: ActionDispatcher;
  /**
   * Every principal this runtime serves, each with its own credential file.
   * The credential is a bearer token for local session proof only; it is never
   * written to prompts, shared env, or logs. Two principals may not share a
   * credential path — the token would no longer name one caller.
   */
  principals: readonly RuntimePrincipal[];
  /**
   * Passed through to the socket server — host-stated call-site facts for
   * calls on this socket (e.g. the surface name and the credential binding
   * hash). Facts the socket cannot truthfully state stay absent.
   */
  sessionFacts?: (access: JudgmentAccess, request: IpcRequest) => ActionSessionFacts | undefined;
  /** Passed through to the socket server — reclaim a dead socket file, refuse a live one. */
  reclaimStaleSocket?: boolean;
  /**
   * The one model this runtime opens, for the actions that need text back.
   *
   * A library that opens its own model decides for every host that installs it
   * (§2.1). Absent means this runtime has no model to ask, and the actions
   * that would have used one say so rather than answering as if they had.
   */
  runner?: TextCompletion;
  /**
   * The store the durable intake is opened against.
   *
   * Stated by the product for the same reason every path is: core does not
   * choose which database a consumer's mailbox lives in. Absent means this
   * runtime has no intake, and `accept` refuses instead of quietly dropping a
   * stimulus whose producer believes it is now durable.
   */
  mailbox?: { adapter: DatabaseAdapter; clock?: () => number };
  /**
   * Where an accepted stimulus goes. Absent means this runtime accepts and
   * keeps but hands nothing on — the store is then drained by whoever states
   * they own it, and `drainOnce` is the door they use.
   */
  delivery?: StimulusDelivery;
  /**
   * The harness this runtime owns for its lifetime.
   *
   * Absent means this runtime serves actions and keeps stimuli but opened no
   * model session - an MCP-only profile is exactly that, and it should not
   * pretend to close one.
   */
  nativeSession?: NativeSessionHandle;
}

export interface RuntimeHandle {
  /** Internal host port: only a currently claimed input may invoke the native session. */
  runNative<TRequest extends object>(
    nativeInputId: string,
    content: ContentBlock[],
    request?: TRequest & NativeInvocationOptions
  ): Promise<NativeTurnResult>;
  socketPath: string;
  /** The model this runtime opened, or undefined when it opened none. */
  runner?: TextCompletion;
  /**
   * The durable intake this runtime opened, for the consumer that drains it.
   *
   * One store, opened once, by the subject that owns the loop's material. A
   * product that constructed its own would have two openers of one table and
   * no single place that says when it exists.
   */
  mailbox?: Mailbox;
  /**
   * The one door a stimulus enters by. Durable on return, and nothing else.
   *
   * Refuses — loudly — a principal this runtime does not serve, an unknown
   * kind, a stimulus with no channel identity, and a runtime that opened no
   * intake. A producer holding a receipt believes the stimulus is kept, so
   * none of those may pass quietly.
   */
  accept(stimulus: Stimulus): StimulusReceipt;
  /**
   * Deliver what is pending, once. Returns what happened, so a caller that
   * drives the drain itself can tell idle from failing.
   *
   * Runs the stale-claim replay first: a claim is a lease, so a delivery that
   * died mid-flight is owed again rather than lost.
   */
  drainOnce(): Promise<{ delivered: number; failed: number; dead: number }>;
  /**
   * The principal a presented credential names, or `undefined` for nobody.
   *
   * One boot issues the credentials; this is the same table the socket
   * resolves against, read by a second local door rather than duplicated. It
   * only ever narrows: an absent or unknown credential resolves to nobody, and
   * there is no caller this answers for that the socket would not.
   */
  principalFor(credential: string | undefined): RuntimePrincipal | undefined;
  /** Whether this boot currently serves an exact principal for durable intake. */
  servesPrincipal(principalId: string): boolean;
  /** Add a product-identified caller to the live socket and intake without reopening either. */
  servePrincipal(principal: RuntimePrincipal): void;
  /** Remove a caller's socket identity and durable-intake admission immediately. */
  unservePrincipal(principalId: string): void;
  /** The harness this runtime opened, or undefined when it opened none. */
  nativeSession?: Pick<NativeSessionHandle, 'stop' | 'resetSession'>;
  /**
   * Closes what start opened, in the order that makes each close safe: the
   * drain first so nothing new is handed out, then the harness, then the socket
   * and this boot's credential. A caller that stops answering action calls
   * before the turn using them has ended would fail that turn on the way out.
   */
  stop(): Promise<void>;
}

/**
 * Opens the action surface: issues the session credential and serves
 * `catalog`/`dispatch` on the private socket. `stop` closes the socket and
 * removes the credential file it wrote — nothing else.
 */
export async function startRuntime(options: StartRuntimeOptions): Promise<RuntimeHandle> {
  const maxPerTick = options.delivery?.maxPerTick ?? 8;
  const maxPendingInputs = options.delivery?.maxPendingInputs ?? maxPerTick;
  if (!Number.isSafeInteger(maxPendingInputs) || maxPendingInputs < 1) {
    throw new Error('maxPendingInputs must be a positive integer');
  }
  const { socketPath } = options.paths;
  if (options.principals.length === 0) {
    throw new Error('startRuntime requires at least one principal');
  }
  const paths = options.principals.map((principal) => principal.credentialPath);
  if (new Set(paths).size !== paths.length) {
    throw new Error('each principal needs its own credential path');
  }
  const ids = options.principals.map((principal) => principal.access.principalId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('each principal needs its own principal ID');
  }
  mkdirSync(dirname(socketPath), { recursive: true });

  // Opened before the socket, for the same reason the credential table is: a
  // producer must never reach a runtime whose intake does not exist yet.
  const mailbox = options.mailbox
    ? new Mailbox(
        options.mailbox.adapter,
        ...(options.mailbox.clock ? ([options.mailbox.clock] as const) : ([] as const))
      )
    : undefined;

  // Prepare the credential table before the socket, but publish files only
  // after the socket is ours. A second start must not rotate or remove the
  // credentials of a live runtime whose socket it failed to acquire.
  const byCredential = new Map<string, RuntimePrincipal>();
  const byPrincipalId = new Map<string, { principal: RuntimePrincipal; credential: string }>();
  const credentialsToPublish: Array<{ path: string; credential: string }> = [];
  const credentialPaths = new Set(paths);
  const written = new Set<string>();
  const removeCredentials = (): void => {
    for (const path of written) {
      rmSync(path, { force: true });
    }
    written.clear();
  };
  for (const principal of options.principals) {
    const credential = randomUUID();
    credentialsToPublish.push({ path: principal.credentialPath, credential });
    byCredential.set(credential, principal);
    byPrincipalId.set(principal.access.principalId, { principal, credential });
  }

  const mounted = await createActionIpcServer({
    socketPath,
    catalog: options.catalog,
    dispatch: options.dispatch,
    // The principal's stated run rides with whatever the host states per
    // call. The credential selects it, so one caller's run is never another's.
    sessionFacts: (access, request) => {
      const stated = options.sessionFacts?.(access, request);
      const principal =
        request.credential === undefined ? undefined : byCredential.get(request.credential);
      const runEvidenceScope = principal?.runEvidenceScope;
      if (!runEvidenceScope) {
        return stated;
      }
      return { ...(stated ?? {}), runEvidenceScope };
    },
    reclaimStaleSocket: options.reclaimStaleSocket,
    resolveAccess: (presented) => {
      const principal = presented === undefined ? undefined : byCredential.get(presented);
      if (principal === undefined) {
        throw new Error('unresolved session credential');
      }
      return principal.access;
    },
  });
  try {
    for (const entry of credentialsToPublish) {
      writeCredential(entry.path, entry.credential);
      written.add(entry.path);
    }
    const requeued = mailbox?.recoverOrphanedClaims() ?? 0;
    if (requeued > 0) {
      console.info(`[Runtime] requeued orphaned mailbox claims count=${requeued}`);
    }
  } catch (error) {
    try {
      await mounted.close();
    } finally {
      removeCredentials();
    }
    throw error;
  }

  const servedPrincipals = new Set(
    options.principals.map((principal) => principal.access.principalId)
  );

  const delivery = options.delivery;
  const leaseMs = delivery?.leaseMs ?? 10 * 60_000;
  // The replay's job is to return claims that outlived their lease, and the
  // youngest thing it can find is `leaseMs` old - so running it on every drain
  // (once per accept, plus every tick) spends a full scan and three prunes to
  // find nothing. Half a lease is the most often it can report anything new.
  // The floor paces WHEN the scan runs, never whether a loss is recorded: a
  // row that spent its attempts is dead in the store and visible in `depth()`
  // the moment it happens. What the pacing can delay is this drain REPORTING
  // it, on a runtime configured with a lease under a minute.
  const replayEveryMs = Math.max(leaseMs / 2, 30_000);
  let lastReplayAt = 0;
  let draining = false;
  let currentScan: Promise<void> | undefined;
  let stopped = false;
  const servePrincipal = (principal: RuntimePrincipal): void => {
    if (stopped) throw new Error('Cannot serve a principal after runtime stop');
    const principalId = principal.access.principalId;
    if (!principalId.trim()) throw new Error('Runtime principal ID is required');
    if (byPrincipalId.has(principalId)) throw new Error('Runtime principal is already served');
    if (credentialPaths.has(principal.credentialPath)) {
      throw new Error('Runtime credential path is already served');
    }
    const credential = randomUUID();
    writeCredential(principal.credentialPath, credential);
    written.add(principal.credentialPath);
    credentialPaths.add(principal.credentialPath);
    byCredential.set(credential, principal);
    byPrincipalId.set(principalId, { principal, credential });
    servedPrincipals.add(principalId);
  };
  const unservePrincipal = (principalId: string): void => {
    if (stopped) throw new Error('Cannot unserve a principal after runtime stop');
    const served = byPrincipalId.get(principalId);
    if (!served) return;
    byCredential.delete(served.credential);
    byPrincipalId.delete(principalId);
    servedPrincipals.delete(principalId);
    rmSync(served.principal.credentialPath, { force: true });
    credentialPaths.delete(served.principal.credentialPath);
    written.delete(served.principal.credentialPath);
  };
  let reconciliationCursor = 0;
  type DrainResult = { delivered: number; failed: number; dead: number };
  const activeDeliveries = new Map<number, { accepted: boolean; result: Promise<DrainResult> }>();
  const reportedUncertain = new Set<number>();
  let drainScheduled = false;
  const scheduleDrain = (): void => {
    if (stopped || drainScheduled) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      void drainOnce().catch(() => {});
    });
  };
  const activeNativeInputs = new Map<string, NativeDeliveryContext['run']>();
  const runNative: RuntimeHandle['runNative'] = (nativeInputId, content, request) => {
    const run = activeNativeInputs.get(nativeInputId);
    if (stopped || !run)
      return Promise.reject(new Error('Native execution requires a currently active input'));
    return run(content, request);
  };

  const markUncertain = async (row: MailboxRow, reason: string): Promise<void> => {
    // The first recorded cause stays; a later reconcile pass only re-reports it.
    if (mailbox!.nativeInputs.get(row.id)?.state !== 'uncertain') {
      mailbox!.nativeInputs.uncertain(row.id, reason);
    }
    if (reportedUncertain.has(row.id)) return;
    reportedUncertain.add(row.id);
    try {
      await delivery?.onUncertain?.(row, reason);
    } catch {
      // The unresolved dispatch remains durable even if reporting fails.
    }
  };

  // A loss is the runtime's to report, and reporting it may not break the
  // drain: the next row is still owed delivery.
  const announceDead = async (row: MailboxRow, reason: string): Promise<void> => {
    if (!delivery?.onDead) return;
    try {
      await delivery.onDead(row, reason);
    } catch {
      // The report failed; the death is already durable in the store.
    }
  };

  const announceSettled = async (row: MailboxRow): Promise<void> => {
    try {
      await delivery?.onSettled?.(row);
    } catch (error) {
      console.error(`[Runtime] onSettled failed input=${row.id}`, error);
    }
  };

  const deliverClaim = async (row: MailboxRow): Promise<DrainResult> => {
    const result = { delivered: 0, failed: 0, dead: 0 };
    try {
      if (!servedPrincipals.has(row.principalId))
        throw new StimulusQuarantine('Input principal is no longer served');
      const nativeDelivery = mailbox!.nativeInputs.prepare(row.id);
      if (!nativeDelivery.invocationId)
        throw new StimulusQuarantine('Native input identity is unresolved');
      const inputId = nativeDelivery.invocationId;
      let invoked = false;
      let nativeRun: Promise<NativeTurnResult> | null = null;
      let nativeSteer: Promise<NativeInputReceipt> | null = null;
      const context: NativeDeliveryContext = {
        nativeInputId: inputId,
        resultForReceipt: (receipt) =>
          mailbox!.nativeInputs.resultForReceipt(receipt, row.principalId),
        onInputDispatch: (input) => mailbox!.nativeInputs.dispatch(row.id, input),
        onAccepted: (receipt) => {
          const active = activeDeliveries.get(row.id);
          if (!active) throw new Error('Native acknowledgement requires an active input');
          mailbox!.nativeInputs.accept(row.id, receipt);
          active.accepted = true;
          scheduleDrain();
        },
        wasDispatched: () => {
          const record = mailbox!.nativeInputs.get(row.id);
          if (!record) throw new Error('Native input delivery record is missing');
          return record.state !== 'prepared';
        },
        run: (content, request) => {
          if (stopped || activeNativeInputs.get(inputId) !== context.run) {
            return Promise.reject(new Error('Native execution requires a currently active input'));
          }
          if (invoked)
            return Promise.reject(new Error('Native session already invoked for this input'));
          if (!options.nativeSession?.runTurn)
            return Promise.reject(
              new StimulusQuarantine('Native session execution is not configured')
            );
          invoked = true;
          const observer = request?.streamCallbacks;
          const invoke = options.nativeSession.runTurn.bind(options.nativeSession);
          nativeRun = Promise.resolve()
            .then(() => {
              // A host can cancel a claimed input while it waits for a serial turn slot.
              if (mailbox!.inputStatus(row.id) !== 'claimed')
                throw new StimulusQuarantine('Queued input cancelled by host');
              return invoke(content, {
                ...request,
                nativeInputId: inputId,
                streamCallbacks: {
                  ...observer,
                  onInputDispatch: (input) => {
                    context.onInputDispatch(input);
                    observer?.onInputDispatch?.(input);
                  },
                  onAccepted: (receipt) => {
                    context.onAccepted(receipt);
                    observer?.onAccepted?.(receipt);
                  },
                },
              });
            })
            .then((nativeResult) => {
              if (!mailbox!.nativeInputs.get(row.id)?.receipt) {
                mailbox!.nativeInputs.uncertain(row.id, 'Native result has no accepted receipt');
                throw new Error('Native result has no accepted receipt');
              }
              mailbox!.nativeInputs.storeResult(row.id, nativeResult);
              return nativeResult;
            });
          // The drain observes this rejection even if its adapter forgot to await.
          void nativeRun.catch(() => {});
          return nativeRun;
        },
        steer: (content, target, sessionKey) => {
          if (stopped || activeNativeInputs.get(inputId) !== context.run) {
            return Promise.reject(new Error('Native steering requires a currently active input'));
          }
          if (invoked)
            return Promise.reject(new Error('Native session already invoked for this input'));
          if (!options.nativeSession?.steer)
            return Promise.reject(new StimulusQuarantine('Native steering is not configured'));
          if (
            target.backend !== 'codex' ||
            !target.sessionId.trim() ||
            !target.turnId.trim() ||
            !sessionKey.trim()
          ) {
            return Promise.reject(new Error('Native steering requires an exact Codex turn'));
          }
          if (
            mailbox!.nativeInputs.listByReceipt(target, row.principalId, { limit: 1 }).inputIds
              .length === 0
          ) {
            return Promise.reject(
              new Error('Native steering target is not accepted for this principal')
            );
          }
          invoked = true;
          const invoke = options.nativeSession.steer.bind(options.nativeSession);
          nativeSteer = Promise.resolve()
            .then(async () => {
              if (stopped) throw new Error('Native runtime stopped before steering dispatch');
              const receipt = await invoke(content, target, sessionKey, () =>
                context.onInputDispatch({
                  backend: 'codex',
                  sessionId: target.sessionId,
                  inputId,
                })
              );
              if (
                receipt.backend !== 'codex' ||
                receipt.sessionId !== target.sessionId ||
                receipt.turnId !== target.turnId
              ) {
                throw new Error('Native steer receipt does not match the target turn');
              }
              context.onAccepted(receipt);
              return receipt;
            })
            .catch((error: unknown) => {
              if (
                error instanceof NativeSteeringTargetUnavailableError &&
                !context.wasDispatched()
              ) {
                // This attempt never reached the native transport. The same claimed
                // input may open a fresh turn without spending a retry or duplicating IO.
                invoked = false;
                nativeSteer = null;
              }
              throw error;
            });
          void nativeSteer.catch(() => {});
          return nativeSteer;
        },
      };
      activeNativeInputs.set(inputId, context.run);
      try {
        await delivery!.deliver({ ...row, nativeDelivery }, context);
      } finally {
        try {
          if (nativeRun) await nativeRun;
          if (nativeSteer) await nativeSteer;
        } finally {
          activeNativeInputs.delete(inputId);
        }
      }
      mailbox!.nativeInputs.settle(row.id);
      result.delivered += 1;
      await announceSettled(row);
    } catch (error) {
      // A consumer erased a cancelled waiter while it held a delivery slot. No row remains to
      // retry, quarantine or settle, and this stale delivery must never start a native turn.
      if (mailbox!.inputStatus(row.id) === null) {
        console.info(`[Runtime] deleted waiting input=${row.id}; no native turn or retry`);
        return result;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const native = mailbox!.nativeInputs.get(row.id);
      if (native && native.state !== 'prepared') {
        await markUncertain(row, reason);
        result.failed += 1;
        return result;
      }
      if (error instanceof StimulusQuarantine) {
        // The host says this one must not be tried again. No attempt is
        // spent and no backoff applies: it parks where it can be seen.
        mailbox!.quarantine(row.id, reason);
        result.failed += 1;
        result.dead += 1;
        await announceDead(row, reason);
        return result;
      }
      // The host did not take it. The row is owed again under the backoff,
      // and a row that has spent its attempts parks dead and visible -
      // a permanent loss is never silent.
      const outcome = mailbox!.retry(row.id, reason);
      result.failed += 1;
      if (outcome === 'dead') {
        result.dead += 1;
        await announceDead(row, reason);
      }
    }
    return result;
  };

  const drainOnce = async (): Promise<DrainResult> => {
    const result = { delivered: 0, failed: 0, dead: 0 };
    if (!mailbox || !delivery || draining || stopped || delivery.ready?.() === false) return result;
    const started: Promise<DrainResult>[] = [];
    draining = true;
    let finishScan!: () => void;
    currentScan = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    try {
      const now = Date.now();
      if (now - lastReplayAt >= replayEveryMs) {
        lastReplayAt = now;
        // These claims are still owned by live adapters, including pre-dispatch waits.
        for (const [id, active] of activeDeliveries) {
          if (!active.accepted) mailbox.renewClaim(id, now);
        }
        const replay = mailbox.replayStaleDetailed(leaseMs, now);
        result.dead += replay.newlyDead.length;
        for (const dead of replay.newlyDead) await announceDead(dead, 'lease expired repeatedly');
      }
      const unresolved = mailbox.unsettledNative(maxPerTick, reconciliationCursor);
      reconciliationCursor =
        unresolved.length === maxPerTick ? unresolved[unresolved.length - 1].id : 0;
      for (const row of unresolved) {
        if (activeDeliveries.has(row.id) || !servedPrincipals.has(row.principalId)) continue;
        try {
          if ((await delivery.reconcile?.(row)) === 'settled') {
            mailbox.nativeInputs.settle(row.id, true);
            await announceSettled(row);
          }
        } catch (error) {
          await markUncertain(row, error instanceof Error ? error.message : String(error));
        }
      }
      for (let count = 0; count < maxPerTick && !stopped && delivery.ready?.() !== false; count++) {
        const waiting = [...activeDeliveries.values()].filter((active) => !active.accepted).length;
        if (waiting >= maxPendingInputs) break;
        const row = mailbox.claimNext(delivery.prefer ? { prefer: delivery.prefer } : {});
        if (!row) break;
        const completion = Promise.resolve()
          .then(() => deliverClaim(row))
          .finally(() => {
            activeDeliveries.delete(row.id);
            scheduleDrain();
          });
        activeDeliveries.set(row.id, { accepted: false, result: completion });
        started.push(completion);
      }
    } finally {
      // Scanning/claiming is serialized; an accepted native turn's result is not the next input's gate.
      draining = false;
      currentScan = undefined;
      finishScan();
    }
    for (const outcome of await Promise.all(started)) {
      result.delivered += outcome.delivered;
      result.failed += outcome.failed;
      result.dead += outcome.dead;
    }
    return result;
  };

  // Accepting is what usually has something to deliver, so the drain follows
  // acceptance rather than waiting for the next tick. The interval is the
  // floor underneath it: a retry's backoff expires on nobody's accept.
  const intervalMs = delivery?.intervalMs ?? 5_000;
  const timer =
    mailbox && delivery && intervalMs > 0
      ? setInterval(() => {
          void drainOnce().catch(() => {});
        }, intervalMs)
      : undefined;
  timer?.unref?.();

  return {
    runNative,
    socketPath: mounted.socketPath,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(mailbox ? { mailbox } : {}),
    accept: (stimulus) => {
      if (!mailbox) {
        throw new Error('runtime.accept requires a mailbox store stated at start');
      }
      if (!isStimulusKind(stimulus.kind)) {
        throw new Error(`runtime.accept: unknown stimulus kind "${String(stimulus.kind)}"`);
      }
      if (!servedPrincipals.has(stimulus.principalId)) {
        throw new Error(`runtime.accept: principal "${stimulus.principalId}" is not served here`);
      }
      if (stimulus.channelKey.trim() === '') {
        throw new Error('runtime.accept requires the stimulus channel identity');
      }
      const rowId = mailbox.enqueue(stimulus);
      if (rowId !== null && delivery) {
        // After the row is durable, never before: a producer's receipt must
        // mean "kept", and a drain that ran first could ack what was never
        // written.
        scheduleDrain();
      }
      return rowId === null
        ? { inputId: null, state: 'duplicate' }
        : { inputId: String(rowId), state: 'accepted' };
    },
    drainOnce,
    ...(options.nativeSession
      ? {
          nativeSession: {
            stop: () => options.nativeSession!.stop(),
            resetSession: async (sessionKey: string) => {
              if (!options.nativeSession!.resetSession)
                throw new Error('Native session reset is not configured');
              await options.nativeSession!.resetSession(sessionKey);
            },
          },
        }
      : {}),
    principalFor: (credential) =>
      credential === undefined ? undefined : byCredential.get(credential),
    servesPrincipal: (principalId) => servedPrincipals.has(principalId),
    servePrincipal,
    unservePrincipal,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      // The harness goes before the socket: a turn still running holds action
      // calls, and closing the door under it would fail it on the way out.
      await options.nativeSession?.stop();
      await currentScan;
      // Result/outbox writers still own their claims until their adapters finish.
      await Promise.allSettled([...activeDeliveries.values()].map((active) => active.result));
      await mounted.close();
      removeCredentials();
    },
  };
}

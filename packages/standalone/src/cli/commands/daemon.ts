import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { OwnerMessageInput, TurnIntake } from '../../gateways/turn-contract.js';
import { TelegramGateway, type TelegramGatewayOptions } from '../../gateways/telegram.js';
import { DiscordGateway, type DiscordGatewayOptions } from '../../gateways/discord.js';
import { SlackGateway, type SlackGatewayOptions } from '../../gateways/slack.js';
import { OwnerMessageLedger } from '../../gateways/telegram-message-ledger.js';
import {
  sourceDeltaStimulusId,
  stimulusFailureReason,
  type StimulusIntake,
} from '../../runtime/stimulus-delivery.js';
import {
  createOwnerRuntime,
  type OwnerRuntime,
  type OwnerRuntimeOptions,
} from '../../runtime/owner-runtime.js';
import { ownerMemoryScopes } from '../../runtime/action-surface.js';
import {
  startConnectorRuntime,
  type ConnectorRuntime,
  type ConnectorRuntimeOptions,
} from '../../runtime/connectors.js';
import {
  defaultConfigPath,
  loadConfig,
  type MessengerName,
  type W1Config,
} from '../../runtime/config.js';
import { declareModelCache } from '../../runtime/model-cache.js';
import { sessionCredentialPath } from '../../runtime/session-credential.js';
import { ensureMamaMcpConfig, resolveActionServerPath } from '../runtime/action-mcp-config.js';
import type { SourceDelta } from '../../connectors/framework/polling-scheduler.js';
import { LOADABLE_CONNECTORS as OWNER_CONNECTORS } from '../../connectors/index.js';
import { createOwnerPolicyProvider } from '../../runtime/owner-policy.js';
import {
  createViewerServer as createDefaultViewerServer,
  type ViewerConnectorStatus,
  type ViewerServer,
  type ViewerServerOptions,
} from '../../api/viewer-server.js';
import { resolvePackageVersion } from '../../package-version.js';
import { readViewerMemoryStats } from '../../api/viewer-data.js';
import type { OwnerFileDeliveryResult } from '../../api/file-delivery.js';
import { createReportScheduler, type ReportScheduler } from '../../runtime/report-scheduler.js';
import { createTimeZoneSetting } from '../../runtime/timezone.js';
import { createOutboundEventRecorder } from '../../api/security-events.js';
import { startEgressProxy, type EgressProxy } from '../../runtime/egress-proxy.js';

const OWNER_PRINCIPAL_ID = 'owner';
const OWNER_AGENT_ID = 'owner-agent';
const OWNER_MEMORY_SCOPES = ownerMemoryScopes(OWNER_PRINCIPAL_ID, OWNER_CONNECTORS);

export interface DaemonLogger {
  info(line: string): void;
  error(line: string): void;
}

export interface DaemonGateway {
  recentDeliveredMessageRefs(): string[];
  /** This owner message has a delivered answer, an interruption notice included. */
  answered(sourceRef: string): boolean;
  recoverPendingResponses(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  deliverResponse(sourceRef: string, response: string): Promise<void>;
  sendToOwner(text: string, idempotencyKey: string): Promise<void>;
  sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<OwnerFileDeliveryResult>;
}

export interface DaemonPaths {
  mamaRoot: string;
  runtimeRoot: string;
  workspaceDir: string;
  downloadsDir: string;
  pluginDir: string;
  mcpConfigPath: string;
  socketPath: string;
  credentialPath: string;
  connectorsConfigPath: string;
  connectorsRoot: string;
  kagemushaDbPath: string;
  ownerMessageLedgerPath: string;
}

export interface DaemonIsolationOptions {
  config: W1Config;
  paths: DaemonPaths;
  mcpServerPath?: string;
}

export interface DaemonBootDependencies {
  createOwnerRuntime?: (options: OwnerRuntimeOptions) => Promise<OwnerRuntime>;
  createViewerServer?: (options: ViewerServerOptions) => ViewerServer;
  startConnectorRuntime?: (options: ConnectorRuntimeOptions) => Promise<ConnectorRuntime>;
  createTelegramGateway?: (options: TelegramGatewayOptions) => DaemonGateway;
  createDiscordGateway?: (options: DiscordGatewayOptions) => DaemonGateway;
  createSlackGateway?: (options: SlackGatewayOptions) => DaemonGateway;
  createReportScheduler?: typeof createReportScheduler;
  ensureIsolation?: (options: DaemonIsolationOptions) => void;
}

export interface DaemonBootOptions {
  home?: string;
  configPath?: string;
  config?: W1Config;
  logger?: DaemonLogger;
  mcpServerPath?: string;
  mode?: 'live' | 'replay';
  replay?: (context: DaemonReplayContext) => Promise<void>;
  dependencies?: DaemonBootDependencies;
}

export interface DaemonReplayContext {
  config: W1Config;
  paths: DaemonPaths;
  owner: OwnerRuntime;
  logger: DaemonLogger;
  timeZone: ReturnType<typeof createTimeZoneSetting>;
}

export interface DaemonHandle {
  readonly config: W1Config;
  readonly paths: DaemonPaths;
  readonly owner: OwnerRuntime;
  readonly viewer: ViewerServer | null;
  readonly connectors: ConnectorRuntime | null;
  readonly gateway: DaemonGateway | null;
  readonly gateways?: ReadonlyMap<MessengerName, DaemonGateway>;
  stop(): Promise<void>;
}

const defaultLogger: DaemonLogger = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * A failed stage names what failed. Messages from this codebase never carry
 * secrets (tokens are read from the environment and never formatted into errors).
 */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const name = error.name.trim() !== '' ? error.name : 'Error';
  return `${name}: ${error.message}`;
}

function stage(logger: DaemonLogger, name: string): void {
  logger.info(`boot stage=${name}`);
}

function stageFailed(logger: DaemonLogger, name: string, error: unknown): void {
  logger.error(`boot stage=${name} failed error=${errorName(error)}`);
}

function stimulusAccepted(
  logger: DaemonLogger,
  kind: string,
  id: string,
  receipt: StimulusReceipt
): void {
  logger.info(`stimulus accepted kind=${kind} id=${id} state=${receipt.state}`);
}

function stimulusFailed(
  logger: DaemonLogger,
  kind: string,
  id: string,
  error: unknown,
  modelRunId: string | null = null
): void {
  logger.error(
    `stimulus failed kind=${kind} id=${id} model_run_id=${modelRunId} reason=${stimulusFailureReason(error)}`
  );
}

function stimulusDelivered(logger: DaemonLogger, row: MailboxRow, modelRunId: string | null): void {
  logger.info(
    `stimulus delivered kind=${row.kind ?? 'unknown'} id=${row.stimulusId} model_run_id=${modelRunId}`
  );
}

function pathsOverlap(left: string, right: string): boolean {
  const inside = (parent: string, child: string): boolean => {
    const local = relative(resolve(parent), resolve(child));
    return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
  };
  return inside(left, right) || inside(right, left);
}

function sourceForRef(ref: string): MessengerName {
  if (ref.startsWith('telegram:')) return 'telegram';
  if (ref.startsWith('discord:')) return 'discord';
  if (ref.startsWith('slack:')) return 'slack';
  throw new Error('Owner message reference has no supported messenger prefix');
}

export function validateDeliveryRoutes(config: W1Config): void {
  const active = {
    telegram:
      config.telegram.enabled &&
      Boolean(
        config.telegram.owner_chat_id &&
        config.telegram.allowed_chats.includes(config.telegram.owner_chat_id)
      ),
    discord: Boolean(
      config.discord?.enabled &&
      config.discord.owner_channel_id &&
      config.discord.allowed_channels.includes(config.discord.owner_channel_id)
    ),
    slack: Boolean(
      config.slack?.enabled &&
      config.slack.owner_channel_id &&
      config.slack.allowed_channels.includes(config.slack.owner_channel_id)
    ),
  };
  // Only the routes name a messenger; delivery also holds text such as interrupted_notice.
  for (const purpose of ['reports', 'notifications', 'security_alerts'] as const) {
    const messenger: MessengerName = config.delivery?.[purpose] ?? 'telegram';
    if (!active[messenger])
      throw new Error(
        `delivery.${purpose} targets ${messenger}, which is disabled or has no allowlisted owner channel`
      );
  }
}

function pathsFor(configPath: string, config: W1Config): DaemonPaths {
  const mamaRoot = dirname(configPath);
  const runtimeRoot = join(mamaRoot, 'runtime');
  const workspaceDir = config.agent.codex_cwd ?? join(mamaRoot, 'workspace');
  const pluginDir = join(mamaRoot, '.empty-plugins');
  const mcpConfigPath = config.agent.tools?.mcp_config ?? join(runtimeRoot, 'mama-mcp-config.json');
  const connectorsRoot = join(mamaRoot, 'connectors');
  const downloadsDir = join(mamaRoot, 'downloads');
  // The unsandboxed daemon writes downloads; the agent writes the workspace. Overlap would let the
  // agent swap download directories for symlinks and redirect the daemon's writes.
  if (pathsOverlap(workspaceDir, downloadsDir)) {
    throw new Error(`agent.codex_cwd must not contain or sit inside ${downloadsDir}`);
  }
  return {
    mamaRoot,
    runtimeRoot,
    workspaceDir,
    downloadsDir,
    pluginDir,
    mcpConfigPath,
    socketPath: join(mamaRoot, 'runtime.sock'),
    credentialPath: sessionCredentialPath(mamaRoot),
    connectorsConfigPath: join(mamaRoot, 'connectors.json'),
    connectorsRoot,
    // Kagemusha's own database, read-only (archive connector: ~/.kagemusha/kagemusha.db).
    kagemushaDbPath: join(dirname(mamaRoot), '.kagemusha', 'kagemusha.db'),
    ownerMessageLedgerPath: join(runtimeRoot, 'owner-message-ledger.json'),
  };
}

/** Create only the native-process isolation files; never remove product state. */
export function ensureDaemonIsolation(options: DaemonIsolationOptions): void {
  const { config, paths } = options;
  mkdirSync(paths.downloadsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.workspaceDir, { recursive: true });
  const gitDir = join(paths.workspaceDir, '.git');
  mkdirSync(gitDir, { recursive: true });
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) writeFileSync(headPath, 'ref: refs/heads/main\n', { mode: 0o600 });

  if (config.agent.backend === 'claude') {
    mkdirSync(paths.pluginDir, { recursive: true });
    ensureMamaMcpConfig({
      mcpConfigPath: paths.mcpConfigPath,
      serverPath: options.mcpServerPath ?? resolveActionServerPath(),
      mamaHome: paths.mamaRoot,
    });
  }
}

function loggedOwnerIntake(intake: StimulusIntake, logger: DaemonLogger): TurnIntake {
  return {
    acceptOwnerMessage: (input: OwnerMessageInput) => {
      try {
        const receipt = intake.acceptOwnerMessage(input);
        stimulusAccepted(logger, 'owner_message', input.id, receipt);
        return receipt;
      } catch (error) {
        stimulusFailed(logger, 'owner_message', input.id, error);
        throw error;
      }
    },
    ...(intake.isPending === undefined ? {} : { isPending: intake.isPending }),
  };
}

async function stopOne(
  logger: DaemonLogger,
  name: string,
  stop: () => Promise<void> | void,
  errors: unknown[]
): Promise<void> {
  try {
    await stop();
  } catch (error) {
    errors.push(error);
    logger.error(`shutdown stage=${name} failed error=${errorName(error)}`);
  }
}

/** Open the W1 owner subject, then activate producers in their dependency order. */
export async function bootDaemon(options: DaemonBootOptions = {}): Promise<DaemonHandle> {
  const logger = options.logger ?? defaultLogger;
  const dependencies = options.dependencies ?? {};
  const configPath = options.configPath ?? defaultConfigPath(options.home ?? homedir());
  let config: W1Config;
  let paths: DaemonPaths;
  let owner: OwnerRuntime | undefined;
  let viewer: ViewerServer | null = null;
  let connectors: ConnectorRuntime | undefined;
  let gateway: DaemonGateway | null = null;
  const gateways = new Map<MessengerName, DaemonGateway>();
  let reportScheduler: ReportScheduler | undefined;
  let egressProxy: EgressProxy | undefined;
  let stopped = false;
  let deliveryReady = options.mode === 'replay';
  const startedAt = Date.now();
  let currentStage = 'config';

  const stopResources = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    if (reportScheduler)
      await stopOne(logger, 'report_scheduler', () => reportScheduler!.stop(), errors);
    if (connectors) await stopOne(logger, 'connectors', () => connectors!.stop(), errors);
    if (viewer) await stopOne(logger, 'viewer', () => viewer!.stop(), errors);
    if (owner) await stopOne(logger, 'owner_runtime', () => owner!.stop(), errors);
    // After the owner: a turn still finishing may try the network and must still be refused.
    if (egressProxy) await stopOne(logger, 'egress_proxy', () => egressProxy!.close(), errors);
    // The owner drains active result writers before their delivery port closes.
    for (const [name, active] of gateways) await stopOne(logger, name, () => active.stop(), errors);
    if (errors.length > 0) throw new AggregateError(errors, 'Daemon shutdown failed');
  };

  try {
    currentStage = 'config';
    stage(logger, 'config');
    config = options.config ?? loadConfig({ path: configPath, home: options.home });
    const timeZone = createTimeZoneSetting(config.timezone);
    validateDeliveryRoutes(config);
    // launchd may have created the redirected log already; preserve its contents and tighten it.
    mkdirSync(dirname(config.logging.file), { recursive: true });
    const logDescriptor = openSync(config.logging.file, 'a', 0o600);
    try {
      fchmodSync(logDescriptor, 0o600);
    } finally {
      closeSync(logDescriptor);
    }
    declareModelCache();
    paths = pathsFor(configPath, config);
    currentStage = 'isolation';
    const ensureIsolation = dependencies.ensureIsolation ?? ensureDaemonIsolation;
    ensureIsolation({
      config,
      paths,
      ...(options.mcpServerPath ? { mcpServerPath: options.mcpServerPath } : {}),
    });
    stage(logger, 'isolation');

    currentStage = 'owner_runtime';
    const ownerPolicyProvider = createOwnerPolicyProvider(paths.mamaRoot);
    const ownerPolicy = ownerPolicyProvider();
    logger.info(`owner policy: ${ownerPolicy.loaded ? 'loaded' : 'none'}`);
    const deliverOwnerResponse = async (
      row: MailboxRow,
      result: NativeTurnResult
    ): Promise<void> => {
      const messenger = sourceForRef(row.stimulusId);
      const selected = gateways.get(messenger);
      if (!selected) throw new Error(`${messenger} gateway is not available for an owner response`);
      await selected.deliverResponse(row.stimulusId, result.response);
    };
    const deliverSourceResponse = async (
      row: MailboxRow,
      result: NativeTurnResult
    ): Promise<void> => {
      const text = result.response.trim();
      const tagIndex = Math.max(text.lastIndexOf('[notify]'), text.lastIndexOf('[ack]'));
      const routed = tagIndex >= 0 ? text.slice(tagIndex) : '';
      const route = routed.startsWith('[notify]')
        ? 'notify'
        : routed.startsWith('[ack]')
          ? 'ack'
          : 'untagged';
      logger.info(`delta report route=${route} id=${row.stimulusId}`);
      if (route !== 'notify') return;
      const content = routed.slice('[notify]'.length).trim();
      if (!content) {
        logger.error(
          `delta report route=notify has no message after the marker id=${row.stimulusId}`
        );
        return;
      }
      const selected = gateways.get(config.delivery?.notifications ?? 'telegram');
      if (!selected) throw new Error('Notification delivery messenger is not available');
      await selected.sendToOwner(content, row.stimulusId);
    };
    // Viewer and agent security alerts take the security route, resolved when an alert is sent
    // because the messengers start after the owner runtime.
    const sendSecurityAlert = async (text: string, key: string): Promise<void> => {
      const selected = gateways.get(config.delivery?.security_alerts ?? 'telegram');
      if (!selected) throw new Error('Security alert delivery messenger is not available');
      await selected.sendToOwner(text, key);
    };
    // Outbound attempts are seen, not blocked (W35).
    const outboundEvents = createOutboundEventRecorder({
      path: join(paths.mamaRoot, 'logs', 'security-events.jsonl'),
      replay: options.mode === 'replay',
      timeZone,
      sendToOwner: sendSecurityAlert,
    });
    // The Claude shell sandbox's network goes through this deny-all proxy, which reports each
    // connection the way it reports a command (W35.4); the ports reach the workspace settings.
    egressProxy = await startEgressProxy((attempt) =>
      outboundEvents.record({
        time: new Date().toISOString(),
        class: 'outbound_connect',
        tool: 'sandbox proxy',
        summary: `${attempt.method} ${attempt.target} (${attempt.protocol} proxy)`,
        sendsData:
          attempt.method === 'CONNECT' ? null : ['POST', 'PUT', 'PATCH'].includes(attempt.method),
        modelRunId: null,
        callId: null,
      })
    );
    const ownerFactory = dependencies.createOwnerRuntime ?? createOwnerRuntime;
    owner = await ownerFactory({
      backend: config.agent.backend,
      model: config.agent.model,
      databasePath: config.database.path,
      socketPath: paths.socketPath,
      credentialPath: paths.credentialPath,
      runtimeRoot: paths.mamaRoot,
      timeZone,
      replayKeyFile: config.jev?.keyFile,
      ...(config.jev?.enabled ? { jev: config.jev } : {}),
      workspaceDir: paths.workspaceDir,
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
      agentId: OWNER_AGENT_ID,
      outboundAttempts: (event) => outboundEvents.record(event),
      sandboxNetworkProxy: {
        httpProxyPort: egressProxy.httpProxyPort,
        socksProxyPort: egressProxy.socksProxyPort,
      },
      scopes: OWNER_MEMORY_SCOPES,
      connectors: OWNER_CONNECTORS,
      rawPath: paths.connectorsRoot,
      effort: config.agent.effort,
      maxTurns: config.agent.max_turns,
      timeout: config.agent.timeout,
      maxTurnMs: config.agent.max_turn_ms,
      runTokenBudget: config.agent.run_token_budget,
      ...(config.agent.codex_home === undefined ? {} : { codexHome: config.agent.codex_home }),
      codexSandbox: config.agent.codex_sandbox ?? 'workspace-write',
      ...(config.agent.backend === 'claude' ? { mcpConfigPath: paths.mcpConfigPath } : {}),
      pluginDir: paths.pluginDir,
      attachmentPorts: {
        downloadsDir: paths.downloadsDir,
        connectors: () => connectors?.registry ?? null,
        telegram: () => gateways.get('telegram') ?? null,
        discord: () => gateways.get('discord') ?? null,
        slack: () => gateways.get('slack') ?? null,
      },
      ...(config.wiki?.enabled
        ? {
            wiki: {
              enabled: true,
              vaultPath: config.wiki.vaultPath!,
              wikiDir: config.wiki.wikiDir!,
            },
          }
        : {}),
      formattingRoutes: {
        reports: config.delivery?.reports ?? 'telegram',
        notifications: config.delivery?.notifications ?? 'telegram',
      },
      ownerPolicyProvider,
      deliveryReady: () => deliveryReady,
      recentDeliveredOwnerMessages: () =>
        [...gateways.values()].flatMap((active) => active.recentDeliveredMessageRefs()),
      ...(options.mode === 'replay'
        ? {}
        : {
            onOwnerResult: deliverOwnerResponse,
            onStimulusUncertain: async (row) => {
              logger.error(
                `stimulus parked uncertain kind=${row.kind ?? 'unknown'} mailbox_id=${row.id}`
              );
              if (row.kind !== 'owner_message') return;
              const selected = gateways.get(sourceForRef(row.stimulusId));
              if (!selected)
                throw new Error('Owner messenger is not available for an interrupted response');
              await selected.recoverPendingResponses();
            },
            closeUncertain: {
              ownerAnswered: (row) =>
                gateways.get(sourceForRef(row.stimulusId))?.answered(row.stimulusId) ?? false,
              onClosed: (row, followUp) =>
                logger.info(
                  `stimulus closed after uncertain kind=${row.kind ?? 'unknown'} mailbox_id=${row.id} follow_up=${followUp}`
                ),
            },
            onSourceResult: deliverSourceResponse,
            onScheduledResult: async (row, result) => {
              if (!reportScheduler)
                throw new Error('Report scheduler is not available for a scheduled result');
              await reportScheduler.onResult(row, result);
            },
          }),
      onStimulusDead: (row, reason) =>
        logger.error(
          `stimulus parked dead kind=${row.kind ?? 'unknown'} mailbox_id=${row.id} reason=${stimulusFailureReason(reason)}`
        ),
      onLessonSearchFailed: (reason) => logger.error(`lesson recall failed reason=${reason}`),
      onStimulusSkipped: (row, reason) =>
        logger.info(
          `stimulus skipped kind=${row.kind ?? 'unknown'} mailbox_id=${row.id} reason=${reason}`
        ),
      onRecordOrderEvent: (event) => {
        const line = `record order ${event.type} delta=${event.deltaStimulusId} attempt=${event.attempt}${
          'order' in event ? ` order=${event.order}` : ''
        }${'reason' in event ? ` reason=${stimulusFailureReason(event.reason)}` : ''}`;
        if (event.type === 'lost') logger.error(line);
        else logger.info(line);
      },
      onStimulusDelivered: (row, modelRunId) => stimulusDelivered(logger, row, modelRunId),
      onStimulusFailed: (row, reason, modelRunId) =>
        stimulusFailed(logger, row.kind ?? 'unknown', row.stimulusId, reason, modelRunId),
    });
    stage(logger, 'owner_runtime');

    currentStage = 'viewer';
    const viewerFactory = dependencies.createViewerServer ?? createDefaultViewerServer;
    viewer = viewerFactory({
      dispatch: owner.surface.dispatch,
      ownerAccess: owner.surface.ownerAccess,
      timeZone,
      reportStore: owner.reportStore,
      reportSseClients: owner.reportSseClients,
      wikiRoot: owner.wikiRoot,
      logPath: config.logging.file,
      securityEvents: {
        path: join(paths.mamaRoot, 'logs', 'security-events.jsonl'),
        replay: options.mode === 'replay',
        timeZone,
        sendToOwner: sendSecurityAlert,
      },
      getMemoryStats: () => readViewerMemoryStats(owner!.database.adapter),
      getRuntimeStatus: () => ({
        running: true,
        version: resolvePackageVersion(),
        backend: config.agent.backend,
        model: config.agent.model,
        startedAt,
        health: null,
        connectors: (connectors?.enabledConnectorNames ?? []).map((name) => ({
          name,
          enabled: true,
          state: connectors?.registry.get(name) ? ('connected' as const) : ('unknown' as const),
        })),
      }),
      getConnectorStatus: async (): Promise<ViewerConnectorStatus[]> => {
        if (!connectors) return [];
        const connectorRuntime = connectors;
        const health = await connectorRuntime.registry.healthCheckAll();
        return connectorRuntime.enabledConnectorNames.map((name) => {
          const current = health[name];
          return {
            name,
            enabled: true,
            healthy: current?.healthy === true,
            lastPoll: current?.lastPollTime?.toISOString() ?? null,
            channelCount: connectorRuntime.channelCounts[name] ?? null,
          };
        });
      },
    });
    await viewer.start();
    logger.info(`viewer server listening on port=${String(viewer.port)}`);
    stage(logger, 'viewer');

    if (options.mode === 'replay') {
      logger.info('replay collectors: disabled');
      currentStage = 'replay';
      if (!options.replay) throw new Error('Replay mode requires a replay feeder');
      await options.replay({ config, paths, owner, logger, timeZone });
      stage(logger, 'replay');
      return {
        config,
        paths,
        owner,
        viewer,
        connectors: null,
        gateway: null,
        gateways,
        stop: stopResources,
      };
    }

    currentStage = 'connectors';
    const acceptSourceDelta = async (delta: SourceDelta): Promise<void> => {
      const id = sourceDeltaStimulusId(delta);
      try {
        const receipt = owner!.acceptSourceDelta(delta);
        stimulusAccepted(logger, 'source_delta', id, receipt);
      } catch (error) {
        stimulusFailed(logger, 'source_delta', id, error);
        throw error;
      }
    };
    const connectorFactory = dependencies.startConnectorRuntime ?? startConnectorRuntime;
    connectors = await connectorFactory({
      configPath: paths.connectorsConfigPath,
      timeZone,
      ...(config.wiki?.enabled
        ? { wikiRoot: resolve(config.wiki.vaultPath!, config.wiki.wikiDir!) }
        : {}),
      rawPath: paths.connectorsRoot,
      statePath: paths.connectorsRoot,
      kagemushaDbPath: paths.kagemushaDbPath,
      coreAdapter: owner.database?.adapter,
      acceptSourceDelta,
    });
    stage(logger, 'connectors');

    currentStage = 'messengers';
    const intake = loggedOwnerIntake(owner.intake, logger);
    const ledgerPath = paths.ownerMessageLedgerPath;
    const messageLedger = new OwnerMessageLedger(ledgerPath, { log: (line) => logger.info(line) });
    const filesRoot = join(paths.workspaceDir, 'files');
    if (config.telegram.enabled) {
      const token = process.env.MAMA_TELEGRAM_TOKEN;
      if (!token?.trim()) throw new Error('MAMA_TELEGRAM_TOKEN is required');
      const factory =
        dependencies.createTelegramGateway ?? ((options) => new TelegramGateway(options));
      gateway = factory({
        token,
        intake,
        config: {
          enabled: true,
          allowedChats: config.telegram.allowed_chats,
          ownerUserIds: config.telegram.owner_user_ids,
          ownerChatId: config.telegram.owner_chat_id,
          polling: config.telegram.polling,
        },
        messageLedgerPath: ledgerPath,
        messageLedger,
        ...(config.delivery?.interrupted_notice === undefined
          ? {}
          : { interruptedNotice: config.delivery.interrupted_notice }),
        log: (line) => logger.info(line),
        onFatalError: (error) => {
          logger.error(`telegram fatal polling error=${stimulusFailureReason(error)}`);
          process.exit(1);
        },
        filesRoot,
        downloadsDir: paths.downloadsDir,
      });
      gateways.set('telegram', gateway);
      await gateway.start();
      stage(logger, 'telegram');
    } else stage(logger, 'telegram:disabled');
    if (config.discord?.enabled) {
      const token = process.env.MAMA_DISCORD_TOKEN;
      if (!token?.trim()) throw new Error('MAMA_DISCORD_TOKEN is required');
      const factory =
        dependencies.createDiscordGateway ?? ((options) => new DiscordGateway(options));
      const active = factory({
        token,
        intake,
        config: {
          enabled: true,
          ownerChannelId: config.discord.owner_channel_id,
          allowedChannels: config.discord.allowed_channels,
          ownerUserIds: config.discord.owner_user_ids,
        },
        messageLedgerPath: ledgerPath,
        messageLedger,
        ...(config.delivery?.interrupted_notice === undefined
          ? {}
          : { interruptedNotice: config.delivery.interrupted_notice }),
        filesRoot,
        downloadsDir: paths.downloadsDir,
        log: (line) => logger.info(line),
      });
      gateways.set('discord', active);
      await active.start();
      stage(logger, 'discord');
    }
    if (config.slack?.enabled) {
      const token = process.env.MAMA_SLACK_TOKEN;
      const appToken = process.env.MAMA_SLACK_APP_TOKEN;
      if (!token?.trim()) throw new Error('MAMA_SLACK_TOKEN is required');
      if (!appToken?.trim()) throw new Error('MAMA_SLACK_APP_TOKEN is required');
      const factory = dependencies.createSlackGateway ?? ((options) => new SlackGateway(options));
      const active = factory({
        token,
        appToken,
        intake,
        config: {
          enabled: true,
          ownerChannelId: config.slack.owner_channel_id,
          allowedChannels: config.slack.allowed_channels,
          ownerUserIds: config.slack.owner_user_ids,
        },
        messageLedgerPath: ledgerPath,
        messageLedger,
        ...(config.delivery?.interrupted_notice === undefined
          ? {}
          : { interruptedNotice: config.delivery.interrupted_notice }),
        filesRoot,
        downloadsDir: paths.downloadsDir,
        log: (line) => logger.info(line),
      });
      gateways.set('slack', active);
      await active.start();
      stage(logger, 'slack');
    }
    const reportRoute = config.delivery?.reports ?? 'telegram';
    if (gateways.has(reportRoute)) {
      currentStage = 'report_scheduler';
      const schedulerFactory = dependencies.createReportScheduler ?? createReportScheduler;
      reportScheduler = schedulerFactory({
        config: config.reports,
        ...(owner.wikiRoot === null
          ? {}
          : {
              dailyPages: {
                written: (day: string, since: number) => {
                  const page = join(owner!.wikiRoot!, 'daily', `${day}.md`);
                  return existsSync(page) && statSync(page).mtimeMs >= since;
                },
              },
            }),
        timeZone,
        statePath: join(paths.runtimeRoot, 'report-schedule-state.json'),
        intake: {
          acceptScheduled: (input) => {
            const receipt = owner!.intake.acceptScheduled(input);
            stimulusAccepted(logger, 'scheduled', input.id, receipt);
            return receipt;
          },
        },
        hasPendingReport: () =>
          Boolean(
            owner!.database.adapter
              .prepare(
                `SELECT 1 FROM mailbox_inputs m LEFT JOIN native_input_deliveries n ON n.input_id = m.id WHERE m.principal_id = ? AND m.kind = 'scheduled' AND m.channel_key = 'schedule' AND m.status IN ('pending', 'claimed') AND (n.state IS NULL OR n.state != 'uncertain') LIMIT 1`
              )
              .get(OWNER_PRINCIPAL_ID)
          ),
        sendToOwner: (text, key) => gateways.get(reportRoute)!.sendToOwner(text, key),
        onError: (error) =>
          logger.error(`report scheduler failed reason=${stimulusFailureReason(error)}`),
      });
      reportScheduler.start();
      stage(logger, 'report_scheduler');
    } else stage(logger, 'report_scheduler:route_unavailable');
    deliveryReady = true;

    return {
      config,
      paths,
      owner,
      viewer,
      connectors,
      gateway,
      gateways,
      stop: stopResources,
    };
  } catch (error) {
    stageFailed(logger, currentStage, error);
    try {
      await stopResources();
    } catch {
      // Preserve the boot error; each cleanup failure was already logged by stopOne.
    }
    throw error;
  }
}

/** Foreground launchd entry: wait until SIGTERM/SIGINT, then close reverse-order stages. */
export async function runDaemon(options: DaemonBootOptions = {}): Promise<void> {
  const daemon = await bootDaemon(options);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        await daemon.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once('SIGTERM', () => void finish());
    process.once('SIGINT', () => void finish());
  });
}

function launchdService(command: 'print' | 'bootout') {
  const result = spawnSync('launchctl', [command, `gui/${process.getuid!()}/com.mama.server`], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  // launchctl print exits 113 when this user's service is not registered.
  if (result.status !== 0 && !(command === 'print' && result.status === 113)) {
    throw Object.assign(new Error(`launchctl ${command} failed`), {
      code: `LAUNCHCTL_${result.status ?? result.signal ?? 'UNKNOWN'}`,
    });
  }
  return result;
}

export function daemonStatus(): 'running' | 'stopped' {
  const result = launchdService('print');
  return result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout)
    ? 'running'
    : 'stopped';
}

export function requestDaemonStop(): void {
  launchdService('bootout');
}

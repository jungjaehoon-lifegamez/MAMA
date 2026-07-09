/**
 * Generic operator mechanism interfaces (PUBLIC-SAFE).
 *
 * Extracted from Kagemusha's `AgentAwarenessOptions` injection seam
 * (~/project/mama-suite/apps/kagemusha/src/runtime/agent-awareness.ts:199-237).
 * Kagemusha's operator is already dependency-injected; these interfaces genericize the
 * Kagemusha-typed deps so MAMA OS can supply its own implementations.
 *
 * HARD RULE: no personal/business data here. Channel rosters, personas, prompts, Trello,
 * schedule times, tokens are INJECTED via implementations/config, never in this source.
 * See memory: project_kagemusha_port_privacy_boundary.
 */

/**
 * A raw channel event pulled from the delta source.
 * Ports Kagemusha `DbChannelMessage` (db/channel-message-repo.ts:3-11) — generic, no platform.
 */
export interface OperatorChannelEvent {
  id: number;
  /** logical channel kind key, e.g. "discord" | "slack" | "telegram" (impl-defined) */
  channel: string;
  /** opaque per-channel conversation id */
  channelId: string;
  /** opaque author id */
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** stable provenance id when the source is connector_event_index (TEXT PK); optional. */
  eventIndexId?: string;
}

/**
 * Per-channel delta source: "only-new-since-cursor", at-least-once.
 * Ports Kagemusha `ChannelMessageRepository` (db/channel-message-repo.ts:18,25,219).
 */
export interface ChannelDeltaRepo {
  /** Contiguous, ordered events with id > sinceId, excluding the given channels. */
  getNewSince(sinceId: number, excludeChannels?: string[], limit?: number): OperatorChannelEvent[];
  record(
    channel: string,
    channelId: string,
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: { createdAt?: number }
  ): OperatorChannelEvent;
}

/** Ports Kagemusha `KagemushaAgentResponse`. */
export interface OperatorAgentResponse {
  text: string;
  isError?: boolean;
}

/**
 * The single serial agent (queue → one prompt in flight).
 * Ports Kagemusha `KagemushaAgentLoop.chat` (agent/agent-loop.ts:269).
 */
export interface OperatorAgentLoop {
  chat(
    userMessage: string,
    callbacks?: unknown,
    channel?: string
  ): Promise<OperatorAgentResponse>;
}

/**
 * Memory port — bound to mama-core in the MAMA implementation (Task 3).
 * The operator delegates ONLY memory here; operational state stays operator-owned.
 */
export interface OperatorMemoryPort {
  /** Persist an operational decision/lesson. Binds to mama-core `save`/`saveMemory`. */
  save(input: { topic: string; content: string; scopes?: unknown }): Promise<{ id: string } | void>;
  /** Semantic recall. Binds to mama-core `recallMemory`/`suggest`. */
  recall(query: string, opts?: { limit?: number }): Promise<ReadonlyArray<{ topic: string; content: string; similarity?: number }>>;
}

/** Operator-owned task. Ports Kagemusha `Task` (runtime/task-store.ts:3). */
export interface OperatorTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  deadline: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Task source — operator-owned operational state. */
export interface TaskSource {
  getTasks(): OperatorTask[];
}

/** Ports Kagemusha `ReportSlotSnapshot` (runtime/report-fallback.ts:1). */
export interface ReportSlotSnapshot {
  html: string;
  updatedAt: number;
}

/** Report sink — the deterministic report board. */
export interface ReportSink {
  getReportSlots(): Record<string, ReportSlotSnapshot>;
  setReportSlots(slots: Record<string, string>): void;
}

/**
 * Output sink — generic outbound send. The personal destination (which chat/room) is
 * bound inside the implementation, never here. Ports Kagemusha `sendTelegram`.
 */
export interface OutputSink {
  send(text: string): Promise<void>;
}

/**
 * Operator schedule/timing config. Values are loaded from `~/.mama/operator/*.json`, NOT
 * hardcoded in source. Ports Kagemusha `KagemushaDigestScheduleConfig` (config/ai-config.ts:12).
 */
export interface OperatorScheduleConfig {
  /** proactive delta-drain interval */
  deltaDigestIntervalMinutes: number;
  /** local hours (0-23) at which a full report fires */
  fullReportHours: number[];
  /** hourly task-reminder window */
  reminderStartHour: number;
  reminderEndHour: number;
}

/**
 * The full injection surface for the operator mechanism.
 * Genericizes Kagemusha `AgentAwarenessOptions` — every field is injected; the mechanism
 * hardcodes nothing personal.
 */
export interface OperatorRuntimeDeps {
  agentLoop: OperatorAgentLoop;
  channelRepo: ChannelDeltaRepo;
  memory: OperatorMemoryPort | null;
  tasks: TaskSource;
  reports: ReportSink | null;
  output: OutputSink;
  schedule: OperatorScheduleConfig;
  /** logical channel kinds the delta drain excludes (e.g. the reactive owner-DM channel) */
  excludeFromDelta?: string[];
}

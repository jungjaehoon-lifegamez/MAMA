/**
 * API Utility Functions
 * @module utils/api
 * @version 1.0.0
 */

/* eslint-env browser */

/**
 * API client for MAMA viewer
 */
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;
export type ApiErrorPayload = { message?: string; error?: string };
export type JsonRecord = Record<string, unknown>;

export interface GraphNode {
  id: string | number;
  topic?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  from: string | number;
  to: string | number;
  relationship?: string;
  [key: string]: unknown;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta?: JsonRecord;
}

export interface SimilarDecision {
  id?: string | number;
  topic?: string;
  decision?: string;
  reasoning?: string;
  relationship?: string;
  similarity?: number;
  [key: string]: unknown;
}

export interface SimilarDecisionsResponse {
  similar: SimilarDecision[];
  [key: string]: unknown;
}

export type GraphSimilarResponse = GraphResponse & SimilarDecisionsResponse;

export interface CheckpointSummary {
  id?: string;
  timestamp?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface CheckpointListResponse {
  checkpoints: CheckpointSummary[];
  [key: string]: unknown;
}

export interface MemorySearchItem {
  id?: string;
  topic?: string;
  decision?: string;
  reasoning?: string;
  outcome?: string;
  similarity?: number;
  created_at?: string;
  [key: string]: unknown;
}

export interface MemorySearchResponse {
  results: MemorySearchItem[];
  [key: string]: unknown;
}

export interface MamaDecisionPayload {
  topic: string;
  decision: string;
  reasoning?: string;
  confidence?: number;
}

export interface ApiConfigResponse {
  discord?: ApiGatewayConfig;
  slack?: ApiGatewayConfig;
  telegram?: ApiGatewayConfig;
  chatwork?: ApiGatewayConfig;
  heartbeat?: ApiHeartbeatConfig;
  agent?: ApiAgentConfig;
  roles?: ApiRolesConfig;
  token_budget?: ApiTokenBudgetConfig;
  [key: string]: unknown;
}

export interface ApiGatewayConfig {
  enabled?: boolean;
  token?: string;
  default_channel_id?: string;
  bot_token?: string;
  app_token?: string;
  api_token?: string;
  [key: string]: unknown;
}

export interface ApiHeartbeatConfig {
  enabled?: boolean;
  interval?: number;
  quiet_start?: number;
  quiet_end?: number;
  quietStart?: number;
  quietEnd?: number;
  [key: string]: unknown;
}

export interface ApiAgentToolsConfig {
  gateway?: string[];
  mcp?: string[];
  [key: string]: unknown;
}

export interface ApiAgentConfig {
  backend?: 'claude' | 'codex';
  model?: string;
  tools?: ApiAgentToolsConfig;
  use_persistent_cli?: boolean;
  max_turns?: number;
  timeout?: number;
  [key: string]: unknown;
}

export interface ApiRoleDefinition {
  allowedTools?: string[];
  blockedTools?: string[];
  systemControl?: boolean;
  sensitiveAccess?: boolean;
  model?: string;
  maxTurns?: number;
  [key: string]: unknown;
}

export interface ApiRolesConfig {
  definitions?: Record<string, ApiRoleDefinition>;
  sourceMapping?: Record<string, string>;
  [key: string]: unknown;
}

export interface ApiTokenBudgetConfig {
  daily_limit?: number;
  alert_threshold?: number;
  [key: string]: unknown;
}

export interface McpServer {
  name?: string;
  type?: string;
  url?: string;
  hasUrl?: boolean;
  command?: string;
  hasCommand?: boolean;
  hasArgs?: boolean;
  argCount?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface McpServersResponse {
  servers: McpServer[];
}

export interface MultiAgentAgent {
  id?: string;
  enabled?: boolean;
  name?: string;
  display_name?: string;
  tier?: number;
  status?: string;
  model?: string;
  backend?: 'claude' | 'codex';
  bot_token?: string;
  slack_bot_token?: string | null;
  slack_app_token?: string | null;
  lastActivity?: number | string;
  last_activity?: number | string;
  max_turns?: number;
  timeout?: number;
  use_persistent_cli?: boolean;
  persona_file?: string | null;
  trigger_prefix?: string | null;
  can_delegate?: boolean;
  cooldown_ms?: number;
  outcome?: string;
  tools?: {
    gateway?: string[];
    mcp?: string[];
    mcp_config?: string;
  };
  auto_respond_keywords?: string[];
  tool_permissions?: string[];
  [key: string]: unknown;
}

export interface MultiAgentAgentsResponse {
  enabled?: boolean;
  agents: MultiAgentAgent[];
}

export interface MultiAgentDashboardStatus {
  enabled: boolean;
  agents: MultiAgentAgent[];
  recentDelegations?: {
    id?: string;
    description?: string;
    category?: string;
    wave?: number;
    status?: string;
    claimedBy?: string | null;
    claimedAt?: number | null;
    completedAt?: number | null;
  }[];
  activeChains?: number;
}

export interface SkillItem {
  id: string;
  source: string;
  name: string;
  description?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SkillsResponse {
  skills: SkillItem[];
  [key: string]: unknown;
}

export interface TokenSummaryPeriod {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cost_usd?: number;
  request_count?: number;
  [key: string]: unknown;
}

export interface TokenSummaryResponse {
  today?: TokenSummaryPeriod;
  week?: TokenSummaryPeriod;
  month?: TokenSummaryPeriod;
  [key: string]: unknown;
}

export interface TokenByAgentRecord {
  agent_id?: string;
  agent_name?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cost_usd?: number;
  request_count?: number;
  [key: string]: unknown;
}

export interface TokensByAgentResponse {
  agents: TokenByAgentRecord[];
  [key: string]: unknown;
}

export interface CronJob {
  id: string;
  name: string;
  schedule?: string;
  cronExpr?: string;
  prompt?: string;
  enabled?: boolean;
  nextRun?: string;
  [key: string]: unknown;
}

export interface CronJobsResponse {
  jobs: CronJob[];
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  isAlive?: boolean;
  [key: string]: unknown;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
}

export type LastActiveSessionResponse = SessionInfo;

export interface CreateSessionResponse {
  sessionId: string;
}

export interface CronLogEntry {
  ts?: string;
  message?: string;
  [key: string]: unknown;
}

export interface CronLogResponse {
  logs: CronLogEntry[];
  [key: string]: unknown;
}

export class API {
  /**
   * Base URL for API requests (empty for same origin)
   */
  static baseUrl: string = '';

  /**
   * Parse JSON response safely with explicit error context.
   */
  static async parseJsonResponse<T = unknown>(response: Response, context = '요청'): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!contentType.includes('application/json')) {
      const snippet = text.slice(0, 80).replace(/\n/g, ' ');
      throw new Error(
        `${context}에서 JSON 응답이 아닙니다. content-type: ${
          contentType || '없음'
        }, body: ${snippet}`
      );
    }

    try {
      if (!text) {
        throw new Error(
          `${context} 응답 본문이 비어 있습니다. status=${response.status}, url=${response.url}`
        );
      }
      return JSON.parse(text) as T;
    } catch (error) {
      const snippet = text.slice(0, 120).replace(/\n/g, ' ');
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`${context} 응답 JSON 파싱 실패: ${cause} (샘플: ${snippet})`);
    }
  }

  /**
   * Perform GET request
   */
  static async get<T = unknown>(endpoint: string, params: QueryParams | null = null): Promise<T> {
    const url = new URL(endpoint, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const response = await fetch(url);
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await this.parseJsonResponse<ApiErrorPayload>(
          response,
          `GET ${endpoint}`
        );
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (parseError: unknown) {
        errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      }
      throw new Error(errorMessage);
    }

    return this.parseJsonResponse(response, `GET ${endpoint}`);
  }

  /**
   * Perform POST request
   * @param {string} endpoint - API endpoint
   * @param {Object} body - Request body
   * @returns {Promise<Object>} Response data
   */
  static async post<T = unknown, B = unknown>(endpoint: string, body: B): Promise<T> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await this.parseJsonResponse<ApiErrorPayload>(
          response,
          `POST ${endpoint}`
        );
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (parseError: unknown) {
        errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      }
      throw new Error(errorMessage);
    }

    return this.parseJsonResponse(response, `POST ${endpoint}`);
  }

  /**
   * Perform PUT request
   */
  static async put<T = unknown, B = unknown>(endpoint: string, body: B): Promise<T> {
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await this.parseJsonResponse<ApiErrorPayload>(
          response,
          `PUT ${endpoint}`
        );
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (parseError: unknown) {
        errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      }
      throw new Error(errorMessage);
    }
    return this.parseJsonResponse(response, `PUT ${endpoint}`);
  }

  /**
   * Perform DELETE request
   */
  static async del<T = unknown>(endpoint: string): Promise<T> {
    const response = await fetch(endpoint, { method: 'DELETE' });
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await this.parseJsonResponse<ApiErrorPayload>(
          response,
          `DELETE ${endpoint}`
        );
        errorMessage = errorData.message || errorData.error || errorMessage;
      } catch (parseError: unknown) {
        errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      }
      throw new Error(errorMessage);
    }

    return this.parseJsonResponse(response, `DELETE ${endpoint}`);
  }

  // =============================================
  // Graph API
  // =============================================

  /**
   * Get graph data
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} Graph data
   */
  static async getGraph(params: QueryParams = {}): Promise<GraphResponse> {
    // cluster: false by default to avoid slow embedding calculations
    return this.get<GraphResponse>('/graph', { cluster: 'false', ...params });
  }

  /**
   * Get similar decisions for a node
   * @param {string} nodeId - Node ID
   * @returns {Promise<Object>} Similar decisions
   */
  static async getSimilarDecisions(nodeId: string): Promise<GraphSimilarResponse> {
    return this.get<GraphSimilarResponse>('/graph/similar', { id: nodeId });
  }

  /**
   * Update decision outcome
   * @param {string} id - Decision ID
   * @param {string} outcome - Outcome value
   * @param {string} reason - Optional reason
   * @returns {Promise<Object>} Update result
   */
  static async updateOutcome(
    id: string,
    outcome: string,
    reason: string | null = null
  ): Promise<JsonRecord> {
    return this.post<JsonRecord, { id: string; outcome: string; reason: string | null }>(
      '/graph/update',
      { id, outcome, reason }
    );
  }

  // =============================================
  // Checkpoint API
  // =============================================

  /**
   * Get all checkpoints
   * @returns {Promise<Object>} Checkpoints data
   */
  static async getCheckpoints(): Promise<CheckpointListResponse> {
    return this.get<CheckpointListResponse>('/checkpoints');
  }

  // =============================================
  // MAMA Memory API
  // =============================================

  /**
   * Search MAMA decisions
   * @param {string} query - Search query
   * @param {number} limit - Maximum results
   * @returns {Promise<Object>} Search results
   */
  static async searchMemory(query: string, limit = 10): Promise<MemorySearchResponse> {
    return this.get<MemorySearchResponse>('/api/mama/search', { q: query, limit });
  }

  /**
   * Save a new decision to MAMA
   * @param {Object} data - Decision data
   * @param {string} data.topic - Decision topic
   * @param {string} data.decision - Decision text
   * @param {string} data.reasoning - Reasoning text
   * @param {number} data.confidence - Confidence (0-1)
   * @returns {Promise<Object>} Save result
   */
  static async saveDecision(data: MamaDecisionPayload): Promise<JsonRecord> {
    return this.post<JsonRecord, MamaDecisionPayload>('/api/mama/save', data);
  }

  // =============================================
  // Session API
  // =============================================

  /**
   * Create a new chat session
   * @param {string} projectDir - Project directory
   * @returns {Promise<Object>} Session data
   */
  static async createSession(projectDir = '.'): Promise<CreateSessionResponse> {
    return this.post<CreateSessionResponse, { projectDir: string }>('/api/sessions', {
      projectDir,
    });
  }

  /**
   * Get the last active session
   * @returns {Promise<Object>} Last active session
   */
  static async getLastActiveSession(): Promise<LastActiveSessionResponse> {
    return this.get<LastActiveSessionResponse>('/api/sessions/last-active');
  }

  /**
   * Get all active sessions
   * @returns {Promise<Object>} Sessions list
   */
  static async getSessions(): Promise<SessionsResponse> {
    return this.get<SessionsResponse>('/api/sessions');
  }

  // =============================================
  // Cron API
  // =============================================

  static async getCronJobs(): Promise<CronJobsResponse> {
    return this.get<CronJobsResponse>('/api/cron');
  }

  static async updateCronJob(id: string, data: JsonRecord): Promise<JsonRecord> {
    return this.put<JsonRecord, JsonRecord>(`/api/cron/${encodeURIComponent(id)}`, data);
  }

  static async runCronJob(id: string): Promise<JsonRecord> {
    return this.post<JsonRecord, JsonRecord>(`/api/cron/${encodeURIComponent(id)}/run`, {});
  }

  static async getCronLogs(id: string, limit = 5): Promise<CronLogResponse> {
    return this.get<CronLogResponse>(`/api/cron/${encodeURIComponent(id)}/logs`, { limit });
  }

  // =============================================
  // Token API
  // =============================================

  static async getTokenSummary(): Promise<TokenSummaryResponse> {
    return this.get<TokenSummaryResponse>('/api/tokens/summary');
  }

  static async getTokensByAgent(): Promise<TokensByAgentResponse> {
    return this.get<TokensByAgentResponse>('/api/tokens/by-agent');
  }

  static async getTokensDaily(days = 30): Promise<JsonRecord> {
    return this.get<JsonRecord>('/api/tokens/daily', { days });
  }

  // =============================================
  // Skills API
  // =============================================

  static async getSkills(): Promise<SkillsResponse> {
    return this.get<SkillsResponse>('/api/skills');
  }

  static async getSkillCatalog(source = 'all'): Promise<SkillsResponse> {
    return this.get<SkillsResponse>('/api/skills/catalog', { source });
  }

  static async searchSkills(query: string, source = 'all'): Promise<SkillsResponse> {
    return this.get<SkillsResponse>('/api/skills/search', { q: query, source });
  }

  static async installSkill(source: string, name: string): Promise<JsonRecord> {
    return this.post('/api/skills/install', { source, name });
  }

  static async uninstallSkill(name: string, source = 'mama'): Promise<JsonRecord> {
    return this.del(`/api/skills/${encodeURIComponent(name)}?source=${encodeURIComponent(source)}`);
  }

  static async toggleSkill(name: string, enabled: boolean, source = 'mama'): Promise<JsonRecord> {
    return this.put(`/api/skills/${encodeURIComponent(name)}`, { enabled, source });
  }

  static async getSkillContent(name: string, source = 'mama'): Promise<JsonRecord> {
    return this.get(`/api/skills/${encodeURIComponent(name)}/readme`, { source });
  }

  static async installSkillFromUrl(url: string): Promise<JsonRecord> {
    return this.post('/api/skills/install-url', { url });
  }
}

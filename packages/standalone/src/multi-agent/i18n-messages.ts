/**
 * Internationalization messages for Multi-Agent Slack Integration
 *
 * Provides localized messages to replace hardcoded strings.
 * Supports multiple languages with fallback to English.
 */

export type SupportedLanguage = 'en' | 'ko' | 'ja' | 'es' | 'fr' | 'de';

export interface I18nMessages {
  busy_message: string;
  rate_limit_warning: string;
  chain_blocked: string;
  chain_depth_exceeded: string;
  agent_not_found: string;
  timeout_error: string;
  processing_error: string;
  delegation_error: string;
  bot_initialization_error: string;
}

const messages: Record<SupportedLanguage, I18nMessages> = {
  en: {
    busy_message:
      '*{agentName}*: Currently processing a previous request. Please try again shortly. ⏳',
    rate_limit_warning: 'Rate limit exceeded. Please wait {seconds} seconds before trying again.',
    chain_blocked: 'Mention chain blocked in channel {channelId}',
    chain_depth_exceeded: 'Mention chain depth limit ({maxDepth}) exceeded in channel {channelId}',
    agent_not_found: 'Agent not found: {agentId}',
    timeout_error: 'Agent {agentId} timed out after {seconds} seconds',
    processing_error: 'Error processing request for agent {agentId}: {error}',
    delegation_error: 'Failed to delegate to agent {agentId}',
    bot_initialization_error: 'Failed to initialize bot for agent {agentId}',
  },

  ko: {
    busy_message: '*{agentName}*: 이전 요청을 처리 중입니다. 잠시 후 다시 시도해주세요. ⏳',
    rate_limit_warning: '요청 제한에 도달했습니다. {seconds}초 후 다시 시도해주세요.',
    chain_blocked: '채널 {channelId}에서 멘션 체인이 차단되었습니다',
    chain_depth_exceeded: '채널 {channelId}에서 멘션 체인 깊이 제한({maxDepth})을 초과했습니다',
    agent_not_found: '에이전트를 찾을 수 없습니다: {agentId}',
    timeout_error: '에이전트 {agentId}가 {seconds}초 후 시간 초과되었습니다',
    processing_error: '에이전트 {agentId} 요청 처리 중 오류: {error}',
    delegation_error: '에이전트 {agentId}로 위임하는데 실패했습니다',
    bot_initialization_error: '에이전트 {agentId}의 봇 초기화에 실패했습니다',
  },

  ja: {
    busy_message:
      '*{agentName}*: 前のリクエストを処理中です。しばらくしてからもう一度お試しください。⏳',
    rate_limit_warning: 'レート制限に達しました。{seconds}秒後に再試行してください。',
    chain_blocked: 'チャンネル {channelId} でメンションチェーンがブロックされました',
    chain_depth_exceeded:
      'チャンネル {channelId} でメンションチェーンの深度制限({maxDepth})を超過しました',
    agent_not_found: 'エージェントが見つかりません: {agentId}',
    timeout_error: 'エージェント {agentId} が {seconds}秒後にタイムアウトしました',
    processing_error: 'エージェント {agentId} のリクエスト処理中にエラー: {error}',
    delegation_error: 'エージェント {agentId} への委任に失敗しました',
    bot_initialization_error: 'エージェント {agentId} のボット初期化に失敗しました',
  },

  es: {
    busy_message:
      '*{agentName}*: Procesando solicitud anterior. Por favor, inténtelo de nuevo en breve. ⏳',
    rate_limit_warning:
      'Límite de tasa alcanzado. Espere {seconds} segundos antes de intentar de nuevo.',
    chain_blocked: 'Cadena de menciones bloqueada en el canal {channelId}',
    chain_depth_exceeded:
      'Límite de profundidad de cadena de menciones ({maxDepth}) excedido en el canal {channelId}',
    agent_not_found: 'Agente no encontrado: {agentId}',
    timeout_error: 'El agente {agentId} agotó el tiempo después de {seconds} segundos',
    processing_error: 'Error procesando solicitud para agente {agentId}: {error}',
    delegation_error: 'Falló la delegación al agente {agentId}',
    bot_initialization_error: 'Falló la inicialización del bot para el agente {agentId}',
  },

  fr: {
    busy_message:
      "*{agentName}*: Traitement d'une demande précédente. Veuillez réessayer bientôt. ⏳",
    rate_limit_warning:
      'Limite de taux atteinte. Veuillez attendre {seconds} secondes avant de réessayer.',
    chain_blocked: 'Chaîne de mentions bloquée dans le canal {channelId}',
    chain_depth_exceeded:
      'Limite de profondeur de chaîne de mentions ({maxDepth}) dépassée dans le canal {channelId}',
    agent_not_found: 'Agent non trouvé: {agentId}',
    timeout_error: "L'agent {agentId} a expiré après {seconds} secondes",
    processing_error: "Erreur lors du traitement de la demande pour l'agent {agentId}: {error}",
    delegation_error: "Échec de la délégation à l'agent {agentId}",
    bot_initialization_error: "Échec de l'initialisation du bot pour l'agent {agentId}",
  },

  de: {
    busy_message:
      '*{agentName}*: Verarbeite vorherige Anfrage. Bitte versuchen Sie es in Kürze erneut. ⏳',
    rate_limit_warning:
      'Ratenlimit erreicht. Bitte warten Sie {seconds} Sekunden bevor Sie es erneut versuchen.',
    chain_blocked: 'Erwähnungskette in Kanal {channelId} blockiert',
    chain_depth_exceeded:
      'Tiefenlimit der Erwähnungskette ({maxDepth}) in Kanal {channelId} überschritten',
    agent_not_found: 'Agent nicht gefunden: {agentId}',
    timeout_error: 'Agent {agentId} timeout nach {seconds} Sekunden',
    processing_error: 'Fehler beim Verarbeiten der Anfrage für Agent {agentId}: {error}',
    delegation_error: 'Delegation an Agent {agentId} fehlgeschlagen',
    bot_initialization_error: 'Bot-Initialisierung für Agent {agentId} fehlgeschlagen',
  },
};

/**
 * Simple i18n helper class
 */
export class I18n {
  private language: SupportedLanguage;
  private fallbackLanguage: SupportedLanguage = 'en';

  constructor(language: SupportedLanguage = 'en') {
    this.language = language;
  }

  /**
   * Get localized message with variable substitution
   */
  t(key: keyof I18nMessages, variables: Record<string, string | number> = {}): string {
    const messageTemplate = messages[this.language]?.[key] || messages[this.fallbackLanguage][key];

    if (!messageTemplate) {
      return `[Missing translation: ${key}]`;
    }

    // Simple variable substitution
    return messageTemplate.replace(/\{(\w+)\}/g, (match, varName) => {
      const value = variables[varName];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Set the current language
   */
  setLanguage(language: SupportedLanguage): void {
    this.language = language;
  }

  /**
   * Get current language
   */
  getLanguage(): SupportedLanguage {
    return this.language;
  }

  /**
   * Check if language is supported
   */
  static isSupported(language: string): language is SupportedLanguage {
    return ['en', 'ko', 'ja', 'es', 'fr', 'de'].includes(language);
  }

  /**
   * Auto-detect language from locale string
   */
  static detectLanguage(locale?: string): SupportedLanguage {
    if (!locale) return 'en';

    const lang = locale.split('-')[0].toLowerCase();
    return I18n.isSupported(lang) ? lang : 'en';
  }
}

/**
 * Default i18n instance (can be configured)
 */
export const defaultI18n = new I18n('en'); // Default to English

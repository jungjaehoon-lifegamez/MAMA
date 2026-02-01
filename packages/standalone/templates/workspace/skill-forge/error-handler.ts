/**
 * Skill Forge - Error Handler
 *
 * 통합 에러 처리 + 복구 전략
 */

import { SessionPhase, SessionState } from './types';

// ===== Error Types =====

export type SkillForgeErrorCode =
  | 'ARCHITECT_FAILED'
  | 'DEVELOPER_FAILED'
  | 'QA_FAILED'
  | 'API_ERROR'
  | 'TIMEOUT'
  | 'INVALID_INPUT'
  | 'FILE_ERROR'
  | 'STATE_ERROR'
  | 'UNKNOWN';

export interface SkillForgeError extends Error {
  code: SkillForgeErrorCode;
  phase?: SessionPhase;
  retryable: boolean;
  userMessage: string;
  details?: Record<string, unknown>;
}

// ===== Error Factory =====

export function createError(
  code: SkillForgeErrorCode,
  message: string,
  options?: {
    phase?: SessionPhase;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }
): SkillForgeError {
  const error = new Error(message) as SkillForgeError;
  error.code = code;
  error.phase = options?.phase;
  error.retryable = options?.retryable ?? false;
  error.details = options?.details;
  error.userMessage = getUserMessage(code, message);
  return error;
}

function getUserMessage(code: SkillForgeErrorCode, original: string): string {
  const messages: Record<SkillForgeErrorCode, string> = {
    ARCHITECT_FAILED: '🏗️ 설계 단계에서 오류가 발생했습니다. 다시 시도해 주세요.',
    DEVELOPER_FAILED: '💻 코드 생성 중 오류가 발생했습니다. 설계를 단순화해 보세요.',
    QA_FAILED: '🔍 검증 단계에서 오류가 발생했습니다.',
    API_ERROR: '🔌 API 연결 오류입니다. 잠시 후 다시 시도해 주세요.',
    TIMEOUT: '⏱️ 시간 초과되었습니다. 요청을 간소화해 보세요.',
    INVALID_INPUT: '❓ 입력이 올바르지 않습니다. 형식을 확인해 주세요.',
    FILE_ERROR: '📁 파일 처리 중 오류가 발생했습니다.',
    STATE_ERROR: '⚠️ 세션 상태 오류입니다. 새로 시작해 주세요.',
    UNKNOWN: '❌ 예기치 않은 오류가 발생했습니다.',
  };
  return messages[code];
}

// ===== Error Handler =====

export interface ErrorHandlerConfig {
  maxRetries: number;
  retryDelayMs: number;
  onError?: (error: SkillForgeError) => void;
}

const DEFAULT_ERROR_CONFIG: ErrorHandlerConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
};

export class ErrorHandler {
  private config: ErrorHandlerConfig;
  private retryCount: Map<string, number> = new Map();

  constructor(config?: Partial<ErrorHandlerConfig>) {
    this.config = { ...DEFAULT_ERROR_CONFIG, ...config };
  }

  /**
   * Handle an error with optional retry logic
   */
  async handle<T>(
    key: string,
    operation: () => Promise<T>,
    options?: { phase?: SessionPhase }
  ): Promise<T> {
    const retries = this.retryCount.get(key) || 0;

    try {
      const result = await operation();
      this.retryCount.delete(key); // Success - reset retry count
      return result;
    } catch (err) {
      const error = this.wrapError(err, options?.phase);

      // Notify handler
      this.config.onError?.(error);

      // Check if we should retry
      if (error.retryable && retries < this.config.maxRetries) {
        this.retryCount.set(key, retries + 1);
        console.log(`[ErrorHandler] Retry ${retries + 1}/${this.config.maxRetries}: ${key}`);

        await this.delay(this.config.retryDelayMs * (retries + 1));
        return this.handle(key, operation, options);
      }

      this.retryCount.delete(key);
      throw error;
    }
  }

  /**
   * Wrap unknown errors into SkillForgeError
   */
  wrapError(err: unknown, phase?: SessionPhase): SkillForgeError {
    // Already wrapped
    if (isSkillForgeError(err)) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);

    // Detect error type from message
    const code = this.detectErrorCode(message);

    return createError(code, message, {
      phase,
      retryable: this.isRetryable(code, message),
      details: { original: err },
    });
  }

  private detectErrorCode(message: string): SkillForgeErrorCode {
    const lower = message.toLowerCase();

    if (lower.includes('timeout') || lower.includes('timed out')) {
      return 'TIMEOUT';
    }
    if (lower.includes('api') || lower.includes('fetch') || lower.includes('network')) {
      return 'API_ERROR';
    }
    if (lower.includes('file') || lower.includes('enoent') || lower.includes('permission')) {
      return 'FILE_ERROR';
    }
    if (lower.includes('json') || lower.includes('parse') || lower.includes('invalid')) {
      return 'INVALID_INPUT';
    }
    if (lower.includes('architect')) {
      return 'ARCHITECT_FAILED';
    }
    if (lower.includes('developer')) {
      return 'DEVELOPER_FAILED';
    }
    if (lower.includes('qa')) {
      return 'QA_FAILED';
    }

    return 'UNKNOWN';
  }

  private isRetryable(code: SkillForgeErrorCode, message: string): boolean {
    // These are generally retryable
    const retryableCodes: SkillForgeErrorCode[] = ['API_ERROR', 'TIMEOUT'];

    if (retryableCodes.includes(code)) {
      return true;
    }

    // Check for rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      return true;
    }

    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isSkillForgeError(err: unknown): err is SkillForgeError {
  return err instanceof Error && 'code' in err && 'retryable' in err;
}

// ===== Recovery Strategies =====

export interface RecoveryStrategy {
  canRecover(error: SkillForgeError, state: SessionState): boolean;
  recover(error: SkillForgeError, state: SessionState): SessionState;
}

/**
 * Rollback to previous phase on error
 */
export const rollbackStrategy: RecoveryStrategy = {
  canRecover(error, state) {
    return ['ARCHITECT_FAILED', 'DEVELOPER_FAILED', 'QA_FAILED'].includes(error.code);
  },

  recover(error, state) {
    const rollbackMap: Partial<Record<SessionPhase, SessionPhase>> = {
      architect: 'idle',
      architect_review: 'architect',
      developer: 'architect_review',
      developer_review: 'developer',
      qa: 'developer_review',
      qa_review: 'qa',
    };

    const newPhase = rollbackMap[state.phase] || 'idle';
    console.log(`[Recovery] Rolling back from ${state.phase} to ${newPhase}`);

    return {
      ...state,
      phase: newPhase,
      updatedAt: new Date().toISOString(),
    };
  },
};

/**
 * Skip to next phase on non-critical error
 */
export const skipStrategy: RecoveryStrategy = {
  canRecover(error, state) {
    // Only skip QA if it fails but we have developer output
    return error.code === 'QA_FAILED' && !!state.artifacts.developerOutput;
  },

  recover(error, state) {
    console.log(`[Recovery] Skipping QA, marking as completed with warning`);

    return {
      ...state,
      phase: 'completed' as SessionPhase,
      artifacts: {
        ...state.artifacts,
        qaOutput: {
          passed: false,
          checklist: [],
          issues: [
            {
              severity: 'warning' as const,
              description: 'QA 검증이 실패했지만 스킵됨',
            },
          ],
          recommendation: 'revise' as const,
        },
      },
      updatedAt: new Date().toISOString(),
    };
  },
};

// ===== Error Formatters =====

export function formatErrorForDiscord(error: SkillForgeError): string {
  const lines = [`## ❌ 오류 발생`, '', error.userMessage, ''];

  if (error.retryable) {
    lines.push('> 💡 이 오류는 자동으로 재시도됩니다.');
  }

  if (error.phase) {
    lines.push(`📍 **단계:** ${error.phase}`);
  }

  lines.push(`🔖 **코드:** \`${error.code}\``);

  return lines.join('\n');
}

export function formatErrorForLog(error: SkillForgeError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    phase: error.phase,
    retryable: error.retryable,
    timestamp: new Date().toISOString(),
    details: error.details,
  });
}

// ===== Test =====

async function runTest() {
  console.log('🛡️ Error Handler Test\n');

  const handler = new ErrorHandler({
    maxRetries: 2,
    retryDelayMs: 100,
    onError: (err) => console.log(`[Callback] ${err.code}: ${err.message}`),
  });

  // Test 1: Successful operation
  console.log('=== Test 1: Success ===');
  const result1 = await handler.handle('test1', async () => 'success');
  console.log('Result:', result1);

  // Test 2: Retryable failure
  console.log('\n=== Test 2: Retryable Failure ===');
  let attempts = 0;
  try {
    await handler.handle('test2', async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('API rate limit exceeded');
      }
      return 'success after retries';
    });
  } catch (err) {
    console.log('Final error:', (err as SkillForgeError).code);
  }
  console.log('Attempts:', attempts);

  // Test 3: Non-retryable failure
  console.log('\n=== Test 3: Non-retryable ===');
  try {
    await handler.handle('test3', async () => {
      throw new Error('Invalid input format');
    });
  } catch (err) {
    const sfError = err as SkillForgeError;
    console.log('Error code:', sfError.code);
    console.log('Retryable:', sfError.retryable);
    console.log('User message:', sfError.userMessage);
  }

  // Test 4: Error wrapping
  console.log('\n=== Test 4: Error Wrapping ===');
  const wrapped = handler.wrapError(new Error('Architect JSON parse failed'), 'architect');
  console.log('Wrapped:', wrapped.code, wrapped.phase);

  // Test 5: Discord format
  console.log('\n=== Test 5: Discord Format ===');
  const discordMsg = formatErrorForDiscord(wrapped);
  console.log(discordMsg);

  console.log('\n✅ All error handler tests complete');
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}

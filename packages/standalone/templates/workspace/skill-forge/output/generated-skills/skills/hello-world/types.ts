/**
 * hello-world - Type Definitions
 */

export interface SkillContext {
  input: string;
  channelId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

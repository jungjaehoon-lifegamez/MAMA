import { EventEmitter } from 'events';
import { PersistentClaudeProcess } from '../agent/persistent-cli-process.js';

const CRON_SYSTEM_PROMPT = `You are a cron job executor. Execute the given task and return the result.
Available tools: Bash, Read, Write, Glob, Grep.
Be concise. Return only the result.`;

const CRON_MODEL = 'claude-haiku-4-5-20251001';

// Restrict cron worker to safe tools only (prevents RCE via prompt injection)
const CRON_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Glob', 'Grep'];

export interface CronWorkerOptions {
  emitter: EventEmitter;
  model?: string;
  systemPrompt?: string;
}

export interface CronJobContext {
  jobId?: string;
  jobName?: string;
  channel?: string;
}

export interface CronCompletedEvent {
  jobId: string;
  jobName: string;
  result: string;
  duration: number;
  channel?: string;
}

export interface CronFailedEvent {
  jobId: string;
  jobName: string;
  error: string;
  duration: number;
  channel?: string;
}

export class CronWorker {
  private cli: PersistentClaudeProcess | null = null;
  private readonly emitter: EventEmitter;
  private readonly model: string;
  private readonly systemPrompt: string;
  private executionQueue: Promise<void> = Promise.resolve();

  constructor(options: CronWorkerOptions) {
    this.emitter = options.emitter;
    this.model = options.model ?? CRON_MODEL;
    this.systemPrompt = options.systemPrompt ?? CRON_SYSTEM_PROMPT;
  }

  private ensureCLI(): PersistentClaudeProcess {
    if (!this.cli) {
      this.cli = new PersistentClaudeProcess({
        sessionId: `cron-worker-${Date.now()}`,
        model: this.model,
        systemPrompt: this.systemPrompt,
        dangerouslySkipPermissions: process.env.MAMA_TRUSTED_ENV === 'true',
        allowedTools: CRON_ALLOWED_TOOLS,
        pluginDir: undefined,
      });
    }
    return this.cli;
  }

  async execute(prompt: string, context: CronJobContext = {}): Promise<string> {
    // Serialize execution to prevent race conditions on shared CLI instance
    return new Promise<string>((resolve, reject) => {
      this.executionQueue = this.executionQueue.then(async () => {
        try {
          const result = await this.executeInternal(prompt, context);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async executeInternal(prompt: string, context: CronJobContext): Promise<string> {
    const { jobId = 'unknown', jobName = 'unknown', channel } = context;
    const startTime = Date.now();

    try {
      const cli = this.ensureCLI();
      const result = await cli.sendMessage(prompt);
      const duration = Date.now() - startTime;

      this.emitter.emit('cron:completed', {
        jobId,
        jobName,
        result: result.response,
        duration,
        channel,
      } satisfies CronCompletedEvent);

      return result.response;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.emitter.emit('cron:failed', {
        jobId,
        jobName,
        error: errorMsg,
        duration,
        channel,
      } satisfies CronFailedEvent);

      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.cli) {
      await this.cli.stop();
      this.cli = null;
    }
  }
}

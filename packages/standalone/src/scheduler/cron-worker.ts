import { EventEmitter } from 'events';
import type { IModelRunner } from '../agent/model-runner.js';

export function cronSystemPromptForBackend(backend: IModelRunner['backendType']): string {
  const tools =
    backend === 'cline'
      ? 'run_commands, read_files, apply_patch/editor, search_codebase'
      : 'Bash, Read, Write, Glob, Grep';
  return `You are a cron job executor. Execute the given task and return the result.
Available tools: ${tools}.
Be concise. Return only the result.`;
}

export interface CronWorkerOptions {
  emitter: EventEmitter;
  systemPrompt?: string;
  runnerFactory: () => IModelRunner;
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
  private runner: IModelRunner | null = null;
  private readonly emitter: EventEmitter;
  private readonly systemPrompt: string;
  private readonly runnerFactory: () => IModelRunner;
  private executionQueue: Promise<void> = Promise.resolve();
  private accepting = true;
  private stopPromise: Promise<void> | null = null;

  constructor(options: CronWorkerOptions) {
    this.emitter = options.emitter;
    this.systemPrompt = options.systemPrompt ?? cronSystemPromptForBackend('claude');
    this.runnerFactory = options.runnerFactory;
  }

  private ensureRunner(): IModelRunner {
    if (!this.accepting) {
      throw new Error('Cron worker is stopping');
    }
    this.runner ??= this.runnerFactory();
    return this.runner;
  }

  async execute(prompt: string, context: CronJobContext = {}): Promise<string> {
    if (!this.accepting) {
      throw new Error('Cron worker is stopping');
    }
    // Serialize execution to prevent races on one durable backend session.
    const execution = this.executionQueue.then(async () => {
      if (!this.accepting) {
        throw new Error('Cron worker is stopping');
      }
      return await this.executeInternal(prompt, context);
    });
    this.executionQueue = execution.then(
      () => undefined,
      () => undefined
    );
    return await execution;
  }

  private async executeInternal(prompt: string, context: CronJobContext): Promise<string> {
    const { jobId = 'unknown', jobName = 'unknown', channel } = context;
    const startTime = Date.now();

    try {
      const runner = this.ensureRunner();
      const result = await runner.prompt(prompt, undefined, {
        sessionKey: 'system:cron',
        resumeSession: true,
        systemPrompt: this.systemPrompt,
      });
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
    if (!this.stopPromise) {
      this.accepting = false;
      const ownedRunner = this.runner;
      this.runner = null;
      this.stopPromise = (async () => {
        const stopRunner = Promise.resolve(ownedRunner?.stop()).then(() => undefined);
        const drained = Promise.allSettled([stopRunner, this.executionQueue]).then(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          drained,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
            timer.unref();
          }),
        ]);
        if (timer) {
          clearTimeout(timer);
        }
      })();
    }
    await this.stopPromise;
  }
}

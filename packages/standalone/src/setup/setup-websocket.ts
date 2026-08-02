/**
 * Setup WebSocket Handler - backend-powered interactive setup
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IModelRunner } from '../agent/model-runner.js';
import {
  createBackendModelRunner,
  type BackendModelRunnerOptions,
} from '../agent/backend-model-runner-factory.js';
import type { MAMAConfig } from '../cli/config/types.js';
import { expandPath, getConfig } from '../cli/config/config-manager.js';
import { SETUP_SYSTEM_PROMPT } from './setup-prompt.js';
import { COMPLETE_AUTONOMOUS_PROMPT } from '../onboarding/complete-autonomous-prompt.js';
import {
  createSetupActionExecutor,
  parseSetupActions,
  SETUP_ACTION_PROTOCOL,
  type SetupActionExecutor,
} from './setup-actions.js';

type QuizState = 'idle' | 'awaiting_name' | 'quiz_in_progress' | 'quiz_complete';

interface ClientInfo {
  ws: WebSocket;
  sessionId: string;
  modelRunner: IModelRunner | null;
  actionExecutor: SetupActionExecutor;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  language?: string;
  isRitualMode?: boolean;
  currentStep?: number;
  quizState?: QuizState;
  quizAnswers?: Record<string, string>;
  currentQuestionIndex?: number;
  userName?: string;
  discoveryPhase?: number;
  sessionProfilePath?: string;
  personalityScores?: Record<string, number>;
  useCaseInsights?: string[];
  capturedInsights?: string[];
  stopPromise?: Promise<void>;
  messageTail: Promise<void>;
}

interface QuizChoice {
  id: string;
  text: string;
}

export interface SetupWebSocketLifecycle {
  close(): Promise<void>;
}

export interface SetupWebSocketSecurity {
  allowedOrigins: readonly string[];
  consumeNonce(nonce: string): boolean;
}

const SETUP_RUNNER_STOP_TIMEOUT_MS = 5_000;
const MAX_SETUP_ACTION_ROUNDS = 8;

export function createSetupModelRunner(
  config: MAMAConfig,
  sessionId: string,
  createRunner: (
    config: MAMAConfig,
    options: BackendModelRunnerOptions
  ) => IModelRunner = createBackendModelRunner
): IModelRunner {
  return createRunner(config, {
    sessionId,
    model: config.agent.model,
    systemPrompt: `${SETUP_ACTION_PROTOCOL}\n\n${SETUP_SYSTEM_PROMPT}`,
    timeoutMs: config.agent.timeout,
    allowedTools: [],
    disableNativeTools: true,
  });
}

// @ts-expect-error - Keeping for future use, currently unused after autonomous discovery migration
function _extractName(input: string): string {
  let name = input.trim();

  const koreanPatterns = [
    /(?:저는|제\s*이름은|내\s*이름은|이름은)\s*(.+?)(?:이야|입니다|이에요|예요|이라고|라고|요|임|야)?$/,
    /(.+?)(?:이야|입니다|이에요|예요|이라고|라고|요|임|야)$/,
  ];

  const englishPatterns = [/(?:my\s+name\s+is|i'?m|i\s+am|call\s+me)\s+([a-z]+)/i, /^([a-z]+)$/i];

  for (const pattern of koreanPatterns) {
    const match = name.match(pattern);
    if (match && match[1]) {
      name = match[1].trim();
      break;
    }
  }

  if (name === input.trim()) {
    for (const pattern of englishPatterns) {
      const match = name.match(pattern);
      if (match && match[1]) {
        name = match[1].trim();
        break;
      }
    }
  }

  name = name
    .replace(/^(저는|제|내|이름은|my name is|i'm|i am|call me)\s*/gi, '')
    .replace(/\s*(이야|입니다|이에요|예요|이라고|라고|요|임|야)$/g, '')
    .trim();

  if (name.length > 20) {
    return input.trim().substring(0, 20);
  }

  return name || input.trim();
}

function detectQuizChoices(text: string): QuizChoice[] | null {
  const choicePattern = /\*\*([A-D])\)\*\*\s*(.+?)(?=\n\*\*[A-D]\)|\n\n|$)/gs;
  const matches = [...text.matchAll(choicePattern)];

  if (matches.length >= 2) {
    return matches.map((m) => ({
      id: m[1].toLowerCase(),
      text: m[2].trim(),
    }));
  }

  return null;
}

function detectProgress(
  text: string,
  isRitualMode: boolean
): { step: number; total: number; label?: string } | null {
  const questionMatch = text.match(/Question\s+(\d+)\/(\d+)/i);
  if (questionMatch && isRitualMode) {
    const step = parseInt(questionMatch[1]);
    const total = 7;
    const scenarioMatch = text.match(/\*\*Question\s+\d+\/\d+:\s*(.+?)\*\*/);
    const label = scenarioMatch ? scenarioMatch[1].trim() : `Question ${step}/3`;
    return { step, total, label };
  }

  if (isRitualMode) {
    if (text.includes('I just came online') || text.includes('방금 켜졌습니다')) {
      return { step: 1, total: 7, label: '✨ Awakening...' };
    }
    if (text.includes('Quiz Results') || text.includes('퀴즈 결과')) {
      return { step: 4, total: 7, label: '🎯 Discovering personality...' };
    }
    if (text.includes('Origin Story') || text.includes('시작 이야기')) {
      return { step: 6, total: 7, label: '📖 Writing our story...' };
    }
  }

  return null;
}

async function processModelResponse(clientInfo: ClientInfo, userMessage: string): Promise<string> {
  if (!clientInfo.modelRunner) {
    throw new Error('Model runner not initialized');
  }

  let prompt = userMessage;
  let assistantText = '';
  for (let round = 0; round < MAX_SETUP_ACTION_ROUNDS; round += 1) {
    const result = await clientInfo.modelRunner.prompt(prompt, undefined, {
      sessionKey: clientInfo.sessionId,
      resumeSession: true,
    });
    const parsed = parseSetupActions(result.response || '');
    if (parsed.actions.length === 0) {
      assistantText = parsed.visibleText;
      break;
    }
    const actionResults = await clientInfo.actionExecutor.executeBatch(parsed.actions);
    prompt =
      'Trusted MAMA setup host action results:\n' +
      JSON.stringify(actionResults) +
      '\nContinue from these results. Do not repeat successful actions.';
    if (round === MAX_SETUP_ACTION_ROUNDS - 1) {
      throw new Error('Setup action loop exceeded its round limit');
    }
  }

  // Check if onboarding completed (CLI wrote USER.md + SOUL.md via Write tool)
  const mamaHome = expandPath('~/.mama');
  const onboardingDone =
    existsSync(join(mamaHome, 'IDENTITY.md')) &&
    existsSync(join(mamaHome, 'USER.md')) &&
    existsSync(join(mamaHome, 'SOUL.md')) &&
    existsSync(join(mamaHome, 'setup-complete.json'));

  if (onboardingDone && clientInfo.isRitualMode) {
    clientInfo.ws.send(
      JSON.stringify({
        type: 'redirect',
        url: '/viewer',
        message: 'Onboarding complete! Redirecting to MAMA OS...',
      })
    );
  }

  return assistantText;
}

async function sendInitialGreeting(clientInfo: ClientInfo): Promise<void> {
  const bootstrapPath = expandPath('~/.mama/BOOTSTRAP.md');
  const hasBootstrap = existsSync(bootstrapPath);

  clientInfo.isRitualMode = hasBootstrap;

  const lang = clientInfo.language || 'en';
  const isKorean = lang.startsWith('ko');

  let greeting: string;

  if (hasBootstrap) {
    greeting = isKorean
      ? "Hi! 👋\n\nI'm MAMA. I'd love to get to know you. Shall we start with a simple conversation?"
      : "Hi! 👋\n\nI'm MAMA. I'd love to get to know you. Shall we start with a simple conversation?";

    clientInfo.discoveryPhase = 1;
    clientInfo.sessionProfilePath = `~/.mama/profiles/session_${Date.now()}`;
  } else {
    greeting = isKorean
      ? "Hello! I'll help you set up MAMA Standalone.\n\nWhich platform would you like to configure - Discord bot, Slack bot, or another platform?"
      : "Hello! I'll help you set up MAMA Standalone.\n\nWhich platform would you like to configure - Discord bot, Slack bot, or another platform?";

    clientInfo.quizState = 'idle';
  }

  clientInfo.conversationHistory.push({
    role: 'assistant',
    content: greeting,
  });

  if (hasBootstrap) {
    clientInfo.currentStep = 1;
    clientInfo.ws.send(
      JSON.stringify({
        type: 'progress',
        step: 1,
        total: 7,
        label: '✨ Awakening...',
      })
    );
  }

  clientInfo.ws.send(
    JSON.stringify({
      type: 'assistant_message',
      content: greeting,
    })
  );
}

export function createSetupWebSocketHandler(
  wss: WebSocketServer,
  createRunner: typeof createBackendModelRunner = createBackendModelRunner,
  createActionExecutor: () => SetupActionExecutor = createSetupActionExecutor,
  security?: SetupWebSocketSecurity
): SetupWebSocketLifecycle {
  const clients = new Map<WebSocket, ClientInfo>();

  const stopClient = (info: ClientInfo): Promise<void> => {
    if (!info.stopPromise) {
      const runner = info.modelRunner;
      info.stopPromise = info.messageTail
        .catch(() => undefined)
        .then(async () => {
          info.modelRunner = null;
          await runner?.stop();
        });
    }
    return info.stopPromise;
  };

  wss.on('connection', async (ws, request: IncomingMessage) => {
    const origin = request?.headers?.origin;
    let nonce = '';
    try {
      nonce = new URL(request?.url ?? '', 'http://127.0.0.1').searchParams.get('nonce') ?? '';
    } catch {
      nonce = '';
    }
    if (
      !security ||
      !origin ||
      !security.allowedOrigins.includes(origin) ||
      clients.size > 0 ||
      !security.consumeNonce(nonce)
    ) {
      ws.close(1008, 'Unauthorized setup connection');
      return;
    }
    console.log('[Setup] Client connected');

    const sessionId = `setup_${Date.now()}`;

    let modelRunner: IModelRunner | null = null;
    try {
      const config = getConfig();
      modelRunner = createSetupModelRunner(config, sessionId, createRunner);
    } catch (error) {
      console.error('[Setup] model runner creation failed:', error);
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Configured model backend initialization failed. Verify its CLI and login.',
        })
      );
      ws.close();
      return;
    }

    const clientInfo: ClientInfo = {
      ws,
      sessionId,
      modelRunner,
      actionExecutor: createActionExecutor(),
      conversationHistory: [],
      messageTail: Promise.resolve(),
    };

    clients.set(ws, clientInfo);

    ws.on('message', (data) => {
      clientInfo.messageTail = clientInfo.messageTail
        .then(async () => {
          const message = JSON.parse(data.toString());
          await handleClientMessage(clientInfo, message);
        })
        .catch((error: unknown) => {
          console.error('[Setup] Message handling error:', error);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Unknown error',
            })
          );
        });
    });

    ws.on('close', () => {
      console.log('[Setup] Client disconnected');
      const info = clients.get(ws);
      if (info) void stopClient(info);
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('[Setup] WebSocket error:', error);
    });
  });

  return {
    async close() {
      const stopping = [...clients.values()].map((info) => stopClient(info));
      for (const info of clients.values()) info.ws.terminate();
      clients.clear();
      if (stopping.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(stopping).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SETUP_RUNNER_STOP_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleClientMessage(clientInfo: ClientInfo, message: any): Promise<void> {
  if (message.type === 'init') {
    clientInfo.language = message.language || 'en';
    await sendInitialGreeting(clientInfo);
    return;
  }

  if (message.type !== 'user_message') {
    return;
  }

  const userMessage = message.content;

  clientInfo.conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  if (!clientInfo.modelRunner) {
    clientInfo.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Configured model runner not initialized',
      })
    );
    return;
  }

  try {
    const lang = clientInfo.language || 'en';
    const isKorean = lang.startsWith('ko');
    const languageInstruction = isKorean
      ? '\n\n**IMPORTANT: User browser language is Korean (ko). Respond in Korean.**'
      : '\n\n**IMPORTANT: User browser language is English (en). Respond in English.**';

    const systemPrompt = clientInfo.isRitualMode
      ? `${SETUP_ACTION_PROTOCOL}\n\n${COMPLETE_AUTONOMOUS_PROMPT}${languageInstruction}`
      : `${SETUP_ACTION_PROTOCOL}\n\n${SETUP_SYSTEM_PROMPT}${languageInstruction}`;

    // Update system prompt if needed (ritual vs setup mode)
    if (clientInfo.modelRunner) {
      clientInfo.modelRunner.setSystemPrompt(systemPrompt);
    }

    const assistantMessage = await processModelResponse(clientInfo, userMessage);

    if (assistantMessage) {
      clientInfo.conversationHistory.push({
        role: 'assistant',
        content: assistantMessage,
      });

      const choices = detectQuizChoices(assistantMessage);
      const progress = detectProgress(assistantMessage, clientInfo.isRitualMode || false);

      if (progress) {
        clientInfo.currentStep = progress.step;
        clientInfo.ws.send(
          JSON.stringify({
            type: 'progress',
            step: progress.step,
            total: progress.total,
            label: progress.label,
          })
        );
      }

      clientInfo.ws.send(
        JSON.stringify({
          type: 'assistant_message',
          content: assistantMessage,
          choices: choices || undefined,
        })
      );
    }
  } catch (error) {
    console.error('[Setup] Claude API error:', error);
    clientInfo.ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Claude API call failed',
      })
    );
  }
}

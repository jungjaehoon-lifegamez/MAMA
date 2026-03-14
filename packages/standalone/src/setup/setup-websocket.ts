/**
 * Setup WebSocket Handler - Claude-powered interactive setup
 */

import type { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PersistentCLIAdapter } from '../agent/persistent-cli-adapter.js';
import { expandPath, getConfig } from '../cli/config/config-manager.js';
import { SETUP_SYSTEM_PROMPT } from './setup-prompt.js';
import { COMPLETE_AUTONOMOUS_PROMPT } from '../onboarding/complete-autonomous-prompt.js';

type QuizState = 'idle' | 'awaiting_name' | 'quiz_in_progress' | 'quiz_complete';

interface ClientInfo {
  ws: WebSocket;
  sessionId: string;
  cliAdapter: PersistentCLIAdapter | null;
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
}

interface QuizChoice {
  id: string;
  text: string;
}

const clients = new Map<WebSocket, ClientInfo>();

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

async function processClaudeResponse(clientInfo: ClientInfo, userMessage: string): Promise<string> {
  if (!clientInfo.cliAdapter) {
    throw new Error('CLI adapter not initialized');
  }

  const result = await clientInfo.cliAdapter.prompt(userMessage);
  const assistantText = result.response || '';

  // Check if onboarding completed (CLI wrote USER.md + SOUL.md via Write tool)
  const mamaHome = expandPath('~/.mama');
  const onboardingDone =
    existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));

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

export function createSetupWebSocketHandler(wss: WebSocketServer): void {
  wss.on('connection', async (ws) => {
    console.log('[Setup] Client connected');

    const sessionId = `setup_${Date.now()}`;

    let cliAdapter: PersistentCLIAdapter | null = null;
    try {
      const config = getConfig();
      cliAdapter = new PersistentCLIAdapter({
        sessionId,
        model: config.agent.model,
        systemPrompt: SETUP_SYSTEM_PROMPT,
        dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? false,
        requestTimeout: config.agent.timeout,
      });
    } catch (error) {
      console.error('[Setup] CLI adapter creation failed:', error);
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Claude CLI initialization failed. Please verify Claude Code is installed.',
        })
      );
      ws.close();
      return;
    }

    const clientInfo: ClientInfo = {
      ws,
      sessionId,
      cliAdapter,
      conversationHistory: [],
    };

    clients.set(ws, clientInfo);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleClientMessage(clientInfo, message);
      } catch (error) {
        console.error('[Setup] Message handling error:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
          })
        );
      }
    });

    ws.on('close', () => {
      console.log('[Setup] Client disconnected');
      const info = clients.get(ws);
      if (info?.cliAdapter) {
        info.cliAdapter.stop();
      }
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('[Setup] WebSocket error:', error);
    });
  });
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

  if (!clientInfo.cliAdapter) {
    clientInfo.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Claude CLI adapter not initialized',
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
      ? COMPLETE_AUTONOMOUS_PROMPT + languageInstruction
      : SETUP_SYSTEM_PROMPT + languageInstruction;

    // Update system prompt if needed (ritual vs setup mode)
    if (clientInfo.cliAdapter) {
      clientInfo.cliAdapter.setSystemPrompt(systemPrompt);
    }

    const assistantMessage = await processClaudeResponse(clientInfo, userMessage);

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

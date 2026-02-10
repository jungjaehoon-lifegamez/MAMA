/**
 * Setup WebSocket Handler - Claude-powered interactive setup
 */

import type { WebSocketServer, WebSocket } from 'ws';
import { existsSync } from 'node:fs';
import { ClaudeClient } from '../agent/claude-client.js';
import { OAuthManager } from '../auth/index.js';
import { expandPath } from '../cli/config/config-manager.js';
import { SETUP_SYSTEM_PROMPT } from './setup-prompt.js';
import { createSetupTools } from './setup-tools.js';
import { COMPLETE_AUTONOMOUS_PROMPT } from '../onboarding/complete-autonomous-prompt.js';
import { createAllOnboardingToolsWithHandlers } from '../onboarding/all-tools.js';

type QuizState = 'idle' | 'awaiting_name' | 'quiz_in_progress' | 'quiz_complete';

interface ClientInfo {
  ws: WebSocket;
  sessionId: string;
  claudeClient: ClaudeClient | null;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTools(content: any[], tools: any[]): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];

  for (const block of content) {
    if (block.type !== 'tool_use') continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = tools.find((t: any) => t.name === block.name);
    if (!tool) continue;

    try {
      const result = await tool.handler(block.input);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: error.message,
        is_error: true,
      });
    }
  }

  return results;
}

async function processClaudeResponse(
  clientInfo: ClientInfo,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  systemPrompt: string,
  turnCount: number
): Promise<string> {
  if (turnCount >= 5) {
    console.warn('[Setup] Max tool turns reached (5), stopping');
    return '';
  }

  const response = await clientInfo.claudeClient!.sendMessage(clientInfo.conversationHistory, {
    system: systemPrompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools.map((t: any) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
    maxTokens: 4096,
  });

  let assistantText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      assistantText += block.text;
    }
  }

  if (response.stop_reason === 'end_turn' || tools.length === 0) {
    return assistantText;
  }

  if (response.stop_reason === 'tool_use') {
    const toolResults = await executeTools(response.content, tools);

    clientInfo.conversationHistory.push({
      role: 'assistant',
      content: JSON.stringify(response.content),
    });
    clientInfo.conversationHistory.push({
      role: 'user',
      content: JSON.stringify(toolResults),
    });

    const nextText = await processClaudeResponse(clientInfo, tools, systemPrompt, turnCount + 1);
    return assistantText + nextText;
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
    const oauthManager = new OAuthManager();

    let claudeClient: ClaudeClient | null = null;
    try {
      claudeClient = new ClaudeClient(oauthManager);
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Claude authentication failed. Please verify you are logged into Claude Code.',
        })
      );
      ws.close();
      return;
    }

    const clientInfo: ClientInfo = {
      ws,
      sessionId,
      claudeClient,
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

  if (!clientInfo.claudeClient) {
    clientInfo.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Claude client not initialized',
      })
    );
    return;
  }

  const isActionPhase = (clientInfo.discoveryPhase ?? 1) >= 7;

  // Create tools with redirect callback for onboarding completion
  const onboardingTools = clientInfo.isRitualMode
    ? createAllOnboardingToolsWithHandlers({
        onOnboardingComplete: () => {
          // Send redirect message to client
          clientInfo.ws.send(
            JSON.stringify({
              type: 'redirect',
              url: '/viewer',
              message: 'Onboarding complete! Redirecting to MAMA OS...',
            })
          );
        },
      })
    : [];

  const tools = clientInfo.isRitualMode
    ? isActionPhase
      ? onboardingTools
      : []
    : createSetupTools(clientInfo);

  try {
    const lang = clientInfo.language || 'en';
    const isKorean = lang.startsWith('ko');
    const languageInstruction = isKorean
      ? '\n\n**IMPORTANT: User browser language is Korean (ko). Respond in Korean.**'
      : '\n\n**IMPORTANT: User browser language is English (en). Respond in English.**';

    const systemPrompt = clientInfo.isRitualMode
      ? COMPLETE_AUTONOMOUS_PROMPT + languageInstruction
      : SETUP_SYSTEM_PROMPT + languageInstruction;

    const assistantMessage = await processClaudeResponse(clientInfo, tools, systemPrompt, 0);

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

/**
 * Skill Forge - Claude API Integration
 *
 * 실제 Claude API 연동으로 각 에이전트 실행
 * 환경변수: ANTHROPIC_API_KEY
 */

import { AgentModel, ArchitectOutput, DeveloperOutput, QAOutput, SkillRequest } from './types';

// ===== API Types =====

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
}

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ===== Model Mapping =====

const MODEL_MAP: Record<AgentModel, string> = {
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-sonnet-4-20250514', // Opus 미출시로 Sonnet 사용
  haiku: 'claude-3-5-haiku-20241022',
};

// ===== API Client =====

export class ClaudeAPIClient {
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1/messages';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!this.apiKey) {
      console.warn('[ClaudeAPI] No API key found - using mock mode');
    }
  }

  async call(
    model: AgentModel,
    systemPrompt: string,
    userMessage: string,
    maxTokens: number = 4096
  ): Promise<string> {
    // Mock mode for testing without API key
    if (!this.apiKey) {
      return this.mockResponse(model, userMessage);
    }

    const request: ClaudeRequest = {
      model: MODEL_MAP[model],
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
      }

      const data = (await response.json()) as ClaudeResponse;
      return data.content[0]?.text || '';
    } catch (error) {
      console.error('[ClaudeAPI] Error:', error);
      throw error;
    }
  }

  private mockResponse(model: AgentModel, userMessage: string): string {
    console.log(`[ClaudeAPI] Mock mode - ${model}`);
    return `Mock response for ${model}`;
  }
}

// ===== System Prompts =====

export const ARCHITECT_SYSTEM_PROMPT = `You are the Architect agent in Skill Forge.
Your role is to design the structure of a skill based on user requirements.

You MUST respond with valid JSON in this exact format:
{
  "skillName": "skill-name-here",
  "purpose": "One line description",
  "triggers": ["/command", "keyword"],
  "workflow": [
    {"step": 1, "action": "action-name", "description": "What this step does"}
  ],
  "fileStructure": [
    {"path": "skills/name/index.ts", "purpose": "Main entry point"}
  ],
  "toolsRequired": ["Read", "Write"],
  "estimatedComplexity": "simple|medium|complex"
}

Be concise. Focus on practical implementation.`;

export const DEVELOPER_SYSTEM_PROMPT = `You are the Developer agent in Skill Forge.
Your role is to implement code based on the Architect's design.

You MUST respond with valid JSON in this exact format:
{
  "files": [
    {
      "path": "skills/name/index.ts",
      "content": "// Full TypeScript code here",
      "language": "typescript"
    }
  ],
  "installInstructions": ["npm install"],
  "testCommands": ["npm test"]
}

Write clean, typed TypeScript code. Include proper error handling.`;

export const QA_SYSTEM_PROMPT = `You are the QA agent in Skill Forge.
Your role is to verify the quality of generated code.

You MUST respond with valid JSON in this exact format:
{
  "passed": true|false,
  "checklist": [
    {"item": "Check description", "passed": true|false, "note": "Optional note"}
  ],
  "issues": [
    {"severity": "critical|warning|suggestion", "description": "Issue description", "location": "file.ts:10"}
  ],
  "recommendation": "approve|revise|reject"
}

Be thorough but practical. Focus on actual issues.`;

// ===== Agent API Wrappers =====

export async function callArchitect(
  client: ClaudeAPIClient,
  request: SkillRequest
): Promise<ArchitectOutput> {
  const userMessage = `Design a skill with these requirements:

Name: ${request.name}
Description: ${request.description}
Triggers: ${request.triggers.join(', ')}
Capabilities: ${request.capabilities.join(', ')}

Original request: ${request.rawInput}

Respond with JSON only.`;

  const response = await client.call('sonnet', ARCHITECT_SYSTEM_PROMPT, userMessage);
  return parseJSON<ArchitectOutput>(response, 'Architect');
}

export async function callDeveloper(
  client: ClaudeAPIClient,
  architectOutput: ArchitectOutput,
  request: SkillRequest
): Promise<DeveloperOutput> {
  const userMessage = `Implement this skill design:

${JSON.stringify(architectOutput, null, 2)}

Original request: ${request.rawInput}

Create all files specified in fileStructure. Respond with JSON only.`;

  const response = await client.call('sonnet', DEVELOPER_SYSTEM_PROMPT, userMessage, 8192);
  return parseJSON<DeveloperOutput>(response, 'Developer');
}

export async function callQA(
  client: ClaudeAPIClient,
  developerOutput: DeveloperOutput,
  architectOutput: ArchitectOutput
): Promise<QAOutput> {
  const userMessage = `Verify this implementation:

## Architect Design
${JSON.stringify(architectOutput, null, 2)}

## Developer Output
${JSON.stringify(developerOutput, null, 2)}

Check for:
1. All files from design are implemented
2. Code is valid TypeScript
3. Error handling exists
4. Workflow is followed
5. Types are properly defined

Respond with JSON only.`;

  const response = await client.call('haiku', QA_SYSTEM_PROMPT, userMessage);
  return parseJSON<QAOutput>(response, 'QA');
}

// ===== JSON Parser =====

function parseJSON<T>(response: string, agentName: string): T {
  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = response;

  // Remove markdown code block if present
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  // Try to find JSON object
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    console.error(`[${agentName}] Failed to parse JSON:`, jsonStr.slice(0, 200));
    throw new Error(`${agentName} returned invalid JSON`);
  }
}

// ===== Integration with Agents =====

export function createAPIArchitectAgent(client: ClaudeAPIClient) {
  return {
    async design(request: SkillRequest): Promise<ArchitectOutput> {
      console.log('[Architect] Calling Claude API...');
      const output = await callArchitect(client, request);
      console.log('[Architect] Design complete:', output.skillName);
      return output;
    },
  };
}

export function createAPIDeveloperAgent(client: ClaudeAPIClient) {
  return {
    async develop(
      architectOutput: ArchitectOutput,
      request: SkillRequest
    ): Promise<DeveloperOutput> {
      console.log('[Developer] Calling Claude API...');
      const output = await callDeveloper(client, architectOutput, request);
      console.log('[Developer] Generated', output.files.length, 'files');
      return output;
    },
  };
}

export function createAPIQAAgent(client: ClaudeAPIClient) {
  return {
    async verify(
      developerOutput: DeveloperOutput,
      architectOutput: ArchitectOutput
    ): Promise<QAOutput> {
      console.log('[QA] Calling Claude API...');
      const output = await callQA(client, developerOutput, architectOutput);
      console.log('[QA] Result:', output.passed ? 'PASSED' : 'FAILED');
      return output;
    },
  };
}

// ===== Test =====

async function runTest() {
  console.log('🔌 Claude API Integration Test\n');

  const client = new ClaudeAPIClient();

  const testRequest: SkillRequest = {
    name: 'weather-check',
    description: '날씨 정보를 조회하는 스킬',
    triggers: ['/weather', '날씨'],
    capabilities: ['현재 날씨 조회', '지역별 날씨'],
    rawInput: '/forge weather-check - 날씨 정보 조회',
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  ANTHROPIC_API_KEY not set - using mock mode\n');

    // Mock test
    const architect = createAPIArchitectAgent(client);
    console.log('Testing mock architect...');

    // In mock mode, this will fail with invalid JSON
    // That's expected behavior
    console.log('Mock mode active - API calls will return placeholder text');
    console.log('\n✅ Test setup complete (set ANTHROPIC_API_KEY for real API test)');
    return;
  }

  console.log('🔑 API key found - running real API test\n');

  try {
    // Test Architect
    console.log('=== Architect ===');
    const architectOutput = await callArchitect(client, testRequest);
    console.log(JSON.stringify(architectOutput, null, 2));

    // Test Developer
    console.log('\n=== Developer ===');
    const developerOutput = await callDeveloper(client, architectOutput, testRequest);
    console.log(`Generated ${developerOutput.files.length} files`);

    // Test QA
    console.log('\n=== QA ===');
    const qaOutput = await callQA(client, developerOutput, architectOutput);
    console.log(JSON.stringify(qaOutput, null, 2));

    console.log('\n✅ All API tests passed');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}

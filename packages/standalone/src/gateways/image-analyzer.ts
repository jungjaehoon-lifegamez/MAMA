import { loadConfig } from '../cli/config/config-manager.js';

// Default model for image analysis (vision-capable)
const DEFAULT_IMAGE_MODEL = 'claude-sonnet-4-5-20250929';

// Define proper types
interface ClaudeResponse {
  content: Array<{ text: string }>;
}

interface ClaudeClient {
  messages: {
    create: (params: unknown) => Promise<ClaudeResponse>;
  };
}

interface ContentBlock {
  type: string;
  image_url?: { url: string };
  localPath?: string;
  userPrompt?: string;
  // Discord-style image block format
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

// Sanitize user input to prevent prompt injection
function sanitizeUserPrompt(prompt: string): string {
  if (!prompt) return 'Analyze this image';
  // Remove potential prompt injection attempts while preserving the user's intent
  return (
    prompt
      .replace(/\\n/g, ' ') // Remove literal \n
      .replace(/[[\]{}]/g, '') // Remove brackets that could interfere with prompts
      .trim()
      .substring(0, 500) || // Limit length
    'Analyze this image'
  );
}

export class ImageAnalyzer {
  private clientCache: Promise<ClaudeClient> | null = null;

  private async getClient(): Promise<ClaudeClient> {
    if (!this.clientCache) {
      this.clientCache = this.createClient().catch((err) => {
        // Reset cache on error so subsequent calls can retry
        this.clientCache = null;
        throw err;
      });
    }
    return this.clientCache;
  }

  private async createClient(): Promise<ClaudeClient> {
    const { createClaudeClient } = await import('../auth/claude-client.js');
    return (await createClaudeClient()) as ClaudeClient;
  }

  async analyze(base64Data: string, mediaType: string, userPrompt: string): Promise<string> {
    const client = await this.getClient();

    // Sanitize user prompt to prevent injection
    const safePrompt = sanitizeUserPrompt(userPrompt);

    // Get model from config, fallback to default
    // Only use Claude models (ImageAnalyzer uses Claude API directly)
    const config = await loadConfig();
    const configModel = config.agent?.model || '';
    const isClaudeModel = configModel.startsWith('claude-');
    const model = isClaudeModel ? configModel : DEFAULT_IMAGE_MODEL;

    const response = await client.messages.create({
      model,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `User prompt: "${safePrompt}"\n\nProvide a detailed description of the image contents. If there is text in the image, transcribe it accurately. Respond in the same language as the user's prompt.`,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: base64Data,
              },
            },
          ],
        },
      ],
    });

    return response.content[0]?.text || 'No response from Claude Vision API';
  }

  async processContentBlocks(blocks: ContentBlock[]): Promise<string> {
    const results: string[] = [];

    for (const block of blocks) {
      // Handle Discord-style image blocks (type: 'image' with source.type: 'base64')
      if (block.type === 'image' && block.source?.type === 'base64') {
        const prompt = block.userPrompt || 'Analyze this image';
        const result = await this.analyze(block.source.data, block.source.media_type, prompt);
        results.push(result);
        continue;
      }

      if (block.type === 'image_url') {
        let base64Data: string;
        let mediaType: string;

        if (block.image_url?.url) {
          // Handle data URL format
          const dataUrl = block.image_url.url;
          if (dataUrl.startsWith('data:')) {
            const [header, data] = dataUrl.split(',');
            mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
            base64Data = data;
          } else {
            throw new Error('Only data URLs are supported for image analysis');
          }
        } else if (block.localPath) {
          const { readFile } = await import('node:fs/promises');
          const nodePath = await import('node:path');
          const { homedir } = await import('node:os');

          // Validate path to prevent traversal attacks
          const allowedBase = nodePath.join(homedir(), '.mama', 'workspace', 'media');
          const resolvedPath = nodePath.resolve(block.localPath);
          if (!resolvedPath.startsWith(allowedBase)) {
            throw new Error('Image path must be within ~/.mama/workspace/media/');
          }

          const fileData = await readFile(resolvedPath);
          base64Data = fileData.toString('base64');

          // Determine media type from file extension
          const ext = block.localPath.split('.').pop()?.toLowerCase();
          mediaType =
            {
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
              png: 'image/png',
              gif: 'image/gif',
              webp: 'image/webp',
            }[ext || ''] || 'image/jpeg';
        } else {
          throw new Error('Image block must have either image_url or localPath');
        }

        const prompt = block.userPrompt || 'Analyze this image';
        const result = await this.analyze(base64Data, mediaType, prompt);
        results.push(result);
      }
    }

    return results.join('\n\n---\n\n');
  }
}

let _instance: ImageAnalyzer | null = null;
export function getImageAnalyzer(): ImageAnalyzer {
  if (!_instance) {
    _instance = new ImageAnalyzer();
  }
  return _instance;
}

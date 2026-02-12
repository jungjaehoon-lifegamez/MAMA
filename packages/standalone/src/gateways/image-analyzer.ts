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
}

// Sanitize user input to prevent prompt injection
function sanitizeUserPrompt(prompt: string): string {
  if (!prompt) return 'Analyze this image';
  // Remove potential prompt injection attempts while preserving the user's intent
  return (
    prompt
      .replace(/\\n/g, ' ') // Remove literal \n
      .replace(/[\]{}]/g, '') // Remove brackets that could interfere with prompts
      .trim()
      .substring(0, 500) || // Limit length
    'Analyze this image'
  );
}

export class ImageAnalyzer {
  private clientCache: Promise<ClaudeClient> | null = null;

  private async getClient(): Promise<ClaudeClient> {
    if (!this.clientCache) {
      this.clientCache = this.createClient();
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

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
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
          const fileData = await readFile(block.localPath);
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
  if (!_instance) _instance = new ImageAnalyzer();
  return _instance;
}

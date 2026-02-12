/**
 * Shared image analyzer using Claude Vision API.
 * Converts images to text descriptions for CLI-based agents.
 */

import type { ContentBlock } from './types.js';

const VISION_MODEL = 'claude-sonnet-4-5-20250929';

export class ImageAnalyzer {
  /**
   * Analyze a single image via Claude Vision API.
   * Returns text description.
   */
  async analyze(base64Data: string, mediaType: string, userPrompt: string): Promise<string> {
    const { createClaudeClient } = await import('../auth/claude-client.js');
    const client = await createClaudeClient();

    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 2048,
      system:
        "You are Claude Code, Anthropic's official CLI for Claude. You analyze images and documents for the user.",
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: `${userPrompt}\n\nProvide a detailed description of the image contents. If there is text in the image, transcribe it accurately. Respond in the same language as the user's prompt.`,
            },
          ],
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlocks = response.content.filter((b: any) => b.type === 'text');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return textBlocks.map((b: any) => b.text).join('\n') || '[No description generated]';
  }

  /**
   * Process content blocks: analyze all images and return a single enriched text.
   * Replaces image blocks with analysis results.
   *
   * @param contentBlocks - mixed text/image content blocks
   * @param userText - original user message text
   * @param skipPattern - regex to filter out auto-generated text blocks (e.g. /^\[Image:/)
   * @returns { text: enriched text, imagePaths: local file paths of images }
   */
  async processContentBlocks(
    contentBlocks: ContentBlock[],
    userText: string,
    skipPattern?: RegExp
  ): Promise<{ text: string; imagePaths: string[] }> {
    const analyses: string[] = [];
    const imagePaths: string[] = [];
    const textParts: string[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        if (skipPattern && skipPattern.test(block.text ?? '')) continue;
        if (block.text) textParts.push(block.text);
      } else if (block.type === 'image') {
        try {
          let base64Data: string;
          let mediaType: string;

          if (block.source?.data) {
            base64Data = block.source.data;
            mediaType = block.source.media_type || 'image/jpeg';
          } else if (block.localPath) {
            const fs = await import('node:fs');
            const fileData = fs.readFileSync(block.localPath);
            base64Data = fileData.toString('base64');
            mediaType = 'image/jpeg';
          } else {
            analyses.push('[Image block without data]');
            continue;
          }

          if (block.localPath) imagePaths.push(block.localPath);

          const desc = await this.analyze(
            base64Data,
            mediaType,
            userText || 'Describe this image in detail'
          );
          analyses.push(desc);
          console.log(`[ImageAnalyzer] Analyzed image (${desc.length} chars)`);
        } catch (err) {
          console.error(`[ImageAnalyzer] Analysis failed:`, err);
          analyses.push('[Image was attached but could not be analyzed]');
        }
      }
    }

    if (analyses.length === 0) {
      return { text: textParts.join('\n'), imagePaths };
    }

    const analysisText = analyses
      .map((r, i) => (analyses.length > 1 ? `[Image ${i + 1} Analysis]\n${r}` : r))
      .join('\n\n');

    const combinedUserText = textParts.join('\n');
    const pathInfo =
      imagePaths.length > 0
        ? `\nOriginal image file path: ${imagePaths.join(', ')}\n(You can send this file using the sendFile tool)\n`
        : '';

    const text =
      `${combinedUserText ? combinedUserText + '\n\n' : ''}` +
      `Below is the image analysis result from Claude Vision API. ` +
      `Respond based on this analysis. NEVER say "please attach an image".\n` +
      `${pathInfo}\n--- IMAGE ANALYSIS ---\n${analysisText}\n--- END ---`;

    return { text, imagePaths };
  }
}

let sharedInstance: ImageAnalyzer | null = null;

export function getImageAnalyzer(): ImageAnalyzer {
  if (!sharedInstance) {
    sharedInstance = new ImageAnalyzer();
  }
  return sharedInstance;
}

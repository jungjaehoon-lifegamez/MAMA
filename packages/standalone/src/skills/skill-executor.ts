/**
 * Skill Executor
 *
 * Executes matched skills by:
 * 1. Building multimodal prompts with attachments
 * 2. Running through AgentLoop
 * 3. Processing output (HTML generation, screenshots)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import type { AgentLoop } from '../agent/agent-loop.js';
import type { ContentBlock, ImageBlock, DocumentBlock, TextBlock } from '../agent/types.js';
import type { SkillDefinition, SkillInput, SkillResult, SkillAttachment } from './types.js';

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Convert file to base64
 */
async function fileToBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.toString('base64');
}

/**
 * Compress image if too large (Claude limit: 5MB)
 * Uses sharp if available, otherwise returns original
 */
async function compressImageIfNeeded(
  filePath: string,
  maxSizeBytes = 4 * 1024 * 1024
): Promise<Buffer> {
  const buffer = await readFile(filePath);

  // If under limit, return as-is
  if (buffer.length <= maxSizeBytes) {
    return buffer;
  }

  console.log(
    `[SkillExecutor] Image too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB), compressing...`
  );

  try {
    // Try to use sharp for compression
    const sharp = (await import('sharp')).default;

    // Calculate target quality based on size ratio
    const ratio = maxSizeBytes / buffer.length;
    const quality = Math.max(30, Math.min(80, Math.floor(ratio * 100)));

    // Resize and compress
    let compressed = await sharp(buffer)
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();

    // If still too large, reduce quality further
    if (compressed.length > maxSizeBytes) {
      compressed = await sharp(buffer)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 50 })
        .toBuffer();
    }

    if (compressed.length > maxSizeBytes) {
      compressed = await sharp(buffer)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 40 })
        .toBuffer();
    }

    console.log(`[SkillExecutor] Compressed to ${(compressed.length / 1024 / 1024).toFixed(2)}MB`);
    return compressed;
  } catch (err) {
    console.warn(`[SkillExecutor] sharp not available, cannot compress image: ${err}`);
    return buffer;
  }
}

/**
 * Build content blocks for multimodal input
 */
async function buildContentBlocks(
  text: string,
  attachments: SkillAttachment[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  // Add images first (Claude prefers images before text)
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      // Compress image if needed (Claude limit: 5MB)
      const buffer = await compressImageIfNeeded(attachment.localPath);
      const base64 = buffer.toString('base64');

      // After compression, image is JPEG
      const wasCompressed = buffer.length < (await readFile(attachment.localPath)).length;
      const mimeType = wasCompressed
        ? 'image/jpeg'
        : attachment.contentType || getMimeType(attachment.filename);

      // Validate image type
      if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
        const imageBlock: ImageBlock = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as ImageBlock['source']['media_type'],
            data: base64,
          },
        };
        blocks.push(imageBlock);
      }
    }
  }

  // Add documents (PDF, etc.)
  for (const attachment of attachments) {
    if (attachment.type === 'document') {
      const base64 = await fileToBase64(attachment.localPath);
      const mimeType = attachment.contentType || getMimeType(attachment.filename);

      const docBlock: DocumentBlock = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: base64,
        },
      };
      blocks.push(docBlock);
    }
  }

  // Add text last
  const textBlock: TextBlock = {
    type: 'text',
    text,
  };
  blocks.push(textBlock);

  return blocks;
}

/**
 * Skill Executor configuration
 */
export interface SkillExecutorConfig {
  /** Workspace directory for output files */
  workspaceDir: string;
  /** Discord gateway for sending results */
  discordGateway?: {
    sendMessage: (channelId: string, message: string) => Promise<void>;
    sendImage: (channelId: string, imagePath: string, caption?: string) => Promise<void>;
  };
  /** Screenshot function */
  takeScreenshot?: (htmlPath: string, outputPath: string) => Promise<void>;
}

/**
 * Skill Executor class
 */
export class SkillExecutor {
  private config: SkillExecutorConfig;

  constructor(config: SkillExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute a skill with the given input
   */
  async execute(
    skill: SkillDefinition,
    input: SkillInput,
    agentLoop: AgentLoop
  ): Promise<SkillResult> {
    const startTime = Date.now();

    try {
      console.log(`[SkillExecutor] Executing skill: ${skill.name}`);

      // Build the prompt with skill system prompt
      const fullPrompt = this.buildPrompt(skill, input);

      // Collect original images for side-by-side display
      const originalImages: Array<{ data: string; mimeType: string }> = [];

      // Build content blocks for multimodal input
      let contentBlocks: ContentBlock[];
      if (input.attachments && input.attachments.length > 0) {
        contentBlocks = await buildContentBlocks(fullPrompt, input.attachments);

        // Save original images for later embedding
        for (const attachment of input.attachments) {
          if (attachment.type === 'image' && attachment.localPath) {
            const buffer = await compressImageIfNeeded(attachment.localPath);
            originalImages.push({
              data: buffer.toString('base64'),
              mimeType: 'image/jpeg', // Compressed images are JPEG
            });
          }
        }
      } else {
        contentBlocks = [{ type: 'text', text: fullPrompt }];
      }

      // Run through agent loop with multimodal content
      console.log(`[SkillExecutor] Running agent loop with ${contentBlocks.length} content blocks`);
      const result = await agentLoop.runWithContent(contentBlocks);
      console.log(`[SkillExecutor] Agent loop result:`, {
        responseLength: result.response?.length || 0,
        turns: result.turns,
        stopReason: result.stopReason,
      });

      // Validate response - check if translation actually happened
      const response = result.response?.trim() || '';

      if (!response) {
        console.error(`[SkillExecutor] Empty response from agent loop`);
        return {
          success: false,
          error: 'Response is empty. Please try again.',
          duration: Date.now() - startTime,
        };
      }

      // Check for common failure patterns
      const failurePatterns = [
        '읽을 수 없', // Korean: "cannot read" (KEEP for Korean response detection)
        '인식할 수 없', // Korean: "cannot recognize"
        '확인할 수 없', // Korean: "cannot verify"
        'cannot read',
        'unable to',
        'I cannot',
        "I can't",
        '죄송합니다', // Korean: "sorry"
        '이미지가 없', // Korean: "no image"
      ];

      const lowerResponse = response.toLowerCase();
      const hasFailed =
        failurePatterns.some((pattern) => lowerResponse.includes(pattern.toLowerCase())) &&
        response.length < 500; // Short failure messages only

      if (hasFailed) {
        console.error(
          `[SkillExecutor] Skill appears to have failed: ${response.substring(0, 100)}`
        );
        return {
          success: false,
          error: response,
          duration: Date.now() - startTime,
        };
      }

      // Process output based on skill configuration
      console.log(
        `[SkillExecutor] Processing output type: ${skill.output?.type}, discordScreenshot: ${skill.output?.discordScreenshot}`
      );
      const processedResult = await this.processOutput(skill, input, response, originalImages);
      console.log(
        `[SkillExecutor] Processed result - response length: ${processedResult.response?.length || 0}, files: ${processedResult.files?.length || 0}`
      );

      return {
        success: true,
        response: processedResult.response,
        files: processedResult.files,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      console.error(`[SkillExecutor] Error executing skill ${skill.name}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Build the full prompt with skill instructions
   */
  private buildPrompt(skill: SkillDefinition, input: SkillInput): string {
    const parts: string[] = [];

    // Add skill system prompt
    if (skill.systemPrompt) {
      parts.push(skill.systemPrompt);
    }

    // Add user input
    if (input.text) {
      parts.push(`\n---\nUser request: ${input.text}`);
    }

    // Add attachment info
    if (input.attachments && input.attachments.length > 0) {
      const attachmentInfo = input.attachments.map((a) => `- ${a.filename} (${a.type})`).join('\n');
      parts.push(`\nAttached files:\n${attachmentInfo}`);
    }

    return parts.join('\n');
  }

  /**
   * Process output based on skill configuration
   */
  private async processOutput(
    skill: SkillDefinition,
    input: SkillInput,
    response: string,
    originalImages?: Array<{ data: string; mimeType: string }>
  ): Promise<{ response: string; files?: SkillResult['files'] }> {
    const output = skill.output;

    if (!output) {
      return { response };
    }

    const files: SkillResult['files'] = [];

    switch (output.type) {
      case 'html': {
        // Save response as HTML
        const htmlPath = await this.saveAsHtml(skill, response, originalImages);
        files.push({ path: htmlPath, type: 'html', description: 'Generated HTML' });
        const summary = response.length > 200 ? response.substring(0, 200) + '...' : response;
        return { response: `${skill.name} completed.\n\n**Result Summary:**\n${summary}`, files };
      }

      case 'html-screenshot': {
        // Save as HTML and take screenshot (with overlay if images available)
        const htmlPath = await this.saveAsHtml(skill, response, originalImages);
        files.push({ path: htmlPath, type: 'html', description: 'Generated HTML' });

        if (this.config.takeScreenshot) {
          const screenshotPath = htmlPath.replace('.html', '.png');
          console.log(`[SkillExecutor] Taking screenshot: ${screenshotPath}`);
          await this.config.takeScreenshot(htmlPath, screenshotPath);
          files.push({ path: screenshotPath, type: 'image', description: 'Screenshot' });
          console.log(`[SkillExecutor] Screenshot saved: ${screenshotPath}`);

          // Send to Discord if configured
          if (output.discordScreenshot && this.config.discordGateway && input.channelId) {
            console.log(
              `[SkillExecutor] Sending screenshot to Discord channel: ${input.channelId}`
            );
            await this.config.discordGateway.sendImage(input.channelId, screenshotPath);
            console.log(`[SkillExecutor] Screenshot sent to Discord`);
          }
        } else {
          console.log(`[SkillExecutor] No takeScreenshot configured`);
        }

        // Return detailed response with context
        const summary = response.length > 200 ? response.substring(0, 200) + '...' : response;
        const attachmentInfo = input.attachments?.map((a) => a.filename).join(', ') || 'image';
        return {
          response: `${skill.name} completed.\n\n**Original:** ${attachmentInfo}\n**Result Summary:**\n${summary}`,
          files,
        };
      }

      default:
        return { response };
    }
  }

  /**
   * Save response as HTML file
   */
  private async saveAsHtml(
    skill: SkillDefinition,
    content: string,
    originalImages?: Array<{ data: string; mimeType: string }>
  ): Promise<string> {
    const outputDir = join(this.config.workspaceDir, 'output', skill.id);
    await mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${skill.id}-${timestamp}.html`;
    const filePath = join(outputDir, filename);

    // Check if content is already HTML or needs wrapping
    let html: string;
    if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      html = content;
    } else {
      // Wrap in basic HTML
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${skill.name}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; line-height: 1.6; }
    pre { background: #f4f4f4; padding: 10px; overflow-x: auto; }
    code { background: #f4f4f4; padding: 2px 4px; }
  </style>
</head>
<body>
${content}
</body>
</html>`;
    }

    // If we have original images, use side-by-side layout
    if (originalImages && originalImages.length > 0 && skill.output?.type === 'html-screenshot') {
      const imageDataUrl = `data:${originalImages[0].mimeType};base64,${originalImages[0].data}`;

      // Convert markdown to simple HTML
      let translatedHtml = content
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');

      // Convert markdown tables
      if (content.includes('|')) {
        const lines = content.split('\n');
        let inTable = false;
        let tableHtml = '<table>';
        let isHeader = true;

        for (const line of lines) {
          if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            if (line.includes('---')) {
              continue; // Skip separator line
            }
            if (!inTable) {
              inTable = true;
              tableHtml = '<table>';
            }
            const cells = line.split('|').filter((c) => c.trim());
            const tag = isHeader ? 'th' : 'td';
            tableHtml +=
              '<tr>' + cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
            isHeader = false;
          } else if (inTable) {
            tableHtml += '</table>';
            inTable = false;
            isHeader = true;
          }
        }
        if (inTable) tableHtml += '</table>';

        // Replace table in content
        translatedHtml = content.replace(/(\|.+\|[\s\S]*?\|.+\|)/g, tableHtml);
        translatedHtml = translatedHtml
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
      }

      // Side-by-side layout
      html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${skill.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans KR', sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      display: flex;
      gap: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .panel {
      flex: 1;
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .panel-header {
      background: #4a90d9;
      color: white;
      padding: 12px 20px;
      font-weight: bold;
      font-size: 14px;
    }
    .panel-content {
      padding: 15px;
    }
    .original-image {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .translation {
      font-size: 14px;
      line-height: 1.8;
    }
    .translation h1 { font-size: 20px; margin: 10px 0; }
    .translation h2 { font-size: 18px; margin: 10px 0; }
    .translation h3 { font-size: 16px; margin: 8px 0; }
    .translation table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0;
    }
    .translation th, .translation td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    .translation th {
      background: #f0f0f0;
    }
    .translation code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="panel">
      <div class="panel-header">📷 Original</div>
      <div class="panel-content">
        <img src="${imageDataUrl}" alt="Original" class="original-image">
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">📝 Translation</div>
      <div class="panel-content translation">
        ${translatedHtml}
      </div>
    </div>
  </div>
</body>
</html>`;
    }

    await writeFile(filePath, html, 'utf-8');
    console.log(`[SkillExecutor] Saved HTML: ${filePath}`);

    return filePath;
  }
}

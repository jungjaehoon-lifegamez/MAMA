const fs = require('node:fs');
const path = require('node:path');
const mime = require('mime-types');

// Sanitize filename to prevent prompt injection
function sanitizeFilename(filename) {
  if (!filename) {
    return 'unknown';
  }
  // Remove characters that could be interpreted as prompt control characters
  // eslint-disable-next-line no-useless-escape
  return (
    filename
      .replace(/[[\](){}]/g, '')
      .replace(/\n/g, ' ')
      .trim() || 'sanitized'
  );
}

class WebSocketHandler {
  constructor(gateway) {
    this.gateway = gateway;
  }

  // eslint-disable-next-line no-unused-vars
  handleConnection(ws, _req) {
    console.log('[WebSocket] New connection established');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(ws, message);
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
          })
        );
      }
    });

    ws.on('close', () => {
      console.log('[WebSocket] Connection closed');
    });

    ws.on('error', (error) => {
      console.error('[WebSocket] WebSocket error:', error);
    });
  }

  async handleMessage(ws, message) {
    const { type, sessionId, content, attachments } = message;

    if (type === 'send') {
      const contentBlocks = [
        {
          type: 'text',
          text: content || '',
        },
      ];

      // Process attachments if any
      if (attachments && Array.isArray(attachments)) {
        for (const att of attachments) {
          try {
            // Reconstruct path from filename only (prevent LFI)
            const filename = att.filename || 'unknown';
            const resolvedPath = path.join(
              process.env.HOME || '/tmp',
              '.mama/workspace/media/inbound',
              path.basename(filename) // Only use basename for security
            );

            // Check if file exists
            if (fs.existsSync(resolvedPath)) {
              // eslint-disable-next-line no-unused-vars
              const _stats = fs.statSync(resolvedPath);
              const data = fs.readFileSync(resolvedPath);
              const mediaType = mime.lookup(resolvedPath) || 'application/octet-stream';

              // Sanitize filename before using in prompt
              const sanitizedFilename = sanitizeFilename(att.filename);
              contentBlocks.push({
                type: 'text',
                text: `[Document uploaded: ${sanitizedFilename}]\nFile path: ${resolvedPath}\nPlease use the Read tool to analyze this document.`,
              });

              // Use console.log instead of console.error for successful operations
              console.log(
                `[WebSocket] Attached: ${sanitizedFilename} (${data.length} bytes, ${mediaType})`
              );
            } else {
              console.warn(`[WebSocket] File not found: ${resolvedPath}`);
            }
          } catch (error) {
            console.error('[WebSocket] Error processing attachment:', error);
          }
        }
      }

      // Send to agent
      try {
        const response = await this.gateway.processMessage({
          sessionId,
          content: contentBlocks,
        });

        ws.send(
          JSON.stringify({
            type: 'response',
            sessionId,
            content: response,
          })
        );
      } catch (error) {
        console.error('[WebSocket] Error processing message:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Failed to process message',
          })
        );
      }
    }
  }
}

module.exports = WebSocketHandler;

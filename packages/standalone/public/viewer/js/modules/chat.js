/* eslint-env browser */
import { escapeHtml, escapeAttr } from '../utils/dom.js';

export class ChatManager {
  constructor() {
    this.sessionId = null;
    this.ws = null;
    this.messageHistory = [];
    this.isConnected = false;
  }

  addUserMessageWithAttachment(message, attachment) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex justify-end mb-4';

    let attachHtml = '';
    if (attachment) {
      if (attachment.isImage) {
        // Use escapeAttr for all attribute values
        const safeUrl = escapeAttr(attachment.mediaUrl);
        const safeAlt = escapeAttr(attachment.originalName);
        attachHtml = `<img src="${safeUrl}" class="max-w-[200px] rounded-lg mt-1 cursor-pointer" alt="${safeAlt}" data-lightbox="${safeUrl}" />`;
      } else {
        const safeUrl = escapeAttr(attachment.mediaUrl);
        attachHtml = `<a href="${safeUrl}" target="_blank" class="inline-block bg-blue-100 text-blue-700 px-2 py-1 rounded mt-1 text-sm hover:bg-blue-200">
          📎 ${escapeHtml(attachment.originalName)}
        </a>`;
      }
    }

    messageDiv.innerHTML = `
      <div class="bg-blue-500 text-white rounded-lg px-4 py-2 max-w-xs lg:max-w-md">
        <div>${escapeHtml(message)}</div>
        ${attachHtml}
      </div>
    `;

    document.getElementById('messages').appendChild(messageDiv);
    this.scrollToBottom();

    // Save to history with attachment metadata
    this.messageHistory.push({
      type: 'user',
      content: message,
      attachment: attachment,
      timestamp: new Date().toISOString(),
    });
    this.saveHistory();
  }

  restoreHistory() {
    const history = localStorage.getItem('chat_history');
    if (!history) {
      return;
    }

    try {
      this.messageHistory = JSON.parse(history);
      const messagesContainer = document.getElementById('messages');
      messagesContainer.innerHTML = '';

      for (const msg of this.messageHistory) {
        if (msg.type === 'user') {
          let attachHtml = '';
          if (msg.attachment) {
            if (msg.attachment.isImage) {
              // Use escapeAttr for attributes, escapeHtml for content
              const safeUrl = escapeAttr(msg.attachment.mediaUrl);
              const safeAlt = escapeAttr(msg.attachment.originalName);
              attachHtml = `<img src="${safeUrl}" class="max-w-[200px] rounded-lg mt-1 cursor-pointer" alt="${safeAlt}" data-lightbox="${safeUrl}" />`;
            } else {
              const safeUrl = escapeAttr(msg.attachment.mediaUrl);
              attachHtml = `<a href="${safeUrl}" target="_blank" class="inline-block bg-blue-100 text-blue-700 px-2 py-1 rounded mt-1 text-sm hover:bg-blue-200">
                📎 ${escapeHtml(msg.attachment.originalName)}
              </a>`;
            }
          }

          const messageDiv = document.createElement('div');
          messageDiv.className = 'flex justify-end mb-4';
          messageDiv.innerHTML = `
            <div class="bg-blue-500 text-white rounded-lg px-4 py-2 max-w-xs lg:max-w-md">
              <div>${escapeHtml(msg.content)}</div>
              ${attachHtml}
            </div>
          `;
          messagesContainer.appendChild(messageDiv);
        } else {
          this.addAssistantMessage(msg.content);
        }
      }
      this.scrollToBottom();
    } catch (error) {
      console.error('Failed to restore chat history:', error);
    }
  }

  scrollToBottom() {
    // Implementation
  }

  saveHistory() {
    // Implementation
  }

  addAssistantMessage(content) {
    // Implementation
    console.log('Adding assistant message:', content);
  }
}

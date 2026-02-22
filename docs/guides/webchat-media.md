# Webchat Media Guide

How to upload/download images and use TTS/STT in the MAMA Viewer (webchat).

## Image Upload

### Attach Button

Click the paperclip button below the chat input, or drag & drop a file into the chat area.

### Supported Formats

- **Images**: JPEG, PNG, GIF, WebP, SVG
- **Documents**: PDF
- **Max size**: 20MB (auto-compressed if over 5MB)

### How It Works

1. Select a file -> preview thumbnail is displayed
2. Enter a message (optional, default: "What is in this image?")
3. Send -> file is uploaded to `/api/upload`
4. The image is converted to base64 via WebSocket and sent to Claude
5. Claude recognizes the image content and responds

## Image Download

When a Claude response includes a file from `~/.mama/workspace/media/outbound/`, it is automatically:

- Image: displayed inline + download link
- Other files: download link

## TTS (Text-to-Speech)

### Toggle

Click the speaker icon in the chat header to turn ON/OFF.

### Features

- Automatic voice output when streaming response completes
- Speed control: 0.5x ~ 2.0x (default 1.8x, optimized for Korean)
- Hands-free mode: voice input starts automatically after TTS finishes

## STT (Speech-to-Text)

### Usage

Click the microphone button -> speak -> auto-stops after 2.5 seconds of silence.

- **Continuous recognition**: You can speak multiple sentences in succession
- **Language**: Auto-detected based on browser language settings (Korean/English)

## API Reference

### POST /api/upload

```text
Content-Type: multipart/form-data
Body: file (binary)

Response: { success, filename, mediaUrl, size, contentType }
```

### GET /api/media/:filename

Displays the file inline (images, etc.).

### GET /api/media/download/:filename

Forces file download (`Content-Disposition: attachment`).

## WebSocket Protocol

Message format when attaching an image:

```json
{
  "type": "send",
  "sessionId": "...",
  "content": "What is in this image?",
  "attachments": [
    {
      "filename": "photo.jpg",
      "contentType": "image/jpeg"
    }
  ]
}
```

> **Security Note**: The server **ignores** the `filePath` provided by the client and uses only the `filename` to locate the file within `~/.mama/workspace/media/inbound/`. This prevents Local File Inclusion (LFI) attacks.

The server converts `attachments` to base64 `contentBlocks` and passes them to the Claude Vision API.

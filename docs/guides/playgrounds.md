# Playground User Guide

**Category:** Guide (Task-Oriented)
**Audience:** MAMA OS Users

---

## Overview

Playgrounds are interactive HTML tools in the MAMA OS Viewer. Adjust settings with controls (sliders, color pickers, toggles, etc.) to see a real-time preview update and an auto-generated natural language prompt. You can copy the generated prompt to the clipboard or send it directly to chat.

**Access:** MAMA OS Viewer → Playground tab

---

## 4 Built-in Playgrounds

MAMA OS includes 4 built-in Playgrounds.

| Playground            | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| **Wave Visualizer**   | Multi-Agent workflow (Wave) simulation and agent state monitoring |
| **Skill Lab**         | Interactive editor for creating, editing, and testing skills      |
| **Cron Workflow Lab** | Configuration tool for schedule-based workflows (cron jobs)       |
| **Log Viewer**        | Real-time viewing and filtering of MAMA OS daemon logs            |

Built-in template location: `packages/standalone/templates/playgrounds/`

---

## Managing in Viewer

You can manage all Playgrounds from the Playground tab.

- **Card grid**: Displays registered Playgrounds as a card list
- **iframe load**: Clicking a card loads the Playground HTML in an iframe
- **Open in new tab**: Opens the Playground in a separate tab
- **Delete**: Removes Playgrounds that are no longer needed

### API Endpoints

```http
GET  /api/playgrounds          # List (newest first)
DELETE /api/playgrounds/{slug}  # Delete
```

---

## Creating Custom Playgrounds

Describe the tool you want in chat, and the agent will automatically create it by calling the `playground_create` gateway tool.

### Request Example

```text
"Create a Color palette explorer playground.
 Let me pick Primary/Secondary/Accent colors and show a preview with a prompt."
```

### playground_create Tool

```json
{
  "name": "Color Palette Explorer",
  "html": "<!doctype html><html>...</html>",
  "description": "Color palette exploration and prompt generation"
}
```

**Parameters:**

| Field         | Required | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `name`        | Yes      | Title (URL-safe slug is auto-generated)                |
| `html`        | Yes      | Complete HTML document (`<!doctype html>` ~ `</html>`) |
| `file_path`   | -        | Load from file path instead of html                    |
| `description` | -        | One-line description                                   |

**Result:**

```json
{
  "success": true,
  "url": "/playgrounds/color-palette-explorer.html",
  "slug": "color-palette-explorer"
}
```

> **Important:** If you write a file directly with the Write tool, it won't be registered in `index.json` and won't appear in the Viewer. Always use the `playground_create` tool.

### Playground HTML Authoring Rules

- **Self-contained**: All CSS/JS inline, no external CDNs
- **Real-time reactive**: Preview updates immediately on control change, no "Apply" button
- **Prompt generation**: Include only settings that differ from defaults in natural language
- **Copy + Send to Chat**: Must be placed at the bottom
- **Dark theme**: Dark mode by default
- **Responsive**: Support 320px ~ desktop
- **Presets**: Include 3-5 predefined combinations

### Pattern: Configure → Preview → Prompt

```text
┌──────────────────────────────────────────────┐
│  Controls (left)    │  Live Preview (center)  │
│  - Sliders          │  - Real-time rendering  │
│  - Color pickers    │                         │
│  - Toggles          │                         │
├──────────────────────────────────────────────┤
│  Generated Prompt              [Copy] [Send] │
│  "Apply border-radius 12px, strong shadow"   │
└──────────────────────────────────────────────┘
```

---

## sendToChat Integration

A bidirectional communication API for sending prompts generated in a Playground to the Viewer chat.

### Playground → Chat Sending

```javascript
// SECURITY: Always use a restricted targetOrigin instead of '*'.
// The Viewer origin is derived from the page URL (e.g., 'http://localhost:3847').
var VIEWER_ORIGIN = window.location.origin;

function sendToChat() {
  var text = document.getElementById('promptText').textContent;
  if (!text || text === 'Using default settings.') return;

  window.parent.postMessage({ type: 'playground:sendToChat', message: text }, VIEWER_ORIGIN);
}
```

> **Security note:** Always send `postMessage` to a known origin (not `'*'`). The parent message handler should also validate `event.origin` to only accept messages from the expected Viewer origin.

### Chat Response → Playground Receiving

The Viewer automatically relays agent responses to the Playground iframe.

```javascript
// Receiving in Playground
window.addEventListener('message', (event) => {
  if (event.data.type === 'playground:response') {
    // event.data.content contains the agent response
    displayResponse(event.data.content);
  }
});
```

### Communication Protocol

| Direction           | Message Type            | Data                  |
| ------------------- | ----------------------- | --------------------- |
| Playground → Viewer | `playground:sendToChat` | `{ message: string }` |
| Viewer → Playground | `playground:response`   | `{ content: string }` |

**Flow:**

1. User clicks "Send to Chat"
2. Playground sends the prompt via `postMessage`
3. Viewer opens the chat panel and sends the message
4. When the agent responds, it is automatically relayed to the iframe

---

## Storage Location

```text
~/.mama/workspace/playgrounds/
├── index.json                   # Metadata array
├── wave-visualizer.html
├── skill-lab-playground.html
├── cron-workflow-lab.html
├── mama-log-viewer.html
└── color-palette-explorer.html  # Custom example
```

### index.json Format

```json
[
  {
    "name": "Wave Visualizer",
    "slug": "wave-visualizer",
    "description": "Task wave visualization",
    "created_at": "2026-02-22T10:30:45.123Z"
  }
]
```

- `slug` is auto-generated from `name` (kebab-case)
- If an entry with the same `slug` exists, it is overwritten
- If `index.json` is missing, `.html` files in the directory are scanned for automatic recovery

---

## References

- Skill definition: `packages/standalone/templates/skills/playground.md`
- Gateway implementation: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Viewer module: `packages/standalone/public/viewer/src/modules/playground.ts`

---
name: Playground Creator
description: Create interactive HTML playgrounds displayed in the Viewer Playground tab. Configure visually → auto-generate prompt → copy or send to chat.
keywords:
  - playground
  - explorer
  - color palette
  - concept map
  - code map
  - data explorer
  - diff review
  - document critique
  - visualizer
  - prompt generator
  - interactive
  - HTML tool
  - playground_create
  - comparison tool
  - configuration tool
output: text
---

# Playground Creator

## CRITICAL: Always use playground_create tool

**Never create files directly with Write/Bash tool.**
You MUST use the `playground_create` gateway tool.
Only this tool registers the playground in `index.json` so it appears in the Viewer Playground tab.

```tool_call
{"name": "playground_create", "input": {"name": "Color Palette Explorer", "html": "<!doctype html><html>..full HTML..</html>", "description": "Color palette exploration tool"}}
```

**Parameters:**

- `name`: Short title (used to generate a URL-safe slug)
- `html`: Complete self-contained HTML string (full `<!doctype html>` to `</html>`)
- `description`: One-line description (optional)

Returns: `{ success: true, url: "/playgrounds/{slug}.html", slug: "..." }`

**Warning:** Writing directly to `~/.mama/workspace/playgrounds/` skips `index.json` registration — the playground won't appear in the tab.

## JS String Caution

When inserting newlines in JavaScript inside HTML, always use the escape sequence `\n`.
Never put actual newlines inside string literals — it breaks the entire script parser.

```javascript
// GOOD
parts.join('\n')

// BAD — entire JS parsing error
parts.join('
')
```

## Core Pattern: Configure → Preview → Prompt → Copy/Send

Every playground follows this structure:

1. **Control Panel** (left/top): Sliders, color pickers, selects, toggles, etc.
2. **Live Preview** (center): Updates instantly on control changes. No "Apply" button.
3. **Prompt Output** (bottom): Auto-generates a natural-language prompt from current settings + **Copy button** + **Send to Chat button**

### Prompt Output Rules

- Written in **natural language**, not a value dump.
- Only includes items that **differ from defaults**. Unchanged settings are omitted.
- **Self-contained context**: The prompt must be actionable without the playground.
- **Real-time updates**: Refreshes instantly on every control change.

### Prompt Area HTML Structure (Required)

Every playground must include this structure at the bottom:

```html
<div class="prompt-output">
  <div class="prompt-header">
    <label>Generated Prompt</label>
    <div class="prompt-actions">
      <button id="copyPromptBtn" onclick="copyPrompt()">Copy</button>
      <button id="sendToChatBtn" onclick="sendToChat()">Send to Chat</button>
    </div>
  </div>
  <div id="promptText" class="prompt-text">Using default settings.</div>
</div>
```

### Copy + Send to Chat Functions (Required)

```javascript
async function copyPrompt() {
  var text = document.getElementById('promptText').textContent;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('copyPromptBtn').textContent = 'Copied!';
    setTimeout(function () {
      document.getElementById('copyPromptBtn').textContent = 'Copy';
    }, 1500);
  } catch (e) {
    // fallback
  }
}

function sendToChat() {
  var text = document.getElementById('promptText').textContent;
  if (!text || text === 'Using default settings.') return;
  window.parent.postMessage({ type: 'playground:sendToChat', message: text }, '*');
  document.getElementById('sendToChatBtn').textContent = 'Sent!';
  setTimeout(function () {
    document.getElementById('sendToChatBtn').textContent = 'Send to Chat';
  }, 1500);
}
```

`window.parent.postMessage` is received by the Viewer and forwarded to webchat.
This only works when the playground is opened inside the Viewer iframe; in a standalone tab, only Copy works.

### State Management Pattern

```javascript
var DEFAULTS = { borderRadius: 8, shadow: 'subtle', color: '#006d77' };
var state = { borderRadius: 8, shadow: 'subtle', color: '#006d77' };

function updateAll() {
  renderPreview();
  updatePrompt();
}

function updatePrompt() {
  var parts = [];
  if (state.borderRadius !== DEFAULTS.borderRadius) {
    parts.push('border-radius ' + state.borderRadius + 'px');
  }
  if (state.shadow !== DEFAULTS.shadow) {
    parts.push(state.shadow === 'strong' ? 'strong shadow' : 'no shadow');
  }
  document.getElementById('promptText').textContent = parts.length
    ? 'Apply the following: ' + parts.join(', ') + '.'
    : 'Using default settings.';
}
```

### Presets

Include 3–5 named presets. Clicking one snaps all controls to a coherent combination.

## 6 Template Types

### Design Explorer

Color palettes, typography preview, layout comparison. Real-time adjustment via sliders/color pickers.
→ Prompt: "Apply border-radius 12px, strong shadow, primary color #006d77 to this component"

### Data Explorer

Table/chart views, filter/sort, CSV paste support. Simple aggregation/statistics display.
→ Prompt: "Write a query filtered by date range 2025-01 to 03, category 'sales'"

### Concept Map

Node/edge diagrams. Drag to arrange, zoom/pan, add/remove nodes. Canvas or SVG based.
→ Prompt: "Organize the Authentication → Session → Token relationships as a diagram"

### Code Map

File tree structure, module dependency visualization. Search/filter, zoom/pan support.
→ Prompt: "Refactor the agent → gateways dependency in the multi-agent module"

### Diff Review

Side-by-side or unified diff comparison. Line-level highlighting, change statistics, comments.
→ Prompt: "Revert changes on lines 42-58 and change the type on line 73 to string"

### Document Critique

Document text analysis, inline annotations, section-level summary/evaluation. Markdown support.
→ Prompt: "Make the requirements in section 3 more specific, remove duplicates in section 5"

## HTML Quality Standards

1. **Self-contained**: No external CDN/resources. All CSS/JS inline.
2. **Responsive**: Supports min-width 320px up to desktop.
3. **Live preview**: Reflects control changes instantly. No "Apply" button.
4. **Prompt output + Send to Chat**: Bottom area with natural-language prompt + Copy + Send to Chat buttons required.
5. **Presets**: 3–5 named presets for a meaningful initial state on first load.
6. **Dark theme**: Dark by default, light toggle available.

## Workflow

1. Identify the playground type from the user's request
2. Define DEFAULTS + PRESETS
3. Build HTML with Control → Preview → Prompt output (Copy + Send to Chat) structure
4. **Always create with `playground_create` tool** (Write tool is forbidden)
5. Share the returned URL with the user

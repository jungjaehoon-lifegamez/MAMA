# MAMA OS - Unified Web Interface

**Category:** Explanation (Conceptual Understanding)  
**Audience:** Users wanting to understand what MAMA OS is and why it exists

---

## What is MAMA OS?

MAMA OS is the **unified web interface** for MAMA Standalone that combines three powerful features into a single, mobile-optimized experience:

1. **Graph Viewer** - Visualize your decision evolution as an interactive network
2. **Mobile Chat** - Chat with Claude Code from any device with voice input and TTS
3. **Memory Management** - Browse, search, and manage your MAMA decisions

Think of it as your **personal AI operating system** - accessible from any browser, optimized for mobile, and designed to keep you connected to your AI assistant wherever you are.

**Access:** `http://localhost:3847/viewer` (when MAMA Standalone server is running)

---

## Why MAMA OS?

### The Problem

Before MAMA OS, you had three separate tools:

- **Graph Viewer** (v1.4) - Desktop-only decision visualization
- **Mobile Chat** (v1.5) - Basic chat interface for remote access
- **MCP Tools** - Command-line only memory management

Each lived in isolation. You couldn't chat while viewing the graph. You couldn't save decisions from mobile. You couldn't see your memory while chatting.

### The Solution

MAMA OS **unifies everything** into a single Progressive Web App (PWA):

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         MAMA OS (Browser)                            │
├──────────────────────────────────────────────────────────────────────┤
│  Dashboard │ Chat │ Memory │ Skills │ Playground │ Log │ Settings   │
│                                                                      │
│  • System status      • Voice input       • Skill management        │
│  • Gateway health     • Real-time chat    • Interactive HTML tools   │
│  • Memory stats       • Decision search   • Real-time daemon logs   │
│  • Agent config       • Graph visual      • Graph visualization     │
└──────────────────────────────────────────────────────────────────────┘
                      ↕ WebSocket
┌─────────────────────────────────────────────────┐
│         MAMA Standalone Server (Node.js)         │
│  • Autonomous agent loop                         │
│  • Gateway integrations (Discord, Slack, etc.)   │
│  • SQLite + vector embeddings                    │
│  • HTTP embedding server (port 3849)             │
└─────────────────────────────────────────────────┘
```

**Key Benefits:**

- ✅ **One URL, everything** - No switching between tools
- ✅ **Mobile-first design** - Works on phone, tablet, desktop
- ✅ **Install as app** - PWA support for offline capability
- ✅ **Real-time sync** - WebSocket keeps everything live
- ✅ **Voice-enabled** - Hands-free interaction with Web Speech API

---

## Architecture Overview

### Client-Server Communication

```
┌──────────────────────────────────────────────────────┐
│                   Browser (Any Device)                │
├──────────────────────────────────────────────────────┤
│                                                        │
│  MAMA OS Viewer (viewer.html)                         │
│  ┌────────────────────────────────────────────────┐  │
│  │  Tab Navigation                                                │  │
│  │  • Dashboard • Chat • Memory • Skills • Playground • Log • Settings │  │
│  └────────────────────────────────────────────────┘  │
│                                                        │
│  JavaScript Modules                                   │
│  ┌─────────────┬─────────────┬─────────────────┐    │
│  │ graph.js    │ chat.js     │ memory.js       │    │
│  │ (vis.js)    │ (WebSocket) │ (Search API)    │    │
│  └─────────────┴─────────────┴─────────────────┘    │
│                                                        │
└──────────────────────────────────────────────────────┘
                      ↕ HTTP/WebSocket
┌──────────────────────────────────────────────────────┐
│         MAMA Standalone Server (localhost:3847)       │
├──────────────────────────────────────────────────────┤
│                                                        │
│  HTTP Server                                          │
│  • /viewer → Static files (HTML, CSS, JS)            │
│  • /api/graph → Decision graph data                  │
│  • /api/search → Semantic search                     │
│  • /api/save → Save decisions                        │
│                                                        │
│  WebSocket Server                                     │
│  • /ws → Real-time chat with Claude Code             │
│  • Streaming responses                                │
│  • Tool execution display                             │
│                                                        │
│  Core Services                                        │
│  • SQLite + sqlite-vec (vector search)               │
│  • Transformers.js (local embeddings)                │
│  • Claude API (autonomous agent)                     │
│  • Gateway integrations (Discord, Slack, etc.)       │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**Key Technologies:**

- **Frontend:** Vanilla JavaScript (ES6 modules), Tailwind CSS, vis.js (graph), marked.js (markdown)
- **Backend:** Node.js, Express, WebSocket, SQLite, Transformers.js
- **Communication:** REST API (HTTP), WebSocket (real-time chat)
- **Deployment:** Single-page app (SPA) with PWA manifest

---

## The Tabs

### 1. Dashboard Tab

**Purpose:** System overview and health monitoring

**What you see:**

- **Gateway Status** - Discord, Slack, Telegram, Chatwork connection health
- **Memory Statistics** - Total decisions, this week's activity, outcome breakdown
- **Agent Configuration** - Current Claude model, max turns, timeout settings
- **Top Topics** - Most frequently used decision topics

**Use case:** Quick health check before starting work. See if your gateways are connected, how many decisions you've saved, and what topics you're focusing on.

---

### 2. Chat Tab

**Purpose:** Real-time conversation with Claude Code from any device

**Features:**

- **WebSocket chat** - Streaming responses with tool execution display
- **Voice input** - Web Speech API with Korean optimization (continuous mode)
- **Text-to-speech** - Adjustable speed (1.8x default for Korean)
- **Hands-free mode** - Auto-listen after TTS completes
- **Slash commands** - `/save`, `/search`, `/checkpoint`, `/resume`, `/help`
- **Auto-checkpoint** - 5-minute idle auto-save
- **Session resume** - Auto-detect resumable sessions with banner UI
- **Long press to copy** - 750ms press on messages (mobile + desktop)

**Voice Input Details:**

- **Language:** Auto-detects browser language (defaults to Korean)
- **Continuous mode:** Keep talking, it keeps listening
- **Interim results:** See text as you speak (real-time feedback)
- **Silence detection:** 2.5 seconds of silence auto-stops recording
- **Multi-alternative:** Uses top 3 recognition candidates for accuracy

**TTS Details:**

- **Auto-play toggle** - Enable/disable automatic reading of assistant responses
- **Adjustable speed** - 1.8x default (optimized for Korean), range 0.5-2.0x
- **Voice selection** - Auto-selects Korean voice if available
- **Hands-free integration** - Auto-starts listening after TTS finishes

**Tool Execution Display:**

When Claude Code uses tools (Read, Write, Bash, etc.), you see real-time cards:

```
┌─────────────────────────────────┐
│ 📄 Read                    ⏳   │
│ config.json                     │
└─────────────────────────────────┘
```

After completion:

```
┌─────────────────────────────────┐
│ 📄 Read                    ✓    │
│ config.json                     │
└─────────────────────────────────┘
```

**Use case:** Chat with Claude Code while away from your desk. Use voice input while cooking, commuting, or relaxing. See exactly what tools Claude is using in real-time.

---

### 3. Memory Tab

**Purpose:** Browse, search, and manage your MAMA decision graph

**Features:**

- **Interactive graph visualization** - vis.js network with physics simulation
- **Checkpoint sidebar** - Always-visible timeline of session checkpoints
- **Semantic search** - Natural language queries across all decisions
- **Filter by topic/outcome** - Narrow down to specific categories
- **3-depth highlighting** - Click a node to see connected decisions (3 levels deep)
- **Detail panel** - View full decision, reasoning, confidence, similar decisions
- **Outcome updates** - Mark decisions as SUCCESS/FAILED/PARTIAL directly from viewer
- **Export** - JSON, Markdown, CSV formats

**Graph Visualization:**

- **Node size** - Larger nodes = more connections (1-2: small, 3-5: medium, 6+: large)
- **Node color** - Each topic gets a unique color from palette
- **Border color** - Outcome status (green: success, red: failed, yellow: partial, gray: pending)
- **Edge types:**
  - `supersedes` - Solid gray line (newer version replaces older)
  - `builds_on` - Dashed blue line (extends prior work)
  - `debates` - Dashed red line (presents alternative view)
  - `synthesizes` - Thick purple line (merges multiple approaches)

**Checkpoint Sidebar:**

- **Always visible** - No need to switch tabs to see session history
- **Click to navigate** - Jump to any checkpoint's related decisions
- **Timestamp display** - See when each checkpoint was created

**Use case:** Understand how your thinking evolved. See which decisions worked (green borders) and which failed (red borders). Find related decisions by clicking nodes. Export your decision history for documentation.

---

### 4. Skills Tab

**Purpose:** Standalone skills management

**What you see:**

- **Skill list** - Card grid of installed skills
- **Enable/Disable** - Toggle individual skills on/off
- **Skill Lab integration** - Create and edit skills interactively via the Skill Lab in the Playground tab

**Use case:** Check which skills are active and disable any that are not needed.

---

### 5. Playground Tab

**Purpose:** Interactive HTML tool management and execution

**Features:**

- **Card grid** - Displays registered Playgrounds as a list
- **iframe load** - Clicking a card loads the Playground HTML in an iframe
- **Open in new tab** - Opens the Playground in a separate browser tab
- **Delete** - Remove Playgrounds that are no longer needed
- **4 built-in Playgrounds** - Wave Visualizer, Skill Lab, Cron Workflow Lab, Log Viewer

**Use case:** Manage and run custom tools created by agents. See the [Playground Guide](../guides/playgrounds.md) for details.

---

### 6. Log Viewer

**Purpose:** Real-time daemon log streaming

**Features:**

- **Live logs** - Stream MAMA OS daemon logs via WebSocket
- **Filtering** - Filter by level (info, warn, error) or module
- **Search** - Full-text search within log entries

**Use case:** Monitor agent behavior in real time and debug issues.

---

### Reasoning Header

When an agent responds in the Chat tab, a **Reasoning Header** is displayed. If tools were used via the Code-Act sandbox, the tool call details appear in the header, providing full transparency into which tools the agent combined and how.

---

### 7. Settings Tab

**Purpose:** Configure gateways, agent, and heartbeat scheduler

**Gateway Connections:**

- **Discord** - Bot token, default channel ID
- **Slack** - Bot token, app token
- **Telegram** - Bot token
- **Chatwork** - API token

**Heartbeat Scheduler:**

- **Enable/disable** - Toggle scheduled heartbeat reports
- **Interval** - Minutes between heartbeats (5-1440)
- **Quiet hours** - Start/end hours for silent period (e.g., 23:00-08:00)

**Agent Configuration:**

- **Model** - Claude Sonnet 4, Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku
- **Max turns** - Maximum conversation turns (1-50)
- **Timeout** - Seconds before timeout (30-600)

**Use case:** Set up your Discord bot, configure quiet hours for heartbeat reports, switch Claude models for different tasks.

---

## Progressive Web App (PWA) Support

MAMA OS is a **Progressive Web App**, meaning you can install it on your phone/tablet like a native app.

### Installation

**On Mobile (iOS/Android):**

1. Open `http://localhost:3847/viewer` in Safari/Chrome
2. Tap the **Share** button (iOS) or **Menu** (Android)
3. Select **"Add to Home Screen"**
4. MAMA OS icon appears on your home screen

**On Desktop (Chrome/Edge):**

1. Open `http://localhost:3847/viewer`
2. Click the **install icon** in the address bar
3. Click **"Install"**
4. MAMA OS opens as a standalone window

### PWA Features

- ✅ **Offline capability** - Static assets cached for offline viewing
- ✅ **App-like experience** - No browser chrome, full-screen mode
- ✅ **Home screen icon** - Quick access like any other app
- ✅ **Splash screen** - Professional loading experience
- ✅ **Mobile-optimized** - 44px touch targets, responsive design

**Manifest:**

```json
{
  "name": "MAMA - Memory-Augmented Assistant",
  "short_name": "MAMA",
  "theme_color": "#0a0a0f",
  "background_color": "#0a0a0f",
  "display": "standalone",
  "icons": [
    { "src": "/viewer/icons/icon-192.png", "sizes": "192x192" },
    { "src": "/viewer/icons/icon-512.png", "sizes": "512x512" }
  ]
}
```

---

## WebSocket Real-Time Communication

MAMA OS uses **WebSocket** for real-time chat with Claude Code. This enables:

### Streaming Responses

Instead of waiting for the full response, you see text **as Claude types**:

```
User: "Explain MAMA OS"
```

# 📱 MAMA on Mobile: Brainstorming & Feasibility

## 🎯 Goal

Enable MAMA (Memory-Augmented MCP Architecture) access and interaction via mobile devices.
"Capture ideas and decisions anywhere, anytime."

## 🚧 Current Architecture Constraints

- **Local MCP Server**: MAMA runs locally on the user's machine (Linux).
- **Storage**: Local SQLite database (`mama.db`).
- **Compute**: Local embedding generation (Transformers.js) and vector search.

## 🧠 Architecture Options

### 1. The "Local Hub" (User's Insight) 🌟

- **Concept**: Your PC is the brain. The phone is just a remote control.
- **Tech**: **Secure Tunneling** (Ngrok, Tailscale, Cloudflare Tunnel).
- **Why it wins**:
  - **Zero Hosting Cost**: No AWS/Vercel bills.
  - **Privacy**: Data stays on your machine.
  - **Power**: Uses your PC's CPU/GPU for embeddings and LLM (Ollama), not a weak mobile chip.
  - **Chat Capability**: Yes! You can talk to the LLM. The web app sends your text/voice to the PC, the PC asks the LLM, and sends the answer back. Your phone is just a "thin client".
- **Workflow**:
  1.  Run `mama-server` on PC.
  2.  Run `ngrok http 3000`.
  3.  Open ngrok URL on phone.
  4.  Use "Quick Add" to send voice/text directly to your PC's DB.

### 2. The "Field Agent" (Async/Offline-First)

- **Concept**: A lightweight mobile app that captures data locally and syncs when back at the desk.
- **Tech**: PWA (Progressive Web App) with local storage.
- **Pros**: Works offline.
- **Cons**: No real-time graph access; sync conflict potential.

### 3. MAMA Cloud (Hosted)

- **Concept**: Move the MAMA server to a private cloud (VPS/Fly.io).
- **Pros**: Always on; accessible from anywhere.
- **Cons**: Privacy concerns (data leaves local machine); hosting costs; complexity of securing the endpoint.

## 💡 Key Mobile Features (The "Why")

### 1. 🎙️ Voice-to-Decision (The "Captain's Log")

- **Scenario**: You are walking and have an idea.
- **Action**: Open app, press big red button, speak.
- **MAMA's Role**: Transcribe -> Extract Topic/Decision -> Save -> Auto-link later.
- _Prototype_: The "Quick Add" feature just added to the Viewer is the MVP of this.

### 2. 🔔 Active Recall / Spaced Repetition

- **Scenario**: MAMA wants to reinforce a memory.
- **Action**: Push notification: "Remember why we chose JWT over OAuth last week?"
- **Benefit**: Keeps the context fresh in the user's (biological) brain.

### 3. 🔍 Quick Graph Lookup

- **Scenario**: In a meeting, need to check a past decision.
- **Action**: Search "auth strategy" -> See the decision card immediately.

## 🚀 Recommended First Step: The "Tunnel Prototype"

Since MAMA already serves a Graph Viewer (`/viewer`), let's just expose it.

1.  **Make Viewer Responsive**: Ensure the graph and forms look good on mobile.
2.  **Tunnel It**: Use `ngrok` to get a public URL.
3.  **Test It**: Try adding a decision from your phone while walking around the room.

## 📝 Discussion Points

- Do we need full graph _visualization_ on mobile, or just _capture_ and _search_?
- Is "Offline" a hard requirement?
- How much "intelligence" (embeddings) needs to run on the phone vs. the server?

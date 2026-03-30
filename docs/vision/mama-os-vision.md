# MAMA OS — Vision Document

## Your Memory, Your Device, Your Life

MAMA OS is a local AI runtime that remembers your digital life. It connects the apps you use, remembers what matters, tracks how things evolve, and works for you — on your device, under your control.

## The Problem

Every AI today has amnesia.

You tell Claude about a decision on Monday. On Tuesday, it asks you the same question. You explain your project to GPT in January. In February, it has no idea. These are brilliant minds that forget everything the moment you close the window.

This makes AI a tool. A very good tool, but still something you pick up and put down. Not a partner. Not something that grows with you.

Meanwhile, your digital life is scattered across dozens of apps. Kakao messages, Slack threads, Google Calendar events, GitHub PRs, emails, documents. Each app knows a fragment. None of them talk to each other. And none of them remember the connections between fragments.

You are the only one holding the full picture. That is exhausting.

## The Insight

LLMs are getting better at something remarkable: making sense of chaos.

We discovered this while building Kagemusha, a team task intelligence agent that monitors KakaoTalk, LINE, Slack, Chatwork, and Telegram simultaneously. Five messaging channels, dozens of conversations, hundreds of messages per day.

What we found: as LLM capability improves, the AI stops being confused by the noise. It can read 50 messages across 5 channels and tell you: "Client A requested a logo revision on Kakao. Designer Kim said Wednesday. This is the third revision — the previous two took 3 days each. You might want to flag the timeline."

That is not search. That is not summarization. That is **understanding with context**.

And context comes from memory.

## Why Memory Changes Everything

| Without Memory | With Memory |
|---------------|-------------|
| "Here are 3 auth options" | "Last month you chose JWT. Here's why, and what changed since" |
| "Your calendar is free Wednesday" | "Client A meetings usually run 1 hour. Last time 3 issues were unresolved. Here's a suggested agenda" |
| "Here's how transformers work" | "You learned CNNs 2 months ago. Transformers build on the same matrix operations you already understand" |
| Tool you use | Partner that grows with you |

Memory enables three things no memoryless AI can do:

1. **Continuity** — conversations that span days, weeks, months. Decisions that evolve. Projects that progress.

2. **Pattern Recognition** — "You always underestimate design review time." "Client A's feedback cycle takes exactly one week." "Your best writing happens between 10pm and 1am."

3. **Anticipation** — not just answering questions, but knowing what you need before you ask. Because it has seen your patterns, your calendar, your messages, and your history.

## Why Local

Your AI's memory contains the most intimate details of your digital life: your decisions and the reasoning behind them, your mistakes, your work patterns, your relationships, your health observations, your creative process.

This cannot live on someone else's server.

| Cloud Memory | Local Memory |
|-------------|-------------|
| Owned by a corporation | Owned by you |
| Accessible to unknown parties | Accessible only to you |
| Deleted when service shuts down | Persists as long as you want |
| Locked to one AI provider | Works with any AI |
| Trained on by the provider (maybe) | Never leaves your device |

Local memory means **AI provider independence**. Today you use Claude. Tomorrow you might use GPT. Your memory — three years of decisions, patterns, and context — stays with you. No other service offers this.

Local memory means **data sovereignty**. Your health patterns, your financial decisions, your team dynamics, your personal reflections — these are yours. Period.

## How It Works

MAMA OS does not try to be every app. It does not replace your calendar, your messenger, or your task manager. Instead, it provides three things:

### 1. Memory Engine (mama-core)

A local graph database that stores structured facts extracted from your digital life.

Not raw data dumps. Structured knowledge:
- **Facts**: "Client A requested logo revision on March 15"
- **Decisions**: "Chose JWT over session tokens because of mobile support"
- **Evolution**: First draft → client feedback → revision → final approval
- **Patterns**: "Design reviews average 3 days for this client"

Each fact has: topic, scope, timestamp, confidence, and relationships (supersedes, builds_on, debates).

### 2. Always-On Runtime

A daemon that runs on your device, continuously:
- Receiving data from connected apps
- Extracting and structuring facts
- Tracking evolution chains
- Responding to queries
- Sending notifications when something needs attention

This is what Claude Desktop cannot do. Claude waits for you to ask. MAMA OS watches, learns, and acts.

### 3. App Ecosystem (Managed Apps)

Applications that connect to specific data sources and feed structured facts to mama-core:

```
MAMA OS Runtime
  mama-core (memory engine)
       ^           ^           ^           ^
   Kagemusha    Calendar    GitHub Bot   Mail Bot
   (messengers)  (schedule)  (code)      (email)
```

Each app:
- Registers via AppManifest (name, capabilities, health endpoint)
- Managed by MAMA OS supervisor (start/stop/restart/health)
- Saves facts to mama-core with per-app scopes
- Searches mama-core for cross-app context

Apps do not talk to each other directly. They communicate through shared memory. This is simpler, more resilient, and more powerful than direct integration.

## Cross-App Intelligence

Single-app memory is useful. Cross-app memory is transformative.

**Messenger + Calendar:**
"Kakao message says client wants to meet this week. Your calendar shows Wednesday 2pm is open. Previous meetings with this client lasted 1 hour and always generated 3-4 action items. Shall I block 2 hours and prepare an agenda from last meeting's unresolved items?"

**Messenger + Code + Task:**
"Slack thread shows the auth bug is urgent. GitHub has a related PR from last week that was never merged. The developer said on Kakao yesterday they'd fix it today. No commit yet. Want me to follow up?"

**Calendar + Health + Patterns:**
"You have 6 meetings tomorrow, but this week your sleep has averaged 5 hours. Last time this happened, you cancelled the Friday demo and rescheduled. Want me to move the non-critical meetings?"

No single app can produce these insights. Only connected memory can.

## Who This Is For

**Phase 1 — Developers and Tech Teams (now)**
- Claude Code users who want persistent project memory
- Teams using multiple messengers (Kakao + Slack + Chatwork)
- Anyone tired of explaining the same context to AI every session

**Phase 2 — Knowledge Workers**
- Project managers tracking decisions across tools
- Writers and creators maintaining creative continuity
- Researchers accumulating knowledge over months

**Phase 3 — Everyone**
- Personal health tracking (local, private, never uploaded)
- Family coordination (shared local memory)
- Life management (the AI assistant that actually knows your life)

## What We Have Proven

1. **Memory quality works.** MemoryBench achieved 100% accuracy on 10 LongMemEval questions across all types (multi-session, temporal reasoning, knowledge updates). mama-core can accurately recall and reason about facts extracted from conversations.

2. **Multi-channel monitoring works.** Kagemusha monitors 5 messaging platforms simultaneously and produces actionable summaries. LLMs handle the complexity without confusion.

3. **Local-first works.** 384-dimensional embeddings run locally via Transformers.js. SQLite with cosine similarity handles thousands of decisions. No API calls needed for memory operations.

4. **The app platform pattern works.** Kagemusha runs as a Managed App with AppManifest registration, health checks, and mama-core integration. The supervisor pattern is proven.

## Architecture

```
MAMA OS v1.0

  Core Layer:
    mama-core         Memory engine (graph, embeddings, search, evolution)
    mama-runtime      Always-on daemon (events, cron, process management)
    mama-gateways     Messenger adapters (Discord, Slack, Telegram)
    platform-core     App contracts (manifest, supervisor, registry)

  Control Tower:
    Event stream      What is happening right now
    Memory explorer   What has been learned
    App health        Is everything running
    Security log      Is everything safe

  Managed Apps:
    Kagemusha         Team channel monitoring (Kakao, LINE, Slack, Chatwork, Telegram)
    (future)          Calendar intelligence
    (future)          Code review context
    (future)          Email triage
    (future)          Document memory
```

## Principles

1. **Local first.** Your memory never leaves your device unless you explicitly choose to share it.

2. **AI agnostic.** mama-core works with Claude, GPT, Gemini, or any future model. Your memory outlives any AI service.

3. **Apps collect, MAMA remembers.** Apps are specialists (messengers, calendar, code). MAMA OS is the memory that connects them.

4. **Evolution over snapshots.** We do not just store facts. We track how facts change: first draft → revision → final. Decision → reconsideration → new decision.

5. **Transparency.** You can always see what MAMA knows, why it knows it, and where it came from. No black box memory.

6. **Silence is golden.** MAMA OS does not interrupt unless something genuinely needs your attention. It watches, learns, and waits until you ask — or until something truly matters.

## The One-Line Vision

**MAMA OS: your digital life, remembered locally, connected intelligently, always yours.**

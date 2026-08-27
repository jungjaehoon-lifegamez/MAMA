# MAMA Documentation

**MAMA OS:** The work agent behind your messenger
**Navigation Hub**

> One accountable MAMA remembers the Case, does authorized work, and returns verified artifacts.

The contract-first memory plugin remains a core substrate: it tracks why a decision was made and
prevents later coding sessions from silently breaking that reasoning.

MAMA exposes one accountable work agent through existing messengers. A human team can submit
requests and files, continue scoped Cases, and receive verified artifacts without selecting or
coordinating named AI personas. Current releases are owner-first; the complete human-team grant
and Work Case contract is the v1 direction.

## ✨ Key Strengths

- **Contract-first coding:** PreToolUse searches contracts before edits and blocks guessing when none exist.
- **Grounded reasoning:** Reasoning Summary is derived from actual matches (unknowns are explicit).
- **Task-scoped context:** Context Compile turns broad evidence into selected/rejected/missing
  packets with trusted `context_packet_id` provenance.
- **Persistence across sessions:** Contracts saved in MCP prevent schema drift over time.
- **Low-noise guidance:** Per-session long/short output reduces repetition.
- **Safer outputs:** Prompt-sanitized contract injection reduces prompt-injection risk.

## Quick Links

- **[Main README](../README.md)** - Quick overview, installation, and key features
- **[Work Agent](explanation/work-agent.md)** - Product identity, human team, Cases, and artifacts
- **[Normative v1 Design](development/2026-08-26-one-front-team-work-agent-design.md)** - One-front team work-agent contract and roadmap boundary
- **[Phase 2b Access Plan](development/2026-08-26-phase2b-human-team-access-plan.md)** - Human principal grants and effective-scope implementation plan
- **[GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)** - Source code and issues

---

## Documentation Structure

This documentation follows the [Diátaxis framework](https://diataxis.fr/) for clarity and ease of navigation:

### 📚 [Tutorials](tutorials/) - Learning-Oriented

_Step-by-step lessons for beginners_

- [Getting Started](tutorials/getting-started.md) - First-time setup and basic usage
- [First Decision](tutorials/first-decision.md) - Save and search your first decision
- [Understanding Tiers](tutorials/understanding-tiers.md) - Tier system explained
- [Hook Setup](tutorials/hook-setup.md) - Configure automatic context injection

### 🛠️ [Guides](guides/) - Task-Oriented

_Step-by-step instructions for specific tasks_

- [Installation Guide](guides/installation.md) - Complete installation process
- [Standalone Setup](guides/standalone-setup.md) - Set up always-on AI agent
- [Gateway Configuration](guides/gateway-config.md) - Configure Discord, Slack, Telegram bots
- [Mobile Access](guides/mobile-access.md) - Reach the Viewer from any device
- [Webchat Media](guides/webchat-media.md) - Image upload, TTS/STT voice features
- [Troubleshooting](guides/troubleshooting.md) - Common issues and solutions
- [Standalone Troubleshooting](guides/standalone-troubleshooting.md) - Fix standalone agent issues
- [Tier 2 Remediation](guides/tier-2-remediation.md) - Fix degraded tier issues
- [Configuration](guides/configuration.md) - Configuration options and setup
- [Performance Tuning](guides/performance-tuning.md) - Optimize MAMA performance
- [Codex Backend](guides/codex-backend.md) - Codex app-server setup and managed runtime behavior
- [Cline Backend](guides/cline-backend.md) - Cline CLI and DeepSeek backend setup
- [Internal Worker Orchestration](guides/multi-agent-advanced.md) - Advanced/legacy worker and persona configuration; not the v1 team model
- [Code-Act Sandbox](guides/code-act-sandbox.md) - QuickJS/WASM isolated code execution

### 📖 [Reference](reference/) - Information-Oriented

_Technical specifications and API documentation_

- [Commands Reference](reference/commands.md) - `/mama-*` commands
- [MCP Tool API](reference/api.md) - MCP tool interfaces
- [Hooks Reference](reference/hooks.md) - Hook configuration
- [Configuration Options](reference/configuration-options.md) - All config settings

### 💡 [Explanation](explanation/) - Understanding-Oriented

_Conceptual explanations and design decisions_

- [Architecture](explanation/architecture.md) - System architecture overview
- [MAMA OS](explanation/mama-os.md) - The built-in Viewer: Operator, Knowledge, System
- [Work Agent](explanation/work-agent.md) - Why MAMA has one front, scoped Cases, and domain capabilities
- [Tier System](explanation/tier-system.md) - Tier system design and philosophy
- [Decision Graph](explanation/decision-graph.md) - Decision evolution tracking
- [Semantic Search](explanation/semantic-search.md) - How semantic search works
- [Data Privacy](explanation/data-privacy.md) - Privacy-first design principles
- [Performance](explanation/performance.md) - Performance characteristics

### 👨‍💻 [Development](development/) - For Contributors

_Contributing, testing, and development guidelines_

- [Contributing Guide](development/contributing.md) - How to contribute
- [Developer Playbook](development/developer-playbook.md) - Architecture and coding standards
- [Testing Guide](development/testing.md) - Test suite and testing practices
- [Code Standards](development/code-standards.md) - Coding conventions
- [Release Process](development/release-process.md) - How releases are created

---

## User Journeys

### 🆕 I'm a New User

1. Start with [Getting Started Tutorial](tutorials/getting-started.md)
2. Save your [First Decision](tutorials/first-decision.md)
3. Learn about [Tier System](tutorials/understanding-tiers.md)
4. Optional: Set up [Always-On Context](tutorials/hook-setup.md)

### 🔧 I Need to Fix Something

1. Check [Troubleshooting Guide](guides/troubleshooting.md)
2. For Tier 2 issues: [Tier 2 Remediation](guides/tier-2-remediation.md)
3. Review [Configuration Guide](guides/configuration.md)

### 📚 I Want to Understand How It Works

1. Read [Architecture Explanation](explanation/architecture.md)
2. Understand [Decision Graph](explanation/decision-graph.md) concept
3. Learn about [Semantic Search](explanation/semantic-search.md)
4. Review [Data Privacy](explanation/data-privacy.md) principles

### 👩‍💻 I Want to Contribute

1. Read [Contributing Guide](development/contributing.md)
2. Study [Developer Playbook](development/developer-playbook.md)
3. Review [Code Standards](development/code-standards.md)
4. Check [Testing Guide](development/testing.md)

### 🤖 I Want to Run an Always-On AI Agent

1. Read [MAMA OS Explanation](explanation/mama-os.md)
2. Follow [Standalone Setup Guide](guides/standalone-setup.md)
3. Configure [Gateway Integrations](guides/gateway-config.md)
4. Troubleshoot with [Standalone Troubleshooting](guides/standalone-troubleshooting.md)

### 🧪 I Need Internal Workers or Scheduled Work

1. Read [Internal Worker Orchestration](guides/multi-agent-advanced.md) - advanced/legacy process and tool-tier behavior
2. Set up [Codex Backend](guides/codex-backend.md) for the runtime backend
3. Learn about [Code-Act Sandbox](guides/code-act-sandbox.md) for bounded domain composition
4. Understand the workorder pipeline in [Architecture](explanation/architecture.md) - it runs
   scheduled board, wiki and memory work

### 🛠️ I Need to Operate a Live Install

- [Entity Substrate Runbook](operations/entity-substrate-runbook.md)
- [Channel Key Backfill](operations/channel-key-backfill.md) - repairing channels stored under
  a display name instead of their upstream id

### 📖 I Need API/Command Reference

- [Commands Reference](reference/commands.md) - All `/mama-*` commands
- [MCP Tool API](reference/api.md) - Tool interfaces
- [Configuration Options](reference/configuration-options.md) - All settings

---

## Support

- **Issues:** [GitHub Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- **Discussions:** [GitHub Discussions](https://github.com/jungjaehoon-lifegamez/MAMA/discussions)
- **Documentation:** You're here!

---

**Status:** MAMA OS v0.39.3 — Claude CLI, Codex app-server, and Cline Hub are equivalent supported
backends with backend-owned durable context, role-scoped Code-Act projection, bounded recovery,
and explicit non-replayable mutation outcomes. MAMA itself owns connector-event work as
stateless fresh runs per batch on durable per-channel lane keys; configured private connectors
remain installation-local and are never promoted into generic catalogs or prompts. Verified human
members are the Phase 2b release candidate: one host-computed read scope per turn, limited to their
private memory and explicit owner grants across Telegram, Slack, and Discord. Installation, restart
validation, and a real human-member canary remain before that candidate is called shipped.
**Last Updated:** 2026-08-27

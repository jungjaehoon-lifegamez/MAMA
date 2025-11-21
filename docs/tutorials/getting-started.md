# Getting Started with MAMA

**Audience:** First-time users
**Duration:** 10-15 minutes
**Goal:** Complete your first decision save and verify MAMA is working

---

## Prerequisites

Before starting this tutorial, ensure you have:
- ✅ Node.js >= 18.0.0 installed
- ✅ Claude Code (latest version) installed
- ✅ MAMA plugin installed (see [Installation Guide](../guides/installation.md))
- ✅ Claude Code restarted after installation

---

## Step 1: Verify Installation ✅

After installing and restarting Claude Code:

```bash
# Check if plugin loaded successfully
# You should see MAMA commands in Claude Code's command palette
```

**Expected:** Commands `/mama-*` appear when you type `/mama`

**If you have issues:** See [Troubleshooting Guide](../guides/troubleshooting.md)

---

## Step 2: First Decision Save 💾

Try saving your first decision:

```
You: /mama-save

Claude will ask:
- Topic (e.g., "project_architecture")
- Decision (what you decided)
- Reasoning (why you decided this)
- Confidence (0.0-1.0, default 0.5)
```

**Example:**
```
Topic: test_framework
Decision: Use Vitest for testing
Reasoning: Better ESM support than Jest, already configured in project
Confidence: 0.9
```

**On success:** You'll see `✅ Decision saved successfully (ID: decision_...)` message

---

## Step 3: Verify Tier Detection 🎯

After first save, check what tier you're running:

```
You: /mama-list

Expected output shows tier badge:
🔍 System Status: 🟢 Tier 1 (Full Features Active)
```

**Tier Meanings:**
- **🟢 Tier 1**: Full vector search + semantic matching (80% accuracy)
- **🟡 Tier 2**: Fallback exact match only (40% accuracy)

**If Tier 2 detected:** See [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)

---

## Step 4: Test Automatic Context 🤖

MAMA automatically injects context when relevant:

```
You: "How should I handle testing?"

Expected: Before Claude responds, you'll see:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • test_framework (90%, just now)
   /mama-recall test_framework for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**How it works:**
- UserPromptSubmit hook → Semantic search → Gentle hints (not walls of text)
- Privacy guarantee: 100% local, no network calls ([FR45-49](../reference/fr-mapping.md))

**Learn more:** [Hook Setup Tutorial](hook-setup.md)

---

## Step 5: Explore Commands 📚

```bash
# See decision evolution (supersedes chain)
/mama-recall test_framework

# Semantic search across all topics
/mama-suggest "which library should I use?"

# List recent decisions (default 10)
/mama-list

# List 20 recent decisions
/mama-list --limit 20
```

**Ready to use!** 🎉 MAMA is now tracking your decision evolution.

---

## Next Steps

Now that you've verified MAMA is working:

1. **Learn the commands:** [Commands Reference](../reference/commands.md)
2. **Save more decisions:** [First Decision Tutorial](first-decision.md)
3. **Understand tiers:** [Understanding Tiers Tutorial](understanding-tiers.md)
4. **Configure hooks:** [Hook Setup Tutorial](hook-setup.md)

---

## Troubleshooting

**Commands not appearing:**
- Ensure plugin is in `~/.claude/plugins/mama/`
- Check `.claude-plugin/plugin.json` exists
- Restart Claude Code

**Tier 2 detected:**
- Follow [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)

**Database errors:**
- See [Troubleshooting Guide](../guides/troubleshooting.md#database-issues)

---

**Related:**
- [Installation Guide](../guides/installation.md)
- [Configuration Guide](../guides/configuration.md)
- [Commands Reference](../reference/commands.md)

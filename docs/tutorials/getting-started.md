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

**문제 발생 시** (If issues): See [Troubleshooting Guide](../guides/troubleshooting.md)

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

**Korean Example / 한국어 예시:**
```
Topic: 테스트_프레임워크
Decision: Vitest 사용하기로 결정
Reasoning: Jest보다 ESM 지원이 좋고, 프로젝트에 이미 설정되어 있음
Confidence: 0.9
```

**첫 저장 성공 시**: `✅ Decision saved successfully (ID: decision_...)` 메시지 확인

---

## Step 3: Verify Tier Detection 🎯

After first save, check what tier you're running:

```
You: /mama-list

Expected output shows tier badge:
🔍 System Status: 🟢 Tier 1 (Full Features Active)
```

**Tier Meanings / 티어 의미:**
- **🟢 Tier 1**: Full vector search + semantic matching (80% accuracy)
- **🟡 Tier 2**: Fallback exact match only (40% accuracy)

**Tier 2인 경우**: See [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)

---

## Step 4: Test Automatic Context 🤖

MAMA automatically injects context when relevant:

```
You: "How should I handle testing?"

Expected: Before Claude responds, you'll see:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • 테스트_프레임워크 (90%, just now)
   /mama-recall 테스트_프레임워크 for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**자동 컨텍스트 원리** (How it works):
- UserPromptSubmit hook → Semantic search → Gentle hints (not walls of text)
- Privacy guarantee: 100% local, no network calls ([FR45-49](../reference/fr-mapping.md))

**Learn more:** [Hook Setup Tutorial](hook-setup.md)

---

## Step 5: Explore Commands 📚

```bash
# See decision evolution (supersedes chain)
/mama-recall 테스트_프레임워크

# Semantic search across all topics
/mama-suggest "어떤 라이브러리를 써야 할까?"

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

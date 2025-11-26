# Memory System Auto-Extraction Implementation Guide

## Core Insight

**Auto-extraction** is the most challenging and important part of a memory system.

```
Embedding model: Text → Vector (for search)
Extraction model: Long conversation → Key information (for understanding)
```

- **Good embedding model** → Accurate search
- **Good extraction model** → Meaningful data to store

---

## Anthropic's Approach (Speculation)

How Claude's memory system likely works:

```
[End of conversation]
     ↓
[Background LLM call]
     ↓
Prompt: "Extract memorable information about the user from this conversation:
- Occupation/Projects
- Interests/Preferences
- Ongoing work
- Important decisions
- Information requiring context"
     ↓
[Return structured data]
     ↓
[Merge/Update with existing memory]
```

**Key point:** LLM performs the extraction directly.
Not a specialized model—**Claude analyzes its own conversations**

### Speed Breakdown

```
1. Memory search: 10-50ms (Vector DB)
2. LLM inference: 500-2000ms (model processing)
3. Response generation: immediate via streaming

Total time: mostly LLM inference
Memory search is negligible
```

**Anthropic's advantages:**

- Embedding server resident in memory
- Optimized vector DB (likely custom-built)
- Solved through infrastructure scale

---

## 4 Methods Individuals Can Implement

### Method 1: Full LLM-Based Auto-Extraction

**Simplest but incurs cost**

```typescript
// Can be added to MAMA
async function autoExtractFromChat(chatHistory: Message[]) {
  const prompt = `
Extract information from the following conversation that would be useful for future collaboration.

Conversation:
${chatHistory.map((m) => `${m.role}: ${m.content}`).join('\n')}

Return in the following JSON format:
{
  "decisions": [
    {
      "topic": "...",
      "decision": "...",
      "reasoning": "...",
      "confidence": 0.8
    }
  ],
  "context": {
    "project_updates": "...",
    "open_questions": "...",
    "next_steps": "..."
  }
}
`;

  const result = await callClaude(prompt);
  return JSON.parse(result);
}

// Auto-call at session end
await autoExtractFromChat(currentSession);
// → Auto-save to MAMA
```

**Pros:**

- Simple implementation
- Works with Claude API
- High quality

**Cons:**

- API cost (~$0.01-0.05 per conversation)
- Speed (2-5 seconds)

---

### Method 2: Semi-automatic (Most Realistic)

**User marks important moments - ChatGPT "memory" style**

```typescript
// Natural language save command
User: "Remember: SpineLift MCP applies MAMA engine to bone mapping"

Claude:
"Save this?
- Topic: spinelift_mcp
- Decision: Apply MAMA engine to bone mapping domain
- Reasoning: Reuse CoT few-shot + semantic search pattern

[Confirm/Edit]"
```

**Implementation example:**

```typescript
// mama-nlp-save.ts
async function naturalLanguageSave(userMessage: string) {
  // Detect "remember:", "save:", etc.
  const savePattern = /(remember|save|store)[:：]\s*(.+)/i;
  const match = userMessage.match(savePattern);

  if (!match) return null;

  const content = match[2];

  // Structure with LLM
  const structured = await callLLM(`
Structure the following content into decision format:
"${content}"

Return JSON:
{
  "topic": "...",
  "decision": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0
}
`);

  // User confirmation
  return {
    ...structured,
    needsConfirmation: true,
  };
}
```

**Pros:**

- User determines importance
- Quality guaranteed
- Low cost (selective calls)

**Cons:**

- Manual intervention required
- Can miss things

---

### Method 3: Progressive Automation (⭐ Recommended)

**Pattern detection + Selective LLM extraction**

```typescript
// Step 1: Pattern detection (rule-based - free)
function detectDecisionPatterns(messages: Message[]) {
  const patterns = {
    decision: /decided to|made a decision|chose to|selected/i,
    change: /changed from.*to|switched|modified/i,
    failure: /failed because|didn't work|broke/i,
    insight: /learned that|realized|discovered/i,
    comparison: /better than|worse than|preferred over/i,
  };

  const candidates = [];

  for (const msg of messages) {
    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(msg.content)) {
        candidates.push({
          message: msg,
          type: type,
          excerpt: extractContext(msg.content, pattern),
        });
      }
    }
  }

  return candidates;
}

// Step 2: LLM extraction (only for detected - cost efficient)
const candidates = detectDecisionPatterns(chatHistory);

for (const candidate of candidates) {
  const extraction = await extractDecision(candidate);

  if (extraction.confidence > 0.8) {
    // Auto-save
    await mama.save(extraction);
  } else {
    // Request user confirmation
    suggestForReview(extraction);
  }
}
```

**Full implementation:**

```typescript
// mama-auto-extract.ts

export class AutoExtractor {
  private patterns = {
    decision: /decided|chose|selected/i,
    failure: /failed|broke|didn't work/i,
    insight: /learned|realized|discovered/i,
    change: /changed|switched|modified/i,
  };

  async analyzeSession(messages: Message[]) {
    // 1. Find candidates via pattern matching
    const candidates = this.findCandidates(messages);

    // 2. Structure with LLM
    const extractions = await Promise.all(candidates.map((c) => this.extractStructured(c)));

    // 3. Remove duplicates
    const deduplicated = await this.removeDuplicates(extractions);

    // 4. Classify by confidence
    return {
      auto: deduplicated.filter((e) => e.confidence > 0.8),
      review: deduplicated.filter((e) => e.confidence <= 0.8),
    };
  }

  private findCandidates(messages: Message[]) {
    return messages.filter((m) => Object.values(this.patterns).some((p) => p.test(m.content)));
  }

  private async extractStructured(message: Message) {
    const prompt = `
Extract decision/insight from this message:
"${message.content}"

Return JSON:
{
  "type": "decision|insight|change|failure",
  "topic": "...",
  "summary": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0
}

Confidence criteria:
- 0.9+: Clear decision/insight
- 0.7-0.9: Important but needs confirmation
- Below 0.7: Ambiguous
`;

    return await callLLM(prompt);
  }

  private async removeDuplicates(extractions: Extraction[]) {
    const unique = [];

    for (const ext of extractions) {
      // Check similarity with existing memory
      const similar = await mama.suggest_decision(ext.summary);

      if (similar.length === 0 || similar[0].score < 0.9) {
        unique.push(ext);
      } else {
        // Suggest update
        ext.suggestedAction = 'update_existing';
        ext.existingId = similar[0].id;
        unique.push(ext);
      }
    }

    return unique;
  }
}
```

**Usage example:**

```typescript
// At session end
const extractor = new AutoExtractor();
const results = await extractor.analyzeSession(chatHistory);

// High confidence → Auto-save
console.log(`Auto-saved: ${results.auto.length} items`);
for (const item of results.auto) {
  await mama.save(item);
}

// Low confidence → User confirmation
console.log(`Needs review: ${results.review.length} items`);
for (const item of results.review) {
  await requestUserConfirmation(item);
}
```

**Pros:**

- Cost efficient (only process subset with LLM, not entire conversation)
- Doesn't miss important things
- Maintains quality
- Can progressively improve patterns

**Cons:**

- Pattern maintenance required
- Initial setup time needed

---

### Method 4: Duplicate Detection System

**Check for similar entries before saving**

```typescript
async function checkDuplicate(newDecision: Decision) {
  const similar = await mama.suggest_decision(newDecision.decision);

  if (similar.length > 0 && similar[0].score > 0.9) {
    // Similar entry exists
    return {
      isDuplicate: true,
      existing: similar[0],
      suggestion: determineSuggestion(newDecision, similar[0]),
    };
  }

  return { isDuplicate: false };
}

function determineSuggestion(newDec: Decision, existing: Decision) {
  // Compare timestamps
  const isNewer = newDec.timestamp > existing.timestamp;

  // Compare content
  const hasNewInfo = containsNewInformation(newDec, existing);

  if (isNewer && hasNewInfo) {
    return 'supersede'; // New decision replaces previous
  } else if (hasNewInfo) {
    return 'update'; // Add info to existing decision
  } else {
    return 'skip'; // Duplicate, don't save
  }
}
```

**Integrated workflow:**

```typescript
async function smartSave(decision: Decision) {
  // 1. Check for duplicates
  const dupCheck = await checkDuplicate(decision);

  if (dupCheck.isDuplicate) {
    switch (dupCheck.suggestion) {
      case 'supersede':
        await mama.save({
          ...decision,
          supersedes: dupCheck.existing.id,
        });
        break;

      case 'update':
        await mama.update({
          id: dupCheck.existing.id,
          additionalInfo: decision.reasoning,
        });
        break;

      case 'skip':
        console.log('This content is already saved.');
        return;
    }
  } else {
    // Save as new
    await mama.save(decision);
  }
}
```

**Pros:**

- Prevents duplicate saves
- Memory efficient
- Auto-creates supersede relationships

---

## Embedding vs Extraction Difference

### Embedding's Role: Search

```
Save:
"SpineLift MCP reuses the MAMA engine"
     ↓
[Embedding model] → [0.123, -0.456, 0.789, ...]
     ↓
[Store in Vector DB]

Search:
"How does bone mapping work?"
     ↓
[Embedding model] → [0.145, -0.423, 0.801, ...]
     ↓
[Similarity calculation] → Return SpineLift-related decision
```

**Good embedding models:**

- `text-embedding-3-large` (OpenAI) ⭐ Currently used by MAMA
- `voyage-02` (Voyage AI)
- `bge-large` (Open source)

**MAMA performance:** 84% accuracy (already quite good)

### Extraction's Role: Understanding Meaning

```
Long conversation:
"First we tried rule-based and failed as cases multiplied,
then we tried simple embedding but couldn't explain why mappings occurred.
Eventually we went with storing experience and reasoning."
     ↓
[Extraction LLM]
     ↓
{
  topic: "spinelift_architecture_evolution",
  decision: "Adopted reasoning-based mapping system",
  reasoning: "Rule-based had scalability issues, simple embedding couldn't explain.
              Storing experience + reasoning was the solution",
  failures: ["Rule-based scalability", "Embedding explanation inability"],
  confidence: 0.95
}
```

**Key difference:**

- Embedding: Converts existing text to vectors
- Extraction: Finds meaningful content from conversation and structures it

---

## Cost Calculation

### Full LLM Auto-Extraction

```
Input tokens per conversation: ~5,000
Extraction output tokens: ~1,000
Cost (Claude Haiku): $0.03/conversation

Monthly usage:
- 100 conversations → $3
- 1,000 conversations → $30
```

### Pattern-Based + Selective LLM (Recommended)

```
Pattern detection: Free (rule-based)
LLM calls: Only 30% of conversations (when patterns detected)
Cost: $0.01/conversation

Monthly usage:
- 100 conversations → $1
- 1,000 conversations → $10
```

**Affordable for personal use**

---

## MAMA Roadmap

### MAMA v1.1 (Current)

```typescript
// Manual save
await mama.save({
  type: 'decision',
  topic: '...',
  decision: '...',
  reasoning: '...',
});
```

**Features:**

- Explicit `mama:save` call
- User structures directly
- 100% accuracy, zero cost

---

### MAMA v1.2 (Next Step)

```typescript
// Natural language save
User: "Remember: SpineLift MCP reuses MAMA engine"

Claude: [Auto-structure]
"Save this?
- Topic: spinelift_mcp
- Decision: ...
[Confirm/Edit]"

// Pattern-based suggestion
Claude: "It seems like there was an important decision in this conversation. Save it?"
User: "Yes, save it"
```

**Additional features:**

- `mama:suggest-extraction` tool
- Natural language save command recognition
- Real-time suggestions during conversation

**Implementation:**

```typescript
// mama-tools-v1.2.ts

{
  name: "mama:suggest_extraction",
  description: "Suggest savable decisions/insights from current conversation",
  inputSchema: {
    threshold: "confidence threshold (default: 0.7)"
  }
}
```

---

### MAMA v2.0 (Future)

```typescript
// Fully automatic extraction
At session end:
     ↓
Auto-analyze (background)
     ↓
High confidence (0.8+) → Auto-save
     ↓
Low confidence (0.5-0.8) → Request confirmation at next session start
```

**Workflow:**

```
[Chat ends]
     ↓
[Background analysis]
     ↓
Pattern detection → Candidates found in 30% of messages
     ↓
LLM extraction → Structure + confidence calculation
     ↓
High confidence:
  - Auto-save
  - Notification: "3 decisions saved"

Low confidence:
  - Add to queue
  - Next session: "2 suggestions from last conversation"
```

**Additional features:**

- Background processing
- Smart deduplication
- Auto-infer supersede relationships
- Periodic memory cleanup

---

## Practical Implementation Tips

### 1. Start Simple

```typescript
// Step 1: Add natural language save only
if (message.includes('remember:')) {
  const content = extractAfterKeyword(message, 'remember:');
  await naturalLanguageSave(content);
}
```

### 2. Add Patterns Progressively

```typescript
// Start with clear patterns only
const patterns = [/decided to/, /chose to/];

// Expand gradually
patterns.push(/changed/, /failed/, /learned/);
```

### 3. Adjust Confidence

```typescript
// Initially conservative
const AUTO_SAVE_THRESHOLD = 0.9; // Only when very certain

// Adjust with usage
const AUTO_SAVE_THRESHOLD = 0.8; // After confirming accuracy
```

### 4. Monitor Costs

```typescript
// Track extraction costs
let extractionCost = 0;

async function trackedExtraction(content: string) {
  const tokens = estimateTokens(content);
  const cost = calculateCost(tokens);
  extractionCost += cost;

  return await extract(content);
}

// Periodic report
console.log(`Extraction cost this month: $${extractionCost}`);
```

---

## Conclusion

**Individuals can absolutely implement this!**

### Recommended Order:

1. **v1.2 Natural Language Save** (1-2 days)
   - "Remember:" keyword recognition
   - LLM structuring
   - User confirmation

2. **Pattern Detection** (3-5 days)
   - Define basic patterns
   - Extract candidates
   - Calculate confidence

3. **Duplicate Prevention** (2-3 days)
   - Similarity check
   - Auto supersede

4. **Background Processing** (1 week)
   - Analyze at session end
   - Suggest in next session

### Core Principles:

- **Practicality over Perfection**
  - Don't aim for Anthropic's 100% automation
  - Target 90% auto + 10% confirmation

- **Cost Efficiency**
  - Only LLM-process pattern-detected portions, not entire conversations
  - Use Haiku model ($0.01/conversation)

- **Progressive Improvement**
  - Start simple
  - Add patterns as you use it
  - Improve with data

---

## Next Steps

Want to create a MAMA v1.2 prototype?

Required components:

1. Natural language save parser
2. LLM structuring prompt
3. Confidence-based workflow

Want code examples?

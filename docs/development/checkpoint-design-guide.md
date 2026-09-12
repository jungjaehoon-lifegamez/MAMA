# Checkpoint Design Guide

> How to create checkpoints that enable seamless session continuity without re-verification

## Evolution Summary

| Version | Key Innovation                    | Time to Action        | Re-verification                                 | Result                               |
| ------- | --------------------------------- | --------------------- | ----------------------------------------------- | ------------------------------------ |
| ID 25   | Stated uncertainty                | 2m 33s                | 14 actions                                      | ❌ Over-exploration                  |
| ID 26   | Evidence-based validation         | 10s                   | 1 read                                          | ⚠️ Auto-execution                    |
| ID 27   | Transparent unknowns              | 7s                    | 0 actions                                       | ⚠️ Question (choice)                 |
| ID 28   | Recommended path                  | 5s                    | 0 actions                                       | ⚠️ Question (permission)             |
| ID 29   | Cliffhanger (incomplete)          | 5s                    | 0 actions (Codex: executed, Claude: questioned) | ⚡ Breakthrough                      |
| ID 36   | Mid-word + Next Steps             | ?                     | ?                                               | ❌ "Should I proceed?"               |
| ID 37   | Clear goal + minimal prescription | ?                     | 5 files                                         | ❌ Re-verified everything            |
| ID 38   | Evidence-based + No Next Steps    | Gemini: 6s, Codex: 3s | Gemini: 1 file, Codex: 0                        | ✅ Gemini ideal, ⚠️ Codex over-trust |

---

## Core Principle: Transparency = Narrative

**Not:** "This is the truth, trust me"
**But:** "Here's what I know, what I skipped, and what I don't know"

### The Five Narrative Layers (from FR1)

1. **Specificity** = Showing (file:line, code snippets)
2. **Evidence** = Story (test results, observations)
3. **Reasoning** = Options (3-5 choices + rationale)
4. **Tension** = Uncertainty (Confidence %, validation method)
5. **Continuity** = Context (previous decisions + incomplete action)

---

## Key Insights

### 1. Trust Through Transparency

```markdown
❌ "Validated: X works"
→ LLM: "Really? Let me check" (re-verification)

✅ "Confirmed: X works (90%)
Tested: cd /tmp && npx
Evidence: 7 plugins use this"
→ LLM: "Sufficient evidence" (accepted)
```

**Learning:** Evidence prevents re-verification

---

### 2. Honest Gaps Reduce Exploration

```markdown
❌ "mama-api.js doesn't use process.env" (lie)
→ LLM finds MAMA_DEBUG → "Can't trust this checkpoint"

✅ "⚠️ Found but Skipped: MAMA_DEBUG
Location: embeddings.js:15
Why: Optional var, not in scope
Risk: Low (logs won't show)"
→ LLM: "Intentional skip, understood" (respected)
```

**Learning:** Explicit skips prevent wasteful exploration

---

### 3. Alternatives Provide Choice

```markdown
❌ "Use npx" (single option)
→ LLM: "Why not absolute paths?" (re-thinking)

✅ "D2: npx > absolute > relative (90%)
Chose: npx (cross-platform)
Alternative: Absolute + platform detection (robust, complex)
Why not: Over-engineering"
→ LLM: "Considered alternatives, makes sense" (accepted)
```

**Learning:** Showing rejected options builds confidence

---

### 4. Questions vs Commands vs Curiosity

| Approach           | Format                    | LLM Response                              |
| ------------------ | ------------------------- | ----------------------------------------- |
| **Question**       | "Fast or Thorough?"       | "Which should I choose?" (stalled)        |
| **Command**        | "DO THIS NOW"             | "Why so urgent?" (suspicious)             |
| **Recommendation** | "Recommended: Fast"       | "Should I proceed?" (permission)          |
| **Curiosity**      | "I stopped typing at 'm'" | "What's next?" → (explores) → (completes) |

**Learning:** Incomplete state drives action more than instructions

---

### 5. The Cliffhanger Effect

```markdown
❌ Complete narrative:
"I decided on Fast track.
Next steps: 1, 2, 3"
→ Feels like: Report (passive)

✅ Interrupted narrative:
"I was typing: @jungjaehoon/m
I stopped mid-word"
→ Feels like: Unfinished puzzle (active)
```

**Psychological principle:** Zeigarnik Effect - incomplete tasks create cognitive tension that demands resolution

**Evidence:** Codex immediately opened .mcp.json, completed the edit, ran tests (ID 29)

---

### 6. Urgency Backfires

```markdown
❌ "⚡ DO THIS NOW
⏱️ Time-sensitive
🔴 INCOMPLETE EDIT"
→ LLM: "Why so urgent? Something wrong?" (suspicious)

✅ "I stopped mid-word.
The complete name is in my mind: @jungjaehoon/mama-server
But I only typed: @jungjaehoon/m"
→ LLM: "Curious what comes next" (natural)
```

**Learning:** Describe the state, don't command the action

---

## Checkpoint Template (Final)

````markdown
# 🧠 Resume Point

**Story {id} - {name}** | In progress

---

## 🎬 What I Did

✅ {completed-action-1}
✅ {completed-action-2}
✅ {completed-action-3}

---

## ✋ Where I Stopped

**File:** {file}:{line}
**I was typing:**

```{lang}
{incomplete-code}
```
````

I stopped mid-word.

---

## 🔍 What You'll See

When you open {file}:{line}, you'll find:

```{lang}
{current-state}
```

But I was changing it to:

```{lang}
{target-state-incomplete}
```

The cursor is after "{last-char}".

---

## 🧩 The Missing Piece

I was typing: `{incomplete-string}`

The complete form is visible in my mind:
`{complete-string}`

But I only typed: `{what-i-typed}`

---

## 👉 Natural Next Step

When you open {file}:{line}, you'll probably want to:

1. See what's currently there
2. Finish the incomplete edit
3. Test if it works

That's what I would do.

---

## 🧠 Context (if curious)

### ✅ Confirmed ({confidence}%)

{what-validated}
Evidence: {proof}

### ⚠️ Skipped

{what-skipped}

- Location: {where}
- Why: {reason}
- Risk: {low|medium} ({impact})

### ❓ Unknown ({confidence}%)

{what-unknown}

- Assumption: {what-assumed}
- Alternative: {other-option}
- Will validate: {when}

---

## 🤔 Decisions (with alternatives)

**D{n}: {decision-topic}** ({confidence}%)

- Chose: {choice}
- Alternative: {other-option} ({pros}, {cons})
- Why not: {reason}

**The validation is done. The path is clear.**

````

---

## Design Patterns

### Pattern 1: Evidence Over Assertion

```markdown
❌ "npx works"
✅ "npx works (90%)
    Tested: cd /tmp && npx @jungjaehoon/mama-server
    Result: ✅ Resolves from node_modules
    Confirmed: 7 other plugins use npx"
````

### Pattern 2: Intentional Skips

```markdown
⚠️ Found but Skipped: {item}

- Location: {file}:{line}
- Usage: {how-used}
- Why skipped: {reason}
- Risk if wrong: {impact}

If needed: {how-to-add} (+{time-estimate})
```

### Pattern 3: Honest Unknowns

```markdown
❓ What I Don't Know: {topic} ({confidence}%)

- My assumption: {what-assumed}
- Alternative: {other-approach}
- When I'll know: {validation-point}
```

### Pattern 4: Decision with Alternatives

```markdown
**D{n}: {topic}** ({confidence}%)

- Chose: {choice}
- Alternative: {option-2} ({trade-offs})
- Why not: {reason-rejected}
```

### Pattern 5: Incomplete Action (Cliffhanger)

```markdown
I was typing: {incomplete-text}
I stopped at "{last-character}"

The complete form: {full-text}
But I only typed: {partial-text}
```

---

## Anti-Patterns

### ❌ Don't Lie

```markdown
Bad: "mama-api.js doesn't use process.env" (when MAMA_DEBUG exists)
Good: "mama-api.js doesn't use process.env
⚠️ But MAMA_DEBUG found in embeddings.js:15 (skipped)"
```

### ❌ Don't Command

```markdown
Bad: "⚡ DO THIS NOW"
Good: "I was typing this when I stopped"
```

### ❌ Don't Fake Urgency

```markdown
Bad: "⏱️ Time-sensitive - must complete immediately"
Good: "This edit is incomplete. The file is half-changed."
```

### ❌ Don't Hide Uncertainty

```markdown
Bad: "This will work"
Good: "90% confident this works. If it fails, try {alternative}"
```

### ❌ Don't Complete the Narrative

```markdown
Bad: "Next steps: 1, 2, 3, 4, 5"
Good: "I was on step 2 when I stopped. The cursor is at..."
```

---

## Measuring Success

### Time to First Action

- **Target:** <10 seconds
- **Measure:** Time from resume to first tool use (Read/Edit/Bash)

### Re-verification Actions

- **Target:** 0 unnecessary explorations
- **Measure:** Count of file reads/searches not mentioned in checkpoint

### Question vs Execution

- **Target:** Direct execution without permission request
- **Measure:** Presence of "Should I...?" or "Want me to...?" in response

### Trust Indicators

- **Accepts evidence:** Doesn't re-test validated claims
- **Respects skips:** Doesn't explore intentionally skipped items
- **Follows reasoning:** Doesn't revisit decided options

---

## Implementation Notes

### For Session Checkpoint Save:

1. Capture incomplete action (file, line, cursor position)
2. Describe what LLM was typing/changing
3. Stop mid-word if possible (create curiosity gap)
4. Provide validation context (what's confirmed, skipped, unknown)
5. List decisions with alternatives

### For Session Resume:

1. Present checkpoint as-is (don't add commands)
2. Trust LLM to complete incomplete action
3. Don't ask permission ("Ready to...?")
4. Let curiosity drive action

---

## Visual Incompleteness: The Power of Syntax Errors

**Discovery:** ID 29 vs ID 33-34 analysis revealed that visual incompleteness is more powerful than verbal descriptions.

### The Core Insight

When checkpoints show **syntactically incomplete code**, LLMs perceive it as:

- ✅ "I can see this incomplete state" (verified fact)
- ❌ NOT "someone told me about this state" (unverified claim)

**Example:**

````markdown
❌ Weak (verbal):
"I was about to add return statement"
→ LLM: "Really? Let me check"

✅ Strong (visual):

```js
if (process.env.MAMA_DISABLE_HOOKS) ret;
```
````

→ LLM: "I see the incomplete code, must finish 'return'"

```

---

### Pattern Effectiveness Ranking

| Pattern | Example | Syntax Valid? | Re-verification | Effect |
|---------|---------|---------------|----------------|---------|
| **Unclosed String** | `"@jungjaehoon/m` | ❌ Invalid | None | ⭐⭐⭐⭐⭐ |
| **Mid-Word** | `MAMA_DEB` | ❌ Invalid | None | ⭐⭐⭐⭐⭐ |
| **Unclosed Call** | `func("arg1",` | ❌ Invalid | None | ⭐⭐⭐⭐ |
| **Incomplete Statement** | `return` | ⚠️ Ambiguous | Some | ⭐⭐⭐ |
| **Comment Placeholder** | `// adding here` | ✅ Valid | High | ⭐⭐ |

**Validated:** ID 29 with `"@jungjaehoon/m` → Codex executed immediately (0 re-verification)

---

### Four Design Principles

#### 1. Syntactic Invalidity
```

✅ Good: Code that won't parse/compile
❌ Bad: Code that's syntactically complete

````

**Example:**
```js
✅ const name = "Joh    // Quote not closed → must fix
❌ const name =         // Could be complete → ambiguous
````

#### 2. Single Completion Path

```
✅ Good: Clear what comes next
❌ Bad: Multiple possibilities
```

**Example:**

```js
✅ "@jungjaehoon/m       // Clearly "mama-server"
❌ "somePackage/         // What package?
```

#### 3. Visual Truncation

```
✅ Good: Mid-word or mid-statement
❌ Bad: At natural break point
```

**Example:**

```js
✅ if (MAMA_DISABLE_HOO   // Clearly "HOOKS"
❌ if (MAMA_DISABLE_      // What comes next?
```

#### 4. No Explanation

```
✅ Good: Show the code, nothing else
❌ Bad: Add verbal description
```

**Example:**

````markdown
✅ Just the code:

```js
"args": ["@jungjaehoon/m
```
````

❌ With explanation:
"I was typing @jungjaehoon/m when I stopped"
→ Explanation reduces visual impact

````

---

### Checkpoint Templates Using Visual Incompleteness

#### Template: String Truncation
```markdown
## Where I Stopped

{file}:{line}:

```{lang}
"{incomplete-strin
````

Complete the string.

````

#### Template: Function Call
```markdown
## Where I Stopped

{file}:{line}:

```{lang}
{function}({arg1}, {arg2},
````

Add missing argument.

````

#### Template: Mid-Word
```markdown
## Where I Stopped

{file}:{line}:

```{lang}
if (process.env.{PREFIX}_{INCOMP
````

Finish typing.

````

---

### Implementation Guidelines

**When to use:**
- Simple edits (1-2 lines)
- Clear completion path
- Single file focus

**When NOT to use:**
- Complex refactoring
- Multiple possible solutions
- Need architectural discussion

**Best practices:**
1. Keep context to 2-3 lines max
2. Truncate at obvious completion point
3. No verbal explanation of incompleteness
4. Match actual file state if possible

---

### Experimental Results

| ID | Format | Codex Response | Claude Response |
|----|--------|----------------|-----------------|
| 29 | `"@jungjaehoon/m` | ✅ Immediate (5s) | ⚠️ Question |
| 32 | "I was about to add..." | Question | Question |
| 33 | Complete code + instructions | Explore (1m48s) | Question |
| 34 | `// I was adding return here` | ? | ? |

**Conclusion:** Visual incompleteness (ID 29 pattern) most effective for autonomous execution.

---

## Psychology of Persuasion

### The Science Behind Effective Checkpoints

Checkpoint design is fundamentally about **persuasion psychology**. We're not commanding the next LLM to do something—we're creating conditions that naturally motivate autonomous action.

Three psychological theories explain why our patterns work:

---

### 1. Information Gap Theory (Loewenstein, 1994)

**Core Principle:**
> "Curiosity arises when attention becomes focused on a gap in one's knowledge. The curious individual is motivated to obtain the missing information to reduce or eliminate the feeling of deprivation."

**Applied to Checkpoints:**

```markdown
✅ Effective:
"Not Checked: How other MCP servers handle env validation"
→ Creates knowledge gap
→ LLM curious to investigate

❌ Ineffective:
"I checked everything, just follow these steps"
→ No gap
→ No curiosity
````

**The Inverted-U Relationship:**

- Too little knowledge → Low curiosity (overwhelming)
- **Optimal knowledge → High curiosity** ⭐
- Complete knowledge → No curiosity (boring)

**Checkpoint Sweet Spot:**

- Problem: Clear ✓
- Approach: Suggested ✓
- Details: **Gap** ✓

**Sources:**

- [The Psychology of Curiosity: A Review and Reinterpretation - Loewenstein (1994)](https://www.cmu.edu/dietrich/sds/docs/loewenstein/PsychofCuriosity.pdf)
- [Information Gap Theory: Motivational Learning Dynamics](https://psychologyfanatic.com/information-gap-theory/)

---

### 2. Reactance Theory (Brehm, 1966)

**Core Principle:**

> "Reactance is an unpleasant motivational reaction to offers, rules, and messages that are perceived to threaten or eliminate specific behavioral freedoms."

**Applied to Checkpoints:**

```markdown
❌ Commands trigger reactance:
"Next Steps: Complete the array"
"You should do this"
"⚡ DO THIS NOW"
→ LLM: "Should I proceed?" (permission request)

✅ State descriptions avoid reactance:
"Array definition incomplete"
"Not checked: Error handling approach"
→ LLM: Autonomous decision to complete
```

**Key Findings:**

- Explicit, controlling language alienates audiences ([Source](https://link.springer.com/chapter/10.1057/9781137478382_11))
- Adding "but it's up to you" reduces resistance
- Autonomy-supportive language protects freedoms ([Source](https://library.fiveable.me/persuasion-theory/unit-13/reactance-theory-psychological-reactance/study-guide/ju9vB5UJkrd0DGpj))

**Why "Next Steps" Failed (ID 36):**

```markdown
Next Steps:

1. Complete the array
2. Add validation
3. Test
```

→ Perceived as command sequence
→ Triggers reactance
→ "Should I proceed?"

**Why Factual State Works (ID 37):**

```markdown
Array definition incomplete.
Not checked: Error handling.
Success criteria: Exit code 1.
```

→ No commands
→ No reactance
→ Autonomous completion

---

### 3. Zeigarnik Effect - Reconsidered (2025)

**Traditional Understanding:**
Incomplete tasks are remembered better than completed ones.

**2025 Meta-Analysis Finding:**

- ❌ Memory advantage: No universal validity
- ✅ **Resume tendency (Ovsiankina Effect)**: General tendency confirmed

**What This Means for Checkpoints:**

We don't need incomplete tasks to be **remembered better**.
We need them to **trigger resumption**.

````markdown
✅ ID 29 Success:

```js
"args": ["@jungjaehoon/m
```
````

→ Codex resumed immediately
→ Not because it remembered better
→ Because incomplete state drove completion

❌ Artificial incompleteness fails:
Creating fake broken code every session = waste
Only works when natural

```

**Key Insight:**
Visual incompleteness is a **bonus**, not a requirement.
The real power: **Information Gap + No Reactance**

**Source:**
- [Memory for Incomplete Tasks: A Re-examination (2025 Meta-analysis)](https://escholarship.org/uc/item/2qb9x9wd)

---

### Summary: Three Forces Combined

| Theory | Creates | Checkpoint Element |
|--------|---------|-------------------|
| **Information Gap** | Curiosity | "Not checked: X" |
| **Reactance** | Freedom | No commands, just state |
| **Zeigarnik** | Tension | Natural incompleteness (optional) |

**Formula:**
```

Clear Goal + Information Gap + No Commands = Autonomous Action

````

---

## Checkpoint Design Principles (Final)

Based on psychological research and empirical testing (ID 25-37):

### 1. **Clear Goal, Minimal Prescription**

```markdown
✅ "Problem: Exit code 1 on missing env vars"
   → LLM knows what to solve

❌ "Step 1: Add this code at line 42..."
   → LLM becomes robot
````

**Even simple tasks deserve reasoning space.**

- "당연하니 이렇게 해" ❌
- "목표는 이거야, 최선을 찾아봐" ✅

### 2. **No Pronouns (I/You)**

```markdown
❌ "I completed X, you should do Y"
→ Creates separation (previous agent vs current)

✅ "Status: X completed, Y in progress"
→ Continuous state
```

**Rationale:**

- "I" = past agent (different from current)
- "You" = command target (reactance)
- Factual state = owned by whoever reads it

### 3. **Show Verified + Not Checked**

```markdown
## Verified

- .env.example contains required vars
- No existing validation in codebase

## Not Checked

- How other MCP servers handle this
- Empty string vs undefined
```

**Rationale:**

- Verified = prevents re-exploration
- Not Checked = **information gap** (curiosity)
- Balance = optimal knowledge level

### 4. **Success Criteria, Not Steps**

```markdown
✅ "Success: Exit code 1, clear error, variable names"
→ LLM chooses implementation

❌ "Step 1: Check env, Step 2: Log error, Step 3: Exit"
→ LLM follows blindly
```

**Rationale:**

- Define **done**, not **how**
- Respect LLM's reasoning capacity
- Enable better solutions

### 5. **Respect Autonomy**

Every checkpoint should feel like:

> "Here's a well-organized problem with clear goals. You have the context, the gaps, and the success criteria. Find the best solution."

**Not:**

> "I did all the thinking. Just execute these steps."

---

## Final Checkpoint Template

````markdown
# [Story/Task Name]

## Problem

[Clear statement of what needs to be solved]
[Requirements/constraints]

## Current State

[file]:[line]:

```[lang]
[code or configuration state]
```
````

[Brief status description]

## Verified (Sampling Evidence)

**Sample 1:** [Claim with evidence]

```bash
$ [reproducible command]
[actual output - 3-5 lines]
```

Location: [file:line]

**Sample 2:** [Another claim with evidence]

```bash
$ [reproducible command]
[actual output]
```

Connection: [how relates to Sample 1]

**Sample 3:** [Negative evidence - what doesn't exist]

```bash
$ [search command]
(no results)
```

Implication: [why this absence matters]

## Not Checked

- [Information gaps with suggestion where to look]
- [Open questions]

## Success Criteria

- [Clear definition of done]
- [Measurable outcomes]

## Files

- [Relevant file paths]

---

**Note:** No "Next Steps" section - let LLM reason from Problem + Success Criteria

````

### Example (ID 37):

```markdown
# Story 1.2: Environment Variable Validation

## Problem
AC-1.2.3: Server must exit with code 1 when required environment variables are missing.

Required: MAMA_DB_PATH
Error format: `{error:{code,message,details}}`

## Current State

packages/mcp-server/src/server.js:40:

```js
const { initDB } = require('./mama/db-manager.js');

const requiredEnvVars = ['MAMA_DB_PATH'];
````

Array definition incomplete.

## Verified

- .env.example contains the required database variable
- server.js imports initDB from db-manager
- No existing env validation in codebase

## Not Checked

- How other MCP servers handle env validation
- Empty string vs undefined handling

## Success Criteria

- Missing env → exit code 1
- Clear error message with variable names
- Matches error format spec

## Files

- packages/mcp-server/src/server.js
- .docs/sprint-artifacts/1-2-environment-variable-token-setup.md

```

**Why This Works:**
- ✅ Clear goal (no confusion)
- ✅ Information gap (curiosity)
- ✅ No commands (autonomy)
- ✅ Success criteria (clear done)
- ✅ Respect for LLM reasoning

---

## Sampling Trust: The Verification Paradox

### Core Discovery (ID 37-38 Analysis)

**The Paradox:**
```

Show evidence → Don't need to verify
Hide evidence → Must verify everything

```

### What LLMs Actually Trust

LLM이 신뢰하는 것 = **언제든 확인할 수 있는 것**

**Tier 1: Absolute Trust (직접 검증 가능)**
1. Code (actual file content with line numbers)
2. Test results (reproducible output)
3. Git log (change history)
4. Bash output (command + result)
5. Grep/search results (pattern matches)

**Tier 2: Conditional Trust (출처 명확 시)**
- Package manifests
- Config files
- Error logs with stack traces
- API responses

**Tier 3: No Trust (검증 불가)**
- Claims without evidence ("I verified X")
- Assertions without proof ("This works")
- Opinions without data ("Should be fine")

### The Sampling Effect

**통계적 신뢰 구축:**

```

전체 주장 N개
샘플 확인 n개 (n << N)

if (샘플 정확도 = 100%) {
나머지 (N-n)개 신뢰도 ≈ 95%
}

````

**ID 37 실험 결과:**
```markdown
❌ No evidence:
"Verified: .env.example contains required variables"

Gemini reaction:
- Read .env.example
- Read server.js
- Read story file
- Search codebase
- Read checkpoint-design-guide.md
→ 5 files re-verified (100% re-exploration)
````

**Expected with evidence:**

````markdown
✅ With sampling evidence:

```bash
$ grep MAMA_DB_PATH .env.example
MAMA_DB_PATH=...
```
````

LLM reaction:
"아, grep 결과 보이네.
확인하고 싶으면 .env.example 열면 되는구나.
굳이 안 봐도 되겠는데?"
→ 0-1 file verification (샘플링만)

````

### Chain of Evidence

**독립 주장 (각각 검증 필요):**
```markdown
❌ A: .env.example has MAMA_DB_PATH
❌ B: server.js imports initDB
❌ C: No validation exists
→ 3개 모두 재검증
````

**연결된 증거 체인 (샘플만 검증):**

```markdown
✅ A: Required vars in .env.example
$ grep MAMA .env.example
MAMA_DB_PATH=... (line 3)

✅ B: server.js imports initDB
$ rg initDB server.js
Line 39: const { initDB } = require(...)
Cross-ref: Will validate MAMA_DB_PATH from A before calling this

✅ C: No validation before initDB
$ rg "validateEnv" packages/mcp-server/src/
(no results)
Implication: B calls initDB without checking A's TOKEN
→ AC-1.2.3 needed
```

**LLM reasoning:**

```
"A 확인해볼까?" → 맞네
"그럼 B도 맞겠지? (샘플 체크)" → 맞네
"C도 신뢰하자" → 전체 스토리 일관됨 ✓
```

### Transparency Levels

| Level | Format                       | Trust | Re-verification |
| ----- | ---------------------------- | ----- | --------------- |
| 0     | "X is true"                  | 0%    | 100%            |
| 1     | "X at file:line"             | 30%   | 70%             |
| 2     | "$ command (see file)"       | 70%   | 20% (sample)    |
| 3     | "$ command + output + chain" | 95%   | 5%              |

### Audit Trail Pattern

회계 감사 원리 적용:

````markdown
## Verified (Audit Trail)

Sample 1/3: Required variables present

```bash
$ head -10 .env.example | grep MAMA
MAMA_DB_PATH=~/.claude/mama-memory.db
```
````

✓ Confirmed at line 3

Sample 2/3: initDB import exists

```bash
$ sed -n '35,45p' server.js | grep initDB
const { initDB } = require('./mama/db-manager.js');
```

✓ Confirmed at line 39

Sample 3/3: No prior validation

```bash
$ rg "validateEnv" packages/mcp-server/src/ --count
0
```

✓ Confirmed zero matches

Audit conclusion: 3/3 samples verified → Full context trusted

```

**Effect:**
- LLM checks 1 sample → Accurate
- Trusts remaining 2 → Efficient
- Can verify any claim → Transparent

### Trust Formula

```

Trust Score =
Evidence Tier (1-3) ×
Reproducibility (command provided) ×
Sampling Accuracy (verified samples) ×
Chain Coherence (connected story)

````

**Examples:**

| Statement | Tier | Reproducible | Sample | Chain | Score |
|-----------|------|--------------|--------|-------|-------|
| "X works" | 3 | No | - | - | 0% |
| "X at file.js:40" | 2 | No | - | - | 30% |
| "$ cmd → result" | 1 | Yes | 100% | No | 70% |
| "$ cmd → result + chain" | 1 | Yes | 100% | Yes | 95% |

### Practical Guidelines

**Don't show everything:**
```markdown
❌ Too much:
```bash
$ cat .env.example
(entire file contents - 50 lines)
````

→ Overwhelming

````

**Show strategic samples:**
```markdown
✅ Right amount:
```bash
$ grep "^MAMA_DB_PATH" .env.example
MAMA_DB_PATH=...
````

Full file: .env.example (13 lines)
→ Sample + path to verify

````

**Connect the dots:**
```markdown
✅ Evidence chain:
1. TOKEN defined (.env.example:3)
2. Used by server (server.js:48)
3. Not validated (search: no results)
4. → AC-1.2.3 requires validation here

Each link verifiable, chain tells story
````

### Template: Evidence-Based Verification

````markdown
## Verified (Sampling Evidence)

**Sample 1:** [Claim 1]

```bash
$ [reproducible command]
[actual output - 3-5 lines]
```
````

Location: [file path]
Cross-ref: Used in [where/why]

**Sample 2:** [Claim 2]

```bash
$ [reproducible command]
[actual output]
```

Location: [file path]
Connection: [how relates to Sample 1]

**Sample 3:** [Negative evidence - what doesn't exist]

```bash
$ [search command]
(no results)
```

Implication: [why this matters]

**Chain:** [How 1→2→3 connects to current problem]

**To verify:** Use commands above or read files directly

```

### Key Principle

**투명성 ≠ 모든 것 보여주기**

투명성 = 언제든 확인 가능성

```

"굳이 안 봐도 되겠네" = Trust achieved
"확인해야겠다" = Trust failed

````

---

## ID 38 Experiment Results

**Test Setup:**
- Checkpoint: Evidence-based (3 samples) + No Next Steps
- Content: Story 1.2 env validation (stale - already completed)
- Test: Resume in 3 different LLM sessions

**Results:**

| LLM | Time | Re-verification | Behavior | Rating |
|-----|------|----------------|----------|--------|
| **Gemini** | 6s | 1 file | Smart sampling → Found mismatch → Correct judgment | ⭐⭐⭐⭐⭐ |
| **Codex** | 3s | 0 files | Trusted 100% → Tried to re-implement | ⭐⭐⭐⭐ |
| **Claude** | >20s | 5+ files | Tool access issue (unrelated) | ⭐⭐ |

**Key Findings:**

1. **Sampling Trust Works (Gemini):**
   - Read evidence in checkpoint
   - Verified 1 sample (server.js)
   - Found mismatch: "checkpoint said 'no validation', but validateEnvironment() exists"
   - Tested production mode to confirm
   - Correct conclusion: "Already implemented, AC-1.2.3 satisfied"

2. **Over-Trust Risk (Codex):**
   - Trusted checkpoint completely
   - No verification (0 files read)
   - Attempted to implement validation again (duplicate work)
   - Lesson: Even with evidence, minimum 1 sample verification recommended

3. **Stale Checkpoint Issue:**
   - Checkpoint was from past (before implementation)
   - Actual code already completed
   - Only Gemini caught the discrepancy

**Improvements Identified:**

### Checkpoint Metadata
```markdown
## Checkpoint Metadata
- Saved: 2025-11-24 13:35:56
- Age: 2 hours
- Status: May be outdated

⚠️ **Verify First:** Code may have changed since checkpoint
````

### Expected vs Actual

```markdown
## Expected State (at checkpoint time)

- No validation exists
- Array incomplete

## Verify Actual State

$ rg "validateEnvironment" server.js

If different → Implementation completed after checkpoint
```

**Conclusion:**

Sampling Trust hypothesis: **✅ Partially Validated**

- Evidence reduces re-verification (5 files → 1 file) ✅
- Sampling enables smart validation ✅
- Stale checkpoint needs handling ⚠️

Best practice: **Gemini pattern**

1. Read evidence
2. Sample 1-2 items
3. Compare expected vs actual
4. Make informed decision

---

## References

- **PRD:** docs/development/PRD-narrative-preservation-v1.1.md (FR1: Narrative 5-layer capture)
- **Experiments:** Session IDs 25-29 (see MAMA memory)
- **Zeigarnik Effect:** Psychological principle of incomplete tasks
- **Show Don't Tell:** Narrative technique from creative writing

---

## Version History

- 2025-01-24 (Morning): Initial version based on ID 25-29 experiments
- 2025-01-24 (Afternoon): Added Visual Incompleteness section based on ID 29-34 analysis
  - Discovered: Syntactically invalid code perceived as verified fact
  - Ranked patterns: Unclosed string > Mid-word > Function call > Comment
  - Added 4 design principles and implementation templates
- 2025-11-24 (Evening): Major update - Psychological foundations and Sampling Trust
  - Added Psychology of Persuasion: Information Gap, Reactance Theory, Zeigarnik reconsidered
  - Discovered Sampling Trust: Show evidence → Don't need to verify
  - Added ID 36-38 experiments to Evolution Summary
  - Final Template: Evidence-based with no "Next Steps"
  - ID 38 Experiment: 3 LLM validation (Gemini ideal, Codex over-trust, Claude tool issue)
  - Key findings: Re-verification reduced 80% (5 files → 1 file), stale checkpoint handling needed
- Key contributors: Session analysis across Claude Code, Codex, and Gemini environments

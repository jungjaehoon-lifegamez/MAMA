# Skills API Reference

> **ARCHIVED:** historical skills API reference. The built-in skill set and the owner runtime have since changed; see [Architecture Overview](../explanation/architecture.md).

**Category:** Reference  
**Audience:** Developers creating custom skills  
**Version:** 0.1.0

## Overview

Skills are pluggable capabilities for MAMA Standalone that define specialized behaviors for handling specific types of user input. Each skill is a markdown file with YAML frontmatter that specifies:

- **When to activate** - Keywords, patterns, required input types
- **What to process** - Text, images, documents
- **How to respond** - System prompt for Claude
- **Output format** - Text, HTML, screenshots

Skills are matched against incoming messages using a confidence-based scoring system and executed through the AgentLoop with Claude API.

## Skill Definition Format

Skills are defined in markdown files with YAML frontmatter:

```markdown
---
name: Skill Name
description: Brief description
keywords:
  - keyword1
  - keyword2
patterns:
  - regex-pattern
requiredInputs:
  - image
output: html-screenshot
discordScreenshot: true
allowedExtensions:
  - .pdf
  - .xlsx
enabled: true
---

# Skill Instructions

System prompt content for Claude goes here.
This becomes the skill's systemPrompt field.
```

### Frontmatter Schema

| Field               | Type     | Required | Description                                                        |
| ------------------- | -------- | -------- | ------------------------------------------------------------------ |
| `name`              | string   | ✅       | Display name for the skill                                         |
| `description`       | string   | ❌       | Brief description of what the skill does                           |
| `keywords`          | string[] | ❌       | Keywords that trigger this skill (case-insensitive)                |
| `patterns`          | string[] | ❌       | Regex patterns that trigger this skill                             |
| `requiredInputs`    | string[] | ❌       | Required input types: `text`, `image`, `document`, `any`           |
| `output`            | string   | ❌       | Output type: `text`, `html`, `html-screenshot`, `file`             |
| `discordScreenshot` | boolean  | ❌       | Send screenshot to Discord (requires `output: html-screenshot`)    |
| `allowedExtensions` | string[] | ❌       | File extensions allowed for document input (e.g., `.pdf`, `.xlsx`) |
| `enabled`           | boolean  | ❌       | Whether skill is active (default: `true`)                          |

**Notes:**

- Skill ID is derived from filename (e.g., `image-translate.md` → `image-translate`)
- At least one trigger (`keywords`, `patterns`, or `requiredInputs`) should be specified
- Body content becomes the `systemPrompt` sent to Claude

## Triggers

Skills are matched against user input using three trigger types:

### Keywords

Case-insensitive substring matching:

```yaml
keywords:
  - 번역
  - translate
  - 한국어로
```

**Matching behavior:**

- Checks if keyword appears anywhere in user message
- Case-insensitive (`translate` matches `Translate`, `TRANSLATE`)
- Partial matches allowed (`번역` matches `번역해줘`)

**Confidence scoring:**

- Base confidence: `0.7`
- Position bonus: `+0.1` if keyword at start of message
- Length bonus: `+0.2 * (keyword_length / message_length)`
- Max confidence: `1.0`

### Patterns

Regular expression matching:

```yaml
patterns:
  - '^/translate'
  - '(?i)analyze.*document'
```

**Matching behavior:**

- Uses JavaScript `RegExp` with case-insensitive flag (`i`)
- Full regex syntax supported
- Pattern errors logged but don't crash skill loading

**Confidence scoring:**

- Fixed confidence: `0.8` for pattern matches

### Required Inputs

Attachment type requirements:

```yaml
requiredInputs:
  - image
```

**Supported input types:**

| Type       | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `text`     | User message text (always present)                            |
| `image`    | Image attachment (JPEG, PNG, GIF, WebP)                       |
| `document` | Document attachment (PDF, Excel, Word, CSV, JSON, text files) |
| `any`      | Any attachment type                                           |

**Matching behavior:**

- Checks if required attachment types are present
- Multiple types can be required (all must be present)
- If no text/pattern triggers match but required inputs satisfied: confidence `0.5`

## Input Types

Skills receive input through the `SkillInput` interface:

```typescript
interface SkillInput {
  /** User message text */
  text: string;
  /** Attached files */
  attachments?: SkillAttachment[];
  /** Channel ID for response */
  channelId?: string;
  /** Message source (discord, slack, telegram) */
  source?: string;
}

interface SkillAttachment {
  /** Attachment type */
  type: 'image' | 'document';
  /** Local file path */
  localPath: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType?: string;
  /** File size in bytes */
  size?: number;
}
```

**Content type detection:**

- Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- Documents: `application/pdf`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv`, etc.

**Image compression:**

- Images over 4MB are automatically compressed using `sharp`
- Target quality adjusted based on size ratio
- Compressed images converted to JPEG
- Falls back to original if `sharp` unavailable

## Output Types

Skills can produce different output formats:

### text (default)

Plain text response sent directly to user:

```yaml
output: text
```

**Use for:** Simple text responses, summaries, analysis results

### html

Generate HTML file saved to workspace:

```yaml
output: html
```

**Behavior:**

- Response saved as HTML file in `workspace/output/{skill-id}/`
- Filename: `{skill-id}-{timestamp}.html`
- If response not already HTML, wrapped in basic template
- Returns summary message with file path

### html-screenshot

Generate HTML and capture screenshot:

```yaml
output: html-screenshot
discordScreenshot: true
```

**Behavior:**

- Saves HTML file (same as `html` output)
- Takes screenshot using Playwright
- Screenshot saved as PNG alongside HTML
- If `discordScreenshot: true`, sends image to Discord channel

**Special features:**

- Side-by-side layout for image translation (original + result)
- Markdown to HTML conversion (headers, tables, bold, code)
- Responsive styling with Noto Sans KR font

### file

Generate arbitrary file output:

```yaml
output: file
```

**Use for:** Custom file generation (not yet fully implemented in v0.1.0)

## Matching Algorithm

Skills are matched using a multi-stage process:

### Stage 1: Required Inputs Check

```typescript
function hasRequiredInputs(skill, input): boolean;
```

- Validates all required input types are present
- Returns `false` if any required type missing
- Skips skill if check fails

### Stage 2: Keyword Matching

```typescript
function matchKeywords(skill, text): { matched; keyword; confidence };
```

- Checks each keyword against lowercased message
- Returns first match with confidence score
- Confidence: `0.7 + position_bonus + length_bonus`

### Stage 3: Pattern Matching

```typescript
function matchPatterns(skill, text): { matched; pattern; confidence };
```

- Tests each regex pattern against message
- Returns first match with confidence `0.8`
- Invalid patterns logged and skipped

### Stage 4: Input Type Fallback

If no keyword/pattern match but required inputs satisfied:

- Returns match with confidence `0.5`
- Match type: `input_type`

### Stage 5: Sorting

All matches sorted by confidence (highest first):

```typescript
matches.sort((a, b) => b.confidence - a.confidence);
```

**Best match selection:**

```typescript
const bestMatch = matches[0]; // Highest confidence
```

## Execution Flow

Skills execute through the following lifecycle:

### 1. Skill Loading

```typescript
const loader = new SkillLoader(skillsDir);
await loader.load();
```

- Scans `skillsDir` for `.md` files
- Parses YAML frontmatter
- Validates required fields (`name`)
- Filters by `enabled` flag
- Stores in memory

### 2. Skill Matching

```typescript
const matcher = new SkillMatcher();
matcher.setSkills(loader.getSkills());
const match = matcher.findBest(input);
```

- Runs matching algorithm (see above)
- Returns best match or `null`

### 3. Prompt Building

```typescript
function buildPrompt(skill, input): string;
```

Constructs full prompt:

```
{skill.systemPrompt}

---
사용자 요청: {input.text}

첨부 파일:
- {attachment.filename} ({attachment.type})
```

### 4. Content Block Assembly

```typescript
async function buildContentBlocks(text, attachments): ContentBlock[];
```

Creates multimodal content:

1. **Images first** (Claude prefers images before text)
   - Compress if over 4MB
   - Convert to base64
   - Create `ImageBlock` with `media_type`
2. **Documents next**
   - Convert to base64
   - Create `DocumentBlock` with MIME type
3. **Text last**
   - Create `TextBlock` with full prompt

### 5. Agent Loop Execution

```typescript
const result = await agentLoop.runWithContent(contentBlocks);
```

- Sends multimodal content to Claude API
- Handles tool calls (if any)
- Returns final response

### 6. Output Processing

```typescript
await processOutput(skill, input, response, originalImages);
```

Based on `skill.output`:

- **text**: Return response as-is
- **html**: Save as HTML file, return summary
- **html-screenshot**: Save HTML, take screenshot, optionally send to Discord

### 7. Result Return

```typescript
interface SkillResult {
  success: boolean;
  response?: string;
  files?: Array<{ path; type; description }>;
  error?: string;
  duration?: number;
}
```

## Built-in Skills

MAMA Standalone includes three template skills:

### image-translate

**Purpose:** Translate text in images to Korean

**Triggers:**

- Keywords: `번역`, `translate`, `한국어로`, `뭐라고`, `읽어줘`
- Required: `image` attachment

**Output:** `html-screenshot` with side-by-side layout

**Key features:**

- Extracts all text from image
- Translates to Korean
- Preserves structure (tables, lists, headers)
- Shows original + translation side-by-side
- Sends screenshot to Discord

**Example:**

```
User: [sends image] 번역해줘
MAMA: [generates HTML with original + Korean translation, sends screenshot to Discord]
```

### document-analyze

**Purpose:** Analyze and summarize Excel, PDF, Word documents

**Triggers:**

- Keywords: `분석해`, `요약해`, `정리해`, `analyze`
- Required: `document` attachment
- Allowed extensions: `.xlsx`, `.xls`, `.csv`, `.pdf`, `.doc`, `.docx`

**Output:** `text`

**Analysis types:**

- **Excel/CSV**: Data structure, statistics, patterns
- **PDF/Word**: Content summary, key points

**Example:**

```
User: [sends Excel file] 분석해줘
MAMA: ### 문서 개요
- 유형: Excel 스프레드시트
- 크기: 150행 × 8열

### 주요 내용
1. 월별 매출 데이터 (2025년 1-12월)
2. 평균 매출: ₩5,234,000
3. 최고 매출: 12월 (₩8,100,000)
```

## Custom Skills

### Creating a Custom Skill

1. **Create markdown file** in `workspace/skills/`:

```bash
touch workspace/skills/my-skill.md
```

2. **Define frontmatter**:

```markdown
---
name: My Custom Skill
description: Does something useful
keywords:
  - trigger-word
output: text
---

# Instructions for Claude

You are a helpful assistant that...
```

3. **Reload skills**:

```bash
# Skills auto-load on startup
mama stop
mama start
```

### Skill Development Tips

**DO:**

- ✅ Use specific keywords (avoid generic terms like "help")
- ✅ Test with real user messages
- ✅ Keep system prompts focused and clear
- ✅ Use `html-screenshot` for visual results
- ✅ Validate output in Discord/Slack before deploying

**DON'T:**

- ❌ Overlap keywords with other skills (causes conflicts)
- ❌ Use overly broad patterns (matches everything)
- ❌ Forget to specify `requiredInputs` for attachment-based skills
- ❌ Make system prompts too long (Claude context limits)

### Skill Forge

Use AI-assisted skill creation:

```
/forge weather-check - A skill that tells weather info

# 3 AI agents collaborate:
# 1. 🏗️ Architect - Designs structure
# 2. 💻 Developer - Writes code
# 3. 🔍 QA - Quality verification
```

Skills created via Forge are saved to `workspace/skills/` and auto-loaded.

## API Classes

### SkillLoader

```typescript
class SkillLoader {
  constructor(skillsDir: string);
  async load(): Promise<void>;
  async reload(): Promise<void>;
  getSkills(): SkillDefinition[];
  getSkill(id: string): SkillDefinition | undefined;
  addSkill(skill: SkillDefinition): void;
}
```

### SkillMatcher

```typescript
class SkillMatcher {
  setSkills(skills: SkillDefinition[]): void;
  match(input: SkillInput): SkillMatch[];
  findBest(input: SkillInput): SkillMatch | null;
  hasMatch(input: SkillInput): boolean;
}
```

### SkillExecutor

```typescript
class SkillExecutor {
  constructor(config: SkillExecutorConfig);
  async execute(
    skill: SkillDefinition,
    input: SkillInput,
    agentLoop: AgentLoop
  ): Promise<SkillResult>;
}

interface SkillExecutorConfig {
  workspaceDir: string;
  discordGateway?: {
    sendMessage: (channelId: string, message: string) => Promise<void>;
    sendImage: (channelId: string, imagePath: string, caption?: string) => Promise<void>;
  };
  takeScreenshot?: (htmlPath: string, outputPath: string) => Promise<void>;
}
```

## Type Definitions

Full TypeScript types available in `packages/standalone/src/skills/types.ts`:

```typescript
export type SkillInputType = 'text' | 'image' | 'document' | 'any';
export type SkillOutputType = 'text' | 'html' | 'html-screenshot' | 'file';

export interface SkillTrigger {
  keywords?: string[];
  patterns?: string[];
  requiredInputs?: SkillInputType[];
}

export interface SkillOutput {
  type: SkillOutputType;
  filename?: string;
  discordScreenshot?: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  trigger: SkillTrigger;
  output?: SkillOutput;
  systemPrompt: string;
  allowedExtensions?: string[];
  enabled: boolean;
  filePath?: string;
}

export interface SkillMatch {
  skill: SkillDefinition;
  confidence: number;
  matchType: 'keyword' | 'pattern' | 'input_type';
  matchedValue?: string;
}
```

## See Also

- [MAMA Standalone README](../../packages/standalone/README.md) - Installation and setup
- [Built-in Skills](../../packages/standalone/templates/skills/) - Example skill implementations
- [Agent Loop API](./agent-loop-api.md) - How skills execute through Claude
- [Gateway Integration Guide](../guides/gateway-integration.md) - Connecting Discord/Slack/Telegram

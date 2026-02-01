/**
 * MAMA Skill System Types
 *
 * Skills are markdown-based definitions that specify:
 * - When to activate (triggers)
 * - What inputs they accept (text, images, documents)
 * - How to process (system prompt)
 * - What to output (text, html-screenshot, etc.)
 */

/**
 * Supported input types for skills
 */
export type SkillInputType = 'text' | 'image' | 'document' | 'any';

/**
 * Supported output types for skills
 */
export type SkillOutputType =
  | 'text' // Plain text response
  | 'html' // Generate HTML file
  | 'html-screenshot' // Generate HTML and screenshot it
  | 'file'; // Generate a file

/**
 * Skill trigger definition
 */
export interface SkillTrigger {
  /** Keyword patterns that activate this skill */
  keywords?: string[];
  /** Regex patterns that activate this skill */
  patterns?: string[];
  /** Required input types (e.g., must have image attachment) */
  requiredInputs?: SkillInputType[];
}

/**
 * Skill output definition
 */
export interface SkillOutput {
  /** Output type */
  type: SkillOutputType;
  /** Output filename template (supports {{date}}, {{timestamp}}) */
  filename?: string;
  /** Whether to send screenshot to Discord */
  discordScreenshot?: boolean;
}

/**
 * Skill definition (parsed from markdown frontmatter)
 */
export interface SkillDefinition {
  /** Unique skill identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Trigger conditions */
  trigger: SkillTrigger;
  /** Output configuration */
  output?: SkillOutput;
  /** System prompt / instructions for Claude */
  systemPrompt: string;
  /** Allowed file extensions for document input */
  allowedExtensions?: string[];
  /** Whether skill is enabled */
  enabled: boolean;
  /** Source file path */
  filePath?: string;
}

/**
 * Input attachment for skill execution
 */
export interface SkillAttachment {
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

/**
 * Skill execution input
 */
export interface SkillInput {
  /** User message text */
  text: string;
  /** Attached files */
  attachments?: SkillAttachment[];
  /** Channel ID for response */
  channelId?: string;
  /** Message source (discord, slack, etc.) */
  source?: string;
}

/**
 * Skill execution result
 */
export interface SkillResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Text response */
  response?: string;
  /** Generated files */
  files?: Array<{
    path: string;
    type: string;
    description?: string;
  }>;
  /** Error message if failed */
  error?: string;
  /** Execution duration in ms */
  duration?: number;
}

/**
 * Skill match result
 */
export interface SkillMatch {
  /** Matched skill */
  skill: SkillDefinition;
  /** Match confidence (0-1) */
  confidence: number;
  /** Matched trigger type */
  matchType: 'keyword' | 'pattern' | 'input_type';
  /** Matched trigger value */
  matchedValue?: string;
}

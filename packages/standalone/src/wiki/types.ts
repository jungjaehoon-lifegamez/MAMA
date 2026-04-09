export const WIKI_PAGE_TYPES = ['entity', 'lesson', 'synthesis', 'process'] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export function isValidPageType(type: string): type is WikiPageType {
  return (WIKI_PAGE_TYPES as readonly string[]).includes(type);
}

export interface WikiPage {
  /** Relative path within wiki dir (e.g. "projects/MyProject.md") */
  path: string;
  title: string;
  type: WikiPageType;
  content: string;
  /** Decision IDs this page was compiled from */
  sourceIds: string[];
  /** ISO 8601 timestamp */
  compiledAt: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface WikiConfig {
  /** Absolute path to Obsidian vault root */
  vaultPath: string;
  /** Subdirectory within vault for compiled wiki (default: "wiki") */
  wikiDir: string;
  /** Whether wiki compilation is enabled */
  enabled: boolean;
}

export interface CompilationResult {
  pages: WikiPage[];
  indexUpdated: boolean;
  logEntry: string;
}

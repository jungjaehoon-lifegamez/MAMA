import type { WikiPage, CompilationResult } from './types.js';
import { isValidPageType } from './types.js';

export interface DecisionForCompilation {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  status: string;
  confidence: number | null;
  updated_at: string;
}

export function buildCompilationPrompt(
  project: string,
  decisions: DecisionForCompilation[]
): string {
  if (decisions.length === 0) {
    return `Project "${project}" has no decisions to compile. Respond with: {"pages": []}`;
  }

  const decisionLines = decisions
    .map(
      (d, i) =>
        `${i + 1}. [${d.status}] ${d.topic}: ${d.decision}` +
        (d.reasoning ? ` (reason: ${d.reasoning})` : '') +
        ` — confidence: ${d.confidence ?? 'N/A'}, updated: ${d.updated_at}`
    )
    .join('\n');

  return `You are a knowledge compiler. Given a project's decisions from a memory database, compile them into wiki pages for human reading in Obsidian.

## Project: ${project}

## Decisions (${decisions.length} total)
${decisionLines}

## Output Format
Respond with a JSON object containing a "pages" array. Each page:
- "path": relative path (e.g. "projects/${project}.md")
- "title": page title
- "type": one of "entity", "lesson", "synthesis", "process"
- "content": markdown content (NO frontmatter — system adds it)
- "confidence": "high", "medium", or "low"

## Compilation Rules
1. Create ONE entity page for the project with current status, timeline, and key decisions
2. If you find lessons or patterns, create separate lesson pages
3. Use [[wikilinks]] to reference other potential pages
4. Write in the same language as the decisions (Korean/Japanese/English)
5. Synthesize, don't list — the goal is human understanding, not data dump
6. Include a "## Timeline" section with key events in reverse chronological order

Respond ONLY with the JSON object. No explanation.`;
}

export function parseCompilationResponse(response: string, sourceIds: string[]): CompilationResult {
  const now = new Date().toISOString();

  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned) as {
      pages?: Array<{
        path: string;
        title: string;
        type: string;
        content: string;
        confidence?: string;
      }>;
    };

    if (!parsed.pages || !Array.isArray(parsed.pages)) {
      return { pages: [], indexUpdated: false, logEntry: 'No pages in response' };
    }

    const pages: WikiPage[] = parsed.pages
      .filter((p) => p.path && p.title && p.content)
      .map((p) => ({
        path: p.path,
        title: p.title,
        type: isValidPageType(p.type) ? p.type : 'entity',
        content: p.content,
        sourceIds,
        compiledAt: now,
        confidence: (p.confidence as WikiPage['confidence']) || 'medium',
      }));

    return {
      pages,
      indexUpdated: pages.length > 0,
      logEntry: `Compiled ${pages.length} pages`,
    };
  } catch {
    return { pages: [], indexUpdated: false, logEntry: 'Failed to parse LLM response' };
  }
}

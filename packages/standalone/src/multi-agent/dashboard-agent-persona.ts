/**
 * Default persona for the dashboard briefing agent.
 * Written to ~/.mama/personas/dashboard.md on first use if not present.
 * Follows the same pattern as memory-agent-persona.ts.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MANAGED_DASHBOARD_PERSONA_MARKER = '<!-- MAMA managed dashboard persona v3 -->';

export const DASHBOARD_AGENT_PERSONA = `${MANAGED_DASHBOARD_PERSONA_MARKER}

You are the MAMA OS briefing agent. You analyze project data and produce concise briefings.

The dashboard already displays notifications, timeline, and pipeline via API.
Write only the briefing section — analysis and insights that the API does not provide.

## Language
- Write in the same language the user uses.

## Tools
- mama_search({query, limit}) — search decisions and memory
- report_publish({slots: {briefing: "<html>"}}) — publish a briefing. Only the "briefing" slot is allowed.

## What to Write
- Project status summary (3-5 lines max)
- Items requiring immediate attention
- Cross-project patterns or risks

## How to Write
1. Query recent decisions with mama_search (limit 20)
2. Analyze content and identify patterns
3. Write a concise briefing — no raw data listings, only analysis and insights
4. Publish with report_publish

## HTML Rules
- Inline styles only
- Headings: font-family:Fredoka,sans-serif;font-size:14px;font-weight:600;color:#1A1A1A
- Body text: font-size:12px;color:#6B6560;line-height:1.6
- Warning: color:#D94F4F, Normal: color:#3A9E7E
- border-radius 4px max, no emoji

## Strict Constraints
- Call mama_search at most once
- Call report_publish exactly once
- Do not ask follow-up questions
- Do not perform additional reasoning after publishing
- After publishing, respond with: DONE`;

/**
 * Ensure persona file exists at ~/.mama/personas/dashboard.md
 * Creates it from default if not present.
 */
export function ensureDashboardPersona(mamaHomeDir: string = join(homedir(), '.mama')): string {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'dashboard.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, DASHBOARD_AGENT_PERSONA, 'utf-8');
    return personaPath;
  }

  const existingContent = readFileSync(personaPath, 'utf-8');

  // Upgrade managed personas when our version changes
  // Match any version of the managed marker (v1, v2, etc.)
  if (
    existingContent.includes('<!-- MAMA managed dashboard persona') &&
    existingContent !== DASHBOARD_AGENT_PERSONA
  ) {
    writeFileSync(personaPath, DASHBOARD_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}

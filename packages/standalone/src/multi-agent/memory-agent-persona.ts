/**
 * Default persona for the memory agent.
 * Written to ~/.mama/personas/memory.md on first use if not present.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MANAGED_MEMORY_PERSONA_MARKER = '<!-- MAMA managed memory persona v2 -->';

export const MEMORY_AGENT_PERSONA = `${MANAGED_MEMORY_PERSONA_MARKER}

You are MAMA's memory agent — an always-on observer that watches conversations and extracts knowledge worth remembering.

## Your Role
- Observe every conversation turn between users and the main agent
- Use memory tools directly to inspect, evolve, and save memory
- Never rely on the caller to parse JSON and save for you

## Topic Rules
- MUST reuse existing topic if same subject (provided in context)
- Use lowercase snake_case: auth_strategy, database_choice
- Same topic = evolution chain (supersedes)
- Related topic = builds_on or synthesizes

## Tool Workflow
1. Use \`mama_search\` to inspect existing memory before saving
2. Decide whether new information supersedes, builds on, or synthesizes existing memory
3. Use \`mama_save\` to persist the chosen memory
4. Use \`mama_profile\` if long-term profile context would help judgment

## Relationship Types
- supersedes: replaces a previous decision on same topic
- builds_on: adds information to existing topic without replacing
- synthesizes: merges multiple decisions or infers connections

## What to Save
- Architecture decisions, technical choices, tooling preferences
- User preferences and working style
- Constraints, requirements, lessons learned
- Decision changes that should supersede prior memory

## What to Skip
- Greetings, casual chat, thanks
- Questions without answers
- Temporary debugging steps
- Code snippets

## Response Rules
- If nothing is worth saving, briefly say so
- Do not return JSON for the caller to parse
- Do the memory work yourself with tools, then report a short status`;

function isLegacyManagedPersona(content: string): boolean {
  return (
    content.includes("You are MAMA's memory agent") &&
    (content.includes('Return ONLY a JSON object') ||
      content.includes('Return ONLY JSON') ||
      content.includes('Return ONLY the JSON'))
  );
}

/**
 * Ensure persona file exists at ~/.mama/personas/memory.md
 * Creates it from default if not present and upgrades legacy managed personas.
 */
export function ensureMemoryPersona(mamaHomeDir: string = join(homedir(), '.mama')): string {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'memory.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, MEMORY_AGENT_PERSONA, 'utf-8');
    return personaPath;
  }

  const existingContent = existsSync(personaPath) ? readFileSync(personaPath, 'utf-8') : '';
  if (isLegacyManagedPersona(existingContent)) {
    writeFileSync(personaPath, MEMORY_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}

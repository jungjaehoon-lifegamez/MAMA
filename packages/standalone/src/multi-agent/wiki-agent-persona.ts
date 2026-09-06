/**
 * Default persona for the wiki agent.
 * Written to ~/.mama/personas/wiki.md on first use if not present.
 *
 * v7: the persona is exactly the managed marker plus the ONE code-owned
 * canonical wiki contract (wiki-turn-contract.ts). The unattended workorder run
 * embeds that same contract, so there are no persona-only or runtime-only rules
 * to drift - a drift test pins the equivalence. All behavioral rules (daily
 * journal, lessons, Home.md, progressive source reads) live in the shared
 * contract.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { WIKI_TURN_CONTRACT_TEXT } from '../wiki/wiki-turn-contract.js';

const MANAGED_WIKI_PERSONA_MARKER = '<!-- MAMA managed wiki persona v7 -->';

export const WIKI_AGENT_PERSONA = `${MANAGED_WIKI_PERSONA_MARKER}

${WIKI_TURN_CONTRACT_TEXT}`;

/**
 * Ensure persona file exists at ~/.mama/personas/wiki.md
 * Creates it from default if not present.
 */
export function ensureWikiPersona(mamaHomeDir: string = join(homedir(), '.mama')): string {
  const personaDir = join(mamaHomeDir, 'personas');
  const personaPath = join(personaDir, 'wiki.md');

  if (!existsSync(personaDir)) {
    mkdirSync(personaDir, { recursive: true });
  }

  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, WIKI_AGENT_PERSONA, 'utf-8');
    return personaPath;
  }

  const existingContent = readFileSync(personaPath, 'utf-8');
  if (
    existingContent.includes('<!-- MAMA managed wiki persona') &&
    existingContent !== WIKI_AGENT_PERSONA
  ) {
    writeFileSync(personaPath, WIKI_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}

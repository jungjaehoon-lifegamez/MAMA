/**
 * Wiki agent persona text.
 *
 * v7: the persona is exactly the managed marker plus the ONE code-owned
 * canonical wiki contract (wiki-turn-contract.ts). The unattended workorder run
 * embeds that same contract, so there are no persona-only or runtime-only rules
 * to drift - a drift test pins the equivalence. All behavioral rules (daily
 * journal, lessons, Home.md, progressive source reads) live in the shared
 * contract.
 *
 * This text lives in code only. It is never written to or read back from
 * ~/.mama/personas/wiki.md: personas are retired, and a file on disk could
 * drift from the contract the runtime actually enforces.
 */

import { WIKI_TURN_CONTRACT_TEXT } from '../wiki/wiki-turn-contract.js';

const MANAGED_WIKI_PERSONA_MARKER = '<!-- MAMA managed wiki persona v7 -->';

export const WIKI_AGENT_PERSONA = `${MANAGED_WIKI_PERSONA_MARKER}

${WIKI_TURN_CONTRACT_TEXT}`;

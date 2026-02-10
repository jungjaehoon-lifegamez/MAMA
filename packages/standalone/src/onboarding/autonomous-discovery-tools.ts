import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath } from '../cli/config/config-manager.js';

interface DiscoveryToolInput {
  session_id?: string;
  phase?: string;
  insight?: string;
  dimension?: string;
  score?: number;
  evidence?: string;
  use_case?: string;
  details?: string;
}

export interface DiscoveryTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (input: DiscoveryToolInput) => Promise<Record<string, unknown>>;
}

function getProfileDir(sessionId: string): string {
  return expandPath(`~/.mama/profiles/${sessionId}`);
}

async function ensureProfileDir(sessionId: string): Promise<string> {
  const profileDir = getProfileDir(sessionId);
  if (!existsSync(profileDir)) {
    await mkdir(profileDir, { recursive: true });
  }
  return profileDir;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export const AUTONOMOUS_DISCOVERY_TOOLS: DiscoveryTool[] = [
  {
    name: 'save_phase_insight',
    description: 'Save insights from a discovery phase to the user profile',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Unique session identifier for this onboarding',
        },
        phase: {
          type: 'string',
          description: 'Phase name (e.g., "introduction", "workflow", "goals")',
        },
        insight: {
          type: 'string',
          description: 'Key insight or learning from this phase',
        },
      },
      required: ['session_id', 'phase', 'insight'],
    },
    handler: async (input: DiscoveryToolInput) => {
      if (!input.session_id || !input.phase || !input.insight) {
        return {
          success: false,
          error: 'session_id, phase, and insight are required',
        };
      }

      try {
        const profileDir = await ensureProfileDir(input.session_id);
        const phasesDir = join(profileDir, 'phases');

        if (!existsSync(phasesDir)) {
          await mkdir(phasesDir, { recursive: true });
        }

        const phaseFile = join(phasesDir, `${input.phase}.md`);
        const timestamp = formatTimestamp();

        let content = '';
        if (existsSync(phaseFile)) {
          const existingContent = await readFile(phaseFile, 'utf-8');
          content = existingContent;
          content += `\n\n## Update: ${timestamp}\n\n${input.insight}`;
        } else {
          content = `---
phase: ${input.phase}
created: ${timestamp}
updated: ${timestamp}
---

# Phase: ${input.phase}

## Insights

${input.insight}
`;
        }

        await writeFile(phaseFile, content, 'utf-8');

        return {
          success: true,
          message: `Phase insight saved to ${input.phase}.md`,
          path: phaseFile,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to save phase insight: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  {
    name: 'update_personality_score',
    description: 'Track personality dimensions and scores for the user',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Unique session identifier for this onboarding',
        },
        dimension: {
          type: 'string',
          description:
            'Personality dimension (e.g., "technical_depth", "collaboration_preference")',
        },
        score: {
          type: 'number',
          description: 'Score from 0.0 to 1.0',
          minimum: 0,
          maximum: 1,
        },
        evidence: {
          type: 'string',
          description: 'Evidence or reasoning for this score',
        },
      },
      required: ['session_id', 'dimension', 'score', 'evidence'],
    },
    handler: async (input: DiscoveryToolInput) => {
      if (!input.session_id || !input.dimension || input.score === undefined || !input.evidence) {
        return {
          success: false,
          error: 'session_id, dimension, score, and evidence are required',
        };
      }

      if (input.score < 0 || input.score > 1) {
        return {
          success: false,
          error: 'score must be between 0.0 and 1.0',
        };
      }

      try {
        const profileDir = await ensureProfileDir(input.session_id);
        const personalityFile = join(profileDir, 'personality.md');
        const timestamp = formatTimestamp();

        let content = '';
        const scores: Record<
          string,
          {
            score: number;
            evidence: string;
            updated: string;
          }
        > = {};

        if (existsSync(personalityFile)) {
          const existingContent = await readFile(personalityFile, 'utf-8');

          const scoreMatches = existingContent.matchAll(
            /### (.+?)\n\n\*\*Score:\*\* ([\d.]+)\/1\.0\n\*\*Evidence:\*\* (.+?)\n\*\*Updated:\*\* (.+?)\n/gs
          );

          for (const match of scoreMatches) {
            const [, dim, scoreStr, evidence, updated] = match;
            if (dim !== input.dimension) {
              scores[dim] = {
                score: parseFloat(scoreStr),
                evidence,
                updated,
              };
            }
          }
        }

        scores[input.dimension] = {
          score: input.score,
          evidence: input.evidence,
          updated: timestamp,
        };

        const sortedDimensions = Object.keys(scores).sort();
        const scoresSection = sortedDimensions
          .map(
            (dim) => `### ${dim}

**Score:** ${scores[dim].score.toFixed(2)}/1.0
**Evidence:** ${scores[dim].evidence}
**Updated:** ${scores[dim].updated}
`
          )
          .join('\n');

        content = `---
created: ${existsSync(personalityFile) ? content.match(/created: (.+)/)?.[1] || timestamp : timestamp}
updated: ${timestamp}
---

# Personality Profile

## Dimensions

${scoresSection}
`;

        await writeFile(personalityFile, content, 'utf-8');

        return {
          success: true,
          message: `Personality score updated for ${input.dimension}`,
          path: personalityFile,
          score: input.score,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to update personality score: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },

  {
    name: 'save_use_case_insight',
    description: 'Record use cases and user needs discovered during onboarding',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Unique session identifier for this onboarding',
        },
        use_case: {
          type: 'string',
          description: 'Use case title or category (e.g., "code_reviews", "debugging")',
        },
        details: {
          type: 'string',
          description: 'Detailed description of the use case and context',
        },
      },
      required: ['session_id', 'use_case', 'details'],
    },
    handler: async (input: DiscoveryToolInput) => {
      if (!input.session_id || !input.use_case || !input.details) {
        return {
          success: false,
          error: 'session_id, use_case, and details are required',
        };
      }

      try {
        const profileDir = await ensureProfileDir(input.session_id);
        const useCasesFile = join(profileDir, 'use-cases.md');
        const timestamp = formatTimestamp();

        let content = '';
        if (existsSync(useCasesFile)) {
          const existingContent = await readFile(useCasesFile, 'utf-8');
          content = existingContent;

          content += `\n\n## ${input.use_case}

**Recorded:** ${timestamp}

${input.details}
`;
        } else {
          content = `---
created: ${timestamp}
updated: ${timestamp}
---

# Use Cases

## ${input.use_case}

**Recorded:** ${timestamp}

${input.details}
`;
        }

        await writeFile(useCasesFile, content, 'utf-8');

        return {
          success: true,
          message: `Use case insight saved: ${input.use_case}`,
          path: useCasesFile,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to save use case insight: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
];

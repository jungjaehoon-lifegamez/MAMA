import { writeFile, unlink } from 'node:fs/promises';
import { expandPath } from '../cli/config/config-manager.js';

interface RitualToolInput {
  filepath?: string;
  content?: string;
}

interface RitualTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  handler: (input: any) => Promise<any>;
}

export function createRitualTools(onRitualComplete: () => void): RitualTool[] {
  return [
    {
      name: 'write_file',
      description: 'Write IDENTITY.md, USER.md, or SOUL.md to establish your identity',
      input_schema: {
        type: 'object',
        properties: {
          filepath: {
            type: 'string',
            description:
              'File path relative to ~/.mama/ (e.g., "IDENTITY.md", "USER.md", "SOUL.md")',
          },
          content: {
            type: 'string',
            description: 'File content in markdown format',
          },
        },
        required: ['filepath', 'content'],
      },
      handler: async (input: RitualToolInput) => {
        if (!input.filepath || !input.content) {
          return { success: false, error: 'filepath and content required' };
        }

        const allowedFiles = ['IDENTITY.md', 'USER.md', 'SOUL.md'];
        if (!allowedFiles.includes(input.filepath)) {
          return {
            success: false,
            error: `Only ${allowedFiles.join(', ')} are allowed during ritual`,
          };
        }

        const fullPath = expandPath(`~/.mama/${input.filepath}`);
        await writeFile(fullPath, input.content, 'utf-8');

        return {
          success: true,
          message: `Created ${input.filepath}`,
        };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete BOOTSTRAP.md when ritual is complete',
      input_schema: {
        type: 'object',
        properties: {
          filepath: {
            type: 'string',
            description: 'File path (must be "BOOTSTRAP.md")',
          },
        },
        required: ['filepath'],
      },
      handler: async (input: RitualToolInput) => {
        if (!input.filepath) {
          return { success: false, error: 'filepath required' };
        }

        if (input.filepath !== 'BOOTSTRAP.md') {
          return {
            success: false,
            error: 'Can only delete BOOTSTRAP.md',
          };
        }

        const fullPath = expandPath('~/.mama/BOOTSTRAP.md');
        await unlink(fullPath);

        return {
          success: true,
          message: 'BOOTSTRAP.md deleted - ritual complete',
        };
      },
    },
    {
      name: 'mark_ritual_complete',
      description:
        'Signal that the bootstrap ritual is finished. Call ONLY after all files are created.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => {
        onRitualComplete();
        return {
          success: true,
          message: 'Ritual marked as complete - switching to normal setup mode',
        };
      },
    },
  ];
}
